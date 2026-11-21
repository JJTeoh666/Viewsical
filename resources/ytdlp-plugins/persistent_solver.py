"""Optional worker-local adapter for the pinned upstream EJS Deno solver."""

from collections import defaultdict
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
from queue import Queue
import subprocess
from threading import Thread
from time import perf_counter

from yt_dlp import version
from yt_dlp.extractor.youtube.jsc._builtin.deno import DenoJCP
from yt_dlp.extractor.youtube.jsc.provider import (
    JsChallengeProviderError,
    JsChallengeProviderResponse,
    JsChallengeResponse,
    JsChallengeType,
    NChallengeOutput,
    SigChallengeOutput,
)


SUPPORTED_YTDLP = "2026.10.26"
CORE_SHA256 = "18da6ce0758b416e7ae645084f4f8801f9f9d59d6c477c05eaa0ff94ebd8cc00"
LIB_SHA256 = "c55987fe697e5b9ee18830163f7af85327e9bb5c3e674b969d38c8d205eaa577"
MAX_MESSAGE = 8 * 1024 * 1024
SOLVE_BUDGET_S = 3
PLAYER_RESTORE = 't=function(e){const n={n:null,sig:null};return Function("_result",e)(n),n}(n),o='
SOLVER_ENTRY = 'return function(e){const n="player"===e.type?u(e.player):e.preprocessed_player,'
SOLVER_EXIT = 'return"player"===e.type&&e.output_preprocessed&&(o.preprocessed_player=n),o}}(meriyah,astring);'


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pinned_scripts(provider):
    core = provider._core_script.code
    lib = provider._lib_script.code
    if (
        digest(core) != CORE_SHA256 or digest(lib) != LIB_SHA256
        or any(core.count(part) != 1 for part in (SOLVER_ENTRY, PLAYER_RESTORE, SOLVER_EXIT))
    ):
        raise ValueError("Unsupported EJS bundle")
    return lib, core


def reusable_core(core):
    # Keep the upstream EJS parser and solver. Expose preparation and let the
    # caller reuse the functions that EJS ordinarily restores per invocation.
    return (
        core.replace(SOLVER_ENTRY, SOLVER_ENTRY.replace("return function(e)", "return Object.assign(function(e)"))
        .replace(PLAYER_RESTORE, PLAYER_RESTORE.replace("t=function", "t=e.viewsicalFunctions??function"))
        .replace(SOLVER_EXIT, SOLVER_EXIT.replace("}}(meriyah", "}, {prepare:u})}(meriyah"))
    )


def instrumented_core(core):
    return (
        core.replace(SOLVER_ENTRY, SOLVER_ENTRY.replace("{const n", "{const prepStarted=performance.now();const n"))
        .replace(PLAYER_RESTORE, PLAYER_RESTORE.replace(",o=", ";const solveStarted=performance.now();const o="))
        .replace(SOLVER_EXIT,
                 "const ended=performance.now();o.viewsicalTimings={prepareMs:solveStarted-prepStarted,"
                 "solveMs:ended-solveStarted,scriptMs:ended-viewsicalScriptStarted};" + SOLVER_EXIT)
    )


def millis(started):
    return (perf_counter() - started) * 1000


def remaining(deadline):
    left = deadline - perf_counter()
    if left <= 0:
        raise TimeoutError("EJS solve timed out")
    return left


class Runtime:
    def __init__(self, deno_path):
        self.pending = Queue(1)
        self.results = Queue(1)
        self.request_id = 0
        self.child = subprocess.Popen(
            [deno_path, "run", "--no-prompt", "--no-remote", "--no-npm", "--cached-only",
             "--no-lock", "--no-config", "--no-code-cache", "--node-modules-dir=none",
             "--deny-read", "--deny-write", "--deny-net", "--deny-env", "--deny-run",
             "--deny-ffi", "--deny-sys", "--deny-import",
             str(Path(__file__).with_name("persistent-solver.js"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.thread = Thread(target=self.io, daemon=True, name="Viewsical EJS stdio")
        self.thread.start()

    def io(self):
        try:
            with self.child.stdin as stdin, self.child.stdout as stdout:
                while (message := self.pending.get()) is not None:
                    stdin.write(message)
                    stdin.flush()
                    reply = stdout.readline(MAX_MESSAGE + 1)
                    if not reply.endswith(b"\n") or len(reply) > MAX_MESSAGE:
                        break
                    self.results.put_nowait(reply)
        except OSError:
            pass
        finally:
            if self.results.empty():
                self.results.put_nowait(None)

    def request(self, deadline, **message):
        self.request_id += 1
        payload = json.dumps({"id": self.request_id, **message}, separators=(",", ":")).encode() + b"\n"
        if len(payload) > MAX_MESSAGE:
            raise ValueError("Oversized EJS request")
        self.pending.put_nowait(payload)
        reply = self.results.get(timeout=remaining(deadline))
        if reply is None:
            raise ValueError("Closed EJS runtime")
        response = json.loads(reply)
        if response["id"] != self.request_id or response.get("error"):
            raise ValueError("Invalid EJS response")
        return response

    def close(self):
        try:
            self.child.kill()
            self.child.wait(timeout=0.5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if self.pending.empty():
            self.pending.put_nowait(None)


def provider_responses(requests, output):
    if output["type"] == "error":
        raise JsChallengeProviderError(output["error"])
    responses = []
    for request, response in zip(requests, output["responses"], strict=True):
        if response["type"] == "error":
            responses.append(JsChallengeProviderResponse(request, None, response["error"]))
        else:
            constructor = NChallengeOutput if request.type is JsChallengeType.N else SigChallengeOutput
            responses.append(JsChallengeProviderResponse(request, JsChallengeResponse(
                request.type, constructor(response["data"]))))
    return responses


class Solver:
    def __init__(self, stock, experiment, timings_file):
        self.stock = stock
        self.experiment = experiment
        self.timings_file = timings_file
        self.runtime = None

    def close(self):
        if self.runtime is not None:
            self.runtime.close()
            self.runtime = None

    def log(self, event):
        if self.timings_file:
            try:
                with open(self.timings_file, "a", encoding="utf-8") as output:
                    output.write(json.dumps(event, separators=(",", ":")) + "\n")
            except OSError:
                pass

    def persistent(self, provider, group, player_url, event):
        started = perf_counter()
        if self.runtime is None:
            lib, core = pinned_scripts(provider)
            self.runtime = Runtime(provider.runtime_info.path)
            initialized = self.runtime.request(
                started + SOLVE_BUDGET_S, action="init", lib=lib, core=reusable_core(core))
            if not initialized.get("ready"):
                raise ValueError("EJS runtime failed to initialize")
            event["launchMs"] = millis(started)
        key = digest(player_url + "\0" + CORE_SHA256 + LIB_SHA256)
        challenges = [{"type": req.type.value, "challenges": req.input.challenges} for req in group]
        deadline = started + SOLVE_BUDGET_S
        reply = self.runtime.request(deadline, action="solve", key=key, requests=challenges)
        if reply.get("miss"):
            before_fetch = perf_counter()
            player = provider._get_player(event["videoId"], player_url)
            # The enclosing yt-dlp lookup bounds player fetching as usual.
            deadline += perf_counter() - before_fetch
            reply = self.runtime.request(deadline, action="solve", key=key, requests=challenges, player=player)
        event.update(hit=reply["hit"], prepareMs=reply["prepareMs"], solveMs=reply["solveMs"])
        try:
            responses = provider_responses(group, reply["output"])
        except JsChallengeProviderError as error:
            raise ValueError("EJS helper could not solve the supplied challenges") from error
        for entry in responses:
            data = entry.response.output.results if entry.response else None
            if not isinstance(data, dict) or set(data) != set(entry.request.input.challenges) or not all(
                isinstance(value, str) for value in data.values()
            ):
                raise ValueError("Incomplete EJS result")
        return responses

    def stock_timed(self, provider, group, player_url, event):
        event["path"] = "stock"
        if not self.timings_file or provider._ENABLE_PREPROCESSED_PLAYER_CACHE:
            return list(self.stock(provider, group))
        try:
            _, core = pinned_scripts(provider)
        except Exception:
            return list(self.stock(provider, group))
        player = provider._get_player(event["videoId"], player_url)
        stdin = provider._construct_stdin(player, False, group)
        stdin = "const viewsicalScriptStarted=performance.now();\n" + stdin.replace(core, instrumented_core(core), 1)
        provider.logger.info(f"Solving JS challenges using {provider.JS_RUNTIME_NAME}")
        started = perf_counter()
        result = json.loads(provider._run_js_runtime(stdin))
        if timings := result.get("viewsicalTimings"):
            event.update(launchMs=max(0, millis(started) - timings["scriptMs"]),
                         prepareMs=timings["prepareMs"], solveMs=timings["solveMs"])
        return provider_responses(group, result)

    def solve(self, provider, requests):
        grouped = defaultdict(list)
        for request in requests:
            grouped[request.input.player_url].append(request)
        for player_url, group in grouped.items():
            started = perf_counter()
            event = {
                "path": "persistent", "playerKey": digest(player_url), "hit": False,
                "videoId": next((r.video_id for r in group if r.video_id), None),
                "launchMs": 0, "prepareMs": None, "solveMs": None,
                "fallback": False, "success": False,
            }
            try:
                if self.experiment:
                    try:
                        responses = self.persistent(provider, group, player_url, event)
                    except JsChallengeProviderError:
                        # Player-script download errors belong to yt-dlp's
                        # normal provider retry policy.
                        raise
                    except Exception:
                        self.close()
                        event["fallback"] = True
                        responses = self.stock_timed(provider, group, player_url, event)
                else:
                    responses = self.stock_timed(provider, group, player_url, event)
                event["success"] = all(response.error is None for response in responses)
                yield from responses
            finally:
                event["totalMs"] = millis(started)
                self.log(event)


@contextmanager
def activate(experiment, timings_file):
    if version.__version__ != SUPPORTED_YTDLP:
        yield
        return
    current = DenoJCP._real_bulk_solve
    solver = Solver(current, experiment, timings_file)
    DenoJCP._real_bulk_solve = lambda provider, requests: solver.solve(provider, requests)
    try:
        yield
    finally:
        DenoJCP._real_bulk_solve = current
        solver.close()

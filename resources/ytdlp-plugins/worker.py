"""Serve sequential playback source requests on the private Rust-owned pipe."""

import contextlib
import json
import os
from pathlib import Path
import runpy
import sys

import yt_dlp
from yt_dlp.globals import plugin_dirs

MAX_RESULT = 16 * 1024 * 1024


class RequestLog:
    def __init__(self):
        self.errors = ""

    def debug(self, message):
        pass

    info = warning = debug

    def error(self, message):
        self.errors = (self.errors + "\n" + message)[-8192:]


def extract(arguments):
    _, options, urls, params = yt_dlp.parse_options(arguments)
    if len(urls) != 1:
        raise ValueError("Expected one YouTube target")
    plugin_dirs.value = options.plugin_dirs
    log = RequestLog()
    params["logger"] = log
    try:
        with yt_dlp.YoutubeDL(params) as downloader:
            # Simulated processing collects every comma-separated selection in
            # requested_downloads, without downloading any of those streams.
            collect_selections = "--simulate" in arguments and params.get("simulate") is True
            result = downloader.extract_info(urls[0], download=collect_selections)
            return {"result": downloader.sanitize_info(result)}
    except yt_dlp.utils.DownloadError:
        return {"provider_error": log.errors}


def main():
    protocol = sys.stdout
    with contextlib.redirect_stdout(sys.stderr), contextlib.ExitStack() as cleanup:
        experiment = os.environ.get("VIEWSICAL_EXPERIMENTAL_PERSISTENT_SOLVER", "1") == "1"
        timings = os.environ.get("VIEWSICAL_SOLVER_TIMINGS_FILE")
        if experiment or timings:
            try:
                adapter = runpy.run_path(str(Path(__file__).with_name("persistent_solver.py")))
                cleanup.enter_context(adapter["activate"](experiment, timings))
            except (OSError, ImportError, KeyError):
                # The bundled provider is the compatibility path.
                pass
        print('{"ready":1}', file=protocol, flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            try:
                reply = extract(request["args"])
            except Exception:
                reply = {"worker_error": True}
            reply["id"] = request["id"]
            encoded = json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_RESULT:
                encoded = json.dumps({"id": reply["id"], "too_large": True}).encode("utf-8")
            protocol.buffer.write(encoded + b"\n")
            protocol.flush()


if __name__ == "__main__":
    main()

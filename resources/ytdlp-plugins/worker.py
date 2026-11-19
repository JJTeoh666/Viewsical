"""Serve sequential playback source requests on the private Rust-owned pipe."""

import contextlib
import json
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
            return {"result": downloader.sanitize_info(downloader.extract_info(urls[0], download=False))}
    except yt_dlp.utils.DownloadError:
        return {"provider_error": log.errors}


def main():
    protocol = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
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

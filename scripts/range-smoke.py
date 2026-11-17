"""Verify the bundled yt-dlp resumes safely with 206 and ignored Range requests.

Run from any directory: python scripts/range-smoke.py
Uses generated media and a loopback HTTP server only. No YouTube account or
network connection is needed. Temporary files stay under .tools/test-data.
"""

from __future__ import annotations

import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
HIDDEN = 0x08000000 if os.name == "nt" else 0


def run(command: list[str], timeout: int = 40) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=HIDDEN,
    )
    if result.returncode:
        raise RuntimeError(
            f"{Path(command[0]).name} exited {result.returncode}: "
            f"{result.stderr[-2000:]}"
        )
    return result


def check_resume(folder: Path, data: bytes, honor_range: bool) -> dict[str, object]:
    requests: list[str | None] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            pass

        def do_HEAD(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()

        def do_GET(self) -> None:
            requested_range = self.headers.get("Range")
            requests.append(requested_range)
            offset = (
                int(requested_range.split("=", 1)[1].split("-", 1)[0])
                if requested_range and honor_range
                else 0
            )
            partial = bool(requested_range and honor_range)
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data) - offset))
            if partial:
                self.send_header(
                    "Content-Range", f"bytes {offset}-{len(data) - 1}/{len(data)}"
                )
            self.end_headers()
            try:
                self.wfile.write(data[offset:])
            except (BrokenPipeError, ConnectionResetError):
                # Extractor probing may close the initial response early.
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        output = folder / ("honored.mp4" if honor_range else "ignored.mp4")
        partial_size = len(data) // 3
        output.with_suffix(".mp4.part").write_bytes(data[:partial_size])
        run(
            [
                str(TOOLS / "yt-dlp.exe"),
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-update",
                "--no-playlist",
                "--continue",
                "--part",
                "--no-simulate",
                "--force-generic-extractor",
                "--no-progress",
                "-o",
                str(output),
                "--",
                f"http://127.0.0.1:{server.server_port}/video.mp4",
            ]
        )
        expected_range = f"bytes={partial_size}-"
        if expected_range not in requests:
            raise AssertionError(f"The pre-existing partial was not resumed: {requests}")
        actual = hashlib.sha256(output.read_bytes()).hexdigest()
        expected = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise AssertionError("The resumed output differs from the complete source")
        if output.with_suffix(".mp4.part").exists():
            raise AssertionError("A partial file remains after successful completion")
        return {
            "response": 206 if honor_range else 200,
            "rangeIgnored": not honor_range,
            "rangeRequested": expected_range,
            "bytes": output.stat().st_size,
            "sha256Matches": True,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def main() -> None:
    for name in ("ffmpeg.exe", "yt-dlp.exe"):
        if not (TOOLS / name).is_file():
            raise FileNotFoundError(f"Missing tools/{name}. Run scripts/setup-tools.ps1")
    scratch_root = (ROOT / ".tools" / "test-data").resolve()
    scratch_root.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="range-smoke-", dir=scratch_root)).resolve()
    if scratch.parent != scratch_root or not scratch.name.startswith("range-smoke-"):
        raise RuntimeError("The test scratch path is outside the intended workspace")
    try:
        source = scratch / "source.mp4"
        run(
            [
                str(TOOLS / "ffmpeg.exe"),
                "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25",
                "-f", "lavfi", "-i", "sine=frequency=440",
                "-t", "3",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-movflags", "+faststart",
                str(source),
            ]
        )
        data = source.read_bytes()
        cases = [check_resume(scratch, data, mode) for mode in (True, False)]
        print(json.dumps({"passed": True, "cases": cases}, indent=2))
    finally:
        # Verify the resolved, absolute target immediately before recursive cleanup.
        resolved = scratch.resolve()
        if resolved.parent != scratch_root or not resolved.name.startswith("range-smoke-"):
            raise RuntimeError("Refusing to clean an unexpected test directory")
        shutil.rmtree(resolved)
    if scratch.exists():
        raise AssertionError("Test scratch cleanup failed")


if __name__ == "__main__":
    main()

"""Read one validated YouTube WebVTT track. The parent limits process lifetime."""

import ssl
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

import certifi


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    url = sys.stdin.buffer.read(4097).decode('utf-8')
    address = urlsplit(url)
    if len(url) > 4096 or (address.scheme, address.netloc, address.path) != (
        'https', 'www.youtube.com', '/api/timedtext'
    ) or address.fragment:
        return 1

    context = ssl.create_default_context(cafile=certifi.where())
    opener = build_opener(NoRedirect(), HTTPSHandler(context=context))
    request = Request(url, headers={'Accept': 'text/vtt', 'User-Agent': 'Mozilla/5.0'})
    limit = 4 * 1024 * 1024
    with opener.open(request, timeout=12) as response:
        captions = response.read(limit + 1)
    if len(captions) > limit:
        return 1
    sys.stdout.buffer.write(captions)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)

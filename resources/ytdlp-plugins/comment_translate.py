"""Request the English translation of a comment through YouTube's web client."""

import base64
import sys

from yt_dlp import YoutubeDL
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.utils import traverse_obj


MAX_COMMENT_BYTES = 80_000


def varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def bytes_field(number, value):
    return varint((number << 3) | 2) + varint(len(value)) + value


def translation_action(text):
    # InnerTube PerformCommentActionParams, action type 22 (translation).
    # See LuanRT/YouTube.js protos/misc/params.proto and ProtoUtils.ts.
    comment = bytes_field(1, text.encode('utf-8'))
    parameters = bytes_field(2, b' ') + bytes_field(3, bytes_field(1, comment)) + bytes_field(4, b'en')
    action = (b'\x08\x16\x10\x02' + bytes_field(3, b' ') + bytes_field(5, b' ')
              + bytes_field(23, b' ') + bytes_field(31, parameters))
    # The JSON endpoint expects the URL-safe Base64 alphabet. The standard
    # alphabet corrupts requests when the encoded text contains a '+' or '/'.
    return base64.urlsafe_b64encode(action).decode('ascii')


def main():
    source = sys.stdin.buffer.read(MAX_COMMENT_BYTES + 1)
    if len(source) > MAX_COMMENT_BYTES:
        return 1
    text = source.decode('utf-8').strip()
    if not text:
        return 1

    # The request needs only the comment text and target language. It uses a
    # fresh, anonymous downloader with no Viewsical session cookies.
    with YoutubeDL({'quiet': True, 'no_warnings': True, 'socket_timeout': 10}) as downloader:
        response = YoutubeIE(downloader)._call_api(
            'comment/perform_comment_action', {'actions': [translation_action(text)]},
            video_id='comment-translation')
    translation = traverse_obj(response, (
        'frameworkUpdates', 'entityBatchUpdate', 'mutations', ..., 'payload',
        'commentEntityPayload', 'translatedContent', 'content', {str}), get_all=False)
    if not translation or not translation.strip():
        return 1
    sys.stdout.buffer.write(source if translation.strip() == text else translation.encode('utf-8'))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)

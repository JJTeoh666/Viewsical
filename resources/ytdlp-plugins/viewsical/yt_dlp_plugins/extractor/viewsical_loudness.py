"""Expose only YouTube's per-video loudness value to Viewsical.

Tested with yt-dlp 2026.10.26. Extraction, requests, source selection and
signature solving remain entirely in yt-dlp. No response, URL or cookie is
retained by this adapter, and it makes no additional network requests.
"""

from contextvars import ContextVar
import math

from yt_dlp.extractor.youtube import YoutubeIE

# The subclass replaces YoutubeIE through yt-dlp's documented plugin hook;
# it must not also be registered as a separate URL extractor.
__all__ = []
_active_extraction = ContextVar("viewsical_loudness_extraction", default=None)


def _loudness_for_video(responses, video_id):
    if not isinstance(responses, (list, tuple)):
        return None
    for response in responses:
        if not isinstance(response, dict):
            continue
        details = response.get("videoDetails")
        if not isinstance(details, dict) or details.get("videoId") != video_id:
            continue
        config = response.get("playerConfig")
        audio = config.get("audioConfig") if isinstance(config, dict) else None
        value = audio.get("loudnessDb") if isinstance(audio, dict) else None
        # bool is an int in Python; never accept it as loudness metadata.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if -100 <= value <= 100 and math.isfinite(value):
            return float(value)
    return None


class _ViewsicalYoutubeIE(YoutubeIE, plugin_name="ViewsicalLoudness"):
    def _real_extract(self, url):
        video_id = self._match_id(url)
        current = {"video_id": video_id, "loudness_db": None}
        token = _active_extraction.set(current)
        try:
            result = super()._real_extract(url)
            if isinstance(result, dict) and result.get("id") == video_id:
                # Always remove a previous/custom field on the result when
                # metadata is unavailable, rather than carrying track gain on.
                result.pop("viewsical_loudness_db", None)
                if current["loudness_db"] is not None:
                    result["viewsical_loudness_db"] = current["loudness_db"]
            return result
        finally:
            _active_extraction.reset(token)

    def _extract_player_responses(self, clients, video_id, *args, **kwargs):
        result = super()._extract_player_responses(clients, video_id, *args, **kwargs)
        current = _active_extraction.get()
        if current is not None and current["video_id"] == video_id:
            responses = result[0] if isinstance(result, tuple) and result else None
            current["loudness_db"] = _loudness_for_video(responses, video_id)
        return result

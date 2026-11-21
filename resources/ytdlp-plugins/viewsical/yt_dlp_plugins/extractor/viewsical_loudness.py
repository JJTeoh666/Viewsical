"""Expose YouTube playback metadata and comment threads to Viewsical.

Tested with yt-dlp 2026.10.26. Extraction, requests, source selection and
signature solving remain entirely in yt-dlp. No response, URL or cookie is
retained by this adapter, and it makes no additional network requests.
"""

from contextvars import ContextVar
import math

from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.utils import int_or_none, parse_count
from yt_dlp.utils.traversal import get_first, traverse_obj

# The subclass replaces YoutubeIE through yt-dlp's documented plugin hook;
# it must not also be registered as a separate URL extractor.
__all__ = []
_active_extraction = ContextVar("viewsical_loudness_extraction", default=None)
_active_comment_read = ContextVar("viewsical_comment_read", default=None)


def _comment_threads(response):
    return traverse_obj(response, (
        "onResponseReceivedEndpoints", ..., ("reloadContinuationItemsCommand", "appendContinuationItemsAction"),
        "continuationItems", ..., "commentThreadRenderer", {dict},
    ))


def _record_comment_threads(response, read):
    entities = {
        entity["entityKey"]: count
        for entity in traverse_obj(response, ("frameworkUpdates", "entityBatchUpdate", "mutations", ..., {dict}))
        if isinstance(entity.get("entityKey"), str)
        if (count := traverse_obj(entity, ("payload", "commentEntityPayload", "toolbar", "replyCount", {str})))
    }
    for thread in _comment_threads(response):
        view = traverse_obj(thread, ("commentViewModel", "commentViewModel", {dict})) or {}
        legacy = traverse_obj(thread, ("comment", "commentRenderer", {dict})) or {}
        comment_id = view.get("commentId") or legacy.get("commentId")
        if not isinstance(comment_id, str):
            continue
        if (parent := read["parent"]) and comment_id != parent:
            # Leave the top-level comment intact for yt-dlp's ordering and
            # duplicate checks, but never fetch replies to unrelated comments.
            thread.pop("replies", None)
            continue
        count = int_or_none(legacy.get("replyCount"))
        if count is None:
            count = parse_count(entities.get(traverse_obj(view, ("commentKey", {str}))))
        has_replies = bool(traverse_obj(thread, ("replies", "commentRepliesRenderer", {dict})))
        if count or has_replies:
            read["threads"][comment_id] = (count, has_replies)


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
    def _get_comments(self, ytcfg, video_id, contents, webpage):
        parent = self._configuration_arg("viewsical_reply_parent", [None], casesense=True)[0]
        read = {"parent": parent, "threads": {}}
        context = _active_comment_read.set(read)
        found = False
        try:
            for comment in super()._get_comments(ytcfg, video_id, contents, webpage):
                if parent and comment.get("parent") == "root":
                    if found:
                        return
                    if comment.get("id") != parent:
                        continue
                    found = True
                if parent and not found:
                    continue
                if (hint := read["threads"].pop(comment.get("id"), None)) is not None:
                    count, has_replies = hint
                    if count is not None:
                        comment["reply_count"] = count
                    comment["viewsical_has_replies"] = has_replies
                yield comment
        finally:
            _active_comment_read.reset(context)

    def _extract_response(self, *args, **kwargs):
        response = super()._extract_response(*args, **kwargs)
        if kwargs.get("ep") == "next" and (read := _active_comment_read.get()) is not None:
            _record_comment_threads(response, read)
        return response

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
                if current.get("avatar_channel_id") and current["avatar_channel_id"] == result.get("channel_id"):
                    result["viewsical_channel_avatar"] = current["avatar_url"]
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

    def _download_initial_data(self, video_id, *args, **kwargs):
        data = super()._download_initial_data(video_id, *args, **kwargs)
        current = _active_extraction.get()
        if current is not None and current["video_id"] == video_id:
            owner = traverse_obj(data, (
                "contents", "twoColumnWatchNextResults", "results", "results", "contents", ...,
                "videoSecondaryInfoRenderer", "owner", "videoOwnerRenderer", {dict},
            ), get_all=False)
            current["avatar_channel_id"] = traverse_obj(owner, ("navigationEndpoint", "browseEndpoint", "browseId", {str}))
            current["avatar_url"] = traverse_obj(owner, ("thumbnail", "thumbnails", -1, "url", {str}))
        return data

    def _extract_storyboard(self, player_responses, duration):
        spec = get_first(
            player_responses, ("storyboards", "playerStoryboardSpecRenderer", "spec", {str}),
            default="",
        )
        intervals = {}
        # The spec gives the sampled frame interval in milliseconds. yt-dlp's
        # fps is derived from the frame count and includes partially used tiles.
        for index, entry in enumerate(reversed(spec.split("|")[1:])):
            parts = entry.split("#")
            interval = int_or_none(parts[5]) if len(parts) == 8 else None
            if interval and 0 < interval <= 3_600_000:
                intervals[f"sb{index}"] = interval / 1000
        for board in super()._extract_storyboard(player_responses, duration):
            interval = intervals.get(board["format_id"])
            if interval is not None:
                board["viewsical_frame_interval"] = interval
            yield board

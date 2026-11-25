"""Keep channel metadata, Home shelves, and Mix entry points from YouTube."""

import re
from urllib.parse import parse_qs, urlsplit

from yt_dlp.extractor.youtube import YoutubeTabIE
from yt_dlp.utils import parse_count
from yt_dlp.utils.traversal import traverse_obj

__all__ = []

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def _mix_id(value):
    return isinstance(value, str) and re.fullmatch(r"RD[A-Za-z0-9_-]{0,126}", value)


def _mix_watch_url(playlist_id, command):
    if not isinstance(command, dict):
        return None
    for key in ("watchEndpoint", "watchPlaylistEndpoint"):
        endpoint = command.get(key)
        if not isinstance(endpoint, dict) or endpoint.get("playlistId") != playlist_id:
            continue
        seed = endpoint.get("videoId")
        if isinstance(seed, str) and _VIDEO_ID.fullmatch(seed):
            return f"https://www.youtube.com/watch?v={seed}&list={playlist_id}"

    url = traverse_obj(command, ("commandMetadata", "webCommandMetadata", "url", {str}))
    if not url:
        return None
    try:
        link = urlsplit(url)
    except ValueError:
        return None
    if (link.scheme, link.netloc) not in (
        ("", ""), ("https", "www.youtube.com"), ("https", "youtube.com"),
        ("https", "m.youtube.com"), ("https", "music.youtube.com"),
    ) or link.path != "/watch":
        return None
    query = parse_qs(link.query)
    seeds = query.get("v", [])
    if query.get("list") == [playlist_id] and len(seeds) == 1 and _VIDEO_ID.fullmatch(seeds[0]):
        return f"https://www.youtube.com/watch?v={seeds[0]}&list={playlist_id}"
    return None


class _ViewsicalChannelIE(YoutubeTabIE, plugin_name="ViewsicalChannel"):
    def _extract_data(self, url, item_id, ytcfg=None, fatal=True, webpage_fatal=False, default_client="web"):
        data, ytcfg = super()._extract_data(url, item_id, ytcfg, fatal, webpage_fatal, default_client)
        link = urlsplit(url)
        query = parse_qs(link.query) if link.path == "/watch" else {}
        playlist_id = next(iter(query.get("list", ())), None)
        seed = next(iter(query.get("v", ())), "")
        if not _mix_id(playlist_id) or not _VIDEO_ID.fullmatch(seed) or not data or self.skip_webpage:
            return data, ytcfg

        panel_path = ("contents", "twoColumnWatchNextResults", "playlist", "playlist", {dict})
        if not traverse_obj(data, panel_path):
            # A working watch page can omit the Mix and otherwise fall through to a single video.
            headers = self.generate_api_headers(
                ytcfg=ytcfg, default_client=default_client,
                delegated_session_id=self._extract_delegated_session_id(ytcfg, data),
                visitor_data=self._extract_visitor_data(data, ytcfg),
            )
            refreshed = self._extract_response(
                item_id, {"playlistId": playlist_id, "videoId": seed, "index": 0, "params": "OAE="},
                headers=headers, ytcfg=ytcfg, ep="next", check_get_keys="contents",
                fatal=False, default_client=default_client,
            )
            if traverse_obj(refreshed, panel_path):
                return refreshed, ytcfg
        return data, ytcfg

    def _extract_lockup_view_model(self, view_model):
        entry = super()._extract_lockup_view_model(view_model)
        playlist_id = view_model.get("contentId")
        if entry and view_model.get("contentType") == "LOCKUP_CONTENT_TYPE_PLAYLIST" and _mix_id(playlist_id):
            command = traverse_obj(view_model, (
                "rendererContext", "commandContext", "onTap", "innertubeCommand", {dict},
            ))
            if url := _mix_watch_url(playlist_id, command):
                entry["url"] = url
        return entry

    def _mix_renderer_entry(self, item):
        renderer = item.get("radioRenderer") or self._extract_basic_item_renderer(item)
        if not isinstance(renderer, dict):
            return None
        playlist_id = renderer.get("playlistId")
        if not _mix_id(playlist_id):
            return None
        for key in ("navigationEndpoint", "playNavigationEndpoint"):
            if url := _mix_watch_url(playlist_id, renderer.get(key)):
                return self.url_result(
                    url, ie=YoutubeTabIE.ie_key(), video_id=playlist_id,
                    video_title=self._get_text(renderer, "title"),
                    thumbnails=self._extract_thumbnails(renderer, "thumbnail"),
                )
        return None

    def _grid_entries(self, grid_renderer):
        for item in grid_renderer["items"]:
            entry = self._mix_renderer_entry(item) if isinstance(item, dict) else None
            if entry:
                yield entry
            else:
                yield from super()._grid_entries({"items": [item]})

    def _rich_entries(self, rich_grid_renderer):
        item = traverse_obj(rich_grid_renderer, ("content", {dict}))
        entry = self._mix_renderer_entry(item) if item else None
        if entry:
            yield entry
        else:
            yield from super()._rich_entries(rich_grid_renderer)

    def _extract_metadata_from_tabs(self, item_id, data):
        metadata = super()._extract_metadata_from_tabs(item_id, data)
        if self._configuration_arg("viewsical_profile") != ["1"] or not metadata.get("channel_id"):
            return metadata

        parts = traverse_obj(data, (
            "header", "pageHeaderRenderer", "content", "pageHeaderViewModel",
            "metadata", "contentMetadataViewModel", "metadataRows", ...,
            "metadataParts", ..., "text", "content", {str},
        ))
        for text in parts:
            if re.fullmatch(r"[\d,.\s]+[KMBT]?\s+videos?", text.strip(), flags=re.IGNORECASE):
                count = parse_count(text)
                if count is not None:
                    metadata["viewsical_channel_video_count"] = count
                    break
        return metadata

    def _shelf_entries_from_content(self, shelf_renderer):
        yield from super()._shelf_entries_from_content(shelf_renderer)
        if self._configuration_arg("viewsical_profile") == ["1"]:
            horizontal = traverse_obj(shelf_renderer, ("content", "horizontalListRenderer", {dict}))
            if horizontal:
                yield from self._grid_entries(horizontal)

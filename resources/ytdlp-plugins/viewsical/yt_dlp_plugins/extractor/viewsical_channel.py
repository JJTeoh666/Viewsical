"""Expose metadata and horizontal Home shelves from yt-dlp's channel response."""

import re

from yt_dlp.extractor.youtube import YoutubeTabIE
from yt_dlp.utils import parse_count
from yt_dlp.utils.traversal import traverse_obj

__all__ = []


class _ViewsicalChannelIE(YoutubeTabIE, plugin_name="ViewsicalChannel"):
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

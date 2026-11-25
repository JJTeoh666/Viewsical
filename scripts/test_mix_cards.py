"""Run with the bundled Python using -B scripts/test_mix_cards.py."""

from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

from yt_dlp import YoutubeDL
from yt_dlp.extractor.youtube import YoutubeTabIE


plugin = Path(__file__).resolve().parents[1] / "resources/ytdlp-plugins/viewsical/yt_dlp_plugins/extractor/viewsical_channel.py"
extractor = runpy.run_path(str(plugin))["_ViewsicalChannelIE"](YoutubeDL({}, auto_init=False))
seed = "fzQ6gRAEoy0"
watch_url = f"https://www.youtube.com/watch?v={seed}&list=RDMM"


class MixCards(unittest.TestCase):
    def test_lockup_preserves_starting_video_from_watch_command(self):
        view = {
            "contentId": "RDMM",
            "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST",
            "metadata": {"lockupMetadataViewModel": {"title": {"content": "My Mix"}}},
            "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {
                "watchEndpoint": {"playlistId": "RDMM", "videoId": seed},
            }}}},
        }
        entry = extractor._extract_lockup_view_model(view)
        self.assertEqual(entry["url"], watch_url)
        self.assertEqual(entry["title"], "My Mix")

    def test_legacy_card_keeps_watch_link_in_grid_and_rich_feed(self):
        renderer = {
            "playlistId": "RDMM",
            "title": {"simpleText": "My Mix"},
            "navigationEndpoint": {"commandMetadata": {"webCommandMetadata": {
                "url": f"/watch?v={seed}&list=RDMM&si=tracking",
            }}},
        }
        for method, item in (
            (extractor._grid_entries, {"items": [{"gridPlaylistRenderer": renderer}]}),
            (extractor._rich_entries, {"content": {"radioRenderer": renderer}}),
        ):
            with self.subTest(method=method.__name__):
                entries = list(method(item))
                self.assertEqual([entry["url"] for entry in entries], [watch_url])

    def test_mismatched_playlist_cannot_supply_a_starting_video(self):
        renderer = {"playlistId": "RDMM", "navigationEndpoint": {
            "watchEndpoint": {"videoId": seed, "playlistId": "RDother"},
            "commandMetadata": {"webCommandMetadata": {
                "url": f"https://example.invalid/watch?v={seed}&list=RDMM",
            }},
        }}
        entry, = extractor._grid_entries({"items": [{"gridPlaylistRenderer": renderer}]})
        self.assertEqual(entry["url"], "https://www.youtube.com/playlist?list=RDMM")

    def test_regular_playlist_stays_a_regular_playlist(self):
        renderer = {"playlistId": "PLfixture", "playNavigationEndpoint": {
            "watchEndpoint": {"playlistId": "PLfixture", "videoId": seed},
        }}
        entry, = extractor._rich_entries({"content": {"playlistRenderer": renderer}})
        self.assertEqual(entry["url"], "https://www.youtube.com/playlist?list=PLfixture")

    def test_missing_mix_panel_uses_the_watch_endpoint_once(self):
        watch = {"currentVideoEndpoint": {"watchEndpoint": {"videoId": seed}}}
        mix = {"contents": {"twoColumnWatchNextResults": {"playlist": {"playlist": {
            "playlistId": "RDMM",
        }}}}}
        config = {"theme": "test"}
        with patch.object(YoutubeTabIE, "_extract_data", return_value=(watch, config)):
            with patch.object(extractor, "_extract_response", return_value=mix) as fallback:
                self.assertEqual(extractor._extract_data(watch_url, "RDMM"), (mix, config))
                fallback.assert_called_once()
                self.assertEqual(fallback.call_args.args, ("RDMM", {
                    "playlistId": "RDMM", "videoId": seed, "index": 0, "params": "OAE=",
                }))
                self.assertEqual(fallback.call_args.kwargs["ep"], "next")
            with patch.object(extractor, "_extract_response", return_value=watch) as fallback:
                self.assertEqual(extractor._extract_data(watch_url, "RDMM"), (watch, config))
                fallback.assert_called_once()
        with patch.object(YoutubeTabIE, "_extract_data", return_value=(mix, config)):
            with patch.object(extractor, "_extract_response") as fallback:
                self.assertEqual(extractor._extract_data(watch_url, "RDMM"), (mix, config))
                fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()

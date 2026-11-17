"""Offline contract tests for the small yt-dlp plugin, no yt-dlp install needed."""

import concurrent.futures
import importlib.util
import math
from pathlib import Path
import sys
import threading
import types
import unittest

sys.dont_write_bytecode = True


class _YoutubeIE:
    def __init_subclass__(cls, **kwargs):
        pass

    def _match_id(self, url):
        return url

    def _real_extract(self, url):
        if url == getattr(self, "nested_parent", None):
            self.nested_result = self._real_extract("nested")
        self._extract_player_responses([], url)
        if hasattr(self, "barrier"):
            self.barrier.wait(timeout=5)
        if getattr(self, "fail", False):
            raise ValueError("fixture extraction failed")
        return {"id": getattr(self, "result_id", url)}

    def _extract_player_responses(self, clients, video_id, *args, **kwargs):
        return self.responses.get(video_id, []), "not-used"


for name in ["yt_dlp", "yt_dlp.extractor", "yt_dlp.extractor.youtube"]:
    sys.modules[name] = types.ModuleType(name)
sys.modules["yt_dlp.extractor.youtube"].YoutubeIE = _YoutubeIE
path = Path(__file__).resolve().parents[1] / "resources/ytdlp-plugins/viewsical/yt_dlp_plugins/extractor/viewsical_loudness.py"
spec = importlib.util.spec_from_file_location("viewsical_loudness", path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def response(video_id, value):
    return {"videoDetails": {"videoId": video_id}, "playerConfig": {"audioConfig": {"loudnessDb": value}}}


class LoudnessPluginTests(unittest.TestCase):
    def extractor(self, responses):
        extractor = plugin._ViewsicalYoutubeIE()
        extractor.responses = responses
        return extractor

    def test_valid_positive_negative_and_zero(self):
        for value in [6, -4.25, 0]:
            with self.subTest(value=value):
                ex = self.extractor({"video": [response("video", value)]})
                self.assertEqual(ex._real_extract("video")["viewsical_loudness_db"], value)

    def test_missing_metadata_does_not_reuse_previous_item(self):
        ex = self.extractor({"loud": [response("loud", 6)], "missing": [{"videoDetails": {"videoId": "missing"}}]})
        self.assertEqual(ex._real_extract("loud")["viewsical_loudness_db"], 6)
        self.assertNotIn("viewsical_loudness_db", ex._real_extract("missing"))
        self.assertIsNone(plugin._active_extraction.get())

    def test_mismatched_player_response_is_ignored(self):
        ex = self.extractor({"video": [response("another", 6)]})
        self.assertNotIn("viewsical_loudness_db", ex._real_extract("video"))

    def test_mismatched_extraction_result_is_ignored(self):
        ex = self.extractor({"video": [response("video", 6)]})
        ex.result_id = "redirect"
        self.assertNotIn("viewsical_loudness_db", ex._real_extract("video"))

    def test_invalid_metadata_and_shapes_are_ignored(self):
        for value in [True, False, "6", None, math.inf, -math.inf, math.nan, 101, -101, 10**1000, {}, []]:
            with self.subTest(value=value):
                self.assertIsNone(plugin._loudness_for_video([response("video", value)], "video"))
        for invalid in [None, {}, "response", [None, {"videoDetails": []}], [response("other", 6)]]:
            self.assertIsNone(plugin._loudness_for_video(invalid, "video"))

    def test_valid_later_client_can_supply_metadata(self):
        ex = self.extractor({"video": [response("video", None), response("video", -2)]})
        self.assertEqual(ex._real_extract("video")["viewsical_loudness_db"], -2)

    def test_failed_extraction_cleans_scoped_state(self):
        ex = self.extractor({"video": [response("video", 6)]})
        ex.fail = True
        with self.assertRaises(ValueError):
            ex._real_extract("video")
        self.assertIsNone(plugin._active_extraction.get())

    def test_nested_extraction_restores_parent_context(self):
        ex = self.extractor({"parent": [response("parent", 6)], "nested": [response("nested", -3)]})
        ex.nested_parent = "parent"
        result = ex._real_extract("parent")
        self.assertEqual(result["viewsical_loudness_db"], 6)
        self.assertEqual(ex.nested_result["viewsical_loudness_db"], -3)
        self.assertIsNone(plugin._active_extraction.get())

    def test_concurrent_extractions_are_isolated(self):
        ex = self.extractor({"first": [response("first", 6)], "second": [response("second", -3)]})
        ex.barrier = threading.Barrier(2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(ex._real_extract, ["first", "second"]))
        self.assertEqual([(r["id"], r["viewsical_loudness_db"]) for r in results], [("first", 6), ("second", -3)])
        self.assertIsNone(plugin._active_extraction.get())


if __name__ == "__main__":
    unittest.main()

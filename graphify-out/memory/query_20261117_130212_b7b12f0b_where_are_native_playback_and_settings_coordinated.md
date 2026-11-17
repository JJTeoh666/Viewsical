---
type: "query"
date: "2026-11-17T13:02:12.579796+00:00"
question: "Where are native playback and settings coordinated in Viewsical?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PlayerManager", "PlaybackPlan", "tubedesk_osc.lua"]
---

# Q: Where are native playback and settings coordinated in Viewsical?

## Answer

Expanded from graph vocabulary: [player, manager, mpv, playback, settings, plan, osc]. Existing graph identifies PlayerManager at src-tauri/src/player.rs L164, PlaybackPlan at src-tauri/src/youtube.rs L28 and tubedesk_osc.lua at resources/player/tubedesk_osc.lua L1. These established the Rust source-commit and separate native-control boundaries for the 0.1.5 work; source locations in the old graph predate these edits and must be checked against current files.

## Outcome

- Signal: useful

## Source Nodes

- PlayerManager
- PlaybackPlan
- tubedesk_osc.lua
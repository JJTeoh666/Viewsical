# Graph health — Viewsical 0.1.7 release

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 1389
unverified_code_nodes: 0
raw_edges: 3289
valid_candidate_edges: 3289
missing_endpoint_edges: 0
dangling_endpoint_edges: 0
external_reference_edges: 0
self_loop_edges: 2
exact_duplicate_edges: 0
directed_unique_endpoint_pairs: 3289
directed_same_endpoint_collapsed_edges: 0
undirected_unique_endpoint_pairs: 3289
undirected_same_endpoint_collapsed_edges: 0
same_endpoint_group_count: 0
relation_variant_groups: 0
source_file_variant_groups: 0
source_location_variant_groups: 0
context_variant_groups: 0
post_build_graph_type: Graph
post_build_edges: 3289
producer_suppression_sites: 12
producer_suppression_examples:
  - L1829 seen_ids arity=unknown
  - L2393 seen_ids arity=unknown
  - L2395 seen_doc_refs arity=unknown
  - L3062 seen_ids arity=unknown
  - L3209 seen_ids arity=unknown
  - L4350 seen_keys arity=unknown
  - L4536 seen_keys arity=unknown
  - L7947 seen_ids arity=unknown
note: normal graph.json is post-build; raw producer loss must be measured earlier.

## Reviewed findings

- No final missing or dangling endpoints.
- Two intentional recursive calls: collect() in scripts/collect-licenses.mjs and _real_extract() in scripts/test-loudness-plugin.py.
- Raw diagnostics describe the two changed release documents; their external endpoints resolve in existing graph content.
- This undirected relationship map can fold relation variants between the same endpoints.
- All 18 existing README semantic IDs are preserved. Both changed documents were fully read.
- Host semantic-agent token usage is unavailable; zero cost counters are placeholders.

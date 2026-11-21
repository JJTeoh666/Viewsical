# Graph health for Viewsical 0.1.18

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 2272
unverified_code_nodes: 0
raw_edges: 5556
valid_candidate_edges: 5556
missing_endpoint_edges: 0
dangling_endpoint_edges: 0
external_reference_edges: 0
self_loop_edges: 3
exact_duplicate_edges: 0
directed_unique_endpoint_pairs: 5556
directed_same_endpoint_collapsed_edges: 0
undirected_unique_endpoint_pairs: 5556
undirected_same_endpoint_collapsed_edges: 0
same_endpoint_group_count: 0
relation_variant_groups: 0
source_file_variant_groups: 0
source_location_variant_groups: 0
context_variant_groups: 0
post_build_graph_type: Graph
post_build_edges: 5556
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

The merged graph has no missing or dangling endpoints. Raw extraction diagnostics include references resolved by the existing graph.

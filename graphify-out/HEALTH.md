[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 996
unverified_code_nodes: 0
raw_edges: 2701
valid_candidate_edges: 2488
missing_endpoint_edges: 0
dangling_endpoint_edges: 144
external_reference_edges: 69
self_loop_edges: 1
exact_duplicate_edges: 2
directed_unique_endpoint_pairs: 2387
directed_same_endpoint_collapsed_edges: 101
undirected_unique_endpoint_pairs: 2387
undirected_same_endpoint_collapsed_edges: 101
same_endpoint_group_count: 70
relation_variant_groups: 32
source_file_variant_groups: 0
source_location_variant_groups: 29
context_variant_groups: 10
post_build_graph_type: Graph
post_build_edges: 2585
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
examples:
  - src_tauri_src_player_playermanager -> src_tauri_src_player_rs_mutex edges=16 relations=['references'] locations=['L167', 'L168', 'L171', 'L174', 'L175', 'L180', 'L181', 'L182', 'L183', 'L190', 'L191', 'L192', 'L193', 'L194', 'L195', 'L196'] contexts=['field']
  - src_tauri_src_player_playermanager -> asyncmutex edges=5 relations=['references'] locations=['L169', 'L170', 'L172', 'L173'] contexts=['field', 'generic_arg']
  - src_tauri_src_player_playermanager -> src_tauri_src_player_rs_atomicu64 edges=5 relations=['references'] locations=['L176', 'L177', 'L178', 'L179', 'L184'] contexts=['field']
  - src_tauri_src_player_playermanager -> src_tauri_src_player_rs_atomicbool edges=5 relations=['references'] locations=['L185', 'L186', 'L187', 'L188', 'L189'] contexts=['field']
  - src_tauri_src_player_playermanager -> src_tauri_src_player_sourcetoken edges=4 relations=['references'] locations=['L193', 'L194', 'L195', 'L196'] contexts=['generic_arg']
note: normal graph.json is post-build; raw producer loss must be measured earlier.
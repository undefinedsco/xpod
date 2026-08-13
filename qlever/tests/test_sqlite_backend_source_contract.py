import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
QLEVER = ROOT / "qlever"
HEADER = QLEVER / "rdf_sqlite_backend" / "include" / "xpod_rdf_sqlite_backend.h"
SOURCE = QLEVER / "rdf_sqlite_backend" / "src" / "xpod_rdf_sqlite_backend.cpp"


REQUIRED_CALLBACKS = [
    "get_capabilities",
    "lookup_term",
    "resolve_term",
    "lookup_terms",
    "resolve_terms",
    "scan_permutation",
    "open_scan_cursor",
    "next_scan_cursor",
    "close_scan_cursor",
    "count_scan",
    "distinct_scan",
    "estimate_scan",
    "estimate_distinct",
    "estimate_join_fanout",
    "estimate_source_scope",
    "resolve_source_scope",
    "estimate_access_scope",
    "apply_mutation",
    "encode_qlever_id",
    "decode_qlever_id",
    "compare_qlever_ids",
    "prefetch_qlever_ids",
    "encode_qlever_ids",
]


class SqliteBackendSourceContractTest(unittest.TestCase):
    def read_source(self) -> str:
        self.assertTrue(SOURCE.is_file(), SOURCE)
        return SOURCE.read_text(encoding="utf-8")

    def test_declares_abi_v7_sqlite_backend_entrypoints(self):
        self.assertTrue(HEADER.is_file(), HEADER)
        header = HEADER.read_text(encoding="utf-8")
        self.assertIn('#include "xpod_rdf_physical_backend.h"', header)
        self.assertIn("typedef struct xpod_rdf_sqlite_backend_config", header)
        self.assertIn("database_path", header)
        self.assertIn("xpod_rdf_sqlite_backend_create", header)
        self.assertIn("xpod_rdf_sqlite_backend_destroy", header)
        self.assertIn("xpod_qlever_backend_provider_create", header)
        self.assertIn("xpod_qlever_backend_provider_destroy", header)

    def test_wires_required_abi_v7_callbacks(self):
        source = self.read_source()
        self.assertIn("XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION", source)
        self.assertIn("sizeof(xpod_rdf_backend_v1)", source)
        for callback in REQUIRED_CALLBACKS:
            with self.subTest(callback=callback):
                pattern = rf"\bbackend\.{callback}\s*=\s*sqlite_[a-zA-Z0-9_]+;"
                self.assertRegex(source, pattern)
        self.assertEqual(len(REQUIRED_CALLBACKS), 23)
        self.assertNotRegex(source, r"\bbackend\.resolve_access_scope\s*=")
        self.assertNotRegex(source, r"\bbackend\.prefix_range\s*=")
        self.assertNotIn("sqlite_resolve_access_scope", source)
        self.assertNotIn("sqlite_prefix_range", source)

    def test_uses_mature_sqlite_c_api_without_new_dependencies(self):
        source = self.read_source()
        self.assertIn("#include <sqlite3.h>", source)
        for symbol in [
            "sqlite3_open_v2",
            "sqlite3_prepare_v2",
            "sqlite3_bind_",
            "sqlite3_step",
            "sqlite3_finalize",
            "sqlite3_close",
        ]:
            with self.subTest(symbol=symbol):
                self.assertIn(symbol, source)
        forbidden = [
            "#include <SqliteRuntime",
            "#include <better-sqlite3",
            "#include <bun",
            "Napi::",
            "node_api",
        ]
        for token in forbidden:
            with self.subTest(forbidden=token):
                self.assertNotIn(token, source)

    def test_waits_for_wal_writers_on_the_shared_local_database(self):
        source = self.read_source()
        self.assertIn("sqlite3_busy_timeout(state->db, 5000)", source)
        self.assertIn('"PRAGMA foreign_keys = ON"', source)

    def test_binds_existing_xpod_jobs_sqlite_schema(self):
        source = self.read_source()
        required_schema_tokens = [
            "rdf_terms",
            "rdf_quads",
            "rdf_sources",
            "rdf_index_metadata",
            "rdf_text_sources",
            "rdf_text_chunks",
            "rdf_text_terms",
            "rdf_text_entities",
            "rdf_vector_sources",
            "rdf_vector_chunks",
            "rdf_vector_components",
            "graph_id",
            "subject_id",
            "predicate_id",
            "object_id",
            "source_file_id",
            "value_head",
            "datatype_id",
            "normalized_text",
            "numeric_value",
            "rdf-syntax-ns#langString",
        ]
        for token in required_schema_tokens:
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_fails_closed_on_the_exact_owner_facts_schema(self):
        source = self.read_source()
        self.assertIn('kRequiredFactsSchemaVersion = "1"', source)
        self.assertIn('has_facts_schema', source)
        self.assertIn('has_exact_columns', source)
        self.assertIn('has_exact_index', source)
        self.assertIn('"rdf_index_metadata", "data_version"', source)
        self.assertIn('is_canonical_unsigned_decimal(data_version)', source)
        for column in [
            '"created_at"',
            '"last_indexed_at"',
            '"source_version"',
        ]:
            with self.subTest(column=column):
                self.assertIn(column, source)
        for index in [
            'rdf_terms_identity_hash',
            'rdf_terms_kind_value_head',
            'rdf_terms_kind_numeric_value',
            'rdf_quads_spog',
            'rdf_quads_gpos',
            'rdf_quads_source',
        ]:
            with self.subTest(index=index):
                self.assertIn(f'"{index}"', source)
        self.assertRegex(source, r'if \(!has_facts_schema\(state\.get\(\)\)\)')

    def test_optional_candidate_callbacks_are_capability_gated(self):
        source = self.read_source()
        self.assertRegex(source, r"has_columns\([^)]*rdf_text_chunks")
        self.assertRegex(source, r"has_columns\([^)]*rdf_vector_chunks")
        self.assertIn("has_column", source)
        self.assertIn("has_schema_version", source)
        self.assertIn('"rdf_text_metadata"', source)
        self.assertIn('kRequiredTextSchemaVersion = "3"', source)
        self.assertIn('"rdf_vector_metadata"', source)
        self.assertIn('kRequiredVectorSchemaVersion = "2"', source)
        self.assertIn('has_not_null_column(state, "rdf_text_sources", "source_key")', source)
        self.assertIn('has_unique_column(state, "rdf_text_sources", "source_key")', source)
        self.assertIn('has_not_null_column(state, "rdf_vector_sources", "source_key")', source)
        self.assertIn('has_unique_column(state, "rdf_vector_sources", "source_key")', source)
        self.assertNotIn("rdf_candidate_schema_version", source)
        self.assertIn('"chunk_key"', source)
        self.assertIn('"model_version"', source)
        self.assertIn('"projection_policy_version"', source)
        self.assertRegex(source, r"if\s*\([^)]*has_text[^)]*\)\s*\{[^}]*backend\.text_search\s*=", re.S)
        self.assertRegex(source, r"if\s*\([^)]*has_vector[^)]*\)\s*\{[^}]*backend\.vector_search\s*=", re.S)
        self.assertNotRegex(source, r"backend\.text_search\s*=\s*sqlite_[a-zA-Z0-9_]+;\s*backend\.estimate_text_search", re.S)
        self.assertNotRegex(source, r"backend\.vector_search\s*=\s*sqlite_[a-zA-Z0-9_]+;\s*backend\.estimate_vector_search", re.S)

    def test_required_callbacks_are_not_stubbed_or_capability_mismatched(self):
        source = self.read_source()
        for name in ["sqlite_apply_mutation", "sqlite_encode_qlever_id"]:
            with self.subTest(callback=name):
                body = re.search(rf"xpod_rdf_status {name}\([^{{]+{{(?P<body>.*?)\n}}", source, re.S)
                self.assertIsNotNone(body, name)
                self.assertNotRegex(body.group("body"), r"return XPOD_RDF_STATUS_UNSUPPORTED;\s*$")
        self.assertIn("XPOD_RDF_BACKEND_FEATURE_MUTATION", source)
        self.assertIn("XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE", source)
        for feature in [
            "XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES",
            "XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER",
            "XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER",
            "XPOD_RDF_BACKEND_FEATURE_SCAN_VALUE_RANGE",
        ]:
            with self.subTest(feature=feature):
                self.assertNotIn(feature, source)

    def test_access_scope_is_enforced_across_scan_text_and_vector(self):
        source = self.read_source()
        for token in [
            "append_access_scope_conditions",
            "allowed_graphs",
            "denied_graphs",
            "allowed_sources",
            "denied_sources",
            "allowed_graph_prefixes",
            "denied_graph_prefixes",
            "sqlite_scan_permutation",
            "sqlite_text_search",
            "sqlite_vector_search",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertRegex(source, r"sqlite_text_search[\s\S]*append_access_scope_conditions")
        self.assertRegex(source, r"sqlite_vector_search[\s\S]*append_access_scope_conditions")

    def test_read_paths_validate_snapshot_or_fail_closed(self):
        source = self.read_source()
        scan_sql = re.search(
            r"xpod_rdf_status scan_sql\([^{}]+(?P<body>\{[\s\S]*?)\n\}",
            source,
        )
        self.assertIsNotNone(scan_sql)
        self.assertIn("validate_snapshot(state, &request->snapshot)", scan_sql.group("body"))
        for callback in [
            "sqlite_scan_permutation",
            "sqlite_open_scan_cursor",
            "sqlite_count_scan",
            "sqlite_distinct_scan",
            "sqlite_estimate_scan",
            "sqlite_estimate_distinct",
        ]:
            with self.subTest(callback=callback):
                self.assertIn(callback, source)
        for callback in [
            "sqlite_estimate_source_scope",
            "sqlite_estimate_text_search",
            "sqlite_estimate_vector_search",
        ]:
            with self.subTest(callback=callback):
                start = source.index(f"xpod_rdf_status {callback}(")
                end = source.index("\n}\n", start)
                body = source[start:end]
                self.assertIn("validate_snapshot", body)
                self.assertNotIn("SELECT COUNT(*) FROM rdf_text_chunks", body)
                self.assertNotIn("SELECT COUNT(*) FROM rdf_vector_chunks", body)
        access_start = source.index("xpod_rdf_status sqlite_estimate_access_scope(")
        access_end = source.index("\n}\n", access_start)
        access_body = source[access_start:access_end]
        self.assertIn("XPOD_RDF_STATUS_UNSUPPORTED", access_body)
        self.assertNotIn("sqlite_estimate_scan", access_body)
        self.assertIn("XPOD_RDF_STATUS_STALE_STATS", source)

    def test_writable_provider_is_rollback_only_staging(self):
        source = self.read_source()
        apply_start = source.index("xpod_rdf_status sqlite_apply_mutation(")
        apply_end = source.index("xpod_rdf_status sqlite_begin_transaction", apply_start)
        apply_body = source[apply_start:apply_end]
        self.assertIn("BEGIN IMMEDIATE", apply_body)
        self.assertIn('"ROLLBACK"', apply_body)
        self.assertNotIn('"COMMIT"', apply_body)
        self.assertNotIn("bump_data_version(", source)
        self.assertNotIn("bump_data_version(state, out_result)", apply_body)

        commit_start = source.index("xpod_rdf_status sqlite_commit_transaction(")
        commit_end = source.index("xpod_rdf_status sqlite_rollback_transaction", commit_start)
        commit_body = source[commit_start:commit_end]
        self.assertIn('"ROLLBACK"', commit_body)
        self.assertIn("XPOD_RDF_STATUS_UNSUPPORTED", commit_body)
        self.assertNotIn('"COMMIT"', commit_body)

    def test_vector_text_prefix_and_graph_semantics_are_source_checked(self):
        source = self.read_source()
        for token in [
            "cosine_score",
            "dot_score",
            "euclidean_score",
            "request->threshold",
            "ORDER BY dot_product DESC, text_chunk.id ASC",
            "std::stable_sort",
            "rdf_vector_components",
            "XPOD_RDF_TEXT_CANDIDATE_RECORD",
            "XPOD_RDF_TEXT_CANDIDATE_ENTITY",
            "required_entities",
            "XPOD_RDF_GRAPH_SCOPE_PREFIX",
            "XPOD_RDF_GRAPH_SCOPE_SET",
            "XPOD_RDF_DEFAULT_GRAPH_KEY",
            "COUNT(DISTINCT component.dimension)",
            "component.dimension IN",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertNotRegex(source, r"SELECT MIN\(id\), MAX\(id\)")
        self.assertNotIn("XPOD_RDF_TERM_COLLATION_BYTEWISE", source)
        self.assertNotIn("range.upper = key + 1", source)
        self.assertNotIn("ORDER BY dot_product DESC, chunk.id ASC", source)
        self.assertNotRegex(source, r"candidate\.score\s*=\s*0\.0;")

    def test_vector_search_requires_and_filters_complete_embedding_profile(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_vector_search(")
        end = source.index("xpod_rdf_status sqlite_estimate_vector_search", start)
        body = source[start:end]
        for token in [
            "!has_bytes(request->provider)",
            "!has_bytes(request->model)",
            "!has_bytes(request->model_version)",
            "!has_bytes(request->input_kind)",
            "!has_bytes(request->projection_policy_version)",
            'conditions.push_back("chunk.provider = ?")',
            "add_text(&params, bytes_to_string(request->provider))",
            'conditions.push_back("chunk.model = ?")',
            "add_text(&params, bytes_to_string(request->model))",
            'conditions.push_back("chunk.model_version = ?")',
            "add_text(&params, bytes_to_string(request->model_version))",
            'conditions.push_back("chunk.input_kind = ?")',
            "add_text(&params, bytes_to_string(request->input_kind))",
            'conditions.push_back("chunk.projection_policy_version = ?")',
            "add_text(&params, bytes_to_string(request->projection_policy_version))",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, body)
        self.assertNotIn("input_hash", body)

    def test_vector_estimate_is_limit_based_heuristic_without_scanning_vectors(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_estimate_vector_search(")
        end = source.index("std::string normalized_text_for_term", start)
        body = source[start:end]
        for token in [
            "state == nullptr",
            "request == nullptr",
            "out_estimate == nullptr",
            "request->vector == nullptr",
            "validate_snapshot(state, &request->snapshot)",
            "request->dimensions == 0",
            "request->limit == 0",
            "!has_bytes(request->provider)",
            "!has_bytes(request->model)",
            "!has_bytes(request->model_version)",
            "!has_bytes(request->input_kind)",
            "!has_bytes(request->projection_policy_version)",
            "XPOD_RDF_VECTOR_COSINE",
            "XPOD_RDF_VECTOR_DOT",
            "XPOD_RDF_VECTOR_EUCLIDEAN",
            "out_estimate->rows = request->limit",
            "out_estimate->selectivity = 1.0",
            "out_estimate->startup_cost = 1.0",
            "static_cast<double>(request->limit) *",
            "static_cast<double>(request->dimensions)",
            "out_estimate->io_cost = static_cast<double>(request->limit)",
            "out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC",
            'metadata_value(state, "data_version", &data_version)',
            "out_estimate->stats_version = owned_bytes(state, data_version)",
            'out_estimate->reason = static_bytes("sqlite-heuristic-vector-limit")',
            "return XPOD_RDF_STATUS_OK;",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, body)
        self.assertNotIn("SELECT", body)
        self.assertNotIn("sqlite_vector_search(", body)
        self.assertNotRegex(body, r"return XPOD_RDF_STATUS_UNSUPPORTED;\s*$")

    def test_text_estimate_is_qlever_planner_safe_heuristic(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_estimate_text_search(")
        end = source.index("xpod_rdf_status sqlite_resolve_retrieval_points", start)
        body = source[start:end]
        for token in [
            "state == nullptr",
            "request == nullptr",
            "out_estimate == nullptr",
            "request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_RECORD",
            "request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_ENTITY",
            "request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_RECORD",
            "request->required_entities_size != 0",
            "validate_snapshot(state, &request->snapshot)",
            'metadata_value(state, "data_version", &data_version)',
            "state->owned_strings.clear()",
            "out_estimate->rows = request->limit == 0 ? 1 : request->limit",
            "out_estimate->selectivity = 1.0",
            "out_estimate->startup_cost = 1.0",
            "out_estimate->cpu_cost = static_cast<double>(out_estimate->rows)",
            "out_estimate->io_cost = static_cast<double>(out_estimate->rows)",
            "out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC",
            "out_estimate->stats_version = owned_bytes(state, data_version)",
            'out_estimate->reason = static_bytes("sqlite-heuristic-text-limit")',
            "return XPOD_RDF_STATUS_OK;",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, body)
        self.assertNotIn("SELECT", body)
        self.assertNotIn("sqlite_text_search(", body)
        self.assertNotRegex(body, r"return XPOD_RDF_STATUS_UNSUPPORTED;\s*$")

    def test_vector_candidates_emit_canonical_text_chunk_ids(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_vector_search(")
        end = source.index("xpod_rdf_status sqlite_estimate_vector_search", start)
        body = source[start:end]
        self.assertIn("SELECT text_chunk.id, rdf_source.id,", body)
        self.assertIn("text_source.source_key AS source_key", body)
        self.assertIn("text_chunk.chunk_key AS retrieval_point_key", body)
        self.assertIn("resource.id, chunk.magnitude", body)
        self.assertIn("JOIN rdf_text_sources text_source ON", body)
        self.assertIn("text_source.source_key = source.source_key", body)
        self.assertNotIn("COALESCE(text_source.source_key", body)
        self.assertNotIn("COALESCE(source.source_key", body)
        self.assertIn("JOIN rdf_text_chunks text_chunk ON text_chunk.source_id = text_source.id", body)
        self.assertIn("AND text_chunk.chunk_key = chunk.chunk_key", body)
        self.assertIn("JOIN rdf_sources rdf_source ON rdf_source.source = text_source.source", body)
        self.assertIn("LEFT JOIN rdf_terms resource ON resource.kind = 'iri'", body)
        self.assertIn("AND resource.value = text_source.source", body)
        self.assertIn(
            "GROUP BY text_chunk.id, rdf_source.id, text_source.source_key, "
            "text_chunk.chunk_key, resource.id, chunk.magnitude",
            body,
        )
        self.assertNotIn(
            "GROUP BY text_chunk.id, rdf_source.id, source_key, retrieval_point_key",
            body,
        )
        self.assertIn("candidate.source_key", body)
        self.assertIn("candidate.has_source_key = 1", body)
        self.assertIn("candidate.retrieval_point_key", body)
        self.assertIn("candidate.has_retrieval_point_key = 1", body)
        self.assertIn("candidate.resource_term", body)
        self.assertIn("candidate.has_resource_term = 1", body)
        self.assertIn("ORDER BY dot_product DESC, text_chunk.id ASC", body)
        self.assertNotIn("SELECT chunk.id, rdf_source.id, chunk.magnitude", body)

    def test_text_resolver_callbacks_are_registered_with_text_schema(self):
        source = self.read_source()
        self.assertIn("sqlite_resolve_retrieval_points", source)
        self.assertIn("sqlite_resolve_text_term", source)
        self.assertIn("sqlite_resolve_text_terms", source)
        self.assertIn("SELECT id, content FROM rdf_text_chunks WHERE id IN", source)
        self.assertIn("SELECT term FROM rdf_text_terms WHERE id = ?", source)
        create_body = source[source.index("extern \"C\" xpod_rdf_status xpod_rdf_sqlite_backend_create"):]
        text_block = re.search(r"if\s*\(state->has_text\)\s*\{(?P<body>.*?)\n  \}", create_body, re.S)
        self.assertIsNotNone(text_block)
        for callback in [
            "resolve_retrieval_points",
            "resolve_text_term",
            "resolve_text_terms",
        ]:
            with self.subTest(callback=callback):
                self.assertIn(f"state->backend.{callback} = sqlite_", text_block.group("body"))

    def test_reviewed_runtime_contract_edges_are_source_checked(self):
        source = self.read_source()
        for token in [
            "state->read_only",
            "SQLITE_OPEN_READONLY",
            "SQLITE_OPEN_READWRITE",
            "XPOD_RDF_TERM_KEY_ENCODING_OPAQUE",
            "XPOD_RDF_QLEVER_TERM_ORDER_UNKNOWN",
            "kQleverValueIdDataBits",
            "kQleverValueIdDataMask",
            "kQleverVocabIndexDatatype",
            "kQleverBlankNodeIndexDatatype",
            "decode_term_key_from_qlever_value_id_bits",
            "compare_resolved_terms",
            "permutation_sorted_slots",
            "LIMIT -1",
            "ensure_default_graph_key",
            "kXsdString",
            "resolve_mutation_source_file_id",
            "source_file_id",
        ]:
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertRegex(source, r"if\s*\(state->read_only\)\s*return XPOD_RDF_STATUS_PERMISSION_DENIED;")
        self.assertNotIn("XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS", source)
        self.assertNotIn("XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED", source)
        self.assertIn('resolved.kind == "blank"', source)
        self.assertNotIn("resolved.kind == XPOD_RDF_TERM_BLANK", source)
        self.assertNotRegex(source, r"\*out\s*=\s*term;")
        self.assertNotRegex(source, r"\*out\s*=\s*bits;")
        capability_body = re.search(
            r"xpod_rdf_status sqlite_get_capabilities[\s\S]*?return XPOD_RDF_STATUS_OK;",
            source,
        )
        self.assertIsNotNone(capability_body)
        self.assertIn("XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM", capability_body.group(0))
        self.assertRegex(capability_body.group(0), r"if\s*\(!state->read_only\)")

    def test_text_search_matches_pg_posting_semantics(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_text_search(")
        end = source.index("xpod_rdf_status sqlite_estimate_text_search", start)
        body = source[start:end]
        self.assertIn("request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_RECORD &&", body)
        self.assertIn("request->required_entities_size != 0", body)
        self.assertIn("return XPOD_RDF_STATUS_UNSUPPORTED;", body)
        self.assertIn("FROM rdf_text_terms term", body)
        self.assertIn("JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id", body)
        self.assertIn("term.term = ?", body)
        self.assertIn("append_prefix_condition(&conditions, &params, \"term.term\"", body)
        self.assertIn("SELECT DISTINCT chunk.id AS retrieval_point, rdf_source.id AS source_node", body)
        self.assertIn("source.source_key AS source_key", body)
        self.assertIn("chunk.chunk_key AS retrieval_point_key", body)
        self.assertIn("term.occurrences", body)
        self.assertIn("chunk.start_offset", body)
        self.assertIn("chunk.end_offset", body)
        self.assertIn("batch.matched_terms = matched_terms.data()", body)
        self.assertIn("batch.has_matched_terms = has_matched_terms.data()", body)
        self.assertNotIn("chunk.normalized_text LIKE", body)
        self.assertNotIn("SUM(COALESCE(term.occurrences", body)
        self.assertNotIn("SUM(COALESCE(entity.occurrences", body)

    def test_vector_search_returns_stable_source_and_retrieval_keys(self):
        source = self.read_source()
        start = source.index("xpod_rdf_status sqlite_vector_search(")
        end = source.index("xpod_rdf_status sqlite_estimate_vector_search", start)
        body = source[start:end]
        self.assertIn("text_source.source_key AS source_key", body)
        self.assertIn("text_chunk.chunk_key AS retrieval_point_key", body)
        self.assertIn("candidate.source_key", body)
        self.assertIn("candidate.retrieval_point_key", body)

    def test_comparable_terms_use_string_kind_for_qlever_id_comparison(self):
        source = self.read_source()
        comparable = re.search(
            r"struct ComparableTerm \{(?P<body>.*?)\n\};",
            source,
            re.S,
        )
        self.assertIsNotNone(comparable)
        body = comparable.group("body")

        self.assertIn("std::string kind;", body)
        self.assertNotIn("xpod_rdf_term_kind kind", body)
        self.assertIn('resolved.kind == "blank"', source)
        self.assertIn('left.kind == "literal"', source)
        self.assertNotIn('resolved.kind == XPOD_RDF_TERM_BLANK', source)
        self.assertNotIn('left.kind == XPOD_RDF_TERM_LITERAL', source)

    def test_no_fake_resolver_or_prefix_callback_and_json_fails_closed(self):
        source = self.read_source()
        self.assertNotIn("contract-seed", source)
        self.assertNotIn("contract-mixed", source)
        self.assertNotIn("broad-deny", source)
        self.assertIn("return XPOD_RDF_STATUS_UNSUPPORTED;", source)
        self.assertIn("Json::parse(json, nullptr, false)", source)
        self.assertIn("parsed.is_discarded()", source)
        self.assertIn("if (!ok) return XPOD_RDF_STATUS_BACKEND_ERROR;", source)

    def test_provider_json_uses_shared_nlohmann_header(self):
        source = self.read_source()
        self.assertIn('#if __has_include("util/json.h")', source)
        self.assertIn('#include "util/json.h"', source)
        self.assertIn("#include <nlohmann/json.hpp>", source)
        self.assertIn("using Json = nlohmann::json", source)
        self.assertIn("Json::parse", source)
        self.assertNotIn("json_string_value", source)
        self.assertNotIn("json_bool_value", source)

    def test_does_not_persist_qlever_vocabulary_or_add_compat_paths(self):
        source = self.read_source()
        forbidden_patterns = [
            r"CREATE\s+TABLE[^;]*qlever",
            r"INSERT\s+INTO[^;]*qlever",
            r"ALTER\s+TABLE",
            r"DROP\s+TABLE",
            r"compat",
            r"migration",
            r"fallback",
        ]
        for pattern in forbidden_patterns:
            with self.subTest(pattern=pattern):
                self.assertNotRegex(source, pattern, re.I)


if __name__ == "__main__":
    unittest.main()

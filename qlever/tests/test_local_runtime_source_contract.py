import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = ROOT / "qlever/qlever_local_runtime"
SOURCE = RUNTIME_ROOT / "src/xpod_qlever_local_runtime.cpp"
CMAKE = RUNTIME_ROOT / "CMakeLists.txt"
ADAPTER_HEADER = ROOT / "qlever/qlever_adapter/include/xpod_qlever_adapter.h"
ADAPTER_SOURCE = ROOT / "qlever/qlever_adapter/src/xpod_qlever_adapter.cpp"


class QleverLocalRuntimeSourceContractTest(unittest.TestCase):
    def read_source(self) -> str:
        self.assertTrue(SOURCE.is_file(), f"missing runtime source: {SOURCE}")
        return SOURCE.read_text(encoding="utf-8")

    def test_local_runtime_source_tree_statically_links_sqlite_backend(self):
        self.assertTrue(CMAKE.is_file(), "local runtime owns its CMake file")
        cmake = CMAKE.read_text(encoding="utf-8")
        self.assertIn("xpod_qlever_local_runtime", cmake)
        self.assertIn("xpod_qlever_adapter", cmake)
        self.assertIn("../rdf_sqlite_backend", cmake)
        runtime_links = re.search(
            r"target_link_libraries\(xpod_qlever_local_runtime PRIVATE(?P<body>.*?)\n\)",
            cmake,
            re.S,
        )
        self.assertIsNotNone(runtime_links)
        self.assertIn("xpod_rdf_sqlite_backend", runtime_links.group("body"))
        self.assertNotIn("FetchContent", cmake)

    def test_cli_requires_only_sqlite_path_for_embedded_sqlite_backend(self):
        source = self.read_source()
        self.assertIn("--sqlite-path", source)
        self.assertIn("parseArguments", source)
        self.assertRegex(source, r"databasePath\s*=\s*argv\[\+\+i\]")
        self.assertNotIn("--provider", source)
        self.assertNotIn("providerPath", source)
        self.assertNotIn("dlopen", source)
        self.assertNotIn("dlsym", source)
        self.assertNotIn("dlclose", source)
        self.assertNotIn("xpod_qlever_backend_provider_config", source)
        self.assertNotIn("config.backend_provider = &provider", source)
        self.assertNotIn("xpod_qlever_backend_provider_create", source)
        self.assertNotIn("xpod_qlever_backend_provider_destroy", source)
        self.assertNotIn("provider.library_path", source)
        self.assertNotIn("provider.config_json", source)
        self.assertIn("xpod_rdf_sqlite_backend_create", source)
        self.assertIn("xpod_rdf_sqlite_backend_destroy", source)
        self.assertIn("XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION", source)
        self.assertIn("config.backend = localBackend.backend", source)

    def test_runtime_uses_existing_qlever_json_instead_of_hand_written_parser(self):
        source = self.read_source()
        self.assertIn("util/json.h", source)
        self.assertIn("nlohmann::json", source)
        self.assertIn("Json::parse(line)", source)
        self.assertIn(".dump()", source)
        for forbidden in [
            "class JsonParser",
            "struct JsonValue",
            "enum class JsonKind",
            "jsonString(",
            "parseString(",
            "parseObject(",
            "parseArray(",
            "appendUnicodeEscape",
        ]:
            self.assertNotIn(forbidden, source)

    def test_ready_message_advertises_native_and_physical_abi_versions(self):
        source = self.read_source()
        self.assertIn('"type", "ready"', source)
        self.assertIn('"abiVersion"', source)
        self.assertIn("xpod_qlever_adapter_abi_version()", source)
        self.assertIn("XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION", source)
        self.assertIn('"physicalBackendAbiVersion"', source)
        self.assertIn('"backend", "sqlite"', source)

    def test_jsonl_protocol_handles_query_cancel_shutdown_and_correlates_ids(self):
        source = self.read_source()
        self.assertIn("std::getline(std::cin, line)", source)
        self.assertIn('type != "query"', source)
        self.assertIn('type == "cancel"', source)
        self.assertIn('type == "shutdown"', source)
        self.assertIn('"type", "result"', source)
        self.assertIn('"type", "error"', source)
        self.assertIn('"id", id', source)
        self.assertIn("LocalCancellationState", source)
        self.assertIn("std::thread queryWorker", source)
        self.assertIn("std::condition_variable workAvailable", source)
        self.assertIn("cancellations.find(id)", source)
        self.assertIn("cancelled.store(true", source)

    def test_jsonl_protocol_stdout_is_fd_isolated_from_runtime_logs(self):
        source = self.read_source()
        self.assertIn("class ProtocolOutput", source)
        self.assertIn("ProtocolOutput::isolateStdout()", source)
        self.assertIn("std::cout.flush()", source)
        self.assertIn("std::fflush(stdout)", source)
        self.assertIn("::dup(STDOUT_FILENO)", source)
        self.assertIn("::dup2(STDERR_FILENO, STDOUT_FILENO)", source)
        self.assertIn("writeAll(fd_, line)", source)
        self.assertIn("EINTR", source)
        self.assertIn('syscallError("write protocol stdout")', source)
        self.assertIn("output.writeJson", source)
        self.assertNotIn("std::cout << value.dump()", source)

        run_preamble = re.search(
            r"int run\(int argc, char\*\* argv\) \{\s*"
            r"ProtocolOutput output = ProtocolOutput::isolateStdout\(\);\s*"
            r"Arguments arguments = parseArguments\(argc, argv\);",
            source,
            re.S,
        )
        self.assertIsNotNone(run_preamble)

    def test_runtime_serializes_adapter_queries_while_main_thread_handles_cancel(self):
        source = self.read_source()
        self.assertEqual(source.count("std::thread queryWorker"), 1)
        worker = re.search(
            r"std::thread queryWorker\(\[&\]\(\) \{(.*?)\n  \}\);",
            source,
            re.S,
        )
        self.assertIsNotNone(worker)
        self.assertIn("xpod_qlever_adapter_query_request", worker.group(1))
        main_after_worker = source[worker.end():]
        self.assertNotIn("xpod_qlever_adapter_query_request", main_after_worker)
        self.assertIn("queryWorker.join()", source)

    def test_runtime_never_writes_protocol_output_while_holding_state_lock(self):
        source = self.read_source()

        duplicate = re.search(
            r"bool duplicateQueryId = false;\s*"
            r"\{(?P<locked>.*?)\n    \}\s*"
            r"if \(duplicateQueryId\) \{(?P<output>.*?)\n    \}",
            source,
            re.S,
        )
        self.assertIsNotNone(duplicate)
        self.assertIn("stateMutex", duplicate.group("locked"))
        self.assertNotIn("writeError", duplicate.group("locked"))
        self.assertIn("writeError", duplicate.group("output"))

        shutdown = re.search(
            r"std::vector<std::string> abortedTaskIds;\s*"
            r"\{(?P<locked>.*?)\n  \}\s*"
            r"for \(const std::string& id : abortedTaskIds\) "
            r"\{(?P<output>.*?)\n  \}",
            source,
            re.S,
        )
        self.assertIsNotNone(shutdown)
        self.assertIn("stateMutex", shutdown.group("locked"))
        self.assertNotIn("writeError", shutdown.group("locked"))
        self.assertIn("writeError", shutdown.group("output"))

    def test_request_options_are_mapped_to_qlever_adapter_request(self):
        source = self.read_source()
        for token in [
            'message.value("sparql"',
            "containsOnlyAllowedOptions(options, isAllowedRequestOption)",
            'key == "basePath"',
            'key == "sourceUri"',
            'key == "operation"',
            'key == "timeoutMs"',
            'key == "acceptMediaType"',
            'key == "loadDocument"',
            'key == "accessScope"',
            'key == "vectorQuery"',
            "request.sparql",
            'getString(options, "basePath")',
            'getString(options, "sourceUri")',
            'getString(options, "acceptMediaType")',
            "XPOD_QLEVER_REQUEST_PREPARE_UPDATE",
            "XPOD_QLEVER_REQUEST_QUERY_ONLY",
            "request.accept_media_type",
            "request.access_scope",
            "allowedGraphUrls",
            "deniedGraphUrls",
            "deniedGraphPrefixes",
            "allowedSourceUrls",
            "deniedSourceUrls",
            "deniedSourcePrefixes",
            "xpod_rdf_access_scope",
            "request.source_scope.source_uri_prefix",
            "request.graph_scope",
            "loadDocument",
            "request.load_document_source_uri",
            "request.load_document_body",
            "request.load_document_media_type",
        ]:
            self.assertIn(token, source)
        self.assertIn("xpod_qlever_adapter_lookup_terms", source)
        self.assertIn("XPOD_RDF_STATUS_PERMISSION_DENIED", source)
        self.assertNotIn('getStringArray(access, "allowedGraphPrefixes")', source)
        self.assertNotIn('getString(options, "sourceUriPrefix")', source)
        self.assertNotIn('getString(options, "localPath")', source)
        self.assertNotIn('getString(options, "localPathPrefix")', source)
        self.assertNotIn('options.value("graphScope"', source)
        self.assertNotIn('getBool(options, "accessScopeResolved")', source)
        self.assertNotIn('sparql.find("INSERT")', source)

    def test_nested_vector_query_options_map_complete_profile_to_adapter(self):
        source = self.read_source()
        for token in [
            'const Json& vectorQuery = options.at("vectorQuery")',
            'getDoubleArray(vectorQuery, "embedding", storage.vectorValues)',
            'std::isfinite(number)',
            'getString(vectorQuery, "provider").empty()',
            'getString(vectorQuery, "model").empty()',
            'getString(vectorQuery, "modelVersion").empty()',
            'getString(vectorQuery, "inputKind").empty()',
            'getString(vectorQuery, "projectionPolicyVersion").empty()',
            'getUint64(vectorQuery, "limit")',
            'vectorMetricFromString(\n                          getString(vectorQuery, "metric")',
            'getString(vectorQuery, "retrievalPointVariable").empty() &&',
            'getString(vectorQuery, "resourceVariable").empty()',
            'getFiniteDouble(vectorQuery, "threshold", threshold)',
            'vectorQuery.contains("threshold")',
            'storage.vectorQuery.provider',
            'storage.vectorQuery.model_version',
            'storage.vectorQuery.input_kind',
            'storage.vectorQuery.projection_policy_version',
            'request.vector_query = &storage.vectorQuery',
        ]:
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertIn("std::vector<double> vectorValues", source)
        self.assertIn("xpod_qlever_vector_query vectorQuery", source)
        self.assertIn("outValues.reserve(it->size())", source)
        self.assertIn("limit == 0", source)

    def test_load_document_is_request_scoped_and_reuses_qlever_load_support(self):
        source = self.read_source()
        adapter_header = ADAPTER_HEADER.read_text(encoding="utf-8")
        bridge = (ROOT / "qlever/qlever_adapter/src/XpodQleverBridge.cpp").read_text(
            encoding="utf-8"
        )
        self.assertIn("uint8_t has_load_document", adapter_header)
        self.assertIn("request.has_load_document = 1", source)
        self.assertIn("request.has_load_document != 0", bridge)
        self.assertIn("load_result.content = request.load_document_body", bridge)
        self.assertIn("backend.loadDocument(load_request, load_result)", bridge)

    def test_product_query_operations_are_query_only_and_updates_fail_in_adapter(self):
        source = self.read_source()
        adapter_header = ADAPTER_HEADER.read_text(encoding="utf-8")
        bridge = (ROOT / "qlever/qlever_adapter/src/XpodQleverBridge.cpp").read_text(
            encoding="utf-8"
        )
        for operation in ["queryBindings", "queryBoolean", "queryQuads"]:
            self.assertIn(f'operation != "{operation}"', source)
        self.assertNotIn('operation != "execute"', source)
        self.assertIn("XPOD_QLEVER_REQUEST_QUERY_ONLY", adapter_header)
        self.assertIn("looksLikeSparqlUpdate(query)", bridge)
        self.assertIn("request.operation == XPOD_QLEVER_REQUEST_QUERY_ONLY", bridge)
        self.assertIn('error_storage = "update_authority_required"', bridge)

    def test_base_path_sets_graph_prefix_and_query_source_prefix_boundary(self):
        source = self.read_source()
        base_path_block = re.search(
            r'if \(const std::string basePath = getString\(options, "basePath"\);'
            r'.*?(?=\n  if \(const std::string sourceUri = getString\(options, "sourceUri"\);)',
            source,
            re.S,
        )
        self.assertIsNotNone(base_path_block)
        self.assertIn(
            "request.operation != XPOD_QLEVER_REQUEST_PREPARE_UPDATE",
            base_path_block.group(0),
        )
        self.assertIn(
            "request.source_scope.source_uri_prefix",
            base_path_block.group(0),
        )
        self.assertIn("request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_PREFIX", base_path_block.group(0))
        self.assertIn("request.graph_scope.iri_prefix", base_path_block.group(0))
        self.assertNotIn("local_path_prefix", base_path_block.group(0))

    def test_runtime_resolves_explicit_source_acl_urls_to_physical_ids(self):
        source = self.read_source()
        self.assertIn("std::vector<xpod_rdf_source_node_key> allowedSources", source)
        self.assertIn("std::vector<xpod_rdf_source_node_key> deniedSources", source)
        self.assertIn("resolveSourceUrls", source)
        self.assertIn("resolveSourcePrefixes", source)
        self.assertIn("xpod_qlever_adapter_resolve_source_scope", source)
        self.assertIn("storage.accessScope.allowed_sources = storage.allowedSources.data()", source)
        self.assertIn("storage.accessScope.denied_sources = storage.deniedSources.data()", source)
        self.assertIn("return requireExisting ? XPOD_RDF_STATUS_PERMISSION_DENIED", source)
        allowed_graph_mapping = re.search(
            r"lookupIriTerms\(\s*adapter, allowedGraphUrls.*?storage\.allowedGraphs.*?\);",
            source,
            re.S,
        )
        self.assertIsNotNone(allowed_graph_mapping)
        source_mapping = re.search(
            r"resolveSourceUrls\(\s*adapter, allowedSourceUrls.*?storage\.allowedSources.*?true\);",
            source,
            re.S,
        )
        self.assertIsNotNone(source_mapping)
        self.assertNotRegex(
            source,
            r"resolveSourceUrls\(\s*adapter, allowedGraphUrls.*?storage\.allowedSources",
        )

    def test_principal_access_scope_without_resolved_boundaries_fails_closed(self):
        source = self.read_source()
        self.assertIn('getBool(access, "resolved")', source)
        self.assertNotIn('getBool(options, "accessScopeResolved")', source)
        self.assertIn('getString(access, "version")', source)
        self.assertNotIn('getString(access, "permissionVersion")', source)
        self.assertRegex(
            source,
            re.compile(
                r"const bool hasAccessIdentity =\s*"
                r"!principal\.empty\(\) \|\| !permissionVersion\.empty\(\);",
                re.S,
            ),
        )
        self.assertRegex(
            source,
            re.compile(
                r"if \(hasAccessIdentity && !hasAccessBoundary && !resolvedScope\) \{\s*"
                r"return XPOD_RDF_STATUS_PERMISSION_DENIED;",
                re.S,
            ),
        )

    def test_prepare_update_requires_explicit_source_uri(self):
        source = self.read_source()
        self.assertIn("request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE", source)
        self.assertIn("request.source_scope.source_uri.data == nullptr", source)
        self.assertIn("return XPOD_RDF_STATUS_UNSUPPORTED", source)

    def test_local_runtime_rejects_legacy_flat_request_options(self):
        source = self.read_source()
        allowed_function = re.search(
            r"bool isAllowedRequestOption\(std::string_view key\) \{(?P<body>.*?)\n\}",
            source,
            re.S,
        )
        self.assertIsNotNone(allowed_function)
        allowed_body = allowed_function.group("body")
        for current_key in [
            "basePath",
            "sourceUri",
            "operation",
            "timeoutMs",
            "acceptMediaType",
            "loadDocument",
            "accessScope",
            "vectorQuery",
        ]:
            self.assertIn(f'key == "{current_key}"', allowed_body)
        for legacy_key in [
            "sourceUriPrefix",
            "localPath",
            "localPathPrefix",
            "graphScope",
            "accessScopeResolved",
            "graphPrefix",
            "principal",
            "allowedGraphUrls",
            "deniedGraphUrls",
            "embedding",
            "provider",
            "model",
            "loadDocumentSourceUri",
            "loadDocumentBody",
        ]:
            self.assertNotIn(f'key == "{legacy_key}"', allowed_body)
        self.assertRegex(
            source,
            re.compile(
                r"if \(!containsOnlyAllowedOptions\(options, isAllowedRequestOption\)\) \{\s*"
                r"return XPOD_RDF_STATUS_UNSUPPORTED;",
                re.S,
            ),
        )

    def test_access_scope_defaults_to_mixed_authorization_model(self):
        source = self.read_source()
        self.assertIn('storage.accessScope.authorization_model = XPOD_RDF_AUTH_MIXED;', source)
        self.assertNotIn('getString(access, "authorizationModel")', source)
        self.assertNotIn('authorizationModelFromString', source)

    def test_nested_product_options_reject_legacy_or_unknown_fields(self):
        source = self.read_source()
        self.assertIn('containsOnlyAllowedOptions(vectorQuery, isAllowedVectorQueryOption)', source)
        self.assertIn('containsOnlyAllowedOptions(loadDocument, isAllowedLoadDocumentOption)', source)
        self.assertIn('containsOnlyAllowedOptions(access, isAllowedAccessScopeOption)', source)
        access_fields = re.search(
            r"bool isAllowedAccessScopeOption\(std::string_view key\) \{(?P<body>.*?)\n\}",
            source,
            re.S,
        )
        self.assertIsNotNone(access_fields)
        self.assertNotIn('authorizationModel', access_fields.group('body'))
        self.assertNotIn('permissionVersion', access_fields.group('body'))

    def test_access_scope_base_path_is_an_allowed_graph_prefix(self):
        source = self.read_source()
        self.assertIn('getString(access, "basePath")', source)
        self.assertIn('allowedGraphPrefixes.push_back(accessBasePath)', source)
        self.assertIn('allowedGraphPrefixes,', source)
        self.assertIn('storage.allowedPrefixValues,', source)
        self.assertIn('storage.allowedPrefixes', source)
        self.assertIn('!allowedGraphPrefixes.empty()', source)

    def test_adapter_exposes_backend_lookup_and_source_scope_wrappers_for_runtime_acl(self):
        header = ADAPTER_HEADER.read_text(encoding="utf-8")
        source = ADAPTER_SOURCE.read_text(encoding="utf-8")
        self.assertIn("xpod_qlever_adapter_lookup_terms", header)
        self.assertIn("xpod_qlever_adapter_resolve_source_scope", header)
        self.assertIn("const xpod_rdf_snapshot* snapshot", header)
        self.assertIn("xpod_qlever_adapter_lookup_terms", source)
        self.assertIn("adapter->backend.lookupTerm", source)
        self.assertIn("adapter->backend.resolveSourceScope", source)
        self.assertNotIn("dlopen", self.read_source())

    def test_runtime_uses_adapter_query_path_and_native_only_execution(self):
        source = self.read_source()
        self.assertIn("xpod_qlever_adapter_create", source)
        self.assertIn("xpod_qlever_adapter_query_request", source)
        self.assertIn("xpod_qlever_adapter_release_result", source)
        self.assertIn("xpod_qlever_adapter_destroy", source)
        self.assertIn("XPOD_QLEVER_EXECUTION_NATIVE_ONLY", source)
        self.assertNotIn("XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED", source)
        self.assertNotIn("backend->lookup_term", source)
        self.assertNotIn("backend->lookup_terms", source)
        self.assertNotRegex(source, re.compile(r"RDF3X|rdf3x|Comunica|Quint|fallback|TypeScript"))

    def test_runtime_emits_native_sparql_result_envelope(self):
        source = self.read_source()
        for token in [
            'return "ok"',
            'return "unsupported"',
            'return "error"',
            '"mediaType"',
            '"body"',
            '"profile"',
            '"queryStatus"',
            '"error"',
            "XPOD_RDF_STATUS_OK",
            "XPOD_RDF_STATUS_UNSUPPORTED",
        ]:
            self.assertIn(token, source)


if __name__ == "__main__":
    unittest.main()

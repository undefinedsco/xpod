import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
QLEVER = ROOT / "qlever"
RUNTIME_CMAKE = QLEVER / "qlever_local_runtime" / "CMakeLists.txt"
SQLITE_CMAKE = QLEVER / "rdf_sqlite_backend" / "CMakeLists.txt"
RUNTIME_HELPER = QLEVER / "cmake" / "XpodQleverRuntime.cmake"
DOCKERFILE = ROOT / "docker" / "qlever-local-runtime" / "Dockerfile"
VERIFIER = QLEVER / "scripts" / "verify-local-runtime-artifacts.py"
FOCUSED_BUILD = QLEVER / "scripts" / "run-focused-native-build.sh"
MACOS_BUILD = QLEVER / "scripts" / "build-macos-local-runtime.sh"

VERIFIER_SPEC = importlib.util.spec_from_file_location("qlever_runtime_verifier", VERIFIER)
assert VERIFIER_SPEC is not None and VERIFIER_SPEC.loader is not None
VERIFIER_MODULE = importlib.util.module_from_spec(VERIFIER_SPEC)
VERIFIER_SPEC.loader.exec_module(VERIFIER_MODULE)


class QleverLocalRuntimeBuildContractTest(unittest.TestCase):
    def test_shared_runtime_helper_derives_link_items_from_server_metadata(self):
        self.assertTrue(RUNTIME_HELPER.is_file(), RUNTIME_HELPER)
        helper = RUNTIME_HELPER.read_text(encoding="utf-8")

        self.assertIn("function(xpod_qlever_collect_runtime_link_items", helper)
        self.assertIn("CMakeFiles/qlever-server.dir/link.txt", helper)
        self.assertIn("separate_arguments", helper)
        self.assertIn(r"libserver\\.a$", helper)
        self.assertIn(r"libcompilationInfo\\.a$", helper)
        for suffix in [r"\\.a$", r"\\.so", r"\\.dylib$", r"\\.tbd$"]:
            with self.subTest(suffix=suffix):
                self.assertIn(suffix, helper)
        self.assertIn('MATCHES "^-l"', helper)
        self.assertIn('MATCHES "^-Wl,"', helper)
        self.assertIn('STREQUAL "-L"', helper)
        self.assertIn('MATCHES "^-L(.+)"', helper)
        self.assertIn('"-L${link_search_path}"', helper)
        self.assertIn("PARENT_SCOPE", helper)

    def test_local_build_reuses_the_runtime_link_helper(self):
        local = RUNTIME_CMAKE.read_text(encoding="utf-8")

        self.assertIn("XpodQleverRuntime.cmake", local)
        self.assertIn("xpod_qlever_collect_runtime_link_items", local)
        self.assertIn("${XPOD_QLEVER_RUNTIME_LINK_ITEMS}", local)

    def test_local_cmake_builds_only_xpod_targets_against_prior_qlever_tree(self):
        cmake = RUNTIME_CMAKE.read_text(encoding="utf-8")

        self.assertIn("XPOD_QLEVER_SOURCE_DIR", cmake)
        self.assertIn("XPOD_QLEVER_BUILD_DIR", cmake)
        self.assertIn("XPOD_QLEVER_ADAPTER_ENABLE_QLEVER ON", cmake)
        self.assertIn("../qlever_adapter", cmake)
        self.assertIn("../rdf_sqlite_backend", cmake)
        self.assertIn("find_package(Threads REQUIRED)", cmake)
        self.assertIn("${XPOD_QLEVER_SOURCE_DIR}/src", cmake)
        self.assertIn("${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS}", cmake)
        self.assertIn("${CMAKE_DL_LIBS}", cmake)
        self.assertIn("-Wall -Wextra -Werror", cmake)
        self.assertIn("target_link_libraries(xpod_qlever_adapter PRIVATE", cmake)
        self.assertIn("xpod_qlever_adapter", cmake)
        self.assertIn("xpod_rdf_sqlite_backend", cmake)
        self.assertIn("RUNTIME DESTINATION bin", cmake)
        self.assertNotIn("LIBRARY DESTINATION lib", cmake)
        self.assertNotIn("-Wl,--no-undefined", cmake)
        self.assertNotIn("INSTALL_RPATH", cmake)
        self.assertNotIn("FetchContent", cmake)
        self.assertNotIn("add_subdirectory(${XPOD_QLEVER_SOURCE_DIR}", cmake)

        adapter_cmake = (QLEVER / "qlever_adapter" / "CMakeLists.txt").read_text(encoding="utf-8")
        self.assertRegex(adapter_cmake, r"add_library\(xpod_qlever_adapter\s+STATIC")
        self.assertNotIn("XPOD_QLEVER_ADAPTER_BUILD_SHARED", adapter_cmake)
        self.assertNotIn("SHARED", adapter_cmake)

    def test_sqlite_backend_is_a_static_runtime_dependency_using_cmake_sqlite(self):
        self.assertTrue(SQLITE_CMAKE.is_file(), SQLITE_CMAKE)
        cmake = SQLITE_CMAKE.read_text(encoding="utf-8")

        self.assertIn("find_package(SQLite3 REQUIRED)", cmake)
        self.assertRegex(
            cmake,
            r"add_library\(xpod_rdf_sqlite_backend\s+STATIC",
        )
        self.assertIn("SQLite::SQLite3", cmake)
        self.assertIn("POSITION_INDEPENDENT_CODE ON", cmake)
        self.assertNotIn("-Wl,--no-undefined", cmake)
        self.assertIn("-Wall -Wextra -Werror", cmake)
        self.assertIn("XPOD_QLEVER_SOURCE_DIR", cmake)
        self.assertIn("XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS", cmake)
        self.assertNotIn("install(TARGETS xpod_rdf_sqlite_backend", cmake)

    def test_focused_image_reuses_sdk_and_never_rebuilds_upstream_qlever(self):
        self.assertTrue(DOCKERFILE.is_file(), DOCKERFILE)
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")

        self.assertIn("ARG XPOD_QLEVER_PRIOR_SDK_IMAGE", dockerfile)
        self.assertIn("must be an immutable digest reference", dockerfile)
        self.assertEqual(dockerfile.count("FROM ${XPOD_QLEVER_PRIOR_SDK_IMAGE}"), 1)
        for component in [
            "qlever/qlever_adapter",
            "qlever/qlever_local_runtime",
            "qlever/rdf_sqlite_backend",
            "qlever/rdf_protocol",
            "qlever/cmake",
            "qlever/patches",
        ]:
            with self.subTest(component=component):
                self.assertIn(f"COPY {component}", dockerfile)
        self.assertIn("/opt/qlever-sdk/source", dockerfile)
        self.assertIn("/opt/qlever-sdk/build", dockerfile)
        self.assertIn("COPY qlever/scripts /workspace/xpod/qlever/scripts", dockerfile)
        self.assertIn("XPOD_QLEVER_WORKSPACE_ROOT=/workspace/xpod", dockerfile)
        self.assertIn("XPOD_QLEVER_BUILD_OUTPUT_DIR=/opt/xpod", dockerfile)
        self.assertIn(
            "bash /workspace/xpod/qlever/scripts/run-focused-native-build.sh",
            dockerfile,
        )
        self.assertIn("XPOD_QLEVER_LOCAL_ARTIFACT_DIR=/opt/xpod/qlever", dockerfile)
        self.assertIn("XPOD_FOCUSED_BUILD_CACHE_PROBE", dockerfile)
        self.assertIn("AS runtime", dockerfile)
        self.assertIn("AS runtime-smoke", dockerfile)
        self.assertIn("/opt/xpod/qlever/bin/xpod_qlever_local_runtime", dockerfile)
        self.assertIn("test ! -e /opt/xpod/qlever/lib/libxpod_qlever_adapter.so", dockerfile)
        self.assertIn("test ! -e /opt/xpod/qlever/lib/libxpod_rdf_sqlite_backend.so", dockerfile)
        self.assertIn("/opt/xpod/qlever/manifest.json", dockerfile)
        self.assertNotIn("--provider", dockerfile)
        self.assertIn("debian:trixie-", dockerfile)
        self.assertNotIn("build-pg17.sh", dockerfile)
        self.assertNotIn("cmake --build", dockerfile)
        self.assertNotIn("subprocess.Popen", dockerfile)
        self.assertNotIn("RUN python3 -", dockerfile)
        self.assertNotIn("<<'PY'", dockerfile)

    def test_focused_build_fails_fast_on_stale_runtime_overlay_identity(self):
        self.assertTrue(FOCUSED_BUILD.is_file(), FOCUSED_BUILD)
        script = FOCUSED_BUILD.read_text(encoding="utf-8")

        self.assertIn(".xpod-overlay-identity", script)
        self.assertIn("runtime-overlay-manifest.py", script)
        self.assertIn("--qlever-root \"$workspace_root/qlever\"", script)
        self.assertIn("sha256sum", script)
        self.assertIn("prior SDK overlay identity mismatch", script)
        self.assertIn("rebuild the runtime SDK incrementally before focused local runtime build", script)
        self.assertLess(
            script.index("prior SDK overlay identity mismatch"),
            script.index("dependency_includes=$(python3 -c"),
        )

    def test_manifest_records_abi_qlever_identity_and_build_provenance(self):
        verifier = VERIFIER.read_text(encoding="utf-8")

        self.assertNotIn("ctypes", verifier)
        self.assertIn('ready_message["adapterAbiVersion"]', verifier)
        self.assertIn('ready_message["physicalBackendAbiVersion"]', verifier)
        self.assertIn('"adapterAbiVersion": adapter_abi', verifier)
        self.assertIn('"physicalBackendAbiVersion": physical_backend_abi', verifier)
        self.assertIn('"qlever"', verifier)
        self.assertIn('lock["commit"]', verifier)
        self.assertIn('lock["patchSeriesSha256"]', verifier)
        self.assertIn('"source": "focused-prior-runtime-sdk"', verifier)
        self.assertIn('"priorSdkImage": args.prior_sdk_image', verifier)
        self.assertIn('"entrypoint": "qlever/scripts/run-focused-native-build.sh"', verifier)
        self.assertIn('"source": "native-platform-build"', verifier)
        self.assertIn('"entrypoint": "qlever/scripts/build-macos-local-runtime.sh"', verifier)
        self.assertIn("runtime_artifacts(prefix, runtime_path)", verifier)
        self.assertIn('library_root.rglob("*")', verifier)
        self.assertNotIn("artifact(prefix, adapter_path)", verifier)
        self.assertNotIn("artifact(prefix, provider_path)", verifier)
        self.assertNotIn("ctypes.CDLL(str(provider_path))", verifier)
        self.assertIn("hashlib.file_digest", verifier)

    def test_macos_runtime_build_matches_upstream_native_pattern_and_bundles_dylibs(self):
        self.assertTrue(MACOS_BUILD.is_file(), MACOS_BUILD)
        script = MACOS_BUILD.read_text(encoding="utf-8")

        self.assertIn('[[ "$(uname -s)" == "Darwin" ]]', script)
        self.assertIn('[[ "$(uname -m)" == "arm64" ]]', script)
        self.assertNotIn("brew --prefix", script)
        self.assertIn('brew_bin=$(command -v brew)', script)
        self.assertIn('icu_prefix="$brew_prefix/opt/icu4c"', script)
        self.assertIn('sqlite_prefix="$brew_prefix/opt/sqlite"', script)
        self.assertIn("git clone --filter=blob:none --no-checkout", script)
        self.assertIn("apply-patches.py", script)
        self.assertIn("builder_macos_version=$(sw_vers -productVersion)", script)
        self.assertIn('deployment_target="${builder_macos_version%%.*}.0"', script)
        self.assertEqual(
            script.count('-DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment_target"'),
            2,
        )
        self.assertNotIn("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0", script)
        self.assertIn("-DUSE_PARALLEL=false", script)
        self.assertIn("-DCOMPILER_SUPPORTS_MARCH_NATIVE=FALSE", script)
        self.assertIn("cmake --build \"$qlever_build_dir\" --target qlever-server", script)
        self.assertIn(
            'server_link_command=$(ninja -C "$qlever_build_dir" -t commands qlever-server | tail -n 1)',
            script,
        )
        self.assertLess(
            script.index('server_link_command=$(ninja -C "$qlever_build_dir"'),
            script.index('cmake --build "$qlever_build_dir" --target qlever-server'),
        )
        self.assertIn(
            'CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o',
            script,
        )
        self.assertIn('[[ "$server_link_command" == *" -o qlever-server "* ]]', script)
        self.assertIn("printf '%s\\n' \"$server_link_command\" > \"$server_link_file\"", script)
        self.assertNotIn(
            'test -f "$qlever_build_dir/CMakeFiles/qlever-server.dir/link.txt"',
            script,
        )
        self.assertIn("dylibbundler -od -b", script)
        self.assertIn("codesign --force --sign -", script)
        self.assertIn("--build-source macos-arm64", script)
        self.assertIn("tar -czf \"$archive_path\"", script)

    def test_image_smoke_requires_owner_text_and_vector_schema_and_real_queries(self):
        verifier = VERIFIER.read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE rdf_text_metadata", verifier)
        self.assertIn("CREATE TABLE rdf_vector_metadata", verifier)
        self.assertIn("INSERT INTO rdf_index_metadata(key, value) VALUES ('schema_version', '1')", verifier)
        self.assertIn("created_at TEXT NOT NULL DEFAULT", verifier)
        self.assertIn("last_indexed_at TEXT", verifier)
        self.assertIn("source_version TEXT", verifier)
        self.assertIn("CREATE UNIQUE INDEX rdf_terms_identity_hash", verifier)
        self.assertIn("CREATE INDEX rdf_terms_kind_value_head", verifier)
        self.assertIn("CREATE INDEX rdf_quads_spog", verifier)
        self.assertIn("CREATE INDEX rdf_quads_gpos", verifier)
        self.assertIn("CREATE INDEX rdf_quads_source", verifier)
        self.assertIn("INSERT INTO rdf_text_metadata(key, value) VALUES ('schema_version', '3')", verifier)
        self.assertIn("INSERT INTO rdf_vector_metadata(key, value) VALUES ('schema_version', '2')", verifier)
        self.assertEqual(verifier.count("source_key TEXT NOT NULL UNIQUE"), 2)
        self.assertIn("'smoke-source-term'", verifier)
        self.assertNotIn("rdf_candidate_schema_version", verifier)
        self.assertIn('ql:contains-word "alpha"', verifier)
        self.assertIn('"vectorQuery"', verifier)
        self.assertIn('"retrievalPointVariable": "?retrieval"', verifier)
        self.assertIn('"type": "literal", "value": "alpha card"', verifier)
        self.assertIn('"type": "literal", "value": "chunk-1"', verifier)
        self.assertIn('"id": "gateway-credential-collection"', verifier)
        self.assertIn("https://undefineds.co/ns#Credential", verifier)
        self.assertIn("https://undefineds.co/ns#encryptedSecret", verifier)
        self.assertIn("expected_credential_rows", verifier)
        self.assertIn('"id": "escaped-json-literal-prepare-update"', verifier)
        self.assertIn("prepared_json_literal", verifier)
        self.assertIn("credentials.ttl#deepseek-prepared", verifier)

    def test_vector_smoke_decodes_the_real_runtime_result_envelope(self):
        body = {
            "head": {"vars": ["retrieval"]},
            "results": {
                "bindings": [
                    {"retrieval": {"type": "literal", "value": "chunk-1"}}
                ]
            },
        }
        response = json.dumps(
            {
                "id": "vector",
                "result": {
                    "body": json.dumps(body, separators=(",", ":")),
                    "mediaType": "application/sparql-results+json",
                    "queryStatus": 0,
                    "status": "ok",
                },
                "type": "result",
            },
            separators=(",", ":"),
        )

        self.assertEqual(
            VERIFIER_MODULE.sparql_bindings(response),
            [{"retrieval": {"type": "literal", "value": "chunk-1"}}],
        )


if __name__ == "__main__":
    unittest.main()

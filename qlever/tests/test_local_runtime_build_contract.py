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
        self.assertIn('"priorSdkImage": prior_sdk_image', verifier)
        self.assertIn('"entrypoint": "qlever/scripts/run-focused-native-build.sh"', verifier)
        self.assertIn("artifact(prefix, runtime_path)", verifier)
        self.assertNotIn("artifact(prefix, adapter_path)", verifier)
        self.assertNotIn("artifact(prefix, provider_path)", verifier)
        self.assertNotIn("ctypes.CDLL(str(provider_path))", verifier)
        self.assertIn("hashlib.file_digest", verifier)

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
        self.assertIn('"alpha card" not in fts', verifier)
        self.assertIn('"alpha card" not in vector', verifier)


if __name__ == "__main__":
    unittest.main()

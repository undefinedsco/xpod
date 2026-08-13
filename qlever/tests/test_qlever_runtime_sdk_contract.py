import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
QLEVER = ROOT / "qlever"
SDK_DOCKERFILE = ROOT / "docker/qlever-runtime-sdk/Dockerfile"
SDK_INCREMENTAL_DOCKERFILE = ROOT / "docker/qlever-runtime-sdk/Dockerfile.incremental"
BUILD_SCRIPT = QLEVER / "scripts/build-qlever-runtime-sdk.sh"
OVERLAY_MANIFEST = QLEVER / "scripts/runtime-overlay-manifest.py"
VALIDATE_PRIOR = QLEVER / "scripts/validate-prior-sdk.py"
WORKFLOW = ROOT / ".github/workflows/publish-qlever-runtime-sdk.yml"


class QleverRuntimeSdkContractTest(unittest.TestCase):
    def test_base_image_arg_is_visible_inside_the_build_stage(self):
        dockerfile = SDK_DOCKERFILE.read_text()
        self.assertRegex(
            dockerfile,
            r"FROM \$\{XPOD_QLEVER_SDK_BASE_IMAGE\}\s+\n\s*ARG XPOD_QLEVER_SDK_BASE_IMAGE",
        )

    def test_sdk_image_builds_public_qlever_runtime_without_pg_components(self):
        self.assertTrue(SDK_DOCKERFILE.is_file(), SDK_DOCKERFILE)
        dockerfile = SDK_DOCKERFILE.read_text(encoding="utf-8")

        self.assertRegex(
            dockerfile.splitlines()[0],
            r"^# syntax=docker/dockerfile:1\.7@sha256:[a-f0-9]{64}$",
        )
        self.assertRegex(
            dockerfile,
            r"ARG XPOD_QLEVER_SDK_BASE_IMAGE=debian:trixie-[0-9]{8}-slim@sha256:[a-f0-9]{64}",
        )
        self.assertIn("XPOD_QLEVER_SDK_BASE_IMAGE must be an immutable digest reference", dockerfile)
        for required in [
            "clang-19",
            "cmake",
            "git",
            "libboost-container-dev",
            "libboost-iostreams-dev",
            "libboost-program-options-dev",
            "libboost-url-dev",
            "libicu-dev",
            "libssl-dev",
            "libzstd-dev",
            "lld-19",
            "python3",
        ]:
            with self.subTest(required=required):
                self.assertIn(required, dockerfile)
        for public_component in [
            "qlever/qlever.lock.json",
            "qlever/patches",
            "qlever/cmake",
            "qlever/qlever_adapter",
            "qlever/include",
            "qlever/rdf_protocol",
        ]:
            with self.subTest(public_component=public_component):
                self.assertIn(f"COPY {public_component}", dockerfile)
        self.assertIn("bash /components/qlever/scripts/build-qlever-runtime-sdk.sh", dockerfile)
        self.assertIn("/opt/qlever-sdk/source/src/libqlever/Qlever.h", dockerfile)
        self.assertIn("/opt/qlever-sdk/build/.xpod-build-identity", dockerfile)
        self.assertIn("test -d /components/qlever/cmake", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("test -f /components/qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", dockerfile)
        self.assertIn("test ! -e /components/pg-rdf-extension", dockerfile)
        self.assertNotIn("postgresql-server-dev", dockerfile)
        self.assertNotIn("pg_config", dockerfile)
        self.assertNotIn("qlever_pg_extension", dockerfile.replace("test ! -e /components/qlever/qlever_pg_extension", ""))
        self.assertNotIn("pg-rdf-extension/xpod_rdf", dockerfile)

    def test_incremental_sdk_reuses_prior_digest_and_same_public_boundary(self):
        self.assertTrue(SDK_INCREMENTAL_DOCKERFILE.is_file(), SDK_INCREMENTAL_DOCKERFILE)
        dockerfile = SDK_INCREMENTAL_DOCKERFILE.read_text(encoding="utf-8")

        self.assertIn("ARG XPOD_QLEVER_PRIOR_SDK_IMAGE", dockerfile)
        self.assertIn("FROM ${XPOD_QLEVER_PRIOR_SDK_IMAGE}", dockerfile)
        self.assertIn("must be an immutable digest reference", dockerfile)
        self.assertIn("--bootstrap-missing-contract", dockerfile)
        self.assertIn("XPOD_QLEVER_INCREMENTAL_SDK=1", dockerfile)
        self.assertIn("bash /components/qlever/scripts/build-qlever-runtime-sdk.sh", dockerfile)
        self.assertIn("COPY qlever/cmake /components/qlever/cmake", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("test -d /components/qlever/cmake", dockerfile)
        self.assertIn("test -f /components/qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", dockerfile)
        self.assertIn("test ! -e /components/pg-rdf-extension", dockerfile)
        self.assertNotIn("postgresql-server-dev", dockerfile)
        self.assertNotIn("pg-rdf-extension/xpod_rdf", dockerfile)

    def test_build_script_has_no_pg_extension_phase(self):
        self.assertTrue(BUILD_SCRIPT.is_file(), BUILD_SCRIPT)
        script = BUILD_SCRIPT.read_text(encoding="utf-8")

        self.assertIn('"component": "qlever-runtime-sdk"', script)
        self.assertIn("build-qlever-runtime-sdk", str(BUILD_SCRIPT))
        self.assertIn("apply-patches.py", script)
        self.assertIn("sync-patched-source.py", script)
        self.assertIn("runtime-overlay-manifest.py", script)
        self.assertIn("cmake --build \"$build_dir\" --target server", script)
        self.assertIn("-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1", script)
        self.assertNotIn("pg_config", script)
        self.assertNotIn("postgresMajor", script)
        self.assertNotIn("qlever_pg_extension", script)
        self.assertNotIn("pg-rdf-extension", script)
        self.assertNotIn("xpod_qlever_pg_extension", script)

    def test_overlay_manifest_and_prior_validator_are_runtime_sdk_safe(self):
        self.assertTrue(OVERLAY_MANIFEST.is_file(), OVERLAY_MANIFEST)
        self.assertTrue(VALIDATE_PRIOR.is_file(), VALIDATE_PRIOR)
        overlay = OVERLAY_MANIFEST.read_text(encoding="utf-8")
        validator = VALIDATE_PRIOR.read_text(encoding="utf-8")

        self.assertIn('qlever_root / "qlever_adapter" / "src"', overlay)
        self.assertIn('qlever_root / "rdf_protocol" / "include"', overlay)
        self.assertIn('"component": "qlever-runtime-sdk"', validator)
        self.assertNotIn("postgresMajor", validator)
        self.assertNotIn("pgConfig", validator)
        self.assertNotIn("pg_config", validator)
        self.assertNotIn("maybe_tool_version", validator)

    def test_workflow_publishes_sdk_before_local_runtime_can_consume_digest(self):
        self.assertTrue(WORKFLOW.is_file(), WORKFLOW)
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("source_commit:", workflow)
        self.assertIn("source_commit must be a 40-character lowercase commit SHA", workflow)
        self.assertIn("ref: ${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("XPOD_SOURCE_COMMIT: ${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("org.opencontainers.image.revision=${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("runtime_sdk_tag:", workflow)
        self.assertIn("prior_runtime_sdk_digest:", workflow)
        self.assertIn("bash qlever/scripts/resolve-runtime-sdk-build.sh", workflow)
        self.assertIn("file: ${{ steps.resolve.outputs.dockerfile }}", workflow)
        self.assertIn("target: runtime", (ROOT / ".github/workflows/publish-qlever-local-runtime.yml").read_text(encoding="utf-8"))
        self.assertIn("docker push \"${tag}\"", workflow)
        self.assertIn("[[ \"${digest}\" =~ ^sha256:[a-f0-9]{64}$ ]]", workflow)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", workflow)
        self.assertIn("test -d /components/qlever/cmake", workflow)
        self.assertIn("test -f /components/qlever/scripts/check-qlever-real-runtime.cjs", workflow)
        self.assertIn("test ! -e /components/pg-rdf-extension", workflow)

        actions = [line for line in workflow.splitlines() if "uses:" in line]
        self.assertGreater(len(actions), 0)
        for line in actions:
            revision = line.split("@", 1)[1].split()[0]
            self.assertRegex(revision, r"^[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()

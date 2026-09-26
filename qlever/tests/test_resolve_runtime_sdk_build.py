import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RESOLVE = ROOT / "qlever/scripts/resolve-runtime-sdk-build.sh"


class ResolveRuntimeSdkBuildTest(unittest.TestCase):
    def run_resolve(
        self,
        *,
        tag="",
        prior="",
        github_sha="0123456789abcdef0123456789abcdef01234567",
        source_commit="",
        inputs_tag="",
        reuse_inputs="true",
        inputs_tag_exists=True,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            output = work / "github-output.txt"
            docker = work / "docker"
            docker.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "if [[ \"$1 $2\" != \"buildx imagetools\" || \"$3\" != \"inspect\" ]]; then exit 90; fi\n"
                "case \"$4\" in\n"
                "  ghcr.io/acme/xpod-qlever-sdk:sha-*) exit 0 ;;\n"
                "  ghcr.io/acme/xpod-qlever-sdk@sha256:*) exit 0 ;;\n"
                "  ghcr.io/acme/xpod-qlever-sdk:qlever-inputs-*)\n"
                f"    exit {0 if inputs_tag_exists else 91} ;;\n"
                "  *) exit 91 ;;\n"
                "esac\n"
            )
            docker.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "PATH": f"{work}:{env['PATH']}",
                "GITHUB_OUTPUT": str(output),
                "GITHUB_SHA": github_sha,
                "XPOD_SOURCE_COMMIT": source_commit,
                "SDK_IMAGE": "ghcr.io/acme/xpod-qlever-sdk",
                "REQUESTED_SDK_TAG": tag,
                "PRIOR_SDK_DIGEST": prior,
                "QELEVER_INPUTS_TAG": inputs_tag,
                "REUSE_IDENTICAL_INPUTS": reuse_inputs,
            })
            result = subprocess.run(
                ["bash", str(RESOLVE)],
                text=True,
                capture_output=True,
                env=env,
            )
            return result, output.read_text() if output.exists() else ""

    def test_reuses_existing_immutable_tag_without_building(self):
        result, output = self.run_resolve(tag="sha-0123456789abcdef0123456789abcdef01234567")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tag=sha-0123456789abcdef0123456789abcdef01234567", output)
        self.assertIn("build=false", output)
        self.assertIn("dockerfile=./docker/qlever-runtime-sdk/Dockerfile", output)
        self.assertIn("prior_image=", output)

    def test_uses_incremental_dockerfile_for_prior_digest(self):
        digest = "sha256:" + "a" * 64
        result, output = self.run_resolve(prior=digest)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tag=sha-0123456789abcdef0123456789abcdef01234567", output)
        self.assertIn("build=true", output)
        self.assertIn("dockerfile=./docker/qlever-runtime-sdk/Dockerfile.incremental", output)
        self.assertIn(f"prior_image=ghcr.io/acme/xpod-qlever-sdk@{digest}", output)

    def test_explicit_source_commit_controls_the_immutable_tag(self):
        source_commit = "fedcba9876543210fedcba9876543210fedcba98"
        result, output = self.run_resolve(source_commit=source_commit)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"tag=sha-{source_commit}", output)

    def test_invalid_inputs_fail_closed(self):
        result, _ = self.run_resolve(tag="latest")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime_sdk_tag must be an immutable sha-<40 hex> tag", result.stderr)

        result, _ = self.run_resolve(prior="sha256:not-hex")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("prior_runtime_sdk_digest must be an immutable sha256:<64 hex> digest", result.stderr)

        result, _ = self.run_resolve(source_commit="main")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("XPOD_SOURCE_COMMIT must be a 40 hex commit", result.stderr)

    def test_tag_and_prior_digest_are_mutually_exclusive(self):
        result, _ = self.run_resolve(
            tag="sha-0123456789abcdef0123456789abcdef01234567",
            prior="sha256:" + "b" * 64,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime_sdk_tag and prior_runtime_sdk_digest are mutually exclusive", result.stderr)


    def test_reuses_the_image_built_from_identical_qlever_inputs(self):
        result, output = self.run_resolve(inputs_tag="qlever-inputs-0123456789ab")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tag=qlever-inputs-0123456789ab", output)
        self.assertIn("build=false", output)
        self.assertIn("reused_inputs=true", output)

    def test_builds_when_no_image_carries_these_qlever_inputs(self):
        result, output = self.run_resolve(inputs_tag="qlever-inputs-0123456789ab", inputs_tag_exists=False)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tag=sha-0123456789abcdef0123456789abcdef01234567", output)
        self.assertIn("build=true", output)
        self.assertIn("reused_inputs=false", output)

    def test_an_explicit_tag_outranks_inputs_reuse(self):
        result, output = self.run_resolve(
            tag="sha-0123456789abcdef0123456789abcdef01234567",
            inputs_tag="qlever-inputs-0123456789ab",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=false", output)
        self.assertIn("reused_inputs=false", output)

    def test_inputs_reuse_can_be_turned_off_for_a_forced_rebuild(self):
        result, output = self.run_resolve(
            inputs_tag="qlever-inputs-0123456789ab",
            reuse_inputs="false",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=true", output)
        self.assertIn("tag=sha-0123456789abcdef0123456789abcdef01234567", output)

    def test_rejects_a_malformed_inputs_tag(self):
        result, _ = self.run_resolve(inputs_tag="qlever-inputs-nope")

        self.assertEqual(result.returncode, 64)
        self.assertIn("QELEVER_INPUTS_TAG", result.stderr)


if __name__ == "__main__":
    unittest.main()

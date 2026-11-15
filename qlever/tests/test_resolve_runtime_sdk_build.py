import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RESOLVE = ROOT / "qlever/scripts/resolve-runtime-sdk-build.sh"
SOURCE = "0123456789abcdef0123456789abcdef01234567"
INPUT_HASH = "a" * 64
INPUT_TAG = "qlever-inputs-" + INPUT_HASH
PROOF_IMAGE = "ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:" + "b" * 64


class ResolveRuntimeSdkBuildTest(unittest.TestCase):
    def run_resolve(
        self,
        *,
        tag="",
        prior="",
        github_sha=SOURCE,
        source_commit="",
        inputs_tag="",
        reuse_inputs="true",
        inputs_tag_exists=True,
        normal_selection=None,
        profile="",
        runtime_dockerfile="",
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
                "  ghcr.io/undefinedsco/xpod-qlever-sdk:sha-*)\n"
                "    printf '%s' '\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"'\n"
                "    exit 0 ;;\n"
                "  ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:*) exit 0 ;;\n"
                "  ghcr.io/undefinedsco/xpod-qlever-sdk:qlever-inputs-*)\n"
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
                "SDK_IMAGE": "ghcr.io/undefinedsco/xpod-qlever-sdk",
                "REQUESTED_SDK_TAG": tag,
                "PRIOR_SDK_DIGEST": prior,
                "QELEVER_INPUTS_TAG": inputs_tag,
                "REUSE_IDENTICAL_INPUTS": reuse_inputs,
                "QELEVER_NORMAL_SELECTION": "",
                "SDK_PROFILE": profile,
            })
            if runtime_dockerfile:
                env["RUNTIME_DOCKERFILE"] = runtime_dockerfile
            if normal_selection is not None:
                selection = work / "normal-selection.json"
                selection.write_text(json.dumps(normal_selection))
                env["QELEVER_NORMAL_SELECTION"] = str(selection)
            result = subprocess.run(
                ["bash", str(RESOLVE)],
                text=True,
                capture_output=True,
                env=env,
            )
            return result, output.read_text() if output.exists() else ""

    def selection(self, **overrides):
        value = {
            "schemaVersion": 1,
            "kind": "qlever-sdk-normal-selection",
            "model": "normal-build-v1",
            "verified": True,
            "inputHash": INPUT_HASH,
            "sdk": {"sourceSha": "c" * 40},
            "image": {"referenceByDigest": PROOF_IMAGE},
            "artifact": {"id": 7, "digest": "d" * 64, "master": {"path": "materials.json", "bytes": 10, "sha256": "e" * 64}},
        }
        value.update(overrides)
        return value

    def test_reuses_existing_immutable_tag_without_building(self):
        result, output = self.run_resolve(tag="sha-" + SOURCE)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"tag=sha-{SOURCE}", output)
        self.assertIn("build=false", output)
        self.assertIn("dockerfile=./docker/qlever-runtime-sdk/Dockerfile", output)
        self.assertIn("prior_image=", output)

    def test_uses_incremental_dockerfile_for_prior_digest(self):
        digest = "sha256:" + "a" * 64
        result, output = self.run_resolve(prior=digest)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"tag=sha-{SOURCE}", output)
        self.assertIn("build=true", output)
        self.assertIn("dockerfile=./docker/qlever-runtime-sdk/Dockerfile.incremental", output)
        self.assertIn(f"prior_image=ghcr.io/undefinedsco/xpod-qlever-sdk@{digest}", output)

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
            tag="sha-" + SOURCE,
            prior="sha256:" + "b" * 64,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime_sdk_tag and prior_runtime_sdk_digest are mutually exclusive", result.stderr)

    def test_reuses_a_shared_verified_normal_selection(self):
        result, output = self.run_resolve(inputs_tag=INPUT_TAG, normal_selection=self.selection())

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=false", output)
        self.assertIn("reused_inputs=true", output)
        self.assertIn(f"image_ref={PROOF_IMAGE}", output)
        self.assertIn("tag=sha-" + "c" * 40, output)

    def test_a_bare_inputs_alias_never_authorizes_reuse(self):
        result, output = self.run_resolve(inputs_tag=INPUT_TAG)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tag=sha-" + SOURCE, output)
        self.assertIn("build=true", output)
        self.assertIn("reused_inputs=false", output)
        self.assertIn("image_ref=\n", output)

    def test_forged_selection_input_hash_is_rejected(self):
        result, _ = self.run_resolve(inputs_tag=INPUT_TAG, normal_selection=self.selection(inputHash="d" * 64))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("shared normal SDK selection input hash differs", result.stderr)

    def test_unauthenticated_or_incomplete_selection_is_rejected(self):
        for forged in [self.selection(verified=False), self.selection(kind="qlever-sdk-normal-build-proof-index"),
                       self.selection(image={"referenceByDigest": "ghcr.io/undefinedsco/xpod-qlever-sdk:latest"})]:
            result, _ = self.run_resolve(inputs_tag=INPUT_TAG, normal_selection=forged)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("shared normal SDK selection", result.stderr)

    def test_service_explicit_tag_requires_matching_verified_selection(self):
        tag = "sha-" + "c" * 40
        result, output = self.run_resolve(tag=tag, inputs_tag=INPUT_TAG, profile="service-trixie",
                                          normal_selection=self.selection())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=false", output)
        self.assertIn(f"image_ref={PROOF_IMAGE}", output)
        self.assertIn("reused_inputs=true", output)
        missing, _ = self.run_resolve(tag=tag, inputs_tag=INPUT_TAG, profile="service-trixie")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("requires a matching verified normal SDK selection artifact", missing.stderr)
        wrong_source, _ = self.run_resolve(tag="sha-" + "d" * 40, inputs_tag=INPUT_TAG, profile="service-trixie",
                                           normal_selection=self.selection())
        self.assertNotEqual(wrong_source.returncode, 0)
        self.assertIn("source differs from the requested immutable tag", wrong_source.stderr)
        wrong_image, _ = self.run_resolve(tag=tag, inputs_tag=INPUT_TAG, profile="service-trixie",
                                          normal_selection=self.selection(image={"referenceByDigest": "ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:" + "d" * 64}))
        self.assertNotEqual(wrong_image.returncode, 0)
        self.assertIn("digest differs from the verified normal SDK selection", wrong_image.stderr)

    def test_incremental_recipe_is_a_real_file(self):
        result, output = self.run_resolve(prior="sha256:" + "a" * 64, profile="service-trixie",
                                          runtime_dockerfile="docker/qlever-runtime-sdk/Dockerfile.normal")
        self.assertEqual(result.returncode, 0, result.stderr)
        resolved = [line.split("=", 1)[1] for line in output.splitlines() if line.startswith("dockerfile=")][0]
        self.assertEqual(resolved, "docker/qlever-runtime-sdk/Dockerfile.normal.incremental")
        self.assertTrue((ROOT / resolved).is_file(), resolved)

    def test_an_explicit_tag_outranks_inputs_reuse(self):
        result, output = self.run_resolve(
            tag="sha-" + SOURCE,
            inputs_tag=INPUT_TAG,
            normal_selection=self.selection(),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=false", output)
        self.assertIn("reused_inputs=false", output)

    def test_inputs_reuse_can_be_turned_off_for_a_forced_rebuild(self):
        result, output = self.run_resolve(
            inputs_tag=INPUT_TAG,
            normal_selection=self.selection(),
            reuse_inputs="false",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build=true", output)
        self.assertIn(f"tag=sha-{SOURCE}", output)

    def test_rejects_a_malformed_inputs_tag(self):
        result, _ = self.run_resolve(inputs_tag="qlever-inputs-nope")

        self.assertEqual(result.returncode, 64)
        self.assertIn("QELEVER_INPUTS_TAG", result.stderr)


if __name__ == "__main__":
    unittest.main()

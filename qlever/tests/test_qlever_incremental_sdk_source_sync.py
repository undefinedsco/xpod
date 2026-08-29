import os
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SYNC = ROOT / "qlever/scripts/sync-patched-source.py"
VALIDATE = ROOT / "qlever/scripts/validate-prior-sdk.py"


class QleverIncrementalSdkSourceSyncTest(unittest.TestCase):
    def run_sync(self, patched: Path, target: Path, work: Path, *, marker=True):
        manifest = work / "manifest.txt"
        command = [
                "python3",
                str(SYNC),
                "--patched-source",
                str(patched),
                "--target-source",
                str(target),
                "--manifest-out",
                str(manifest),
        ]
        if marker:
            command.extend([
                "--prior-validation-marker",
                str(work / "prior-marker.json"),
            ])
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
        )

    def write_marker(self, work: Path, target: Path):
        result = subprocess.run(
            [
                "python3",
                str(SYNC),
                "--patched-source",
                str(target),
                "--target-source",
                str(target),
                "--manifest-out",
                str(work / "prior-manifest.txt"),
            ],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        (work / "prior-marker.json").write_text(json.dumps({
            "schemaVersion": 1,
            "sourceManifest": (work / "prior-manifest.txt").read_text(),
        }))

    def test_identical_patched_tree_preserves_all_source_mtimes(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            (patched / "src").mkdir(parents=True)
            (target / "src").mkdir(parents=True)
            (patched / "src/a.cpp").write_text("same\n")
            (patched / "src/b.cpp").write_text("same\n")
            (target / "src/a.cpp").write_text("same\n")
            (target / "src/b.cpp").write_text("same\n")
            self.write_marker(work, target)
            old = 1_700_000_000
            os.utime(target / "src/a.cpp", (old, old))
            os.utime(target / "src/b.cpp", (old + 1, old + 1))

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((old, old + 1), (
                int((target / "src/a.cpp").stat().st_mtime),
                int((target / "src/b.cpp").stat().st_mtime),
            ))
            self.assertIn("src/a.cpp", (work / "manifest.txt").read_text())

    def test_one_changed_file_only_replaces_that_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "changed.hpp").write_text("new\n")
            (patched / "stable.hpp").write_text("same\n")
            (target / "changed.hpp").write_text("old\n")
            (target / "stable.hpp").write_text("same\n")
            self.write_marker(work, target)
            old_changed = 1_700_000_000
            old_stable = old_changed + 10
            os.utime(target / "changed.hpp", (old_changed, old_changed))
            os.utime(target / "stable.hpp", (old_stable, old_stable))
            time.sleep(0.01)

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / "changed.hpp").read_text(), "new\n")
            self.assertGreater((target / "changed.hpp").stat().st_mtime, old_changed)
            self.assertEqual(int((target / "stable.hpp").stat().st_mtime), old_stable)

    def test_deletion_propagates_to_target_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "kept.cpp").write_text("kept\n")
            (target / "kept.cpp").write_text("kept\n")
            (target / "deleted.cpp").write_text("gone\n")
            self.write_marker(work, target)

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((target / "kept.cpp").exists())
            self.assertFalse((target / "deleted.cpp").exists())

    def test_patch_identity_upgrade_is_allowed_when_prior_marker_matches_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "file.cpp").write_text("new patch series\n")
            (target / "file.cpp").write_text("old patch series\n")
            self.write_marker(work, target)

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / "file.cpp").read_text(), "new patch series\n")

    def test_prior_source_tamper_fails_before_syncing_any_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "file.cpp").write_text("new\n")
            (target / "file.cpp").write_text("old\n")
            self.write_marker(work, target)
            (target / "file.cpp").write_text("tampered\n")

            result = self.run_sync(patched, target, work)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK source manifest mismatch", result.stderr)
            self.assertEqual((target / "file.cpp").read_text(), "tampered\n")

    def test_mode_only_change_replaces_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "tool.sh").write_text("#!/bin/sh\n")
            (target / "tool.sh").write_text("#!/bin/sh\n")
            os.chmod(patched / "tool.sh", 0o755)
            os.chmod(target / "tool.sh", 0o644)
            self.write_marker(work, target)

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / "tool.sh").stat().st_mode & 0o777, 0o755)

    def test_missing_or_invalid_marker_fails_before_syncing_any_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (patched / "file.cpp").write_text("new\n")
            (target / "file.cpp").write_text("old\n")

            result = self.run_sync(patched, target, work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior validation marker missing", result.stderr)
            self.assertEqual((target / "file.cpp").read_text(), "old\n")

            (work / "prior-marker.json").write_text("{")
            result = self.run_sync(patched, target, work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior validation marker is invalid", result.stderr)
            self.assertEqual((target / "file.cpp").read_text(), "old\n")

    def test_symlink_sources_are_rejected_before_syncing_any_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            patched.mkdir()
            target.mkdir()
            (target / "file.cpp").write_text("old\n")
            self.write_marker(work, target)
            os.symlink("/etc/passwd", patched / "file.cpp")

            result = self.run_sync(patched, target, work)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlinks are not supported", result.stderr)
            self.assertEqual((target / "file.cpp").read_text(), "old\n")

    def test_file_directory_type_conflicts_are_safely_replaced_inside_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            patched = work / "patched"
            target = work / "target"
            (patched / "dir").mkdir(parents=True)
            (patched / "dir" / "leaf.cpp").write_text("leaf\n")
            (patched / "was_dir").write_text("now file\n")
            target.mkdir()
            (target / "dir").write_text("old file\n")
            (target / "was_dir").mkdir(parents=True)
            (target / "was_dir" / "old.cpp").write_text("old\n")
            self.write_marker(work, target)

            result = self.run_sync(patched, target, work)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / "dir" / "leaf.cpp").read_text(), "leaf\n")
            self.assertEqual((target / "was_dir").read_text(), "now file\n")
            self.assertFalse((target / "was_dir" / "old.cpp").exists())


class QleverPriorSdkValidationTest(unittest.TestCase):
    def run_validator(self, qlever_root: Path, source: Path, build: Path, marker: Path, *, bootstrap=False):
        tool_bin = qlever_root.parents[1] / "bin"
        tool_bin.mkdir(exist_ok=True)
        for name, output in {
            "clang-19": "clang version 19.1.0\n",
            "clang++-19": "clang version 19.1.0\n",
            "cmake": "cmake version 3.30.0\n",
        }.items():
            tool = tool_bin / name
            tool.write_text(f"#!/usr/bin/env bash\nprintf '%b' {json.dumps(output)}\n")
            tool.chmod(0o755)
        os_release = qlever_root.parents[1] / "os-release"
        os_release.write_text('PRETTY_NAME="Fixture OS"\n')
        env = os.environ.copy()
        env["PATH"] = f"{tool_bin}:{env['PATH']}"
        env["XPOD_QLEVER_OS_RELEASE_FILE"] = str(os_release)
        command = [
                "python3",
                str(VALIDATE),
                "--qlever-root",
                str(qlever_root),
                "--source",
                str(source),
                "--build-dir",
                str(build),
                "--marker-out",
                str(marker),
        ]
        if bootstrap:
            command.append("--bootstrap-missing-contract")
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            env=env,
        )

    def seed_prior_sdk(self, work: Path):
        upstream = work / "upstream"
        subprocess.run(["git", "init", str(upstream)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(upstream), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(upstream), "config", "user.name", "Test"], check=True)
        (upstream / "file.cpp").write_text("old\n")
        subprocess.run(["git", "-C", str(upstream), "add", "file.cpp"], check=True)
        subprocess.run(["git", "-C", str(upstream), "commit", "-m", "seed"], check=True, stdout=subprocess.DEVNULL)
        commit = subprocess.check_output(
            ["git", "-C", str(upstream), "rev-parse", "HEAD"],
            text=True,
        ).strip()

        qlever_root = work / "components" / "qlever"
        (qlever_root / "scripts").mkdir(parents=True)
        (qlever_root / "patches").mkdir()
        for name in ["apply-patches.py", "verify-lock.py"]:
            (qlever_root / "scripts" / name).write_text((ROOT / "qlever/scripts" / name).read_text())
        (qlever_root / "patches" / "series").write_text("")
        digest = subprocess.check_output(
            ["python3", "-c", "import hashlib, pathlib; print(hashlib.sha256(pathlib.Path('series').read_bytes()).hexdigest())"],
            cwd=qlever_root / "patches",
            text=True,
        ).strip()
        (qlever_root / "qlever.lock.json").write_text(json.dumps({
            "repository": str(upstream),
            "commit": commit,
            "patchSeriesSha256": digest,
        }))

        source = work / "sdk" / "source"
        build = work / "sdk" / "build"
        subprocess.run(["git", "clone", str(upstream), str(source)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", commit], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(source), "remote", "set-url", "origin", "/nonexistent/offline-prior-remote"], check=True)
        build.mkdir(parents=True)
        (build / ".xpod-build-identity").write_text(f"{commit}:{digest}")
        (build / "CMakeCache.txt").write_text(
            f"CMAKE_HOME_DIRECTORY:INTERNAL={source}\n"
            "CMAKE_BUILD_TYPE:STRING=Release\n"
            "CMAKE_POSITION_INDEPENDENT_CODE:BOOL=ON\n"
            "CHEAPER_COMPILATION:BOOL=ON\n"
            "RANGES_NATIVE:BOOL=OFF\n"
            "USE_PRECOMPILED_HEADERS:BOOL=OFF\n"
            "USE_IO_URING:BOOL=OFF\n"
            "CMAKE_CXX_COMPILER:FILEPATH=/usr/bin/clang++-19\n"
        )
        (build / "compile_commands.json").write_text(json.dumps([{
            "directory": str(build),
            "file": str(source / "file.cpp"),
            "command": "clang++-19 -fPIC -DCHEAPER_COMPILATION=1 -DRANGES_NATIVE=OFF -c file.cpp",
        }]))
        contract = {
            "schemaVersion": 1,
            "component": "qlever-runtime-sdk",
            "base": {
                "osReleasePrettyName": "Fixture OS",
            },
            "toolchain": {
                "clang": "clang version 19.1.0",
                "clangxx": "clang version 19.1.0",
                "cmake": "cmake version 3.30.0",
            },
            "cmake": {
                "source": str(source),
                "build": str(build),
                "buildType": "Release",
                "positionIndependentCode": "ON",
                "flags": {
                    "CHEAPER_COMPILATION": "ON",
                    "RANGES_NATIVE": "OFF",
                    "USE_PRECOMPILED_HEADERS": "OFF",
                    "USE_IO_URING": "OFF",
                },
            },
        }
        contract_text = json.dumps(contract, sort_keys=True, indent=2) + "\n"
        (build / ".xpod-build-contract.json").write_text(contract_text)
        import hashlib
        contract_identity = hashlib.sha256(
            json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        (build / ".xpod-toolchain-identity").write_text(contract_identity)
        return qlever_root, source, build

    def test_prior_validator_writes_marker_for_internally_valid_prior_sdk(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            marker = work / "marker.json"

            result = self.run_validator(qlever_root, source, build, marker)

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(marker.read_text())
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertIn("file.cpp", payload["sourceManifest"])
            self.assertIn("priorIdentity", payload)
            self.assertIn("toolchain", payload)
            self.assertIn("buildContractIdentity", payload)
            self.assertEqual(payload["buildContract"]["base"]["osReleasePrettyName"], "Fixture OS")

    def test_prior_validator_accepts_generated_and_dependency_translation_units_inside_build_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            generated = build / "CompilationInfo.cpp"
            dependency = build / "_deps" / "abseil-src" / "absl" / "base" / "log_severity.cc"
            generated.write_text("// generated\n")
            dependency.parent.mkdir(parents=True)
            dependency.write_text("// dependency\n")
            commands = json.loads((build / "compile_commands.json").read_text())
            commands.extend([
                {
                    "directory": str(build),
                    "file": str(generated),
                    "command": f"clang++-19 -fPIC -c {generated}",
                },
                {
                    "directory": str(build),
                    "file": str(dependency.relative_to(build)),
                    "command": f"clang++-19 -fPIC -c {dependency}",
                },
            ])
            (build / "compile_commands.json").write_text(json.dumps(commands))

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_prior_validator_accepts_clang_19_c_and_non_pic_executable_translation_units(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            c_source = build / "_deps" / "uriparser-src" / "UriCommon.c"
            executable = source / "file.cpp"
            c_source.parent.mkdir(parents=True)
            c_source.write_text("/* dependency */\n")
            (build / "compile_commands.json").write_text(json.dumps([
                {
                    "directory": str(build),
                    "file": str(c_source),
                    "command": f"clang-19 -fPIC -c {c_source}",
                },
                {
                    "directory": str(build),
                    "file": str(executable),
                    "command": f"clang++-19 -c {executable}",
                },
            ]))

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_prior_validator_rejects_translation_units_compiled_by_other_toolchains(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (build / "compile_commands.json").write_text(json.dumps([{
                "directory": str(build),
                "file": str(source / "file.cpp"),
                "command": "g++ -fPIC -c file.cpp",
            }]))

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK compile_commands incompatible: compiler", result.stderr)
            self.assertFalse((work / "marker.json").exists())

    def test_prior_validator_rejects_translation_units_outside_sdk_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            outside = work / "outside.cpp"
            outside.write_text("// outside\n")
            (build / "compile_commands.json").write_text(json.dumps([{
                "directory": str(build),
                "file": str(outside),
                "command": f"clang++-19 -fPIC -c {outside}",
            }]))

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK compile_commands incompatible: source path", result.stderr)
            self.assertFalse((work / "marker.json").exists())

    def test_prior_validator_replays_from_local_prior_git_objects_without_remote(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("Could not resolve host", result.stderr)

    def test_prior_validator_rejects_tampered_source_before_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (source / "file.cpp").write_text("tampered\n")

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK source manifest mismatch", result.stderr)
            self.assertFalse((work / "marker.json").exists())

    def test_prior_validator_rejects_incompatible_cmake_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (build / "CMakeCache.txt").write_text("CMAKE_BUILD_TYPE:STRING=Debug\n")

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK CMake cache incompatible", result.stderr)

    def test_prior_validator_rejects_missing_build_contract_without_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (build / ".xpod-build-contract.json").unlink()

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK build contract missing", result.stderr)

    def test_prior_validator_can_bootstrap_missing_contract_from_actual_image_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (build / ".xpod-build-contract.json").unlink()

            result = self.run_validator(qlever_root, source, build, work / "marker.json", bootstrap=True)

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads((work / "marker.json").read_text())
            self.assertEqual(payload["buildContract"]["component"], "qlever-runtime-sdk")

    def test_prior_validator_rejects_non_runtime_sdk_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            contract = json.loads((build / ".xpod-build-contract.json").read_text())
            contract["component"] = "postgres17-qlever-runtime-sdk"
            (build / ".xpod-build-contract.json").write_text(json.dumps(contract))

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK build contract incompatible: component", result.stderr)

    def test_prior_validator_rejects_toolchain_contract_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            qlever_root, source, build = self.seed_prior_sdk(work)
            (build / ".xpod-toolchain-identity").write_text("tampered")

            result = self.run_validator(qlever_root, source, build, work / "marker.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prior SDK toolchain identity mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()

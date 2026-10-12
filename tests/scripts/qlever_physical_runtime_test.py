import importlib.util
import json
import pathlib
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("physical_runtime", ROOT / "qlever/scripts/prepare-linux-physical-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class PhysicalRuntimeTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / ".test-data/qlever-physical-runtime-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.root = pathlib.Path(tempfile.mkdtemp(dir=parent))
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "bin").mkdir()
        self.binary = self.source / "bin/xpod_qlever_local_runtime"
        data = bytearray(64)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 62)
        self.binary.write_bytes(data)
        self.lock = json.loads((ROOT / "qlever/qlever.lock.json").read_text())
        self.manifest = {"schemaVersion": 1, "adapterAbiVersion": 7, "physicalBackendAbiVersion": 7,
                         "qlever": self.lock, "artifacts": [{"path": "bin/xpod_qlever_local_runtime",
                         "size": 64, "sha256": runtime.digest(self.binary)}]}
        self.save_manifest()

    def save_manifest(self):
        file = self.source / "manifest.json"
        file.write_text(json.dumps(self.manifest))
        self.manifest_sha = runtime.digest(file)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_architecture_is_actual_elf_machine(self):
        runtime.verify_elf(self.binary, "linux-x64")
        with self.assertRaisesRegex(ValueError, "target mismatch"):
            runtime.verify_elf(self.binary, "linux-arm64")
        self.binary.write_bytes(b"not-an-elf")
        with self.assertRaisesRegex(ValueError, "target mismatch"):
            runtime.verify_elf(self.binary, "linux-x64")

    def test_ldd_requires_complete_safe_dependency_paths(self):
        self.assertEqual(runtime.parse_ldd("libz.so.1 => /lib/libz.so.1 (0x123)\n/lib64/ld-linux-x86-64.so.2 (0x456)"),
                         {"libz.so.1": "/lib/libz.so.1", "ld-linux-x86-64.so.2": "/lib64/ld-linux-x86-64.so.2"})
        for text in ["", "libz.so.1 => not found", "libz.so.1 => /lib/../private (0x123)", ".. => /lib/a (0x123)",
                     "libz.so.1 => /lib/a (0x123)\nlibz.so.1 => /lib/b (0x456)"]:
            with self.assertRaises(ValueError):
                runtime.parse_ldd(text)

    def test_original_bytes_and_manifest_authority_are_verified(self):
        runtime.verify_original(self.source, self.manifest_sha, self.lock)
        self.binary.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "byte binding"):
            runtime.verify_original(self.source, self.manifest_sha, self.lock)
        with self.assertRaisesRegex(ValueError, "manifest binding"):
            runtime.verify_original(self.source, "0" * 64, self.lock)

    def test_manifest_rejects_path_escape(self):
        self.manifest["artifacts"][0]["path"] = "bin/../private"
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "unsafe original"):
            runtime.verify_original(self.source, self.manifest_sha, self.lock)

    def test_repeated_execution_and_overlapping_paths_do_not_run_tools(self):
        output = self.root / "output"
        output.mkdir()
        with patch.object(runtime.platform, "system", return_value="Linux"), patch.object(runtime.platform, "machine", return_value="x86_64"), patch.object(runtime.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "fresh output"):
                runtime.prepare(self.source, output, self.root / "evidence", ROOT, "linux-x64", self.manifest_sha)
            with self.assertRaisesRegex(ValueError, "disjoint"):
                runtime.prepare(self.source, self.source / "out", self.root / "evidence", ROOT, "linux-x64", self.manifest_sha)
            with self.assertRaisesRegex(ValueError, "disjoint"):
                runtime.prepare(self.source, self.root / "new", self.source / "evidence", ROOT, "linux-x64", self.manifest_sha)
            command.assert_not_called()

    def controlled_library_preparation(self, escape=False, receipt_failure=False):
        # A dlopen adapter is deliberately absent from the main bin's ldd.
        library = self.source / "lib/libadapter.so"
        library.parent.mkdir()
        library.write_bytes(self.binary.read_bytes())
        dependency = self.root / "libextra.so.1"
        dependency.write_bytes(self.binary.read_bytes())
        libc = self.root / "libc.so.6"
        libc.write_bytes(self.binary.read_bytes())
        self.manifest["artifacts"].append({"path": "lib/libadapter.so", "size": 64, "sha256": runtime.digest(library)})
        self.save_manifest()
        original_hashes = {str(p): runtime.digest(p) for p in [self.binary, library, dependency, self.source / "manifest.json"]}
        output, evidence = self.root / "output", self.root / "evidence"
        tools = {}
        for name in ["ldd", "patchelf", "python3"]:
            tool = self.root / ("tool-" + name)
            tool.write_bytes(b"controlled-tool-fixture")
            tools[name] = str(tool)
        commands = []

        def command(args, **_kwargs):
            commands.append(args)
            name = pathlib.Path(args[0]).name
            text = ""
            if name == "tool-ldd":
                if receipt_failure:
                    (evidence / "physical-runtime.receipt.safe.json").mkdir()
                    return subprocess.CompletedProcess(args, 1, b"", b"controlled native tool failure")
                if args[1] == "--version":
                    text = "controlled glibc fixture\n"
                else:
                    file = pathlib.Path(args[1])
                    if file.name == "libadapter.so":
                        resolved = dependency if file == library or escape else output / "lib/libextra.so.1"
                        text = f"libextra.so.1 => {resolved} (0x123)\n"
                    else:
                        text = f"libc.so.6 => {libc} (0x123)\n"
            elif name == "tool-patchelf":
                file = pathlib.Path(args[-1])
                file.write_bytes(file.read_bytes() + b"controlled-rpath-change")
            else:
                # Fixture manifest only: no ABI/native execution claim.
                (output / "manifest.json").write_text(json.dumps({"fixture": True}))
            return subprocess.CompletedProcess(args, 0, text.encode(), b"")

        with patch.object(runtime.platform, "system", return_value="Linux"), patch.object(runtime.platform, "machine", return_value="x86_64"), patch.object(runtime.shutil, "which", side_effect=lambda name: tools[name]), patch.object(runtime.subprocess, "run", side_effect=command):
            if receipt_failure:
                with self.assertRaises(runtime.PreparationReceiptError) as caught:
                    runtime.prepare(self.source, output, evidence, ROOT, "linux-x64", self.manifest_sha)
                self.assertIsInstance(caught.exception.errors[0], RuntimeError)
                self.assertIsInstance(caught.exception.errors[1], IsADirectoryError)
            elif escape:
                with self.assertRaisesRegex(ValueError, "unbundled"):
                    runtime.prepare(self.source, output, evidence, ROOT, "linux-x64", self.manifest_sha)
            else:
                runtime.prepare(self.source, output, evidence, ROOT, "linux-x64", self.manifest_sha)
        for name, sha in original_hashes.items():
            self.assertEqual(runtime.digest(pathlib.Path(name)), sha)
        return output, evidence, commands, library

    def test_manifest_dlopen_library_and_its_dependency_survive_physical_export(self):
        output, evidence, commands, library = self.controlled_library_preparation()
        self.assertTrue((output / "lib/libadapter.so").is_file())
        self.assertTrue((output / "lib/libextra.so.1").is_file())
        self.assertIn(str(library), [args[1] for args in commands if pathlib.Path(args[0]).name == "tool-ldd"])
        self.assertNotEqual(runtime.digest(output / "lib/libadapter.so"), runtime.digest(library))
        receipt = json.loads((evidence / "physical-runtime.receipt.safe.json").read_text())
        self.assertTrue(receipt["ok"])
        self.assertFalse(receipt["releaseAccepted"])

    def test_dlopen_library_dependency_escape_fails_before_smoke(self):
        _output, evidence, commands, _library = self.controlled_library_preparation(escape=True)
        self.assertFalse(any(pathlib.Path(args[0]).name == "tool-python3" for args in commands))
        self.assertFalse(json.loads((evidence / "physical-runtime.receipt.safe.json").read_text())["ok"])

    def test_receipt_write_failure_keeps_the_native_failure(self):
        self.controlled_library_preparation(receipt_failure=True)


if __name__ == "__main__":
    unittest.main()

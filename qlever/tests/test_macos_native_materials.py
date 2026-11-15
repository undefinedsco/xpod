import importlib.util
from pathlib import Path
import tempfile
import subprocess
import json
import sys
import os
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/observe-macos-native-materials.py'
spec = importlib.util.spec_from_file_location('mac_materials', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MacMaterialsTest(unittest.TestCase):
    def test_actual_original_rehashed_after_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'source'; source.mkdir()
            (source / 'input.cpp').write_text('original')
            rows = module.snapshot_sources([('engine', source)], root / 'kit')
            self.assertEqual(module.verify_source_snapshot(rows), [rows[0]['reference']])
            (source / 'input.cpp').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'changed'): module.verify_source_snapshot(rows)
            self.assertEqual((root / 'kit/engine/input.cpp').read_text(), 'original')

    def test_workspace_uses_only_tracked_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'tracked').write_text('yes'); (root / 'ignored').write_text('no')
            rows = module.snapshot_sources([('workspace', root)], root / 'kit', ['tracked'])
            self.assertEqual(len(rows), 1)
            self.assertFalse((root / 'kit/workspace/ignored').exists())

    def test_links_and_budget_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'source'; source.mkdir()
            (source / 'input').write_text('payload')
            with patch.object(module, 'SOURCE_BYTES', 1):
                with self.assertRaisesRegex(RuntimeError, 'budget'): module.snapshot_sources([('engine', source)], root / 'kit')
            (source / 'link').symlink_to(source / 'input')
            with self.assertRaisesRegex(RuntimeError, 'link'): module.snapshot_sources([('engine', source)], root / 'kit2')

    def test_input_observation_is_actual_independent_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'source'; source.mkdir()
            (source / 'input').write_text('before')
            rows = module.snapshot_sources([('engine', source)], root / 'kit')
            kit = root/'source-kit.json'; kit.write_text(json.dumps(dict(files=[row['reference'] for row in rows])))
            helper = root/'helper'; helper.write_bytes(b'helper test fixture')
            record = root/'snapshot.json'
            record.write_text(json.dumps(dict(files=rows,target='darwin-arm64',sourceKitPath=str(kit),
                                             sourceKitSha256=module.digest(kit),helperPath=str(helper))))
            command = [sys.executable, '-B', str(SCRIPT), '--verify-inputs', str(record)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=5,
                                    env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads(result.stdout)
            self.assertEqual(actual['filesBefore'], actual['filesAfter'])
            (source / 'input').write_text('mutated')
            result = subprocess.run(command, capture_output=True, text=True, timeout=5,
                                    env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')

    def test_build_test_observation_have_distinct_commands(self):
        observer = SCRIPT.read_text()
        for name in ['native-build', 'native-test', 'native-input-observation']:
            self.assertIn("stage('" + name + "'", observer)
        shell = (SCRIPT.parent / 'build-macos-local-runtime.sh').read_text()
        self.assertLess(shell.index('if [[ "$mode" == build-prepared ]]; then exit 0; fi'),
                        shell.index('python3 "$qlever_root/scripts/verify-local-runtime-artifacts.py"'))

    def test_sourcekit_helper_and_same_input_inventory_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'source'; source.mkdir()
            (source/'input.cpp').write_text('actual source')
            rows = module.snapshot_sources([('engine', source)],root/'kit')
            kit = root/'source-kit.json'; kit.write_text(json.dumps(dict(files=[row['reference'] for row in rows])))
            helper = root/'helper'; helper.write_bytes(b'actual-helper-test-fixture')
            document = dict(files=rows,target='darwin-arm64',sourceKitPath=str(kit),
                            sourceKitSha256=module.digest(kit),helperPath=str(helper))
            actual = module.observe_input_document(document)
            self.assertEqual(actual['filesBefore'], json.loads(kit.read_text())['files'])
            self.assertEqual(actual['filesAfter'], actual['filesBefore'])
            self.assertEqual(actual['helperSha256'], module.digest(helper))
            self.assertEqual(actual['sourceKitSha256'], module.digest(kit))
            kit.write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'kit changed'): module.observe_input_document(document)

    def test_old_archive_only_cache_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError): module.verify_cache(directory)

    def test_workflow_preserves_materials_and_uses_observer(self):
        workflow = (SCRIPT.parents[2] / '.github/workflows/build-qlever-macos-runtime.yml').read_text()
        self.assertIn('qlever-macos-runtime-v2-materials-', workflow)
        self.assertIn('observe-macos-native-materials.py --target "$TARGET"', workflow)
        self.assertIn('--verify-cache "$RUNTIME_ROOT"', workflow)
        self.assertIn('xpod-qlever-runtime/native-materials/', workflow)


if __name__ == '__main__': unittest.main()

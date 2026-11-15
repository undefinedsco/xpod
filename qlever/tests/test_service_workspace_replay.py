"""Actual subprocess tests of mechanical replay, not source qualification."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('workspace_replay_test', ROOT / 'scripts/service-workspace-replay.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

UI_OLD = b'old tracked ui bytes\n'
UI_NEW = b'new built ui bytes\n'

class ReplayTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.test-data').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.test-data')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'package.json').write_text('{}')
        (self.root / 'bun.lock').write_text('{}')
        (self.root / '.test-data').mkdir()
        (self.root / 'static/app').mkdir(parents=True)
        (self.root / 'static/app/index.html').write_bytes(UI_OLD)
        (self.root / 'static/unrelated').mkdir(parents=True)
        (self.root / 'static/unrelated/keep.txt').write_text('keep')
        tools = self.root / 'tools'
        tools.mkdir()
        bun = tools / 'bun'
        bun.write_text('#!' + sys.executable + '\n' + '''import os,sys,pathlib,json
p=pathlib.Path('.test-data/calls')
with p.open('a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
if os.environ.get('FAIL'):sys.exit(7)
if os.environ.get('MUTATE'):
    pathlib.Path('bun.lock').write_text('changed')
if os.environ.get('MUTATE_STATIC'):
    pathlib.Path('static/unrelated/keep.txt').write_text('changed')
if sys.argv[1:]==['run','build:ui']:
    pathlib.Path('dist').mkdir(exist_ok=True)
    pathlib.Path('static/app/index.html').write_bytes(b'new built ui bytes\\n')
    if not os.environ.get('MISSING'):
        q=pathlib.Path('dist/index.js');q.write_bytes(b'actual replay bytes\\n');q.chmod(0o644)
    if os.environ.get('EXTRA'):
        pathlib.Path('dist/extra.js').write_bytes(b'extra')
''')
        bun.chmod(0o755)
        self.env = {'PATH': str(tools)}
        self.reserved = []
        self.row = dict(path='dist/index.js', bytes=20, sha256=hashlib.sha256(b'actual replay bytes\n').hexdigest(), mode=0o644)
        self.ui = dict(path='static/app/index.html', bytes=len(UI_NEW), sha256=hashlib.sha256(UI_NEW).hexdigest(), mode=0o644)

    def run_replay(self, rows=None, end=None):
        return M.replay_workspace(self.root, self.root / '.test-data/replay', self.env,
            time.monotonic() + 90 if end is None else end,
            [self.row, self.ui] if rows is None else rows, lambda: None, self.reserved.append)

    def test_actual_five_command_success(self):
        result = self.run_replay()
        self.assertEqual(self.reserved, [13 * M.META])
        self.assertEqual(result['outputs'], [self.row, self.ui])
        self.assertEqual(len(result['receipts']), 5)
        self.assertTrue(all(M.parent.closed_receipt(row) for row in result['receipts']))
        calls = [json.loads(line) for line in (self.root / '.test-data/calls').read_text().splitlines()]
        self.assertEqual(calls, [list(argv)[1:] for _, argv in M.parent.BUILD_COMMANDS])
        self.assertFalse(any('Verified' in name for name in result))
        self.assertEqual((self.root / 'static/app/index.html').read_bytes(), UI_NEW)

    def test_shared_reservation_failure_prevents_execution(self):
        failure = ValueError('shared retained budget exhausted')
        def reserve(_):
            raise failure
        with self.assertRaises(ValueError) as caught:
            M.replay_workspace(self.root, self.root / '.test-data/replay', self.env,
                time.monotonic() + 90, [self.row, self.ui], lambda: None, reserve)
        self.assertIs(caught.exception, failure)
        self.assertFalse((self.root / '.test-data/calls').exists())
        self.assertFalse((self.root / '.test-data/replay').exists())

    def test_actual_child_failure(self):
        self.env['FAIL'] = '1'
        with self.assertRaisesRegex(ValueError, 'did not close'):
            self.run_replay()

    def test_actual_source_mutation(self):
        self.env['MUTATE'] = '1'
        with self.assertRaisesRegex(ValueError, 'source tree changed'):
            self.run_replay()

    def test_actual_static_source_mutation(self):
        self.env['MUTATE_STATIC'] = '1'
        with self.assertRaisesRegex(ValueError, 'source tree changed'):
            self.run_replay()

    def test_missing_output(self):
        self.env['MISSING'] = '1'
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay()

    def test_extra_output(self):
        self.env['EXTRA'] = '1'
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay()

    def test_missing_ui_output_rejected(self):
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay([self.row])

    def test_extra_ui_output_rejected(self):
        (self.root / 'static/dashboard').mkdir(parents=True)
        (self.root / 'static/dashboard/index.html').write_bytes(UI_OLD)
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay([self.row, self.ui])

    def test_ui_hash_and_mode_comparison(self):
        expected = dict(self.ui, sha256='0' * 64, mode=0o755)
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay([self.row, expected])

    def test_hash_and_mode_comparison(self):
        expected = dict(self.row, sha256='0' * 64, mode=0o755)
        with self.assertRaisesRegex(ValueError, 'output path/size/mode/SHA mismatch'):
            self.run_replay([expected, self.ui])

    def test_expired_deadline_before_spawn(self):
        with self.assertRaises(TimeoutError):
            self.run_replay(end=time.monotonic() - 1)
        self.assertFalse((self.root / '.test-data/calls').exists())

    def test_no_preexisting_generated_outputs(self):
        (self.root / 'dist').mkdir()
        (self.root / 'dist/stale').write_text('stale')
        with self.assertRaisesRegex(ValueError, 'fresh workspace'):
            self.run_replay()

    def test_initial_fixed_ui_files_allowed_but_not_authority(self):
        self.assertEqual(M.snapshots.GENERATED_ROOTS, (('static', 'app'), ('static', 'dashboard'), ('static', 'settings')))
        self.assertEqual(M.snapshots.GENERATED_NAMES, ('dist',))
        self.assertTrue(M.snapshots.is_generated(('static', 'app', 'index.html')))
        self.assertFalse(M.snapshots.is_generated(('static', 'unrelated', 'keep.txt')))
        self.assertTrue(M.snapshots.is_generated(('packages/x/dist/index.js')))

    def test_other_static_never_excluded_from_source(self):
        before = M.snapshots.snapshot(self.root, lambda: None)
        self.assertIn('static/unrelated/keep.txt', [row[0] for row in before['rows']])
        self.assertNotIn('static/app/index.html', [row[0] for row in before['rows']])
        outputs = M.snapshots.snapshot(self.root, lambda: None, generated=True)
        self.assertIn('static/app/index.html', [row[0] for row in outputs['rows']])
        self.assertEqual(before['kind'], 'actual-service-build-file-snapshots-v2')
        self.assertEqual(outputs['generatedDirectoryRoots'], ['static/app', 'static/dashboard', 'static/settings'])

    def test_unsafe_duplicate_output_rejected_before_spawn(self):
        for rows in [[dict(self.row, path='../dist/x')], [self.row, self.row],
                     [self.row, dict(self.ui, path='static/unrelated/keep.txt')]]:
            with self.assertRaises(ValueError):
                self.run_replay(rows)
        self.assertFalse((self.root / '.test-data/calls').exists())

if __name__ == '__main__':
    unittest.main()

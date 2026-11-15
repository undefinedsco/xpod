"""Focused guards for the ci6b gate-layout prototype (no kernel, no gate run).

Validates only the two prototype changes:
  1. the runtime project root is created OUTSIDE the checkout, is fully
     world-traversable, and carries the internal .test-data hierarchy;
  2. the child-setup diagnostic is opaque and stage-tagged.
Structural source assertions are secondary to the executable checks.
"""
import ast
import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TREE = HERE.parents[1]
GATE = TREE / 'qlever/tests/run_sdk70_mremap_gate.py'
PTRACE = TREE / 'qlever/scripts/sdk-ptrace-execution.py'


def load_gate():
    spec = importlib.util.spec_from_file_location('proto_gate', GATE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Layout(unittest.TestCase):
    """Layout contract. `create_project_root` requires euid 0 (the gate runs
    under sudo): a layout owned by a non-root uid is not searchable by the
    capability-empty uid0 child, and the implementation correctly refuses it.
    Those cases are skipped on a non-root host and NEVER reported as passed."""

    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate()

    def _require_root(self):
        if os.geteuid() != 0:
            self.skipTest('layout construction requires euid 0 (gate runs under sudo); '
                          'current euid=%d' % os.geteuid())

    def test_project_root_is_under_canonical_tmp_outside_checkout(self):
        self._require_root()
        outer, project = self.gate.create_project_root()
        try:
            self.assertEqual(self.gate.PROJECT_BASE, '/tmp',
                             'must not use TMPDIR (sudo -E preserves a private one)')
            self.assertTrue(str(project).startswith('/tmp/'),
                            'runtime project must live under canonical /tmp')
            repo_root = Path(self.gate.DEFAULT_ROOT).resolve()
            self.assertFalse(str(project).startswith(str(repo_root) + os.sep),
                             'runtime project must not live inside the checkout')
            for relative in ('qlever/scripts/native', 'qlever/tests', '.test-data'):
                self.assertTrue((project / relative).is_dir(), relative)
        finally:
            import shutil
            shutil.rmtree(outer, ignore_errors=True)

    def test_search_permission_model_matches_capability_empty_child(self):
        """POSIX classes are EXCLUSIVE: exactly one class decides, no fallthrough."""
        allowed = self.gate.search_allowed
        # owner class wins outright
        self.assertTrue(allowed(0, 0, 0o700))
        self.assertFalse(allowed(0, 0, 0o0001),
                         'owner match must NOT fall through to other x')
        self.assertFalse(allowed(0, 0, 0o600))
        # group class wins when uid differs; must not fall through to other
        self.assertTrue(allowed(4242, 0, 0o0750))
        self.assertFalse(allowed(4242, 0, 0o0001),
                         'group match must NOT fall through to other x')
        # other class only when neither uid nor gid matches
        self.assertFalse(allowed(65534, 65534, 0o700))
        self.assertTrue(allowed(65534, 65534, 0o755))
        self.assertTrue(allowed(65534, 65534, 0o001))

    def test_created_ancestors_are_actually_searchable(self):
        self._require_root()
        outer, project = self.gate.create_project_root()
        try:
            base = Path('/tmp').resolve()
            probe = project
            while True:
                info = probe.stat()
                self.assertTrue(
                    self.gate.search_allowed(info.st_uid, info.st_gid,
                                            stat.S_IMODE(info.st_mode)),
                    'created ancestor unsearchable: %s' % probe)
                if probe == base or probe == probe.parent:
                    break
                probe = probe.parent
        finally:
            import shutil
            shutil.rmtree(outer, ignore_errors=True)

    def test_source_checkout_is_never_removed(self):
        source = GATE.read_text()
        body = source[source.index('    finally:'):]
        self.assertIn('shutil.rmtree(outer', body)
        self.assertNotIn('shutil.rmtree(DEFAULT_ROOT', body)
        self.assertNotIn('rmtree(str(Path(DEFAULT_ROOT))', body)

    def test_project_base_does_not_honour_tmpdir(self):
        """Behavioural: the module constant must not derive from TMPDIR."""
        self.assertEqual(self.gate.PROJECT_BASE, '/tmp')
        import ast as _ast
        tree = _ast.parse(GATE.read_text())
        # find the PROJECT_BASE assignment and require a plain string literal
        value = None
        for node in tree.body:
            if isinstance(node, _ast.Assign):
                for target in node.targets:
                    if isinstance(target, _ast.Name) and target.id == 'PROJECT_BASE':
                        value = node.value
        self.assertIsNotNone(value, 'PROJECT_BASE assignment missing')
        self.assertIsInstance(value, _ast.Constant,
                              'PROJECT_BASE must be a literal, not env/tempfile-derived')
        self.assertIsInstance(value.value, str)
        # no executable call to gettempdir anywhere (comments may mention it)
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Call):
                func = node.func
                name = getattr(func, 'attr', None) or getattr(func, 'id', None)
                self.assertNotEqual(name, 'gettempdir',
                                    'executable gettempdir() must not be used')

    def test_no_cli_temp_root_flag(self):
        self.assertNotIn('--temp-root', GATE.read_text())

    def test_creates_testdata_when_absent(self):
        self._require_root()
        outer, project = self.gate.create_project_root()
        try:
            self.assertTrue((project / '.test-data').is_dir())
        finally:
            import shutil
            shutil.rmtree(outer, ignore_errors=True)


class ChildDiagnostic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree = ast.parse(PTRACE.read_text())
        cls.tree = tree
        cls.source = PTRACE.read_text()

    def test_stage_variable_and_opaque_fields(self):
        source = self.source
        for stage in ('authority', 'release', 'stdio', 'chdir', 'exec'):
            self.assertIn("stage='%s'" % stage, source, stage)
        self.assertIn(b'SDK_CHILD_SETUP_FAILED'.decode(), source)
        # diagnostic must carry type + errno, and must not leak text/argv/env/paths
        # scope = the whole `except BaseException as failure:` handler
        handler = source[source.index('except BaseException as failure:'):]
        handler = handler[:handler.index('os._exit(70)')]
        self.assertIn("type(failure).__name__", handler)
        self.assertIn("getattr(failure,'errno',None)", handler)
        self.assertIn('stage.encode', handler)
        # Only the emitted payload matters: comments legitimately name the
        # forbidden concepts. Extract the os.write argument expression.
        payload = handler[handler.index('os.write(2,'):handler.index('except BaseException:\n                    pass')]
        for forbidden in ('str(failure)', 'repr(failure)', 'command', 'env',
                          'cwd', 'token', 'self.out', 'failure.args'):
            self.assertNotIn(forbidden, payload,
                             'emitted diagnostic must not include %r' % forbidden)

    def test_exit_status_unchanged(self):
        source = self.source
        self.assertIn('os._exit(70)', source)
        self.assertEqual(source.count('os._exit(70)'), 1,
                         'child setup must still exit exactly once with 70')


if __name__ == '__main__':
    unittest.main(verbosity=2)

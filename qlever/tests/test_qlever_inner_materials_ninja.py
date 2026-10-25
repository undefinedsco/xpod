"""Regression for the real Ninja branch of sdk-inner-materials.build_materials.

The Trixie x64 CI run failed with

    NameError: name 'materials' is not defined   (line 346)

and the same site used `selected` before it was assigned. Both are data-flow
defects on the newly reached Ninja path, not timeouts.

This test drives the REAL `build_materials` far enough to execute that branch:

  * the module is loaded from its real file (no re-implementation of the branch),
  * only heavyweight outer boundaries are replaced (execution Session, command
    capture, generation/upstream/debian/binary finalizers, cmake File API),
  * tiny GENUINE files stand in for the build inputs and for the Ninja-derived
    link-command record plus its raw stdout/stderr originals.

It therefore fails on the unmodified source with the actual NameError, and after
the fix proves that the raw originals and the derived record survive into the
archived inventory (they are retained evidence, not silently dropped).
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
MODULE = SCRIPTS / 'sdk-inner-materials.py'


# the producer's siblings import e.g. `supervise` as a top-level module; in CI that
# resolves because qlever/scripts is on sys.path. Reproduce it before loading.
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_module():
    spec = importlib.util.spec_from_file_location('inner_under_test', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, data=b'x'):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class NinjaBranch(unittest.TestCase):
    """Execute the actual Ninja branch of build_materials."""

    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.component = root / 'component'
        self.source = root / 'source'
        self.build = root / 'build'
        self.out = root / 'materials'
        for directory in (self.component, self.source, self.build, self.out):
            directory.mkdir(parents=True, exist_ok=True)
        (self.component / 'scripts').mkdir(parents=True, exist_ok=True)
        # minimal real files the flow reads
        write(self.component / 'scripts' / 'build-qlever-runtime-sdk.sh', b'#!/bin/sh\n')
        write(self.build / 'compile_commands.json', b'[]')
        write(self.build / 'CMakeCache.txt', b'# cache\n')
        write(self.component / 'qlever.lock.json', b'{}')
        (self.component.parent / 'scripts' / 'lib').mkdir(parents=True, exist_ok=True)
        write(self.component.parent / 'scripts' / 'lib' / 'module-artifact-limits.json', b'{}')
        # the Ninja-derived record and its retained raw originals
        self.link_txt = write(self.build / 'CMakeFiles' / 'qlever-server.dir' / 'link.txt', b'cc -o qlever-server a.o\n')
        staged = self.out / 'stages' / 'link-command-0'
        self.raw_out = write(staged / 'stdout.raw', b'cc -o qlever-server a.o\n')
        self.raw_err = write(staged / 'stderr.raw', b'')
        self.record_path = self.build / 'CMakeFiles' / 'qlever-server.dir' / 'origin.json'
        import hashlib

        def ref(path):
            raw = pathlib.Path(path).read_bytes()
            return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

        self.record = {
            'schemaVersion': 1,
            'origin': 'ninja-tool-introspection',
            'generator': 'Ninja',
            'argv': ['ninja', '-t', 'commands', '-s', 'qlever-server'],
            'rawStdout': ref(self.raw_out),
            'rawStderr': ref(self.raw_err),
            'linkTxt': ref(self.link_txt),
            'linkLine': self.link_txt.read_text().strip(),
        }
        self.record_path.write_text(json.dumps(self.record))
        self.archived = []
        self.fake_cc1plus = write(root / 'cc1plus', b'#!/bin/sh\n')
        # the declared compiler's search root lives entirely inside the fixture
        self.include_root = root / 'include'
        self.include_root.mkdir(parents=True, exist_ok=True)
        write(self.include_root / 'fixture-header.h', b'/* fixture */\n')
        self.fixture_source = write(self.source / 'fixture-unit.cc', b'int fixture;\n')

    def tearDown(self):
        self.tmp.cleanup()

    def _identity(self):
        return {'sdkProfile': 'service-trixie', 'target': 'x86_64-linux-gnu'}

    def _stub_module(self):
        module = self.module
        state = {'build': self.build, 'source': self.fixture_source, 'include': self.include_root}

        class Budget:
            deadline_unix = 0

            def check(self, _reserve=0):
                return None

            def timeout(self, a, b=0):
                return a

            def remaining(self):
                return 4200

        budget = Budget()
        module.initialize_budget = lambda *a, **k: budget

        class Execution:
            def __init__(self, *a, **k):
                pass

            def phase(self, name, command, inputs=(), *args, **kwargs):
                # The compile stage is where real depfiles appear. Record the state
                # BEFORE it so the test can assert no dependency originals existed
                # while the Ninja originals were being read.
                if name == 'compile':
                    state['depfilesBeforeCompile'] = sorted(
                        str(p) for p in pathlib.Path(state['build']).rglob('*.o.d'))
                    obj = pathlib.Path(state['build']) / 'CMakeFiles' / 'qlever-server.dir' / 'fixture-unit.cc.o'
                    obj.parent.mkdir(parents=True, exist_ok=True)
                    obj.write_bytes(b'\x00')
                    depfile = pathlib.Path(str(obj) + '.d')
                    # a REAL depfile in the shape the real parser accepts
                    depfile.write_text(
                        str(obj) + ': ' + str(state['source']) + ' '
                        + str(pathlib.Path(state['include']) / 'fixture-header.h') + '\n')
                return {'name': name, 'bytes': 0}

            def close(self):
                return None

            def abort(self):
                return None

            def after_tool_inputs(self, fn):
                return [], []

            def tool_input_pending(self, inventory):
                return []

            def finalize(self, inner, upstream_ref, inventory):
                state['finalized'] = True
                return {'path': 'execution.json', 'bytes': 0}, 0

        class Toolchain:
            Session = Execution
            remaining_source_bytes = staticmethod(lambda out: 4 * 1024 ** 3)

        module.toolchain = Toolchain

        def capture(name, command, out, cwd, inputs=(), timeout=30, **k):
            # write REAL raw originals so callers that read them behave normally
            out = pathlib.Path(out)
            out.mkdir(parents=True, exist_ok=True)
            payload = b''
            if name == 'compiler-program':
                # a real absolute file so the declared-program check passes
                payload = str(self.fake_cc1plus).encode() + b'\n'
            stdout = write(out / f'{name}.stdout.raw', payload)
            search = b'#include <...> search starts here:\n ' + str(self.include_root).encode() + b'\nEnd of search list.\n'
            stderr = write(out / f'{name}.stderr.raw', search)
            return {'name': name,
                    'stdout': {'path': stdout.name, 'bytes': 0, 'sha256': '0' * 64},
                    'stderr': {'path': stderr.name, 'bytes': stderr.stat().st_size, 'sha256': '0' * 64}}

        module.commands = mock.MagicMock()
        module.commands.capture.side_effect = capture
        module.commands.ref.side_effect = lambda path, root: {'path': str(path), 'bytes': 0, 'sha256': '0' * 64}
        module.commands.failed_stage_originals.side_effect = lambda *a, **k: {}

        # cmake File API reports a Ninja tree
        module.file_api = mock.MagicMock()
        module.file_api.generator.return_value = 'Ninja'
        module.file_api.FileApiUnavailable = type('FileApiUnavailable', (Exception,), {})

        module.generation = mock.MagicMock()
        module.generation.snapshot.return_value = {'path': 'g.json', 'bytes': 0, 'sha256': '0' * 64}
        module.generation.finalize.return_value = ({'path': 'g.json', 'bytes': 0, 'sha256': '0' * 64}, 0)
        module.upstream = mock.MagicMock()
        module.upstream.finalize.return_value = ({'path': 'u.json', 'bytes': 0, 'sha256': '0' * 64}, 0)
        module.debian_acquisition = mock.MagicMock()
        module.debian_acquisition.acquire.return_value = ({'path': 'd.json', 'bytes': 0, 'sha256': '0' * 64}, 0)
        module.binary_hook = mock.MagicMock()
        module.binary_hook.acquire.return_value = ({'path': 'b.json', 'bytes': 0, 'sha256': '0' * 64}, 0, 0)
        module.symlinks = mock.MagicMock()
        module.symlinks.observe.return_value = ({}, {})
        module.symlinks.save.return_value = None
        module.symlinks.compare.return_value = []
        module.symlinks.identity.return_value = []
        module.profile_module = mock.MagicMock()
        module.profile_module.declared_profile.return_value = {
            'name': 'service-trixie', 'cxx': 'c++', 'compiler_program': 'cc1plus', 'linker_program': 'ld'}
        module.profile_module.compiler_spec.return_value = {'profile': 'service-trixie'}
        module.sdk_tools = lambda name: ()
        # Keep dependency_paths real: its compile ordering is the regression.
        # Configure metadata collection is covered by the separate File API tests.
        module.configure_inputs = lambda build: set()
        module.stage_identity = lambda *a, **k: None
        module.dump = lambda path, value: (pathlib.Path(path).write_text(json.dumps(value, default=str)),
                                           {'path': str(path), 'bytes': 0, 'sha256': '0' * 64})[1]
        module.file_identity = lambda path: {'path': str(path), 'bytes': pathlib.Path(path).stat().st_size,
                                            'sha256': '0' * 64, 'mode': 0o644}
        # record what actually reached the archive

        def spy(files, destination, before, compile_outputs=(), metadata_originals=(), **k):
            self.archived.extend(str(p) for p in files)
            state['before'] = before
            return {'files': [], 'shards': [], 'pending': []}

        module.archive_inputs = spy
        module.symlinks.save = lambda *a, **k: None
        return state

    def _prepared(self):
        identity = self._identity()
        prepared = {'identity': identity, 'deadlineUnix': 0, 'stages': [],
                    'dependencyStage': {'name': 'dependency', 'bytes': 0},
                    'dependencyCollection': 'c.json', 'dependencyMaterialBytes': 0}
        (self.out / 'source-prepared.json').write_text(json.dumps(prepared))
        identity_env = mock.patch.dict(os.environ, {'XPOD_QLEVER_SDK_IDENTITY': json.dumps(identity)})
        identity_env.start()
        self.addCleanup(identity_env.stop)
        (self.out / 'fetchcontent').mkdir(exist_ok=True)

    def test_ninja_branch_uses_defined_materials_root_and_retains_originals(self):
        """Fails on the unmodified source with NameError('materials'); after the fix
        the raw originals and the derived record are retained."""
        self._prepared()
        state = self._stub_module()
        try:
            self.module.build_materials(self.component, self.source, self.build, self.out, '1')
        except NameError as error:
            self.fail(f'unmodified-flow NameError still present: {error}')
        # the retained evidence must actually survive into archive()
        retained = {str(pathlib.Path(p).resolve()) for p in self.archived}
        for expected in (self.raw_out, self.raw_err, self.record_path):
            self.assertIn(str(expected.resolve()), retained,
                          f'Ninja original not retained through selection: {expected}')
        self.assertTrue(state.get('finalized'), 'execution.finalize was not reached')
        # ORDERING: no compiler depfile may exist while the Ninja originals are read;
        # they are produced by the compile stage and only then may dependency_paths
        # be called (it refuses a tree with none).
        self.assertEqual(state.get('depfilesBeforeCompile'), [],
                         'a compiler depfile existed before the compile stage')

    def test_makefiles_branch_refuses_a_derived_origin(self):
        """The Makefiles branch must not invent or accept a Ninja-derived origin."""
        self._prepared()
        self._stub_module()
        self.module.file_api.generator.return_value = 'Unix Makefiles'
        # an existing record on a Makefiles tree is a hard refusal
        with self.assertRaisesRegex(ValueError, 'CMake-authored link command must not carry a derived origin'):
            self.module.build_materials(self.component, self.source, self.build, self.out, '1')


if __name__ == '__main__':
    unittest.main()

"""Repo-relative bootstrap for the native lease contract gate.

This is NOT a test module. It builds the SDK observer's real native helper ONCE
in a private repository-relative temporary layout and hands the three contract
suites a loaded extension plus a factory-shaped module.

Design rules (from the review that rejected the private /w scripts):
  * no sys.argv, no absolute host paths: the repository root is derived from
    THIS file's location, so the same code runs in CI and locally;
  * the compile is a real compiler child with a natural wait, using the same
    build helper the SDK image uses;
  * generated artefacts land in <repo>/.test-data/native-lease-gate-*/ and are
    removed in a finally block - never in qlever/scripts/native/ source;
  * a missing compiler, missing headers or a version mismatch is a FAILURE, not
    a skip: a skipped gate must not be able to look like a pass.

The C source and binding are read from qlever/scripts/native/ (the same files
the Dockerfile ships). If they are absent the gate fails loudly.
"""
import hashlib
import importlib.util
import os
import shutil
import subprocess
import sys
import sysconfig
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))          # <repo>/qlever/tests -> <repo>
NATIVE_SOURCE = os.path.join(REPO, 'qlever', 'scripts', 'native')
BUILD_HELPER = os.path.join(NATIVE_SOURCE, 'build_native_helper.py')
EXT_SOURCE = os.path.join(NATIVE_SOURCE, 'lease_sweep_ext.c')
BINDING = os.path.join(NATIVE_SOURCE, 'lease_sweep_binding.py')


class GateUnavailable(AssertionError):
    """The gate could not construct its fixture. This is a FAILURE, not a skip."""


def _python_for_headers():
    """The interpreter whose headers we will use.

    CI must not silently mix a PATH python with another interpreter's headers.
    We therefore require that the interpreter running this gate has matching
    Python.h; if it does not, we fail with a precise message instead of letting
    the compiler find a mismatched header later.
    """
    include = sysconfig.get_paths()['include']
    header = os.path.join(include, 'Python.h')
    if not os.path.isfile(header):
        raise GateUnavailable(
            'Python.h not present for %s (%s); install the matching python3-dev '
            'in the CI step rather than skipping this gate' % (sys.executable, include))
    return include


def _run(argv, cwd, stdout_path, stderr_path):
    with open(stdout_path, 'wb') as out, open(stderr_path, 'wb') as err:
        completed = subprocess.run(argv, cwd=cwd, stdout=out, stderr=err,
                                   stdin=subprocess.DEVNULL)
    return completed.returncode


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


class LeaseGate:
    """One built-and-verified fixture, shared by every contract suite."""

    def __init__(self):
        for required in (BUILD_HELPER, EXT_SOURCE, BINDING):
            if not os.path.isfile(required):
                raise GateUnavailable('required native source missing: ' + required)
        self.include = _python_for_headers()
        # Private, repository-relative, and removed in close().
        base = os.path.join(REPO, '.test-data')
        os.makedirs(base, exist_ok=True)
        self.root = tempfile.mkdtemp(prefix='native-lease-gate-', dir=base)
        self.scripts = os.path.join(self.root, 'qlever', 'scripts')
        self.native = os.path.join(self.scripts, 'native')
        os.makedirs(self.native)
        self.receipt = None
        self.extension = None

    # ---- construction -------------------------------------------------
    def build(self, source=None):
        """Compile the helper in the private layout. Real child, real wait."""
        source = source or EXT_SOURCE
        shutil.copyfile(source, os.path.join(self.native, 'lease_sweep_ext.c'))
        shutil.copyfile(BINDING, os.path.join(self.native, 'lease_sweep_binding.py'))
        shutil.copyfile(BUILD_HELPER, os.path.join(self.native, 'build_native_helper.py'))
        compiler = os.environ.get('NATIVE_LEASE_CC') or self._first_compiler()
        code = _run([sys.executable,
                     os.path.join(self.native, 'build_native_helper.py'),
                     os.path.join(self.native, 'lease_sweep_ext.c'),
                     self.native, '--cc', compiler],
                    self.root,
                    os.path.join(self.root, 'build.stdout'),
                    os.path.join(self.root, 'build.stderr'))
        if code != 0:
            with open(os.path.join(self.root, 'build.stderr'), 'r', errors='replace') as handle:
                detail = handle.read()[-2000:]
            raise GateUnavailable('native helper compile failed (%d): %s' % (code, detail))
        self.receipt = os.path.join(self.native, 'build.receipt.json')
        self.extension = os.path.join(
            self.native, 'lease_sweep_ext' + sysconfig.get_config_var('EXT_SUFFIX'))
        if not os.path.isfile(self.extension):
            raise GateUnavailable('compile reported success but produced no extension')
        return self

    def _first_compiler(self):
        for candidate in ('clang-19', 'gcc-12', 'cc', 'gcc'):
            if shutil.which(candidate):
                return candidate
        raise GateUnavailable(
            'no C compiler found in this environment; the CI step must install '
            'one instead of skipping the gate')

    # ---- consumption --------------------------------------------------
    def binding_module(self):
        spec = importlib.util.spec_from_file_location(
            'gate_binding', os.path.join(self.native, 'lease_sweep_binding.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def load_extension(self):
        # The module NAME must match the PyInit_<name> export in the ELF, so we
        # use the real name the extension defines, not an ad-hoc alias.
        spec = importlib.util.spec_from_file_location(
            'lease_sweep_ext', self.extension)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def factory_module(self):
        """The real patched LeaseSet module, laid out at the fixed path."""
        path = os.path.join(self.scripts, 'sdk-tool-lifetime-leases.py')
        spec = importlib.util.spec_from_file_location('gate_leases', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def install_factory(self, patched_path):
        shutil.copyfile(patched_path, os.path.join(self.scripts, 'sdk-tool-lifetime-leases.py'))

    # ---- teardown -----------------------------------------------------
    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

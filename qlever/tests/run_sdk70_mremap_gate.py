#!/usr/bin/env python3
"""Run the SDK70 executable-memory-remap gate. Linux-only, fail-closed.

WHY THIS EXISTS
    The CI `test` job discovers `test_qlever*.py` only, so the canonical
    `test_sdk70_mremap*.py` modules would never run there. This is the separate,
    cheap, REAL-Linux gate that runs them, and it runs the SDK's OWN native
    lease DI (`SdkExecutionObserver.lifetime_leases_class`) against a really
    compiled `lease_sweep_ext` rather than any stub.

FAIL-CLOSED CONTRACT
    Wrong platform, missing compiler, missing interpreter headers, missing
    fixture, zero loaded cases, any skip, any nonzero exit or an incomplete
    cleanup ALL fail this gate. There is no skip / default / "accepted" flag.

FIXTURE
    A private `.test-data/sdk70-mremap-gate-*` layout is created per run with the
    repository's real relative shape:

        <root>/qlever/scripts/<public SDK modules + native/>
        <root>/scripts/lib/<required constants>
        <root>/qlever/tests/<canonical test modules>

    Copied inputs are hashed and verified after copying. Only this owned layout
    is removed, in `finally`.

Usage:
    python3 qlever/tests/run_sdk70_mremap_gate.py [-v]
    python3 qlever/tests/run_sdk70_mremap_gate.py --source-root <tree> [-v]

`--source-root` is a TEST-INTERNAL seam for running against a frozen prototype
tree; the default is the actual repository root and a missing canonical file
there is a hard failure.
"""
import argparse
import hashlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parents[1]

# The four canonical test modules.
#   * predicate / observer / e2e are unittest modules (loader + count + skip).
#   * native is a STANDALONE script (see STANDALONE_SCRIPT) and is executed as a
#     real child exactly once; it is NOT a unittest module.
STDLIB_MODULES = ('test_sdk70_mremap_predicate', 'test_sdk70_mremap_observer',
                  'test_sdk70_mremap_e2e')
STANDALONE_SCRIPT = 'test_sdk70_mremap_native.py'
TEST_FILES = tuple('qlever/tests/%s.py' % name for name in STDLIB_MODULES) + \
    ('qlever/tests/' + STANDALONE_SCRIPT,)

# Deterministic public-source rule: EVERY regular public qlever/scripts/*.py.
# This is the one canonical public source directory, not a behavioural catalog.
# Generated artifacts, symlinks, caches and secrets are excluded structurally.
PUBLIC_SCRIPTS = 'qlever/scripts'
SCRIPT_EXCLUDE_SUFFIXES = ('.so', '.pyd', '.pyc', '.pyo')
SCRIPT_EXCLUDE_PREFIXES = ('.',)

# The real native DI layout the SDK loads (not a regenerated variant).
NATIVE_FILES = ('qlever/scripts/native/lease_sweep_ext.c',
                'qlever/scripts/native/lease_sweep_binding.py',
                'qlever/scripts/native/build_native_helper.py')

# Actual JSON constants the SDK modules read at load time.
LIB_FILES = ('scripts/lib/module-artifact-limits.json',)


def public_scripts(source_root):
    """Every regular public .py module under qlever/scripts, sorted.

    Excludes generated binaries/bytecode, caches, symlinks and dotfiles. A
    symlink is never followed: the closure must be real checked-in sources.
    """
    root = Path(source_root) / PUBLIC_SCRIPTS
    if not root.is_dir():
        raise AssertionError('missing canonical source directory: %s' % root)
    found = []
    for entry in sorted(root.iterdir()):
        if entry.name.startswith(SCRIPT_EXCLUDE_PREFIXES):
            continue
        # The canonical rule is ALL regular public *.py modules in this one
        # directory. Shell/.cjs helpers live here too but are not part of the
        # Python import closure this gate exercises.
        if entry.suffix != '.py':
            continue
        if entry.suffix in SCRIPT_EXCLUDE_SUFFIXES:
            continue
        if entry.is_symlink() or not entry.is_file():
            continue
        found.append('%s/%s' % (PUBLIC_SCRIPTS, entry.name))
    if not found:
        raise AssertionError('no public scripts found under %s' % root)
    return tuple(found)


def required_inputs(source_root):
    """The complete canonical input closure for this gate, in a stable order."""
    return tuple(TEST_FILES) + public_scripts(source_root) + tuple(NATIVE_FILES) + tuple(LIB_FILES)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def fail(message):
    sys.stderr.write('SDK70 GATE FAILED: %s\n' % message)
    return 2


def compiler():
    """A real compiler is REQUIRED. No silent fallback."""
    for name in (os.environ.get('NATIVE_LEASE_CC'), os.environ.get('CC'),
                 'clang', 'cc', 'gcc'):
        if not name:
            continue
        path = shutil.which(name)
        if path:
            return path
    raise AssertionError('no C compiler (set NATIVE_LEASE_CC or CC)')


def interpreter_headers():
    """The interpreter-matched headers must already exist (the CI step installs them)."""
    import sysconfig
    include = sysconfig.get_paths()['include']
    header = os.path.join(include, 'Python.h')
    if not os.path.isfile(header):
        raise AssertionError('interpreter headers unavailable: ' + header)
    if not sysconfig.get_config_var('EXT_SUFFIX'):
        raise AssertionError('interpreter has no EXT_SUFFIX')
    return include


def copy_verified(source_root, target, relative):
    """Copy one input and verify the copied bytes hash to the same digest."""
    src = Path(source_root) / relative
    if not src.is_file():
        raise AssertionError('missing canonical input: %s' % src)
    dst = Path(target) / relative
    dst.parent.mkdir(parents=True, exist_ok=True)
    before = sha256_file(src)
    shutil.copy2(src, dst)
    after = sha256_file(dst)
    if before != after:
        raise AssertionError('copied input hash differs: ' + relative)
    return before


def build_layout(source_root, target, required):
    """Materialise the private gate layout and build the real native helper."""
    copied = {}
    for relative in required:
        copied[relative] = copy_verified(source_root, target, relative)

    native_dir = Path(target) / 'qlever/scripts/native'
    helper = native_dir / 'build_native_helper.py'
    source = native_dir / 'lease_sweep_ext.c'
    interpreter_headers()

    done = subprocess.run(
        [sys.executable, str(helper), str(source), str(native_dir), '--cc', compiler()],
        capture_output=True, text=True, cwd=str(native_dir))
    if done.returncode != 0:
        raise AssertionError('native helper build failed (%d): %s'
                             % (done.returncode, (done.stderr or done.stdout)[-2000:]))

    receipt = native_dir / 'build.receipt.json'
    if not receipt.is_file():
        raise AssertionError('native helper produced no build receipt')

    # The produced extension must exist for THIS interpreter ABI.
    import sysconfig
    extension = native_dir / ('lease_sweep_ext' + sysconfig.get_config_var('EXT_SUFFIX'))
    if not extension.is_file():
        raise AssertionError('native helper produced no extension: ' + str(extension))
    if not extension.read_bytes()[:4] == b'\x7fELF':
        raise AssertionError('native helper output is not ELF')
    return copied


def run_standalone_script(directory, name, env):
    """Execute the canonical STANDALONE native script as a real child ONCE.

    It is not a unittest module: it prints its own PASS/FAIL lines and exits
    nonzero on any failure. We require a real child, a nonzero PASS count, no
    SKIP line and exit 0. No case count is invented from a report file.
    """
    path = Path(directory) / name
    if not path.is_file():
        raise AssertionError('missing canonical native script: %s' % path)
    done = subprocess.run([sys.executable, '-B', str(path)],
                          capture_output=True, text=True, cwd=str(directory),
                          env=env, timeout=600)
    output = (done.stdout or '') + (done.stderr or '')
    sys.stderr.write(output)
    if done.returncode != 0:
        raise AssertionError('%s exited %d' % (name, done.returncode))
    passes = sum(1 for line in output.splitlines() if line.startswith('PASS'))
    skips = sum(1 for line in output.splitlines() if line.startswith('SKIP'))
    failures = sum(1 for line in output.splitlines() if line.startswith('FAIL'))
    if skips:
        raise AssertionError('%s reported %d SKIP line(s)' % (name, skips))
    if failures:
        raise AssertionError('%s reported %d FAIL line(s)' % (name, failures))
    if passes <= 0:
        raise AssertionError('%s reported no PASS cases' % name)
    return passes


def load_module(directory, name):
    path = Path(directory) / (name + '.py')
    if not path.is_file():
        raise AssertionError('missing canonical test module: %s' % path)
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise AssertionError('unloadable canonical test module: %s' % path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(argv):
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('-v', '--verbose', action='store_true')
    parser.add_argument('--source-root', default=None,
                        help='TEST-INTERNAL seam; defaults to the repository root')
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return fail('unexpected arguments: %s' % ' '.join(unknown))
    if args.verbose:
        sys.argv.append('-v')

    if not sys.platform.startswith('linux'):
        return fail('this gate is Linux-only (running on %s)' % sys.platform)

    source_root = Path(args.source_root).resolve() if args.source_root else DEFAULT_ROOT
    if not source_root.is_dir():
        return fail('source root is not a directory: %s' % source_root)
    try:
        required = required_inputs(source_root)
    except AssertionError as error:
        return fail(str(error))
    for relative in required:
        if not (source_root / relative).is_file():
            return fail('missing canonical input under source root: %s' % relative)

    try:
        compiler()
        interpreter_headers()
    except AssertionError as error:
        return fail(str(error))

    target = Path(tempfile.mkdtemp(prefix='sdk70-mremap-gate-', dir=str(Path(DEFAULT_ROOT) / '.test-data')))
    created = True
    try:
        copied = build_layout(source_root, target, required)
        sys.stderr.write('sdk70 gate layout: %s (%d hashed inputs)\n' % (target, len(copied)))

        tests_dir = target / 'qlever/tests'
        if str(tests_dir) not in sys.path:
            sys.path.insert(0, str(tests_dir))

        loader = unittest.TestLoader()
        suite = unittest.TestSuite()
        loaded = 0
        for name in STDLIB_MODULES:
            try:
                module = load_module(tests_dir, name)
            except Exception as error:
                return fail('failed to import %s: %s' % (name, error))
            tests = loader.loadTestsFromModule(module)
            count = tests.countTestCases()
            if count == 0:
                return fail('%s loaded 0 tests' % name)
            loaded += count
            suite.addTests(tests)
        if loaded == 0:
            return fail('no tests loaded')

        # The canonical native script is a STANDALONE runner: execute it once as a
        # real child and require its own real PASS/FAIL accounting. It is never
        # loaded through the unittest loader and no count is invented for it.
        child_env = dict(os.environ)
        child_env.setdefault('NATIVE_LEASE_CC', os.environ.get('NATIVE_LEASE_CC') or compiler())
        child_env.setdefault('CC', child_env['NATIVE_LEASE_CC'])
        native_passes = run_standalone_script(tests_dir, STANDALONE_SCRIPT, child_env)
        sys.stderr.write('sdk70 native script: %d PASS cases\n' % native_passes)

        sys.stderr.write('sdk70 gate: %d unittest tests across %d modules + 1 native script\n'
                         % (loaded, len(STDLIB_MODULES)))
        result = unittest.TextTestRunner(
            verbosity=2 if args.verbose else 1, stream=sys.stderr).run(suite)

        if result.skipped:
            return fail('%d case(s) skipped; this gate tolerates no skips' % len(result.skipped))
        if result.errors or result.failures:
            return 1
        if not result.testsRun:
            return fail('no tests actually ran')
        if result.testsRun != loaded:
            return fail('ran %d of %d loaded tests' % (result.testsRun, loaded))
        return 0
    except AssertionError as error:
        return fail(str(error))
    except Exception as error:
        return fail('%s: %s' % (type(error).__name__, error))
    finally:
        # Remove ONLY this owned layout; an incomplete cleanup is a hard failure.
        if created:
            shutil.rmtree(target, ignore_errors=True)
            if target.exists():
                sys.stderr.write('SDK70 GATE CLEANUP FAILED: %s\n' % target)
                os._exit(3)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

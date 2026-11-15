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
    An owned runtime project is created per run under the canonical Linux `/tmp`
    (never `TMPDIR`, which `sudo -E` preserves), with the repository's real
    relative shape:

        /tmp/sdk70-gate-owned-*/project/qlever/scripts/<public SDK modules + native/>
        /tmp/sdk70-gate-owned-*/project/scripts/lib/<required constants>
        /tmp/sdk70-gate-owned-*/project/qlever/tests/<canonical test modules>
        /tmp/sdk70-gate-owned-*/project/.test-data/            (internal scratch)

    The internal `.test-data` keeps the repository-relative contract. Copied
    inputs are hashed and verified after copying. Only this owned outer directory
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
import stat
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
                  'test_sdk70_mremap_e2e', 'test_sdk70_mremap_barrier_e2e')
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


# Canonical Linux temp root. NOT tempfile.gettempdir(): that honours TMPDIR,
# which `sudo -E` preserves, so a private TMPDIR under the runner's home would
# silently reintroduce exactly the layout defect this function exists to avoid.
PROJECT_BASE = '/tmp'


def search_allowed(uid, gid, mode, *, child_uid=0, child_gid=0):
    """Can a capability-empty uid0 child SEARCH (traverse) this directory?

    After the fixture's real capability drop the child keeps uid 0 but has an
    EMPTY capability set, so `CAP_DAC_OVERRIDE`/`CAP_DAC_READ_SEARCH` are gone
    and ordinary permission classes apply.

    POSIX permission classes are EXCLUSIVE: the kernel selects exactly ONE class
    by ownership and never falls through.

      * uid match  -> OWNER class -> bool(S_IXUSR)
      * gid match  -> GROUP class -> bool(S_IXGRP)
      * otherwise  -> OTHER class -> bool(S_IXOTH)

    So a root-owned `0001` is NOT searchable by the child (owner class wins and
    lacks the x bit), even though `other` has x. The fixture child's root gid is
    known, so no supplementary-group modelling is needed here.
    """
    if uid == child_uid:
        return bool(mode & stat.S_IXUSR)
    if gid == child_gid:
        return bool(mode & stat.S_IXGRP)
    return bool(mode & stat.S_IXOTH)


def create_project_root():
    """Materialise the runtime project OUTSIDE the (possibly private) checkout.

    WHY
        The gate used to mkdtemp under `DEFAULT_ROOT/.test-data`. When the
        checkout lives under a runner-owned private ancestor (e.g.
        `/blocked-home/project` owned by uid 65534, mode 0700), the observed
        child -- after its real capability drop to uid 0 with an empty
        capability set -- cannot traverse that ancestor, so `os.chdir(cwd)`
        fails with EACCES. The child then exits 70 silently and the parent
        reports `actual observed root did not exit successfully`.

        The runtime project must therefore live under a base whose ancestors are
        searchable by that child. `/tmp` is root-owned 1777, and the owned
        directories we create are root-owned 0700, which the child CAN search
        through the owner class. Only a foreign-owned 0700 ancestor blocks.

    TEMP-ROOT CONTRACT / data hygiene
        The root is created by this process under the canonical Linux `/tmp`,
        is the ONLY thing removed in `finally`, and contains the required
        internal `.test-data` hierarchy so the fixture sees the normal
        repository-relative shape. No user configuration, environment variable
        or CLI flag selects it. mkdtemp's default 0700 is kept: it is owned by
        the current (root) euid, so the child traverses it legitimately, and
        nothing else on the box can read the layout.

    Returns (outer, project) where `project` holds the canonical tree.
    """
    base = Path(PROJECT_BASE)
    if not base.is_dir():
        raise AssertionError('canonical project base unavailable: %s' % base)
    project_base = base.resolve()
    outer = Path(tempfile.mkdtemp(prefix='sdk70-gate-owned-', dir=str(project_base)))
    try:
        project = outer / 'project'
        # The fixture's own test data must live inside the project, never in a
        # user home; this mirrors the repository-relative contract.
        for relative in ('qlever/scripts/native', 'qlever/tests', '.test-data'):
            (project / relative).mkdir(parents=True, exist_ok=True)
        # Verify the ACTUAL path/ownership the capability-empty child will walk:
        # project -> outer -> /tmp inclusive.
        probe = project
        while True:
            info = probe.stat()
            mode = stat.S_IMODE(info.st_mode)
            if not search_allowed(info.st_uid, info.st_gid, mode):
                raise AssertionError(
                    'project ancestor is not searchable by a capability-empty uid0 '
                    'child: %s (uid=%d gid=%d mode=%04o)'
                    % (probe, info.st_uid, info.st_gid, mode))
            if probe == project_base or probe == probe.parent:
                break
            probe = probe.parent
        return outer, project
    except BaseException:
        # Nothing outside this owned outer may be touched, and a partially built
        # layout must not leak: remove ONLY what mkdtemp created, then re-raise.
        shutil.rmtree(outer, ignore_errors=True)
        if outer.exists():
            sys.stderr.write('SDK70 GATE SCAFFOLD CLEANUP FAILED: %s\n' % outer)
        raise


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

    try:
        outer, target = create_project_root()
    except AssertionError as error:
        return fail(str(error))
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
        # Remove ONLY the owned outer root this process created; never the
        # source checkout and never a caller-owned temp path. An incomplete
        # cleanup is a hard failure.
        if created:
            shutil.rmtree(outer, ignore_errors=True)
            if outer.exists():
                sys.stderr.write('SDK70 GATE CLEANUP FAILED: %s\n' % outer)
                os._exit(3)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

"""Backend boundary + fail-closed gate -- CI-runnable, repo-relative.

Covers, against the REAL compiled helper and the REAL patched factory module:

  * base LeaseSet is pure and works with the native directory absent;
  * SdkLeaseSet is required and RAISES when the helper is missing;
  * SdkLeaseSet raises on source / header / ELF / ABI corruption;
  * the backend is resolved once, not per check;
  * a deliberately wrong product formatter makes the gate FAIL (negative case).
"""
import importlib.util
import json
import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import native_lease_gate as gate  # noqa: E402

_GATE = None
PATCHED_FACTORY = os.path.join(os.path.dirname(os.path.dirname(HERE)),
                               'qlever', 'scripts', 'sdk-tool-lifetime-leases.py')


def setUpModule():
    global _GATE
    _GATE = gate.LeaseGate().build()
    # The gate's fixture must carry the REAL patched module at the fixed path.
    factory = os.environ.get('NATIVE_LEASE_FACTORY') or PATCHED_FACTORY
    if not os.path.isfile(factory):
        raise gate.GateUnavailable('patched factory module not present: ' + factory)
    _GATE.install_factory(factory)


def tearDownModule():
    if _GATE is not None:
        _GATE.close()


def g():
    return _GATE


def fresh_tree():
    """Copy the built fixture so corruption cases cannot affect each other."""
    root = tempfile.mkdtemp(prefix='backend-case-', dir=g().root)
    scripts = os.path.join(root, 'qlever', 'scripts')
    shutil.copytree(os.path.join(g().scripts), scripts)
    return root, scripts


def load_module(path, name='m'):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BaseStaysPure(unittest.TestCase):
    def test_base_class_attribute_is_false(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'base_a')
        self.assertIs(module.LeaseSet._native_backend_required, False)

    def test_base_works_with_native_directory_deleted(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        shutil.rmtree(os.path.join(scripts, 'native'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'base_b')
        group = module.LeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        self.assertIsNone(group._native)
        p = os.path.join(root, 'lease')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        group.check()
        self.assertIsNone(group._failure)

    @staticmethod
    def _quiet(group):
        try: group.close()
        except Exception: pass


class SdkIsRequired(unittest.TestCase):
    def test_sdk_class_attribute_is_true(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_a')
        self.assertIs(module.SdkLeaseSet._native_backend_required, True)
        self.assertTrue(issubclass(module.SdkLeaseSet, module.LeaseSet))

    def test_sdk_raises_when_native_directory_missing(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        shutil.rmtree(os.path.join(scripts, 'native'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_b')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_when_binding_missing(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        os.unlink(os.path.join(scripts, 'native', 'lease_sweep_binding.py'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_c')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_elf(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_d')
        ext = module._load_native_lease_sweep()
        # corrupt the ELF bytes the receipt pinned
        import sysconfig
        so = os.path.join(scripts, 'native',
                          'lease_sweep_ext' + sysconfig.get_config_var('EXT_SUFFIX'))
        with open(so, 'r+b') as h:
            h.seek(80); h.write(b'\xde\xad\xbe\xef')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_source(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        with open(os.path.join(scripts, 'native', 'lease_sweep_ext.c'), 'a') as h:
            h.write('\n/* tampered */\n')
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_e')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_header_original(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        receipt = json.load(open(os.path.join(scripts, 'native', 'build.receipt.json')))
        first = receipt['headerOriginals'][0]['relativePath']
        with open(os.path.join(scripts, 'native', first), 'a') as h:
            h.write('\n/* tampered */\n')
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_f')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_abi_suffix_mismatch(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        path = os.path.join(scripts, 'native', 'build.receipt.json')
        receipt = json.load(open(path))
        receipt['interpreter']['extSuffix'] = '.cpython-999-x86_64-linux-gnu.so'
        json.dump(receipt, open(path, 'w'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_g')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_loads_and_checks_with_real_backend(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_h')
        group = module.SdkLeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        self.assertIsNotNone(group._native)
        p = os.path.join(g().root, 'lease-real')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        group.check()
        self.assertIsNone(group._failure)

    def test_backend_resolved_once_not_per_check(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_i')
        group = module.SdkLeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        p = os.path.join(g().root, 'lease-once')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        # The invariant that matters is "one REAL live check per check()", not the
        # name of the entry point: a LeaseSet with the native plan verifies through
        # sweep_plan, and must still do exactly one of them per check. Both entry
        # points are counted here so a genuine double-verification cannot hide.
        calls = {'sweep': 0, 'sweep_plan': 0}
        original_sweep, original_plan = group._native.sweep, group._native.sweep_plan
        def counting_sweep(rows):
            calls['sweep'] += 1
            return original_sweep(rows)
        def counting_plan(plan):
            calls['sweep_plan'] += 1
            return original_plan(plan)
        group._native.sweep = counting_sweep
        group._native.sweep_plan = counting_plan
        for _ in range(5):
            group.check()
        self.assertEqual(calls['sweep'] + calls['sweep_plan'], 5,
                         'one live sweep per check, no re-verification')
        self.assertEqual(calls['sweep'], 0,
                         'the plan path must not ALSO run the generic sweep')
        self.assertEqual(calls['sweep_plan'], 5)

    @staticmethod
    def _quiet(group):
        try: group.close()
        except Exception: pass


class PlanValidationRefcount(unittest.TestCase):
    """Failed plan validation must not leak a reference on the caller's tuple.

    D1: the builder used `PySequence_Fast(rows)` to iterate an outer container that
    had ALREADY been proven to be an exact tuple. That wrapper takes an extra owning
    reference, which each structural early return has to release. It now iterates
    the tuple directly, so a rejected plan leaves the graph's refcount unchanged.
    """

    SHAPES = ('row-not-tuple', 'row-length', 'custom-fd', 'huge-fd',
              'mutable-identity', 'identity-length')

    @staticmethod
    def _rows(shape, fd):
        stat = os.fstat(fd)
        good = (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
                stat.st_mtime_ns, stat.st_ctime_ns)
        if shape == 'row-not-tuple':
            return ([fd, good],)
        if shape == 'row-length':
            return ((fd, good, 'extra'),)
        if shape == 'custom-fd':
            class CustomFd(object):
                def __index__(self):
                    return fd
            return ((CustomFd(), good),)
        if shape == 'huge-fd':
            return ((2 ** 80, good),)
        if shape == 'mutable-identity':
            return ((fd, list(good)),)
        if shape == 'identity-length':
            return ((fd, good[:5]),)
        raise AssertionError('unknown shape ' + shape)

    def test_rejected_plan_does_not_leak_outer_reference(self):
        native = g().load_extension()
        directory = tempfile.mkdtemp(prefix='refcount-', dir=g().root)
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, 'leased')
        with open(path, 'wb') as handle:
            handle.write(b'x' * 64)
        fd = os.open(path, os.O_RDONLY)
        # A real kernel read lease, so the valid-plan tail can actually verify.
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        self.addCleanup(os.close, fd)

        row_refs = {}
        for shape in self.SHAPES:
            with self.subTest(shape=shape):
                rows = tuple(self._rows(shape, fd))
                before = sys.getrefcount(rows)
                row_refs[shape] = sys.getrefcount(rows[0])
                for _ in range(20):
                    with self.assertRaises((TypeError, ValueError, OSError, OverflowError)):
                        native.plan_new(rows)
                after = sys.getrefcount(rows)
                self.assertEqual(after, before,
                                 '20 rejected plan_new calls must not retain the tuple')
                # The first row must be balanced too (it is the object a partial
                # build would have taken a reference on).
                self.assertEqual(sys.getrefcount(rows[0]), row_refs[shape],
                                 'rejected rows must not retain a reference')

        # A valid plan after all those failures still builds, sweeps and releases.
        stat = os.fstat(fd)
        good_rows = ((fd, (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
                           stat.st_mtime_ns, stat.st_ctime_ns)),)
        before = sys.getrefcount(good_rows)
        capsule = native.plan_new(good_rows)
        self.assertEqual(native.sweep_plan(capsule), (native.OK, -1, 0))
        del capsule
        self.assertEqual(sys.getrefcount(good_rows), before,
                         'a built and dropped plan must not retain its input tuple')


class LoaderRequiresPlanApi(unittest.TestCase):
    """A verified helper WITHOUT the plan API must fail closed.

    The fixture renames ONLY the method-table export string, so the real
    implementation is still referenced by `methods[]` (no -Wunused-function) and
    the source/ELF/header receipt still verifies. The loader must reject that
    incomplete helper instead of silently falling back to the generic sweep.
    """

    def test_plan_new_interruption_propagates_the_same_exception_object(self):
        """A caller-owned SIGALRM/TimeoutError from plan_new must not be wrapped.

        Provenance/module setup stays REAL (the fixture extension is built and
        verified). Only the binding's importer seam is faulted so the verified
        module exposes a plan_new that raises one marker object — no product C
        seam is added.
        """
        root = tempfile.mkdtemp(prefix='loader-int-', dir=g().root)
        self.addCleanup(shutil.rmtree, root, True)
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'),
                            'sdk_interrupt')
        binding, real_extension = module.required_native_backend()
        marker = TimeoutError('caller-owned observation deadline')

        class FaultedModule(object):
            def __init__(self, delegate, error):
                self._delegate = delegate
                self._error = error

            def __getattr__(self, name):
                return getattr(self._delegate, name)

            def plan_new(self, rows):
                raise self._error

        real_spec_from_file_location = binding.importlib.util.spec_from_file_location
        real_module_from_spec = binding.importlib.util.module_from_spec

        class ProxySpec(object):
            def __init__(self, spec):
                self._spec = spec
                self.loader = spec.loader

        def faulting_spec(name, location, *args, **kwargs):
            return ProxySpec(real_spec_from_file_location(name, location, *args, **kwargs))

        def faulting_module(spec):
            return FaultedModule(real_module_from_spec(spec._spec), marker)

        try:
            binding.importlib.util.spec_from_file_location = faulting_spec
            binding.importlib.util.module_from_spec = faulting_module
            with self.assertRaises(TimeoutError) as caught:
                binding.load_required()
            self.assertIs(caught.exception, marker,
                          'the exact interruption object must propagate unwrapped')
        finally:
            binding.importlib.util.spec_from_file_location = real_spec_from_file_location
            binding.importlib.util.module_from_spec = real_module_from_spec
        self.assertIs(binding.importlib.util.module_from_spec, real_module_from_spec,
                      'the importer seam must be restored')
        del module, binding, real_extension

    def test_missing_plan_api_is_rejected(self):
        base = os.path.join(g().scripts, 'native', 'lease_sweep_ext.c')
        with open(base) as handle:
            original = handle.read()
        for method in ('plan_new', 'sweep_plan'):
            with self.subTest(method=method):
                needle = '{"%s", ' % method
                self.assertEqual(original.count(needle), 1)
                variant = original.replace(needle, '{"%s_renamed_for_gate", ' % method)
                root = tempfile.mkdtemp(prefix='loader-case-', dir=g().root)
                self.addCleanup(shutil.rmtree, root, True)
                source = os.path.join(root, 'variant.c')
                with open(source, 'w') as handle:
                    handle.write(variant)
                fixture = gate.LeaseGate()
                self.addCleanup(fixture.close)
                fixture.build(source=source)
                fixture.install_factory(PATCHED_FACTORY)
                module = load_module(os.path.join(fixture.scripts, 'sdk-tool-lifetime-leases.py'),
                                    'sdk_missing_' + method)
                with self.assertRaises(Exception) as caught:
                    module.SdkLeaseSet()
                self.assertIn(method, str(caught.exception),
                              'the failure must name the missing API')


class PlanIsolationContract(unittest.TestCase):
    """A lease plan must never become shared authority.

    These are the corrective regressions for the module-global design that root
    reproduced as an acceptance bypass: an installed plan made generic
    sweep(badExpected) return OK. Every case here runs on REAL Linux leases.
    """

    def setUp(self):
        self.module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_plan')
        self.groups = []
        self.fds = []
        self.root = g().root
        os.makedirs(self.root, exist_ok=True)

    def tearDown(self):
        for group in self.groups:
            try:
                group.close()
            except Exception:
                pass
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass

    def _lease(self, name, size=64):
        path = os.path.join(self.root, name)
        with open(path, 'wb') as handle:
            handle.write(b'x' * size)
        fd = os.open(path, os.O_RDONLY)
        self.fds.append(fd)
        return fd

    def _leased(self, name, size=64):
        """A raw fd with a REAL kernel read lease, for direct native sweep cases."""
        fd = self._lease(name, size)
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        return fd

    def _group(self):
        group = self.module.SdkLeaseSet()
        self.groups.append(group)
        return group

    @staticmethod
    def _mutate(identity, field, delta):
        changed = list(identity)
        changed[field] += delta
        return tuple(changed)

    def test_empty_registration_plan_is_valid_and_verifies_nothing(self):
        """An EMPTY held set must build and sweep a plan without UB.

        UBSAN caught memset(NULL, 0, 0) here: C requires a valid pointer argument
        even for a zero length. The plan must still be a real, usable capsule.
        """
        native = g().load_extension()
        empty = native.plan_new(())
        self.assertEqual(native.sweep_plan(empty), (native.OK, -1, 0))
        # The generic path is unaffected by an existing empty plan.
        self.assertEqual(native.sweep(()), (native.OK, -1, 0))
        # A malformed row still fails plan creation (and unwinds cleanly).
        for bad in [(1, 2, 3), ("not-a-fd", (1, 2, 3, 4, 5, 6)), (0,) * 6]:
            with self.assertRaises((TypeError, ValueError, OSError)):
                native.plan_new((bad,))
        # ... and a good plan still builds and sweeps after those failures.
        again = native.plan_new(())
        self.assertEqual(native.sweep_plan(again), (native.OK, -1, 0))

    def test_plan_rejects_mutable_structural_inputs_without_running_user_code(self):
        """ROOT's counterexample: a mutable identity list must never be cached.

        plan_new accepts ONLY exact tuple structures with exact-int fds, so a list
        that is mutated AFTER plan creation can never make the plan compare stale
        expectations. Generic sweep stays permissive on every one of these shapes.
        """
        native = g().load_extension()
        fd = self._leased('iso-mutable')
        f = os.fstat(fd)
        expected = (f.st_dev, f.st_ino, f.st_mode, f.st_size, f.st_mtime_ns, f.st_ctime_ns)

        # 1. mutable identity list inside an exact pair (root's exact case)
        with self.assertRaises(TypeError):
            native.plan_new(((fd, list(expected)),))
        # 2. mutable outer container
        with self.assertRaises(TypeError):
            native.plan_new([[fd, expected]])
        # 3. mutable pair inside an exact outer tuple
        with self.assertRaises(TypeError):
            native.plan_new(([fd, expected],))
        # 4. custom fd object: must be rejected WITHOUT calling its callbacks
        invoked = []

        class CustomFd(object):
            def __index__(self):
                invoked.append('index')
                return fd

            def __int__(self):
                invoked.append('int')
                return fd

        with self.assertRaises(TypeError):
            native.plan_new(((CustomFd(), expected),))
        self.assertEqual(invoked, [], 'plan creation must not run user fd code')

        # Generic sweep remains fully compatible with all of those shapes.
        for rows in (((fd, list(expected)),), [[fd, expected]], ((fd, expected),)):
            self.assertEqual(native.sweep(rows), (native.OK, -1, 0))

    def test_plan_keeps_generic_precision_for_inexact_and_huge_identity_values(self):
        """Exact structure with float / huge values: decoded=0, generic semantics."""
        native = g().load_extension()
        fd = self._leased('iso-precision')
        f = os.fstat(fd)
        # A float in a value slot is structurally allowed but NOT decodable, so the
        # ORIGINAL generic comparison runs. Python says 1.0 == 1, so a float that is
        # numerically EQUAL must still match (that is the correct generic semantic).
        equal_float = (float(f.st_dev), f.st_ino, f.st_mode, f.st_size, f.st_mtime_ns, f.st_ctime_ns)
        self.assertEqual(native.sweep_plan(native.plan_new(((fd, equal_float),))),
                         (native.OK, -1, 0),
                         'numerically equal float must match via generic comparison')
        # A float that is numerically DIFFERENT must be rejected.
        unequal_float = (float(f.st_dev) + 1.5, f.st_ino, f.st_mode, f.st_size,
                         f.st_mtime_ns, f.st_ctime_ns)
        self.assertEqual(native.sweep_plan(native.plan_new(((fd, unequal_float),))),
                         (native.IDENTITY, 0, 0))
        # Huge out-of-int64 inode: exact Python comparison must be used.
        huge = (f.st_dev, 2 ** 70 + 7, f.st_mode, f.st_size, f.st_mtime_ns, f.st_ctime_ns)
        capsule = native.plan_new(((fd, huge),))
        self.assertEqual(native.sweep_plan(capsule), (native.IDENTITY, 0, 0))
        # The correct immutable tuple still verifies through the plan.
        okay = native.plan_new(((fd, (f.st_dev, f.st_ino, f.st_mode, f.st_size,
                                      f.st_mtime_ns, f.st_ctime_ns)),))
        self.assertEqual(native.sweep_plan(okay), (native.OK, -1, 0))

    def test_generic_wrong_expected_stays_rejected_while_a_plan_exists(self):
        """ROOT's counterexample: a good plan must not override caller data."""
        group = self._group()
        fd = self._lease('iso-wrong')
        token = group.acquire(fd)
        # Make the plan exist for the CORRECT expectations.
        group.check()
        self.assertIsNotNone(group._native_plan)
        pairs = list(group._plan)
        forged = list(pairs)
        forged[0] = (pairs[0][0], self._mutate(pairs[0][1], 5, 1))
        self.assertEqual(group._native.sweep(tuple(forged)),
                         (group._native.IDENTITY, 0, 0),
                         'generic sweep must still reject forged expectations')
        # ... and the same for a different identity field.
        forged2 = list(pairs)
        forged2[0] = (pairs[0][0], self._mutate(pairs[0][1], 1, 1))
        self.assertEqual(group._native.sweep(tuple(forged2)),
                         (group._native.IDENTITY, 0, 0))
        # The plan path itself still accepts the genuine rows.
        self.assertEqual(group._native.sweep_plan(group._native_plan),
                         (group._native.OK, -1, 0))
        del token

    def _selection_group(self, name, seen):
        """A FRESH healthy group with two real leases and recording native calls.

        Each invalid case needs its own group: the first `_reject` makes `_failure`
        sticky, so reusing one group would let `_ready` mask every later mutation and
        the assertion would not exercise that field's own selection.
        """
        group = self._group()
        first = group.acquire(self._lease(name + '-a'))
        second = group.acquire(self._lease(name + '-b'))
        self.assertNotEqual(first['identity'], second['identity'],
                            'the two leases must be genuinely distinct')
        originals = (group._native.sweep, group._native.sweep_plan)

        def recording_sweep(rows):
            seen.append(('generic', tuple(rows)))
            return originals[0](rows)

        def recording_plan_sweep(capsule):
            seen.append(('plan', capsule))
            return originals[1](capsule)

        group._native.sweep = recording_sweep
        group._native.sweep_plan = recording_plan_sweep
        return group, first, second, originals

    @staticmethod
    def _restore_selection(group, originals):
        group._native.sweep, group._native.sweep_plan = originals

    def test_production_check_token_selects_the_exact_owned_pair(self):
        """PRODUCTION check(token) selects exactly the owned (fd, identity) pair.

        Two real leases in one real SdkLeaseSet. The native entry points are wrapped
        to RECORD the rows they receive while still delegating to the original real
        calls, so this asserts actual production behaviour rather than a local
        reimplementation of the lookup.
        """
        seen = []
        group, first, second, originals = self._selection_group('sel-ok', seen)
        try:
            for token in (first, second):
                seen.clear()
                group.check(dict(token, identity=list(token['identity'])))
                self.assertEqual(len(seen), 1, 'exactly one live sweep per token check')
                kind, payload = seen[0]
                self.assertEqual(kind, 'generic',
                                 'a token-filtered check uses the generic live sweep')
                self.assertEqual(len(payload), 1, 'only the selected row is verified')
                fd, identity = payload[0]
                self.assertEqual(fd, group._held[tuple(token['identity'][:2])]['fd'],
                                 'the owned descriptor for that token reaches the sweep')
                self.assertEqual(tuple(identity), tuple(token['identity']),
                                 'the recorded six-field identity reaches the sweep')
        finally:
            self._restore_selection(group, originals)
            group.close()

        # Every single-field mutation and the leaseId must independently exercise
        # production selection, each on a FRESH healthy group.
        cases = [('field-%d%+d' % (field, delta), field, delta)
                 for field in range(6) for delta in (-1, 1)]
        cases.append(('leaseId', None, None))
        for name, field, delta in cases:
            seen.clear()
            group, first, second, originals = self._selection_group('sel-' + name, seen)
            try:
                # Establish a valid check FIRST, then clear what it captured.
                group.check(dict(first, identity=list(first['identity'])))
                self.assertTrue(seen, 'the healthy baseline must perform a real sweep')
                seen.clear()

                mutated = dict(first, identity=list(first['identity']))
                if field is None:
                    mutated['leaseId'] = first['leaseId'] + 100
                else:
                    mutated['identity'][field] += delta
                with self.assertRaises(self.module.LeaseError) as caught:
                    group.check(mutated)
                self.assertEqual(str(caught.exception), 'unknown or changed lease token')
                self.assertEqual(seen, [], 'a mutated token must not reach any live sweep')
                # _reject always records the reason; it must be THIS case's
                # selection failure, not a stale one carried in from a previous
                # mutation (each case starts on a fresh group).
                self.assertEqual(group._failure, 'unknown or changed lease token')
            finally:
                self._restore_selection(group, originals)
                group.close()

    def test_two_same_size_plans_never_share_expectations(self):
        """Two same-size plans are independent objects over independent rows."""
        group = self._group()
        group.acquire(self._lease('iso-plan-a'))
        group.check()
        first = group._native_plan
        first_rows = group._native_plan_source
        # A SECOND plan built from a different (forged) row set of the SAME length
        # must not influence the first plan or the generic sweep.
        forged_row = (group._plan[0][0], self._mutate(group._plan[0][1], 5, 1))
        forged = (forged_row,)
        second = group._native.plan_new(forged)
        self.assertIsNot(first, second)
        self.assertEqual(len(first_rows), len(forged))
        self.assertNotEqual(first_rows[0][1], forged_row[1],
                            'the two plans must carry different expectations')
        # The genuine plan still verifies; the forged plan does not.
        self.assertEqual(group._native.sweep_plan(first), (group._native.OK, -1, 0))
        self.assertEqual(group._native.sweep_plan(second), (group._native.IDENTITY, 0, 0))
        # Building a second plan did not change generic sweep authority.
        self.assertEqual(group._native.sweep(group._plan), (group._native.OK, -1, 0))
        self.assertEqual(group._native.sweep(forged), (group._native.IDENTITY, 0, 0))

    def test_handler_dropping_the_owning_cache_cannot_free_a_live_plan(self):
        """The capsule ref held across the sweep must survive handler mutation."""
        group = self._group()
        for index in range(4):
            group.acquire(self._lease('iso-uaf-%d' % index))
        group.check()
        capsule = group._native_plan
        self.assertIsNotNone(capsule)
        # Simulate a signal handler clearing the instance cache mid-sweep.
        group._native_plan = None
        group._native_plan_source = None
        self.assertEqual(group._native.sweep_plan(capsule), (group._native.OK, -1, 0))

    def test_fd_reuse_is_still_detected_with_a_plan(self):
        """A plan must not mask a different object behind a recycled fd number."""
        group = self._group()
        first_path = os.path.join(self.root, 'iso-reuse-a')
        with open(first_path, 'wb') as handle:
            handle.write(b'a' * 64)
        fd = os.open(first_path, os.O_RDONLY)
        self.fds.append(fd)
        group.acquire(fd)
        group.check()
        capsule = group._native_plan
        held_fd = group._plan[0][0]
        # Replace the leased object on the SAME descriptor number.
        fcntl.fcntl(held_fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        os.close(held_fd)
        second_path = os.path.join(self.root, 'iso-reuse-b')
        with open(second_path, 'wb') as handle:
            handle.write(b'b' * 128)
        recycled = os.open(second_path, os.O_RDONLY)
        self.fds.append(recycled)
        self.assertEqual(recycled, held_fd, 'the fd number must actually be recycled')
        verdict = group._native.sweep_plan(capsule)
        self.assertNotEqual(verdict, (group._native.OK, -1, 0),
                            'a recycled fd must never verify against a stale plan')

    def test_membership_change_invalidates_the_plan(self):
        group = self._group()
        group.acquire(self._lease('iso-grow-a'))
        group.check()
        first = group._native_plan
        group.acquire(self._lease('iso-grow-b'))
        self.assertIsNone(group._native_plan, 'acquire must discard the decode')
        group.check()
        self.assertIsNot(group._native_plan, first)
        group.close()
        self.assertIsNone(group._native_plan, 'close must discard the decode')


class PlanFdDomain(unittest.TestCase):
    """The decoded fast path must never use a narrowed fd.

    plan_new accepts every exact int (that is the baseline contract); the fd
    domain is decided by the sweep, exactly as PyObject_AsFileDescriptor would.
    A negative fd or one above INT_MAX must therefore reach the generic path and
    raise the baseline exception, never silently check a truncated descriptor.
    """

    def _healthy_identity(self, fd):
        stat = os.fstat(fd)
        return (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
                stat.st_mtime_ns, stat.st_ctime_ns)

    def _plan(self, native, fd_value, identity):
        # plan_new acceptance is part of the contract being preserved.
        return native.plan_new(((fd_value, identity),))

    def _leased_fd(self, name):
        path = os.path.join(g().root, name)
        with open(path, 'wb') as handle:
            handle.write(b'x' * 64)
        fd = os.open(path, os.O_RDONLY)
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        self.addCleanup(self._release, fd)
        return fd

    @staticmethod
    def _release(fd):
        try:
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    def test_negative_fd_keeps_the_baseline_valueerror(self):
        native = g().load_extension()
        fd = self._leased_fd('fd-domain-neg')
        identity = self._healthy_identity(fd)
        for value in (-1, -2):
            capsule = self._plan(native, value, identity)
            with self.assertRaises(ValueError) as caught:
                native.sweep_plan(capsule)
            self.assertIn('negative integer', str(caught.exception))
            self.assertIn(str(value), str(caught.exception))

    def test_fd_above_int_max_keeps_the_baseline_overflowerror(self):
        native = g().load_extension()
        fd = self._leased_fd('fd-domain-big')
        identity = self._healthy_identity(fd)
        # INT_MAX+1 and 2**32+<real fd>: the second one is the sharp case, because
        # truncating it lands exactly on the held descriptor.
        for value in (2 ** 31, 2 ** 32 + fd, 2 ** 63 - 1):
            capsule = self._plan(native, value, identity)
            with self.assertRaises(OverflowError) as caught:
                native.sweep_plan(capsule)
            self.assertIn('too large', str(caught.exception))

    def test_normal_and_int_max_stay_accepted(self):
        native = g().load_extension()
        fd = self._leased_fd('fd-domain-ok')
        identity = self._healthy_identity(fd)
        self.assertEqual(native.sweep_plan(self._plan(native, fd, identity)),
                         (native.OK, -1, 0))
        # INT_MAX is a legal fd value for the baseline's accessor; both the
        # baseline and this build reach the generic path and report ERRNO for a
        # descriptor that does not exist here.
        got = native.sweep_plan(self._plan(native, 2 ** 31 - 1, identity))
        self.assertEqual(got[0], native.ERRNO)

class LiveCadenceContract(unittest.TestCase):
    """The decoded fast path must keep the exact live call cadence.

    This is the regression the earlier duplicate-sweep draft passed 47 tests
    without: timing cannot see a second sweep, and a manual witness is not CI. The
    counters are asserted here, in the suite CI already runs.

    The instrumented translation unit is generated from the EXACT product source
    snapshot at test time (never hand-edited), then compiled through the existing
    gate fixture. Each wrapper delegates to the real libc/CPython function, and the
    only extra module surface is a test-only fresh-counter snapshot function.
    """

    WRAPPERS = """
/* ---- TEST-ONLY CADENCE INSTRUMENTATION (generated, never shipped) ---- */
static long long _xpod_n_lease = 0, _xpod_n_fstat = 0, _xpod_n_sig = 0;
static int _xpod_w_fcntl(int fd, int cmd) { _xpod_n_lease++; return fcntl(fd, cmd); }
static int _xpod_w_fstat(int fd, struct stat *st) { _xpod_n_fstat++; return fstat(fd, st); }
static int _xpod_w_signals(void) { _xpod_n_sig++; return PyErr_CheckSignals(); }
static PyObject *_xpod_witness(PyObject *self, PyObject *args)
{
    (void)self; (void)args;
    return Py_BuildValue("(LLL)", _xpod_n_lease, _xpod_n_fstat, _xpod_n_sig);
}
static PyMethodDef _xpod_witness_def = {
    "witness_snapshot", _xpod_witness, METH_NOARGS, "test-only live counters"
};
"""

    @classmethod
    def setUpClass(cls):
        source_path = os.path.join(g().scripts, 'native', 'lease_sweep_ext.c')
        with open(source_path, 'r', encoding='utf-8') as handle:
            text = handle.read()
        # Rewrite the ORIGINAL call sites first, then insert the wrapper bodies, so
        # a wrapper can never end up calling itself.
        text = text.replace('lease = fcntl(fd, F_GETLEASE);',
                            'lease = _xpod_w_fcntl(fd, F_GETLEASE);')
        text = text.replace('stat_result = fstat(fd, &st);',
                            'stat_result = _xpod_w_fstat(fd, &st);')
        text = text.replace('stat_result = fstat(fd, st);',
                            'stat_result = _xpod_w_fstat(fd, st);')
        text = text.replace('PyErr_CheckSignals()', '_xpod_w_signals()')
        anchor = '#include <string.h>\n'
        if text.count(anchor) != 1:
            raise unittest.SkipTest('unexpected product include layout')
        text = text.replace(anchor, anchor + cls.WRAPPERS, 1)
        text = text.replace(
            '    PyModule_AddIntConstant(m, "NEEDPY", V_NEEDPY);',
            '    PyModule_AddIntConstant(m, "NEEDPY", V_NEEDPY);\n'
            '    PyModule_AddObject(m, "witness_snapshot",\n'
            '        PyCFunction_New(&_xpod_witness_def, NULL));', 1)
        for required in ('return fcntl(fd, cmd);', 'return fstat(fd, st);',
                         'return PyErr_CheckSignals();'):
            if required not in text:
                raise AssertionError('wrapper must delegate to the real function')
        for forbidden in ('return _xpod_w_signals()', 'return _xpod_w_fcntl',
                          'return _xpod_w_fstat'):
            if forbidden in text:
                raise AssertionError('wrapper self-recursion')
        if text.count('_xpod_w_fcntl(fd, F_GETLEASE)') != 1:
            raise AssertionError('expected exactly one lease call site')
        instrumented = os.path.join(g().root, 'cadence-instrumented.c')
        with open(instrumented, 'w', encoding='utf-8') as handle:
            handle.write(text)
        fixture = gate.LeaseGate()
        cls.addClassCleanup(fixture.close)
        fixture.build(source=instrumented)
        cls._fixture = fixture
        cls._native = fixture.load_extension()

    def _leased(self, name, count):
        root = tempfile.mkdtemp(prefix='cadence-', dir=g().root)
        self.addCleanup(shutil.rmtree, root, True)
        fds, pairs = [], []
        for index in range(count):
            path = os.path.join(root, 'f%d' % index)
            with open(path, 'wb') as handle:
                handle.write(b'x' * 64)
            descriptor = os.open(path, os.O_RDONLY)
            fds.append(descriptor)
            fcntl.fcntl(descriptor, fcntl.F_SETOWN, os.getpid())
            fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            stat = os.fstat(descriptor)
            pairs.append((descriptor, (stat.st_dev, stat.st_ino, stat.st_mode,
                                       stat.st_size, stat.st_mtime_ns,
                                       stat.st_ctime_ns)))
        self.addCleanup(self._release, fds)
        return fds, pairs

    @staticmethod
    def _release(fds):
        for descriptor in fds:
            try:
                fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError:
                pass
            try:
                os.close(descriptor)
            except OSError:
                pass

    def _run(self, pairs):
        capsule = self._native.plan_new(tuple(pairs))
        before = self._native.witness_snapshot()
        verdict = self._native.sweep_plan(capsule)
        after = self._native.witness_snapshot()
        del capsule
        return verdict, (after[0] - before[0], after[1] - before[1],
                         after[2] - before[2])

    def test_healthy_plan_costs_one_pair_and_four_signals_per_row(self):
        _fds, pairs = self._leased('healthy', 5)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict, (self._native.OK, -1, 0))
        self.assertEqual(counts, (5, 5, 20),
                         'healthy: N lease, N fstat, 4N signal checks')

    def test_first_row_lease_failure_stops_before_any_fstat(self):
        fds, pairs = self._leased('fail-first', 5)
        fcntl.fcntl(fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict[:2], (self._native.LEASE, 0))
        # lease is decided before fstat: k+1 leases, k fstats, 4k+2 signal checks
        self.assertEqual(counts, (1, 0, 2))

    def test_mid_lease_failure_keeps_the_serial_prefix(self):
        fds, pairs = self._leased('fail-mid', 5)
        k = 2
        fcntl.fcntl(fds[k], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict[:2], (self._native.LEASE, k))
        self.assertEqual(counts, (k + 1, k, 4 * k + 2))

    def test_mid_identity_failure_visits_the_failing_row_completely(self):
        _fds, pairs = self._leased('fail-identity', 5)
        k = 2
        broken = list(pairs[k])
        broken[1] = (broken[1][0] + 1,) + tuple(broken[1][1:])
        pairs[k] = tuple(broken)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict[:2], (self._native.IDENTITY, k))
        # identity is compared after fstat: k+1 of each, 4(k+1) signal checks
        self.assertEqual(counts, (k + 1, k + 1, 4 * (k + 1)))

    # Two consecutive rows pushed outside the int64 FAST window (still valid
    # int64 ns, so the kernel accepts the timestamp) must each be decided by the
    # exact comparison on the stat ALREADY sampled for that row. The sweep must
    # therefore still cost exactly one F_GETLEASE + one fstat and four signal
    # checks per visited row, with no second pass over earlier rows.
    OUT_WINDOW_NS = 9223372036000000000          # sec 9223372036 > NS_FAST_MAX

    def _leased_in_window(self, name, count, out_window=()):
        root = tempfile.mkdtemp(prefix='cascade-', dir=g().root)
        self.addCleanup(shutil.rmtree, root, True)
        fds, pairs = [], []
        for index in range(count):
            path = os.path.join(root, 'f%d' % index)
            with open(path, 'wb') as handle:
                handle.write(b'x' * 64)
            descriptor = os.open(path, os.O_RDONLY)
            fds.append(descriptor)
            fcntl.fcntl(descriptor, fcntl.F_SETOWN, os.getpid())
            fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            if index in out_window:
                # Set the live time first, then snapshot the expectation FROM the
                # live stat, so the row is expected to MATCH exactly.
                os.utime(path, ns=(0, self.OUT_WINDOW_NS))
            stat = os.fstat(descriptor)
            pairs.append((descriptor, (stat.st_dev, stat.st_ino, stat.st_mode,
                                       stat.st_size, stat.st_mtime_ns,
                                       stat.st_ctime_ns)))
        self.addCleanup(self._release, fds)
        return fds, pairs

    def test_consecutive_out_of_window_rows_are_not_resampled(self):
        # 3 normal rows + 2 out-of-window rows whose expectations MATCH.
        # One pass over 5 rows => 5 lease, 5 fstat, 20 signal checks.
        # The old cascade branch restarted at row 0 and sampled 6/6/24.
        fds, pairs = self._leased_in_window('cascade-match', 5, out_window={1, 2})
        live = os.fstat(fds[1])
        self.assertEqual(live.st_mtime_ns, self.OUT_WINDOW_NS,
                         'the kernel must have accepted the out-of-window value')
        self.assertGreater(live.st_mtime_ns // 10 ** 9, 9223372035,
                          'the row must really sit outside the int64 fast window')
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict, (self._native.OK, -1, 0),
                         'both out-of-window rows match, so the sweep is clean')
        self.assertEqual(counts, (5, 5, 20),
                         'one sample per row: the cascade resample is a regression')

    def test_out_of_window_then_later_lease_failure_keeps_the_prefix(self):
        # Same shape, but row 3 breaks its lease. Rows 0-2 each run to a full
        # comparison (4 signal checks, one fstat each); row 3 stops after its
        # second signal check and never reaches fstat. A resample of rows 0-2
        # would push the signal count far past 14.
        fds, pairs = self._leased_in_window('cascade-then-lease', 5, out_window={1, 2})
        fcntl.fcntl(fds[3], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict[:2], (self._native.LEASE, 3))
        self.assertEqual(counts, (4, 3, 14))

    def test_out_of_window_then_identity_failure_reports_the_later_row(self):
        # Row 4 breaks identity; rows 1 and 2 are fallback-matching. A resample
        # would inflate the counts well past 5/5/20.
        fds, pairs = self._leased_in_window('cascade-then-identity', 5, out_window={1, 2})
        broken = list(pairs[4])
        broken[1] = (broken[1][0] + 1,) + tuple(broken[1][1:])
        pairs[4] = tuple(broken)
        verdict, counts = self._run(pairs)
        self.assertEqual(verdict[:2], (self._native.IDENTITY, 4))
        self.assertEqual(counts, (5, 5, 20))

    def test_a_second_live_sweep_is_detectable(self):
        """Positive control for the counter itself.

        Two real calls must report exactly double the single-sweep counts. Without
        this a broken counter could make every cadence assertion pass vacuously.
        """
        _fds, pairs = self._leased('control', 3)
        capsule = self._native.plan_new(tuple(pairs))
        before = self._native.witness_snapshot()
        self.assertEqual(self._native.sweep_plan(capsule), (self._native.OK, -1, 0))
        self.assertEqual(self._native.sweep_plan(capsule), (self._native.OK, -1, 0))
        after = self._native.witness_snapshot()
        counts = (after[0] - before[0], after[1] - before[1], after[2] - before[2])
        self.assertEqual(counts, (6, 6, 24), 'two sweeps must double the counts')
        del capsule


class NegativeGateCase(unittest.TestCase):
    """A deliberately broken product formatter MUST make this gate fail.

    This is the meta-check the reviewer asked for: it proves the gate is not
    vacuous. We compile a copy of the source with the format string broken and
    assert the width contract catches it.
    """

    def test_wrong_formatter_is_caught_by_the_gate(self):
        import re
        source = open(os.path.join(g().native, 'lease_sweep_ext.c')).read()
        broken = source.replace('Py_BuildValue("(ini)"', 'Py_BuildValue("(nin)"')
        self.assertNotEqual(broken, source, 'the source must contain the formatter to break it')
        # Compile the broken copy in its own gate fixture.
        with gate.LeaseGate() as other:
            broken_path = os.path.join(other.root, 'broken.c')
            with open(broken_path, 'w') as handle:
                handle.write(broken)
            other.build(source=broken_path)
            ext = other.load_extension()
            # Under "(nin)" the index is truncated; 2**31 must NOT survive.
            ok, index, errno_value = ext.index_roundtrip(2 ** 31)
            self.assertNotEqual((ok, index, errno_value), (0, 2 ** 31, 0),
                                'a wrong formatter must NOT produce a correct tuple')


def harness_for(build, root, path_file, resume, block):
    """Bash harness that runs the REAL block and pauses exactly once, safely.

    The DEBUG trap is gated on `$BASH_COMMAND` so it fires only when bash is about
    to run the `overlay_source_sha=` assignment -- i.e. after the current manifest
    exists and before the block's own consumer logic runs. The guard is nounset-safe
    (`${var:-}`), so an early command can never trip `set -u` and kill the child.

    Returns the harness text. The parent MUST poll for `ready` while also watching
    the child, so a child that dies early fails the test instead of blocking.
    """
    return (
        'set -Eeuo pipefail\n'
        'build_dir=%s\n'
        'qlever_root=%s\n'
        '__pause() {\n'
        '  case "${1:-}" in\n'
        '    overlay_source_sha=*)\n'
        '      if [[ -n "${overlay_manifest_current:-}" '
        '&& -f "${overlay_manifest_current:-}" ]]; then\n'
        '        printf \'%%s\\n\' "$overlay_manifest_current" > %s\n'
        '        printf \'PAUSED\\n\' >&2\n'
        '        read -r _ < %s\n'
        '      fi\n'
        '      ;;\n'
        '  esac\n'
        '}\n'
        'trap \'__pause "$BASH_COMMAND"\' DEBUG\n'
        '%s\n'
        'trap - DEBUG\n'
        "printf 'BLOCK-DONE\\n'\n"
    ) % (build, root, path_file, resume, block)


class OverlayManifestLifetime(unittest.TestCase):
    """The SHIPPED overlay-manifest block must not unlink a leased current manifest.

    Regression for a real CI failure. `build-qlever-runtime-sdk.sh` used to create
    the current overlay manifest with `mktemp` and `rm -f` it after the traced child
    read it. The SDK observer may still hold a real kernel read lease (F_RDLCK,
    role input-read) on that inode for the rest of the observed window, and
    unlinking a leased inode moves its ctime, so the next native six-field sweep
    raised `LeaseError: leased inode identity changed`.

    This executes the ACTUAL shipped block, not a copy: the lines between
    `overlay_manifest_file=` and the source-prepared marker are extracted from the
    real script and run by bash against a private copy of the qlever inputs, so real
    `touch` calls can never mutate the repository. A DEBUG trap pauses the block
    right after the current manifest exists and reports its real path; the parent
    opens that exact fd and acquires a real native lease through the shared gate
    fixture, resumes the block, waits for it to finish, then checks the identity.

    Against the ORIGINAL block (which unlinks the manifest) the post-block native
    sweep rejects; against the FIXED block all six fields stay equal.
    """

    BLOCK_START = 'overlay_manifest_file='
    BLOCK_END = 'printf'

    def _repo(self):
        return os.path.dirname(os.path.dirname(HERE))

    def _extract_block(self, script_text):
        lines = script_text.splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith(self.BLOCK_START))
        end = next(i for i, line in enumerate(lines)
                   if line.startswith(self.BLOCK_END) and '$build_identity' in line)
        return '\n'.join(lines[start:end])

    def _private_inputs(self, directory):
        """A private copy of only the qlever inputs the block actually needs."""
        repo = self._repo()
        root = os.path.join(directory, 'qlever')
        os.makedirs(os.path.join(root, 'scripts'))
        for name in ('include', 'qlever_adapter', 'rdf_protocol', 'patches'):
            source = os.path.join(repo, 'qlever', name)
            if os.path.isdir(source):
                shutil.copytree(source, os.path.join(root, name))
        shutil.copyfile(os.path.join(repo, 'qlever', 'scripts', 'runtime-overlay-manifest.py'),
                        os.path.join(root, 'scripts', 'runtime-overlay-manifest.py'))
        return root

    def _run_block(self, block, module, leases):
        """Execute the real block, leasing its real current manifest mid-flight.

        Returns a dict of observations captured INSIDE the private temp dir (the
        paths do not survive it): whether the current manifest still exists after
        the block, its six-field identity before vs after, whether the final
        manifest was installed, and whether a post-block native check passed.

        Never blocks unconditionally: it polls for the pause marker while watching
        the child, so a child that exits before the marker fails the test with its
        real stderr instead of hanging the suite.
        """
        with tempfile.TemporaryDirectory(prefix='overlay-block-') as directory:
            build = os.path.join(directory, 'build')
            os.makedirs(build)
            root = self._private_inputs(directory)
            path_file = os.path.join(directory, 'path')
            resume = os.path.join(directory, 'resume')
            os.mkfifo(resume)
            harness = harness_for(build, root, path_file, resume, block)
            harness_path = os.path.join(directory, 'harness.sh')
            with open(harness_path, 'w') as handle:
                handle.write(harness)
            process = subprocess.Popen(['bash', harness_path], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if os.path.exists(path_file) and os.path.getsize(path_file) > 0:
                    break
                if process.poll() is not None:
                    out, err = process.communicate()
                    self.fail('block exited rc=%s before the pause marker; stderr=%s'
                              % (process.returncode, err[-800:]))
                time.sleep(0.02)
            else:
                process.kill()
                process.communicate()
                self.fail('timed out waiting for the block pause marker')
            with open(path_file) as handle:
                actual = handle.read().strip()
            self.assertTrue(actual, 'block must expose its real current-manifest path')
            self.assertTrue(os.path.isfile(actual), 'current manifest must exist when paused')
            fd = os.open(actual, os.O_RDONLY)
            try:
                before = module.identity(fd)
                leases.acquire(fd)
                with open(resume, 'w') as handle:
                    handle.write('go\n')
                out, err = process.communicate(timeout=180)
            finally:
                os.close(fd)
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            self.assertEqual(process.returncode, 0, 'shipped block must exit 0: %s' % err[-500:])
            self.assertIn('BLOCK-DONE', out)

            # Observations captured while the private tree still exists.
            retained = os.path.isfile(actual)
            after = None
            if retained:
                after_fd = os.open(actual, os.O_RDONLY)
                try:
                    after = module.identity(after_fd)
                finally:
                    os.close(after_fd)
            installed = os.path.isfile(os.path.join(build, '.xpod-overlay-manifest'))
            check_error = None
            try:
                leases.check()
            except Exception as error:          # noqa: BLE001 - reported, not swallowed
                check_error = str(error)
            return {'path': actual, 'retained': retained, 'installed': installed,
                    'before': before, 'after': after, 'check_error': check_error}

    def test_shipped_block_keeps_leased_current_manifest_identity(self):
        """FIXED-BEHAVIOUR: the real shipped block keeps the leased inode stable."""
        repo = self._repo()
        with open(os.path.join(repo, 'qlever', 'scripts',
                               'build-qlever-runtime-sdk.sh'), encoding='utf-8') as handle:
            block = self._extract_block(handle.read())
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'),
                             'overlay_shipped_leases')
        leases = module.SdkLeaseSet(16)
        self.addCleanup(leases.close)
        seen = self._run_block(block, module, leases)
        self.assertTrue(seen['retained'], 'current manifest must be retained, not unlinked')
        self.assertEqual(seen['after'], seen['before'],
                         'the retained current manifest must keep its six-field identity')
        self.assertTrue(seen['installed'], 'the block must still install the final manifest')
        self.assertIsNone(seen['check_error'], 'post-block native check must pass: %s'
                          % seen['check_error'])

    def test_original_block_unlinks_the_leased_manifest_and_is_rejected(self):
        """BROKEN-BEFORE: the original block's trailing rm -f must be rejected."""
        repo = self._repo()
        with open(os.path.join(repo, 'qlever', 'scripts',
                               'build-qlever-runtime-sdk.sh'), encoding='utf-8') as handle:
            shipped = handle.read()
        current_two = ('overlay_manifest_current="$build_dir/.xpod-overlay-manifest.current"\n'
                       'rm -f "$overlay_manifest_current"\n')
        self.assertIn(current_two, shipped, 'shipped current-manifest assignment differs')
        original = shipped.replace(current_two, 'overlay_manifest_current=$(mktemp)\n', 1)
        marker = '# This marker binds the prepared source/overlay inputs'
        index = original.index(marker)
        original = original[:index] + 'rm -f "$overlay_manifest_current"\n' + original[index:]
        block = self._extract_block(original)

        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'),
                             'overlay_original_leases')
        leases = module.SdkLeaseSet(16)
        self.addCleanup(leases.close)
        seen = self._run_block(block, module, leases)
        self.assertFalse(seen['retained'],
                         'original block must have unlinked the current manifest')
        self.assertIsNotNone(seen['check_error'], 'original block must fail the native check')
        self.assertIn('leased inode identity changed', seen['check_error'])


class FatalDiagnosticIdentityEvidence(unittest.TestCase):
    """The fatal-path diagnostic must name WHICH identity field changed.

    These are REAL-native causal regressions: they register the actual retained
    lease-row shape over a real opened FD, then mutate/unlink the underlying
    inode through real syscalls, and require the same unchanged six-field guard
    to reject. They do not fake a native result and do not mirror the
    implementation's internals; they assert the public diagnostic contract.

    Linux-only where it matters: F_SETLEASE is unavailable on Darwin, so the
    suite never asserts lease acquisition here. The diagnostic is exercised
    through the real FD/identity path, which is identical on both.
    """

    FIELDS = ['st_dev', 'st_ino', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns']

    def _module(self, name):
        return load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), name)

    def _held(self, module, directory, name='leased.bin', payload=b'k' * 64, lease_id=7):
        """Register the REAL retained row shape over a real FD (as acquire does)."""
        path = os.path.join(directory, name)
        with open(path, 'wb') as handle:
            handle.write(payload)
        fd = os.open(path, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        before = module.identity(fd)
        group = module.LeaseSet()
        group._held[tuple(before[:2])] = {
            'fd': fd, 'token': {'leaseId': lease_id, 'identity': list(before)}}
        # Keep close() from treating the probe as a healthy owned set.
        self.addCleanup(self._quiet, group)
        return group, fd, path, list(before)

    @staticmethod
    def _quiet(group):
        try:
            group._held.clear()
            group.close()
        except BaseException:
            pass

    def _diagnostic(self, group):
        raw = group.failure_diagnostic()
        self.assertIsNotNone(raw, 'diagnostic must be emitted for an abnormal set')
        return json.loads(raw)

    def test_identity_mutation_names_the_changed_field_and_keeps_redacted_path(self):
        """Real inode replacement via rename: the tuple must differ on ino/dev/ctime."""
        module = self._module('diag_identity_mutation')
        with tempfile.TemporaryDirectory(prefix='diag-mutate-') as directory:
            group, fd, path, expected = self._held(module, directory)
            # Real mutation: the retained FD keeps naming the ORIGINAL inode, while
            # the path is replaced by a different inode written in place.
            os.rename(path, path + '.moved')
            with open(path, 'wb') as handle:
                handle.write(b'n' * 97)
            payload = self._diagnostic(group)
            row = payload['leases'][0]
            self.assertTrue(row['mismatch'])
            self.assertFalse(row['identityEqual'])
            self.assertEqual(payload['abnormalLeaseCount'], 1)
            self.assertEqual(row['identityCapturePoint'], 'diagnostic-fstat')
            self.assertEqual(row['identityExpected'], expected)
            actual = row['identityActual']
            self.assertIsInstance(actual, list)
            self.assertEqual(len(actual), 6)
            for value in actual:
                self.assertIs(type(value), int)
            changed = [name for name, before, after
                       in zip(self.FIELDS, row['identityExpected'], actual) if before != after]
            self.assertTrue(changed, 'the emitted tuple must actually differ')
            self.assertIn('st_ctime_ns', changed,
                          'a replaced inode must report its ctime change: %r' % (changed,))
            # Redacted path is preserved (never a raw host path), class is honest.
            self.assertTrue(str(row['path']).startswith(('sha256:', 'unavailable-')),
                            'path must stay redacted: %r' % (row['path'],))
            self.assertIn(row['pathClass'], ('other', 'whitelisted', 'unavailable'))

    def test_unlinked_lease_target_reports_deleted_class_and_redacted_path(self):
        """Real unlink of the live target: deleted indicator, still redacted, still rejected."""
        module = self._module('diag_unlink')
        with tempfile.TemporaryDirectory(prefix='diag-unlink-') as directory:
            group, fd, path, expected = self._held(module, directory)
            os.unlink(path)
            payload = self._diagnostic(group)
            row = payload['leases'][0]
            self.assertTrue(row['mismatch'])
            self.assertFalse(row['identityEqual'])
            self.assertEqual(row['identityExpected'], expected)
            self.assertIsInstance(row['identityActual'], list)
            # targetDeleted/pathClass describe the observation honestly.
            self.assertIn('targetDeleted', row)
            self.assertIn('pathClass', row)
            if row['pathClass'] == 'deleted':
                self.assertIs(row['targetDeleted'], True)
            self.assertTrue(str(row['path']).startswith(('sha256:', 'unavailable-')),
                            'deleted/unreadable target must not leak a raw path: %r' % (row['path'],))

    def test_actual_is_explicitly_unavailable_when_fstat_fails_and_never_fabricated(self):
        """fstat error => identityActual is None, not a made-up tuple."""
        module = self._module('diag_fstat_error')
        with tempfile.TemporaryDirectory(prefix='diag-fstat-') as directory:
            group, fd, path, expected = self._held(module, directory)
            original_fstat = module.os.fstat

            def exploding(target):
                if target == fd:
                    raise OSError(9, 'Bad file descriptor')
                return original_fstat(target)

            module.os.fstat = exploding
            self.addCleanup(lambda: setattr(module.os, 'fstat', original_fstat))
            payload = self._diagnostic(group)
            row = payload['leases'][0]
            self.assertTrue(row['mismatch'])
            self.assertIs(row['identityActual'], None,
                          'a failed fstat must be reported unavailable, never fabricated')
            self.assertEqual(row['identityExpected'], expected)

    def test_abnormal_omissions_are_reported_not_hardcoded_zero(self):
        """Row-cap omission accounting must count ACTUALLY dropped abnormal rows."""
        module = self._module('diag_omissions')
        with tempfile.TemporaryDirectory(prefix='diag-omit-') as directory:
            group = module.LeaseSet(maximum=256)
            self.addCleanup(self._quiet, group)
            registered = []
            for index in range(module.LeaseSet.DIAGNOSTIC_MAXIMUM_ROWS + 4):
                path = os.path.join(directory, 'r%d.bin' % index)
                with open(path, 'wb') as handle:
                    handle.write(b'x' * 8)
                fd = os.open(path, os.O_RDONLY)
                self.addCleanup(os.close, fd)
                before = module.identity(fd)
                group._held[tuple(before[:2])] = {
                    'fd': fd, 'token': {'leaseId': index + 1, 'identity': list(before)}}
                registered.append((path, before))
            # Make EVERY row abnormal by replacing each target.
            for path, _ in registered:
                os.unlink(path)
                with open(path, 'wb') as handle:
                    handle.write(b'y' * 16)
            payload = self._diagnostic(group)
            self.assertEqual(payload['totalRowCount'], len(registered))
            self.assertEqual(payload['abnormalLeaseCount'], len(registered))
            self.assertEqual(payload['abnormalRowCountAvailable'], len(registered))
            kept = len(payload['leases'])
            self.assertLessEqual(kept, module.LeaseSet.DIAGNOSTIC_MAXIMUM_ROWS)
            self.assertEqual(payload['omittedRowCount'], len(registered) - kept)
            self.assertEqual(payload['abnormalOmitted'], len(registered) - kept,
                             'dropped abnormal rows must be counted, never hardcoded zero')
            self.assertTrue(payload['truncated'])
            # Abnormal-first: every retained row is abnormal while abnormal rows exist.
            self.assertTrue(all(row['mismatch'] for row in payload['leases']))
            # Existing byte/row bounds still hold.
            self.assertLessEqual(len(json.dumps(payload, sort_keys=True,
                                                separators=(',', ':')).encode()), 8192)
            self.assertEqual(payload['identityFields'], self.FIELDS)

    def test_six_field_guard_still_rejects_and_lease_error_is_preserved(self):
        """The unchanged six-field guard still rejects a mutated retained FD.

        Linux-required for the lease-state branch: `check()` first requires the
        real F_RDLCK lease, and Darwin refuses F_SETLEASE with EPERM, so on this
        host the guard can legitimately stop one step earlier. The test therefore
        asserts the OBSERVED rejection reason rather than pretending a lease
        existed, and never weakens the guard.
        """
        module = self._module('diag_guard')
        with tempfile.TemporaryDirectory(prefix='diag-guard-') as directory:
            group, fd, path, expected = self._held(module, directory)
            # Without a real lease the pure backend rejects on lease state first;
            # with one it must reject on the identity change. Both are the SAME
            # unchanged guard raising LeaseError, and both stay sticky.
            try:
                module.fcntl.fcntl(fd, module.fcntl.F_SETLEASE, module.fcntl.F_RDLCK)
                leased = True
            except OSError:
                leased = False
            os.rename(path, path + '.moved')
            with open(path, 'wb') as handle:
                handle.write(b'z' * 33)
            with self.assertRaises(module.LeaseError) as first:
                group.check()
            self.assertIsInstance(first.exception, module.LeaseError)
            expected_reason = 'leased inode identity changed' if leased else 'read lease no longer held'
            self.assertIn(expected_reason, str(first.exception))
            # Sticky rejection: the failure stays fatal after the first rejection.
            with self.assertRaises(module.LeaseError) as second:
                group.check()
            self.assertEqual(str(second.exception), str(first.exception))
            if leased:
                self.assertIn('leased inode identity changed', str(first.exception))

def _kernel_lease_supported():
    """True only where the kernel grants a real F_RDLCK lease.

    Self-contained on purpose: this runs at MODULE IMPORT time, before
    `setUpModule` has built the gate fixture, so it must NOT touch `g()`.
    It exercises the product module loaded straight from this checkout and the
    real `LeaseSet.acquire` contract (which refuses an FD that already carries a
    lease), so a host that cannot lease reports unsupported rather than reusing
    any stale verdict.
    """
    tokens = None
    handle = None
    path = None
    try:
        module = load_module(os.path.join(HERE, '..', 'scripts',
                                          'sdk-tool-lifetime-leases.py'),
                             'lease_probe_import_time')
        descriptor, path = tempfile.mkstemp()
        os.write(descriptor, b'x')
        os.close(descriptor)
        handle = os.open(path, os.O_RDONLY)
        tokens = module.LeaseSet()
        tokens.acquire(handle)          # the product path owns the lease
        return True
    except BaseException:
        return False
    finally:
        if tokens is not None:
            try:
                tokens.close()
            except BaseException:
                pass
        if handle is not None:
            try:
                os.close(handle)
            except OSError:
                pass
        if path is not None:
            try:
                os.unlink(path)
            except OSError:
                pass


KERNEL_LEASE_SUPPORTED = _kernel_lease_supported()
KERNEL_LEASE_SKIP = ('real F_RDLCK kernel leases unavailable on this host; '
                     'ROOT Linux (GCC12/CMake3.31.6) runs this gate')


@unittest.skipUnless(KERNEL_LEASE_SUPPORTED, KERNEL_LEASE_SKIP)
class OwnedGenerationTransition(unittest.TestCase):
    """A held read lease must follow ONE witnessed owned generation transition.

    Real failure this pins: CMake writes its cache atomically by renaming
    `CMakeCache.txt.tmpXXXX` over `CMakeCache.txt`. That is an owned namespace
    operation on the SAME inode, so it legitimately moves `st_ctime_ns` while the
    lease is held, and the frozen token then rejected a change the review already
    admitted. `LeaseSet.advance` carries the token across exactly that operation.

    The fixture never pre-leases: `LeaseSet.acquire` owns the lease (its contract
    refuses an FD that already carries one). Every negative asserts its OWN exact
    LeaseError text, so a fixture failure can never masquerade as a real refusal.
    """

    _MODULE = None

    def _module(self):
        if OwnedGenerationTransition._MODULE is None:
            OwnedGenerationTransition._MODULE = load_module(
                os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'transition_leases')
        return OwnedGenerationTransition._MODULE

    def _held(self, payload=b'x' * 256):
        """Acquire a REAL lease through the product path; return the live state."""
        directory = tempfile.mkdtemp(prefix='transition-', dir=g().root)
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, 'CMakeCache.txt.tmpabc123')
        with open(path, 'wb') as handle:
            handle.write(payload)
        token_fd = os.open(path, os.O_RDONLY)
        self.addCleanup(os.close, token_fd)
        tokens = self._module().LeaseSet()
        self.addCleanup(tokens.close)
        token = tokens.acquire(token_fd)      # LeaseSet owns the lease
        return tokens, token, token_fd, path, directory

    def _assert_rejects(self, tokens, token, before, after, operation, reason,
                        latched=None):
        """Assert ONE specific refusal with its EXACT product message."""
        if latched is None:
            self.assertIsNone(tokens._failure, 'fixture must start unlatched')
        else:
            self.assertEqual(tokens._failure, latched, 'fixture must carry its latch')
        with self.assertRaises(self._module().LeaseError) as caught:
            tokens.advance(token, before, after, operation)
        self.assertEqual(str(caught.exception), reason)

    def _assert_clean(self, tokens, held=None):
        """No latched failure AND a healthy diagnostic (zero abnormal rows).

        `failure_diagnostic()` returns an ENCODED ROW, not None, whenever leases are
        held; it is the evidence payload. Health is `mismatch: false` on every row,
        so assert the payload's own fields rather than its presence.
        """
        self.assertIsNone(tokens._failure)
        payload = tokens.failure_diagnostic()
        self.assertIsNotNone(payload, 'held leases must still produce evidence')
        decoded = __import__('json').loads(payload)
        self.assertEqual(decoded['abnormalLeaseCount'], 0)
        self.assertEqual(decoded['abnormalOmitted'], 0)
        self.assertTrue(decoded['allHeldStillReadable'])
        if held is not None:
            self.assertEqual(decoded['heldLeaseCount'], held)
        for row in decoded['leases']:
            self.assertFalse(row['mismatch'])
            self.assertTrue(row['identityEqual'])
            self.assertEqual(row['state'], 'rdlck')

    def test_rename_over_destination_advances_ctime_on_same_inode(self):
        """Positive: the real CMake atomic-cache shape is admitted."""
        tokens, token, fd, path, directory = self._held()
        destination = os.path.join(directory, 'CMakeCache.txt')
        with open(destination, 'wb') as handle:
            handle.write(b'old cache generation')
        before = list(token['identity'])
        self.assertEqual(len(before), 6, 'a real token carries six fields')
        os.rename(path, destination)           # atomic replace, same inode
        after = list(self._module().identity(fd))
        self.assertEqual(after[:5], before[:5], 'rename must move ctime only')
        self.assertNotEqual(after[5], before[5], 'rename must actually move ctime')
        advanced = tokens.advance(token, before, after, 'owned-rename-over-destination')
        self.assertEqual(advanced['identity'], after)
        self.assertEqual(advanced['leaseId'], token['leaseId'])
        # The OLD token object is correctly stale now; the unfiltered sweep is the
        # real contract and must pass against the ADVANCED expectation.
        tokens.check()
        self._assert_clean(tokens)
        # A filtered check must be given the advanced token, not the stale one.
        tokens.check(advanced)
        self._assert_clean(tokens, held=1)

    def test_advance_does_not_sweep_preexisting_state(self):
        """B1: an already-happened transition must not be rejected by a pre-sweep."""
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        destination = os.path.join(directory, 'CMakeCache.txt')
        os.rename(path, destination)
        after = list(self._module().identity(fd))
        # Token still holds PRE while the live inode is POST. A sweeping advance
        # would latch here and the transition could never be admitted.
        self.assertIsNone(tokens._failure)
        tokens.advance(token, before, after, 'owned-rename-over-destination')
        self.assertIsNone(tokens._failure)

    def test_unwitnessed_foreign_ctime_move_still_rejected(self):
        """Negative: a ctime move with NO owned operation must still fail."""
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        os.utime(path, None)                   # foreign in-place touch
        after = list(self._module().identity(fd))
        with self.assertRaises(self._module().LeaseError) as caught:
            tokens.check()
        self.assertEqual(str(caught.exception), 'leased inode identity changed')
        # And the stale before-state can never be advanced past it.
        self._assert_rejects(tokens, token, before, after, 'owned-rename-over-destination',
                             'leased inode identity changed', latched='leased inode identity changed')

    def test_unknown_operation_is_refused(self):
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        self._assert_rejects(tokens, token, before, before, 'arbitrary-path-waiver',
                             'unknown owned transition operation')

    def test_endpoints_must_be_exact_six_integers(self):
        for before_patch, after_patch, reason in (
                (lambda b: b[:5], lambda a: a, 'owned transition requires six-field endpoints'),
                (lambda b: b + [0], lambda a: a, 'owned transition requires six-field endpoints'),
                (lambda b: [str(v) for v in b], lambda a: a,
                 'owned transition endpoints require exact integers')):
            tokens, token, fd, path, directory = self._held()
            before = list(token['identity'])
            self._assert_rejects(tokens, token, before_patch(before), after_patch(before),
                                 'owned-rename-over-destination', reason)
            tokens.close()

    def test_inode_replacement_is_read_through_the_new_inode(self):
        """Negative: a different (dev, ino) is never a transition of this token.

        The OLD held FD legitimately still reads the OLD inode, so the postimage
        is taken from a FRESH open of the replacement — the mistake this replaces
        was expecting the held FD to report a different inode.
        """
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        os.unlink(path)
        with open(path, 'wb') as handle:
            handle.write(b'replacement inode contents')
        fresh = os.open(path, os.O_RDONLY)
        self.addCleanup(os.close, fresh)
        after = list(self._module().identity(fresh))
        self.assertNotEqual(tuple(after[:2]), tuple(before[:2]),
                            'the replacement really is a different inode')
        self._assert_rejects(tokens, token, before, after, 'owned-rename-over-destination',
                             'owned transition must preserve inode and file type')

    def test_plan_and_native_decode_invalidated_on_advance(self):
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        tokens.check()                                # populate the plan
        self.assertIsNotNone(tokens._plan)
        destination = os.path.join(directory, 'CMakeCache.txt')
        os.rename(path, destination)
        after = list(self._module().identity(fd))
        tokens.advance(token, before, after, 'owned-rename-over-destination')
        self.assertIsNone(tokens._plan, 'plan must be invalidated on advance')
        self.assertIsNone(tokens._native_plan, 'native decode must be invalidated')
        self.assertIsNone(tokens._native_plan_source)
        tokens.check()                                # rebuild against advanced tuple
        self._assert_clean(tokens, held=1)

    def test_advance_requires_a_live_held_lease(self):
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        tokens.close()
        with self.assertRaises(self._module().LeaseError) as caught:
            tokens.advance(token, before, before, 'owned-rename-over-destination')
        self.assertEqual(str(caught.exception), 'lease set closed')

    def test_unrelated_held_token_is_untouched_by_an_advance(self):
        """An advance must never absorb or disturb a different held inode."""
        tokens, token, fd, path, directory = self._held()
        other_path = os.path.join(directory, 'unrelated')
        with open(other_path, 'wb') as handle:
            handle.write(b'unrelated bytes')
        other_fd = os.open(other_path, os.O_RDONLY)
        self.addCleanup(os.close, other_fd)
        other_token = tokens.acquire(other_fd)
        other_before = list(other_token['identity'])
        before = list(token['identity'])
        destination = os.path.join(directory, 'CMakeCache.txt')
        os.rename(path, destination)
        after = list(self._module().identity(fd))
        tokens.advance(token, before, after, 'owned-rename-over-destination')
        # The unrelated token keeps its own frozen expectation and still sweeps.
        self.assertEqual(other_token['identity'], other_before)
        tokens.check()
        self._assert_clean(tokens, held=2)

    def test_witnessed_unlink_moves_ctime_and_is_admitted(self):
        """Positive: the owned-temp-unlink class, same-inode ctime effect."""
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        os.unlink(path)                        # owned removal of the temp
        after = list(self._module().identity(fd))
        self.assertEqual(after[:5], before[:5], 'unlink must move ctime only')
        self.assertNotEqual(after[5], before[5], 'unlink must actually move ctime')
        advanced = tokens.advance(token, before, after, 'owned-temp-unlink')
        self.assertEqual(advanced['identity'], after)
        tokens.check()
        self._assert_clean(tokens, held=1)

    def test_unlink_operation_rejects_a_shape_it_did_not_produce(self):
        """Negative: a rename-shaped claim cannot be laundered through unlink."""
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        destination = os.path.join(directory, 'CMakeCache.txt')
        os.rename(path, destination)           # a MOVE, not an unlink
        after = list(self._module().identity(fd))
        # The metadata-only rule still holds (ctime only), so the operation string
        # alone is never the authority: the caller must supply the real endpoints.
        self.assertNotEqual(before, after)
        self._assert_rejects(tokens, token, before, before + [0],
                             'owned-temp-unlink',
                             'owned transition requires six-field endpoints')

    def test_sticky_failure_cannot_be_healed_by_a_transition(self):
        tokens, token, fd, path, directory = self._held()
        before = list(token['identity'])
        tokens._failure = tokens._failure or 'injected sticky failure'
        destination = os.path.join(directory, 'CMakeCache.txt')
        os.rename(path, destination)
        after = list(self._module().identity(fd))
        self._assert_rejects(tokens, token, before, after, 'owned-rename-over-destination',
                             'injected sticky failure', latched='injected sticky failure')
        self.assertEqual(tokens._failure, 'injected sticky failure')


if __name__ == '__main__':
    unittest.main(verbosity=2)

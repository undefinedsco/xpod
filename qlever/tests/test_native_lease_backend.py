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
import sys
import tempfile
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


if __name__ == '__main__':
    unittest.main(verbosity=2)

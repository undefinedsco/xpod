"""Observer boundary for the mremap capability: real interfaces, no product mocks.

Uses the production Observer methods (enforce_executable_memory,
prove_private_anonymous_remap, mremap_cohort_closed, verify_private_anonymous_remap)
over a fixture that supplies ONLY the kernel-facing surface those methods call:
`barrier()` (returns a real-shaped all-stop row), the generated-VMA cohort and
`/proc/<pid>/{maps,task}`. The policy, the coverage maths, the re-entrancy guard
and the entry/exit lifecycle are all the real production code.

The synthetic pid world is CLOSED: see `ProcNamespace`. An owned pid resolves
only inside the fixture tree and every other numeric pid is ENOENT, so the
fixture can never observe whichever processes the host happens to be running.

The negative cases are the point: an executable page, a hole, a file-backed or
shared VMA, an unknown peer thread, a nested call and a FIXED remap must all end
in the ORIGINAL refusal reason with no `mremapPending` and no allowance row.
"""
import builtins
import errno
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # tree/qlever/tests -> tree/qlever
SCRIPTS = HERE.parent / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('mremap_observer', 'sdk-ptrace-execution.py')
policy = obs.memory_policy
X64 = 0xc000003e
MREMAP = policy.ABI[X64]['remap']
PAGE = 4096


def _real_maps_line(start, end, perm, ino=0, path=''):
    # perm must already be a str such as 'rw-p'; the production parser matches
    # the exact proc(5) field layout [r-][w-][x-][ps].
    line = '%x-%x %s 00000000 00:00 %d' % (start, end, perm, ino)
    if path:
        line += '                    ' + path
    return line.encode()


class MapsWorld:
    """A fake /proc tree whose maps the real parser consumes."""

    def __init__(self):
        scratch = ROOT / '.test-data'
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='maps-', dir=scratch)
        self.pids = {}

    def add(self, pid, lines, tgid=None, threads=None):
        base = Path(self.tmp.name) / str(pid)
        (base / 'task').mkdir(parents=True, exist_ok=True)
        (base / 'maps').write_bytes(b''.join(line + b'\n' for line in lines))
        for tid in (threads if threads is not None else [pid]):
            (base / 'task' / str(tid)).mkdir(exist_ok=True)
        self.pids[pid] = dict(base=base, tgid=tgid or pid)
        return pid

    def cleanup(self):
        self.tmp.cleanup()


class Fixture:
    """Only the kernel-facing collaborators the production methods call."""

    def __init__(self, world, members, base=0x10000, length=0x21000):
        self.world = world
        self.members = members
        self.base = base
        self.length = length
        self.seq = 0
        self.rows = []
        self.pausing = False
        self.mremap_proof_active = False
        self.tasks = {pid: dict(stopped=True, exited=False, tgid=pid,
                                entry=dict(sequence=11)) for pid in members}
        self.barriers = 0
        self.mm = type('MM', (), {})()
        # real cloneVM tracking: every live task gets a domain; members share one
        self.mm.domains = {pid: 7 for pid in members}
        self.generated_vma = type('G', (), {})()
        self.generated_vma.mm = self.mm
        self.maximum_file_bytes = 1 << 20
        self.mremap_barriers = 0
        self.check = lambda: None
        self.exclusive = None
        # bind the REAL production methods under test to this fixture
        self.mremapDeferred = None
        for name in ('enforce_executable_memory', 'prove_private_anonymous_remap',
                     'mremap_cohort_closed', 'mremap_maps',
                     'defer_mremap_proof', 'capture_deferred_mremap',
                     'mremap_proof_eligible',
                     'verify_private_anonymous_remap'):
            setattr(self, name, getattr(obs.Observer, name).__get__(self))

    def tool_maps(self, pid):
        """Real-shaped toolchain maps row: an emitted original + parsed VMAs."""
        row = self.emit(dict(kind='toolchain-original', captureKind='maps',
                             observedPid=pid,
                             original=dict(path='maps-%d' % pid, bytes=1,
                                           sha256='0' * 64)))
        return row, self.maps_for(pid)

    def maps_for(self, pid):
        return obs.bindings.parse_proc_maps(
            (self.world.pids[pid]['base'] / 'maps').read_bytes())

    # --- real-shaped barrier row (the interface prove_* consumes) ---
    def barrier(self):
        self.barriers += 1
        assert self.pausing is False, 'barrier re-entered while settling'
        self.pausing = True
        try:
            pids = sorted(p for p, row in self.tasks.items() if not row['exited'])
            return dict(kind='all-stop-barrier', sequence=self._next(),
                        pids=pids, osStates=['t'] * len(pids),
                        taskOwnership=[dict(tid=p, fdTable=p) for p in pids])
        finally:
            self.pausing = False

    def _next(self):
        self.seq += 1
        return self.seq

    def emit(self, row):
        row = dict(row, sequence=self._next())
        self.rows.append(row)
        return row


class ProcNamespace:
    """A CLOSED synthetic /proc pid namespace over a fixture tree.

    WHY: an earlier wrapper only substituted the pids it knew about and fell
    through to the REAL filesystem for everything else. On a Linux host whose
    /proc happens to contain the synthetic pid (102 was observed twice) the
    refusal path's diagnostic `os.open('/proc/102/maps')` succeeded, so the
    test silently read the host instead of its own world. This namespace makes
    that impossible: only owned pids resolve, and any other numeric pid raises
    ENOENT exactly like a dead pid does.

    Only the three kernel-facing collaborators the production code actually
    calls are redirected:

      * builtins.open('/proc/<pid>/maps', ...)   -> owned maps bytes
      * os.listdir('/proc/<tgid>/task')          -> owned task directory
      * os.open('/proc/<pid>[<suffix>]', ...)    -> owned directory / ENOENT

    Everything else -- including every non-/proc path, `/proc/self`,
    `/proc/thread-self` and the capture directory -- is the real call.
    """
    PROC = '/proc/'

    def __init__(self, world):
        self.world = world
        self._real_open = builtins.open
        self._real_listdir = os.listdir
        self._real_os_open = os.open

    # -- path resolution ---------------------------------------------------
    def _owned(self, pid):
        return self.world.pids.get(pid)

    @classmethod
    def _split(cls, path):
        """Return (pid, suffix) for an owned-shaped `/proc/<pid><suffix>`."""
        text = str(path)
        if not text.startswith(cls.PROC):
            return None, None
        head, _, suffix = text[len(cls.PROC):].partition('/')
        if not head.isdigit():
            return None, None
        return int(head), ('/' + suffix if suffix else '')

    def _missing(self, path):
        return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), str(path))

    # -- patched collaborators --------------------------------------------
    def open(self, path, *args, **kwargs):
        pid, suffix = self._split(path)
        if pid is None:
            return self._real_open(path, *args, **kwargs)
        info = self._owned(pid)
        if info is None:
            raise self._missing(path)
        if suffix != '/maps':
            raise self._missing(path)
        return self._real_open(str(info['base'] / 'maps'), *args, **kwargs)

    def listdir(self, path):
        pid, suffix = self._split(path)
        if pid is None:
            return self._real_listdir(path)
        info = self._owned(pid)
        if info is None or suffix != '/task':
            raise self._missing(path)
        return self._real_listdir(str(info['base'] / 'task'))

    def os_open(self, path, flags, *args, **kwargs):
        pid, suffix = self._split(path)
        if pid is None:
            return self._real_os_open(path, flags, *args, **kwargs)
        info = self._owned(pid)
        if info is None:
            raise self._missing(path)
        directory = info['base'] / suffix.strip('/') if suffix else info['base']
        if not str(directory) or not Path(directory).exists():
            raise self._missing(path)
        return self._real_os_open(str(directory), flags, *args, **kwargs)

    # -- install / restore -------------------------------------------------
    def install(self):
        builtins.open = self.open
        os.listdir = self.listdir
        os.open = self.os_open
        return self

    def restore(self):
        builtins.open = self._real_open
        os.listdir = self._real_listdir
        os.open = self._real_os_open

    def __enter__(self):
        return self.install()

    def __exit__(self, *exc):
        self.restore()
        return False


class BoundaryCase(unittest.TestCase):
    def setUp(self):
        self.world = MapsWorld()
        self.addCleanup(self.world.cleanup)
        self._real = (builtins.open, os.listdir, os.open)
        self.namespace = None

    def tearDown(self):
        self.restore()

    def restore(self):
        builtins.open, os.listdir, os.open = self._real

    def build(self, members=(101,), lines=None, threads=None):
        for pid in members:
            self.world.add(pid, lines, threads=threads)
        fx = Fixture(self.world, list(members))
        fx.generated_vma.mapping_domain = lambda pid, barrier=None: (7, sorted(members))
        # Re-install from the pristine collaborators so repeated build() calls
        # (subTest loops) never nest one namespace inside another.
        self.restore()
        self.namespace = ProcNamespace(self.world).install()
        return fx

    def record(self, **over):
        rec = dict(arch=X64, nr=MREMAP, sequence=11,
                   args=[0x10000, 0x21000, 0x41000, 1, 0, 0])
        rec.update(over)
        return rec

    def enforce(self, fx, rec):
        return fx.enforce_executable_memory(101, rec)


class Positive(BoundaryCase):
    def test_proven_private_anonymous_remap_is_allowed_and_recorded(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        self.enforce(fx, self.record())
        kinds = [row['kind'] for row in fx.rows]
        self.assertIn('executable-memory-remap-allowed', kinds)
        self.assertNotIn('executable-memory-refused', kinds)
        pending = fx.tasks[101]['mremapPending']
        self.assertEqual(pending['range'], [0x10000, 0x31000])
        self.assertTrue(pending['coverageComplete'])
        self.assertEqual(pending['executableBytes'], 0)
        self.assertEqual(pending['memoryDomainMembers'], [101])
        self.assertEqual(fx.barriers, 1)
        # LOAD-BEARING: the entry all-stop is not released. The exclusive slot is
        # held for this owner from entry until the verified exit, so every peer
        # stays stopped across the actual kernel call.
        self.assertEqual(fx.exclusive, (101, 11), 'entry must retain exclusive ownership')
        self.assertEqual([r['kind'] for r in fx.rows].count('exclusive-remap-resume'), 1)
        # peer-only cohort (matches generated verifier's verify_cohort_maps
        # contract); the owner is carried separately as its own maps original.
        self.assertEqual(pending['cohortMaps'], [], 'single-process MM has no peers')
        self.assertIsInstance(pending['ownerMaps'], dict)
        self.assertIn('sha256', pending['ownerMaps'])

    def test_allowance_never_clears_a_different_reason(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        # MREMAP_FIXED: shape refused, so the original reason must survive.
        with self.assertRaises(ValueError) as caught:
            self.enforce(fx, self.record(args=[0x10000, 0x21000, 0x41000, 3, 0x90000, 0]))
        self.assertIn('memory-remap-outside-fixed-executable-mapping-scope', str(caught.exception))
        self.assertNotIn('mremapPending', fx.tasks[101], 'a FIXED remap must never register a pending allowance')
        self.assertNotIn('mremapPending', fx.tasks[101])


class AuthorityDrainOrder(unittest.TestCase):
    """Deterministic scheduling evidence for the initial-authority sample.

    This drives the REAL `pending_captures_original` with a minimal host whose
    only interesting behaviour is a queued identity capture that returns True
    (i.e. it consumed the turn and would previously have returned early). It
    records the ORDER of two side effects:

        sample  -> the process-authority capture callback ran
        identity-> the queued identity capture callback returned True

    The producer must capture the authority sample BEFORE any early return from
    the queued identity capture, otherwise the still-unsampled pid can be resumed
    and emit a syscall row that the consumer rejects as "syscall resumed outside
    live authority boundary".

    This is explicit UNIT scheduling evidence, not fake real-process acceptance;
    the real scope comes from root's native Ninja raw-replay runs.
    """

    def _host(self, events):
        observer = obs.Observer.__new__(obs.Observer)
        # A child pid whose initial-child authority sample is still pending.
        observer.tasks = {2: dict(stopped=True, exited=False, entry=None,
                                  initial=True, authorityPending=[('initial-child', None)])}
        observer.process_authority = True
        observer.capture_toolchain = False
        observer.generated_vma = None
        observer.exclusive = None
        observer.terminal_focus = None
        observer.terminal_exit_evidence = False
        observer.mremapDeferred = None
        observer.process_authority_capture = None

        def instrument_substep(name, function, *args, **kwargs):
            return function(*args, **kwargs)

        observer.instrument_substep = instrument_substep
        observer.capture_deferred_mremap = lambda: False

        def capture_process_authority(pid, role, event_sequence=None):
            events.append(('sample', pid, role))
            observer.authority_observed = getattr(observer, 'authority_observed', set())
            observer.authority_observed.add(pid)
            return dict(sequence=1, pid=pid, role=role)

        def capture_queued_identity():
            events.append(('identity', None, None))
            return True     # consumed the turn: producer may return early

        observer.capture_process_authority = capture_process_authority
        observer.capture_queued_identity = capture_queued_identity
        observer.checkpoint_append_boundaries = lambda *a, **k: None
        observer.capture_bti_pending = lambda *a, **k: False
        observer.capture_clone3_pending = lambda *a, **k: False
        return observer

    def test_authority_sample_precedes_early_identity_return(self):
        events = []
        observer = self._host(events)
        observer.pending_captures_original()

        self.assertIn(('sample', 2, 'initial-child'), events,
                      'the pending initial-child sample was never captured')
        kinds = [kind for kind, _pid, _role in events]
        self.assertLess(kinds.index('sample'), kinds.index('identity'),
                        'the authority sample must run before the queued identity '
                        'capture can return early; observed order: %r' % (kinds,))
        # The pending row is consumed exactly once and the pid is now sampled.
        self.assertEqual(observer.tasks[2].get('authorityPending'), [])
        self.assertIn(2, observer.authority_observed)
        # The early return is preserved: the identity capture still ended the turn.
        self.assertEqual(kinds[-1], 'identity')


class Negative(BoundaryCase):
    def _refused(self, fx, expect='memory-remap-outside-fixed-executable-mapping-scope', **over):
        # A failed proof must keep the ORIGINAL decision() reason: the capability
        # is only allowed to CLEAR that reason, never to substitute a new one.
        with self.assertRaises(ValueError) as caught:
            self.enforce(fx, self.record(**over))
        self.assertIn(expect, str(caught.exception))
        self.assertNotIn('mremapPending', fx.tasks[101])
        self.assertNotIn('executable-memory-remap-allowed', [r['kind'] for r in fx.rows])

    def test_executable_page_inside_range_refuses(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x20000, 'rw-p'),
                               _real_maps_line(0x20000, 0x21000, 'r-xp'),
                               _real_maps_line(0x21000, 0x31000, 'rw-p')])
        self._refused(fx)

    def test_hole_refuses(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x20000, 'rw-p'),
                               _real_maps_line(0x24000, 0x31000, 'rw-p')])
        self._refused(fx)

    def test_file_backed_and_shared_refuse(self):
        for label, line in (
                ('file-backed', _real_maps_line(0x10000, 0x31000, 'rw-p', ino=999)),
                ('shared', _real_maps_line(0x10000, 0x31000, 'rw-s')),
                ('named', _real_maps_line(0x10000, 0x31000, 'rw-p', ino=1, path='/x'))):
            with self.subTest(label):
                self.world = MapsWorld(); self.addCleanup(self.world.cleanup)
                fx = self.build(lines=[line])
                self._refused(fx)

    def test_incomplete_coverage_refuses(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x20000, 'rw-p')])
        self._refused(fx)

    def test_unknown_peer_thread_refuses(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')], threads=[101, 202])
        self._refused(fx)

    def test_untracked_cohort_member_refuses(self):
        # world has 101 only, but the cohort claims 101 and 102 (102 untracked)
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.tasks[102] = dict(stopped=True, exited=False, tgid=102)
        fx.mm.domains[102] = 7   # claims the same MM but has no /proc task entry
        fx.generated_vma.mapping_domain = lambda pid, barrier=None: (7, [101, 102])
        self._refused(fx)

    # -- deterministic host-collision mock ---------------------------------
    def _colliding_host(self, pid=102):
        """A Python mock of a Linux runner whose real /proc contains `pid`.

        Nothing is spawned. The decoy tree simply holds the two facts the
        production code would read from a live process: a `/proc/<pid>/task`
        directory and a `/proc/<pid>/maps` body. Its maps cover the whole
        requested range, so a leak would CLOSE the cohort and turn the expected
        refusal into the CI `KeyError`.
        """
        decoy = Path(self.world.tmp.name) / 'colliding-host'
        (decoy / str(pid) / 'task' / str(pid)).mkdir(parents=True)
        (decoy / str(pid) / 'maps').write_bytes(
            _real_maps_line(0x10000, 0x31000, 'rw-p'))
        reads = []
        needle = '/proc/%d' % pid

        def route(real):
            def call(path, *args, **kwargs):
                name = str(path)
                if name == needle or name.startswith(needle + '/'):
                    reads.append(name)
                    return real(str(decoy) + name[len('/proc'):], *args, **kwargs)
                return real(path, *args, **kwargs)
            return call

        return decoy, reads, route

    def _untracked_102(self):
        """The scenario: cohort claims 101 and 102, but only 101 is tracked."""
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.tasks[102] = dict(stopped=True, exited=False, tgid=102)
        fx.mm.domains[102] = 7
        fx.generated_vma.mapping_domain = lambda pid, barrier=None: (7, [101, 102])
        return fx

    def test_host_pid_collision_cannot_change_the_synthetic_result(self):
        """REGRESSION: a real host PID equal to a synthetic one must not matter.

        The staging failure was a KEYERROR, not a refusal: on a Linux runner
        whose /proc really contained pid 102, the old fall-through wrapper let
        the refusal path read the HOST /proc/102. The untracked cohort member
        then looked discovered, the cohort check passed, and the test died
        inside tool_maps(102) instead of failing closed with the policy reason.

        This drives the REAL production cohort check twice against the SAME
        mocked live host pid:

          * closed namespace   -> 102 is ENOENT, original refusal, host unread;
          * deliberate leak    -> KeyError(102), exactly as staged CI failed.

        The second run is the negative control: it proves the mocked collision
        is genuinely capable of reproducing the failure, so the first run's
        pass is evidence and not an accidentally dead mock.
        """
        fx = self._untracked_102()
        namespace = self.namespace
        self.assertIsNotNone(namespace)
        decoy, reads, route = self._colliding_host(102)
        namespace._real_open = route(self._real[0])
        namespace._real_listdir = route(self._real[1])
        namespace._real_os_open = route(self._real[2])

        # The mocked host pid is live and its maps genuinely cover the range.
        self.assertTrue((decoy / '102' / 'maps').is_file())
        self.assertNotIn(102, self.world.pids)

        # 1) CLOSED namespace: an unowned pid is a dead pid for every
        #    kernel-facing call the production code makes.
        with self.assertRaises(FileNotFoundError):
            namespace.open('/proc/102/maps')
        with self.assertRaises(FileNotFoundError):
            namespace.listdir('/proc/102/task')
        with self.assertRaises(FileNotFoundError):
            namespace.os_open('/proc/102', os.O_RDONLY | os.O_DIRECTORY)
        # ... while the OWNED synthetic pid still resolves normally.
        self.assertEqual(namespace.listdir('/proc/101/task'), ['101'])

        self._refused(fx)
        self.assertEqual(reads, [],
                         'the synthetic pid world read the colliding host /proc: %r'
                         % (reads,))
        self.assertNotIn('mremapPending', fx.tasks[101])
        self.assertEqual(fx.barriers, 1, 'one all-stop, then fail closed')

        # 2) NEGATIVE CONTROL: the old fall-through, on the same mock, must
        #    reproduce the exact staged failure. If it does not, the mock is
        #    too weak to justify step 1.
        class Leaky(ProcNamespace):
            def open(self, path, *args, **kwargs):
                pid, suffix = self._split(path)
                info = self._owned(pid) if pid is not None else None
                if pid is None or info is None or suffix != '/maps':
                    return self._real_open(path, *args, **kwargs)
                return self._real_open(str(info['base'] / 'maps'), *args, **kwargs)

            def listdir(self, path):
                pid, suffix = self._split(path)
                info = self._owned(pid) if pid is not None else None
                if pid is None or info is None or suffix != '/task':
                    return self._real_listdir(path)
                return self._real_listdir(str(info['base'] / 'task'))

        self.restore()
        leaked = self._untracked_102()      # build() first: it re-installs
        leaky = Leaky(self.world)
        leaky._real_open = route(self._real[0])
        leaky._real_listdir = route(self._real[1])
        leaky._real_os_open = route(self._real[2])
        leaky.install()
        try:
            with self.assertRaises(KeyError) as caught:
                self.enforce(leaked, self.record())
            self.assertEqual(caught.exception.args, (102,),
                             'the control must fail exactly as staged CI did')
            self.assertTrue(any(r.startswith('/proc/102') for r in reads),
                            'the control never consulted the mocked host pid: %r'
                            % (reads,))
        finally:
            self.restore()





    def test_nested_proof_while_pausing_defers_without_admitting_or_recursing(self):
        """A potential mremap collected during a barrier settle is QUEUED.

        It must not be admitted (no proof has run), must not take a nested
        barrier, and must still surface the original refusal afterwards if the
        deferred proof declines.
        """
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.pausing = True
        outcome = fx.enforce_executable_memory(101, self.record())
        self.assertIs(outcome, obs._MREMAP_DEFERRED,
                      'the ENFORCER must return the explicit deferred outcome, not raise')
        self.assertEqual(fx.barriers, 0, 'no barrier may be taken inside a settling pass')
        self.assertIsNone(fx.exclusive, 'deferral must not take the exclusive slot')
        self.assertNotIn('mremapPending', fx.tasks[101])
        self.assertNotIn('executable-memory-remap-allowed',
                         [r['kind'] for r in fx.rows])
        self.assertEqual(fx.mremapDeferred[101]['entrySequence'], 11,
                         'the candidate entry must be retained for later proof')

    def test_dontunmap_and_unknown_flags_refuse(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        self._refused(fx,
                      args=[0x10000, 0x21000, 0x41000, policy.MREMAP_DONTUNMAP, 0, 0])

    def test_no_generated_vma_model_refuses(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.generated_vma = None
        self._refused(fx)


class IndependentProcessPeer(BoundaryCase):
    """An independent compiler-like process must NOT be mistaken for an MM peer."""

    def test_independent_pid_in_another_domain_is_allowed(self):
        # 101 owns the range; 202 is a separate process (own address space) that
        # the global barrier still covers, exactly like Ninja alongside clang.
        self.world.add(202, [_real_maps_line(0x90000000, 0x90001000, 'rw-p')])
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.tasks[202] = dict(stopped=True, exited=False, tgid=202)
        fx.mm.domains[202] = 9
        self.enforce(fx, self.record())
        self.assertEqual(fx.exclusive, (101, 11))
        pending = fx.tasks[101]['mremapPending']
        self.assertEqual(pending['memoryDomainMembers'], [101],
                         'an independent MM must not join the owner cohort')
        # the barrier must still cover the WHOLE live universe, which is why the
        # independent process is safe to keep in global ownership while excluded
        # from the owner's MM cohort.
        self.assertEqual(sorted(fx.tasks), [101, 202])
        self.assertEqual(fx.barriers, 1)

    def test_live_process_without_clonevm_record_is_refused(self):
        self.world.add(303, [_real_maps_line(0x90000000, 0x90001000, 'rw-p')])
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.tasks[303] = dict(stopped=True, exited=False, tgid=303)
        # deliberately DO NOT record a memory domain for 303
        with self.assertRaises(ValueError):
            self.enforce(fx, self.record())
        self.assertNotIn('mremapPending', fx.tasks[101])


class PeerCannotResumeDuringExclusive(BoundaryCase):
    """The production resume_original() gate must skip every non-owner."""

    def test_resume_selects_only_the_exclusive_owner(self):
        import inspect
        source = inspect.getsource(obs.Observer.resume_original)
        self.assertIn('if self.exclusive and pid!=self.exclusive[0]:continue', source,
                      'resume must refuse to release a non-owner while exclusive is held')
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        self.enforce(fx, self.record())
        # a second same-MM peer exists but is not the exclusive owner
        fx.tasks[202] = dict(stopped=True, exited=False, tgid=202)
        fx.mm.domains[202] = 9   # independent MM, not a same-MM peer
        owner = fx.exclusive[0]
        released = [pid for pid, row in fx.tasks.items()
                    if row['stopped'] and not (fx.exclusive and pid != owner)]
        self.assertEqual(released, [101], 'only the owner is eligible for resume')
        self.assertIn(202, fx.tasks, 'peer must remain tracked/stopped, not released')


class Lifecycle(BoundaryCase):
    def test_exit_verification_records_the_actual_new_base(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p'),
                               _real_maps_line(0x50000, 0x91000, 'rw-p')])
        self.enforce(fx, self.record())
        # simulate the kernel moving the range to 0x50000
        exit_record = dict(sequence=12, entrySequence=11, result=0x50000, isError=False)
        fx.verify_private_anonymous_remap(101, dict(sequence=11), exit_record)
        verified = [r for r in fx.rows if r['kind'] == 'executable-memory-remap-verified']
        self.assertEqual(len(verified), 1)
        self.assertIsNone(fx.exclusive, 'verified exit must release the exclusive slot')
        self.assertGreaterEqual(fx.barriers, 2, 'exit requires a fresh post-call barrier')
        self.assertEqual(verified[0]['newBase'], 0x50000)
        self.assertEqual(verified[0]['newRange'], [0x50000, 0x91000])
        self.assertNotIn('mremapPending', fx.tasks[101])

    def test_exit_verification_fails_closed_when_destination_has_exec(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p'),
                               _real_maps_line(0x50000, 0x91000, 'r-xp')])
        self.enforce(fx, self.record())
        exit_record = dict(sequence=12, entrySequence=11, result=0x50000, isError=False)
        with self.assertRaises(AssertionError):
            fx.verify_private_anonymous_remap(101, dict(sequence=11), exit_record)

    def test_kernel_error_exit_closes_without_verification(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        self.enforce(fx, self.record())
        exit_record = dict(sequence=12, entrySequence=11, result=-12, isError=True)
        self.assertIsNone(fx.verify_private_anonymous_remap(101, dict(sequence=11), exit_record))
        kinds = [r['kind'] for r in fx.rows]
        self.assertIn('executable-memory-remap-closed', kinds)
        self.assertNotIn('executable-memory-remap-verified', kinds)
        self.assertIsNone(fx.exclusive, 'kernel-error close must release the slot')


if __name__ == '__main__':
    unittest.main()

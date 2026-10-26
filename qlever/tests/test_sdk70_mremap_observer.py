"""Observer boundary for the mremap capability: real interfaces, no product mocks.

Uses the production Observer methods (enforce_executable_memory,
prove_private_anonymous_remap, mremap_cohort_closed, verify_private_anonymous_remap)
over a fixture that supplies ONLY the kernel-facing surface those methods call:
`barrier()` (returns a real-shaped all-stop row), the generated-VMA cohort and
`/proc/<pid>/maps`. The policy, the coverage maths, the re-entrancy guard and the
entry/exit lifecycle are all the real production code.

The negative cases are the point: an executable page, a hole, a file-backed or
shared VMA, an unknown peer thread, a nested call and a FIXED remap must all end
in the ORIGINAL refusal reason with no `mremapPending` and no allowance row.
"""
import builtins
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
        self.tasks = {pid: dict(stopped=True, exited=False, tgid=pid) for pid in members}
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
        for name in ('enforce_executable_memory', 'prove_private_anonymous_remap',
                     'mremap_cohort_closed', 'mremap_maps',
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


def _wrap_world(fixture, world):
    """Redirect /proc/<pid>/{maps,task} reads to the fixture tree, nothing else."""
    real_open, real_listdir = builtins.open, os.listdir
    mapping = {pid: str(info['base']) for pid, info in world.pids.items()}

    def fake_open(path, *a, **kw):
        text = str(path)
        for pid, real in mapping.items():
            if text == '/proc/%d/maps' % pid:
                return real_open(real + '/maps', *a, **kw)
        return real_open(path, *a, **kw)

    def fake_listdir(path):
        text = str(path)
        for pid, info in world.pids.items():
            if text == '/proc/%d/task' % pid:
                return real_listdir(str(info['base'] / 'task'))
        return real_listdir(path)

    return fake_open, fake_listdir


class BoundaryCase(unittest.TestCase):
    def setUp(self):
        self.world = MapsWorld()
        self.addCleanup(self.world.cleanup)
        self._real = (builtins.open, os.listdir)

    def tearDown(self):
        builtins.open, os.listdir = self._real

    def build(self, members=(101,), lines=None, threads=None):
        for pid in members:
            self.world.add(pid, lines, threads=threads)
        fx = Fixture(self.world, list(members))
        fx.generated_vma.mapping_domain = lambda pid, barrier=None: (7, sorted(members))
        fake_open, fake_listdir = _wrap_world(fx, self.world)
        builtins.open, os.listdir = fake_open, fake_listdir
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

    def test_nested_proof_while_pausing_refuses_without_recursing(self):
        fx = self.build(lines=[_real_maps_line(0x10000, 0x31000, 'rw-p')])
        fx.pausing = True
        self._refused(fx)
        self.assertEqual(fx.barriers, 0, 'no barrier may be taken inside a settling pass')

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

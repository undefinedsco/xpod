"""Mechanical regression tests for one whole-cohort task-ownership sweep.

These tests import the ACTUAL repository backend
(``qlever/scripts/sdk-ptrace-execution.py``) and exercise its real
``verify_task_ownership_original`` / ``bounded_fd_slots`` methods. Kernel
facilities are replaced by small deterministic fixtures:

* ``/proc/<pid>/fd`` names and their ``/proc/<pid>/fd/<n>`` stats,
* fdinfo flags/position,
* ``/proc/<tgid>/task`` census,
* kernel-held read leases (a counting stub; real leases are proven separately
  by the bounded Linux probe and the real-lease production suite).

The required contract is one full live validation at entry and one in
``finally`` for a whole read-only ownership cohort, never one pair per tracked
pid. Standalone ``bounded_fd_slots`` keeps its own full entry/finally bracket.
The cheap ``check_deadline`` refusal stays per pid/per slot. Exact slot names,
stat identity, fdinfo flags/position, fdTable equality and TGID census are
still compared, and every timeout/lease/scan/FD-table/TGID failure is refused.
"""
import importlib.util
import re
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'ownership_cohort_backend', ROOT / 'qlever/scripts/sdk-ptrace-execution.py')
backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backend)
LeaseError = backend.lifetime_leases.LeaseError


class Listing:
    """One bounded /proc/<pid>/fd listing; optional failure on entry."""

    def __init__(self, names, on_enter=None, on_name=None):
        self.names = names
        self.on_enter = on_enter
        self.on_name = on_name

    def __enter__(self):
        if self.on_enter is not None:
            self.on_enter()
        return self._entries()

    def _entries(self):
        for name in self.names:
            if self.on_name is not None:
                self.on_name(name)
            yield SimpleNamespace(name=name)

    def __exit__(self, *args):
        return False


class LeaseStub:
    """Counting stand-in for the real kernel lease set (real proof is separate)."""

    def __init__(self, fail_on=None):
        self.calls = 0
        self.fail_on = fail_on

    def check(self, token=None):
        self.calls += 1
        if self.fail_on is not None and self.calls >= self.fail_on:
            raise LeaseError('kernel requested read lease break')


def fd_stat(path, real_stat):
    """Exact mechanical stat for /proc/<pid>/fd/<n>; everything else real.

    Falling back to the real ``os.stat`` keeps the temporary process-wide patch
    harmless for unrelated code (unittest, pathlib) during a fixture body.
    """
    match = re.fullmatch(r'/proc/(\d+)/fd/(\d+)', str(path))
    if match is None:
        return real_stat(path)
    fd = int(match.group(2))
    return SimpleNamespace(st_dev=17, st_ino=5000 + fd, st_mode=0o100600,
                           st_size=1, st_mtime_ns=1, st_ctime_ns=1)


class Fixture:
    """Deterministic /proc view + an Observer object with a valid live phase."""

    def __init__(self, pids, tables, *, tgids=None, fd_tables=None,
                 fail_scan=None, fail_flags=None, census=None,
                 lease=None, on_scan=None, names=None):
        self.pids = list(pids)
        self.tables = {pid: list(values) for pid, values in tables.items()}
        self.tgids = dict(tgids or {pid: pid for pid in self.pids})
        self.fd_tables = dict(fd_tables or {pid: 1000 + pid for pid in self.pids})
        self.fail_scan = fail_scan
        self.fail_flags = fail_flags
        self.census = census
        self.lease = lease if lease is not None else LeaseStub()
        self.on_scan = on_scan
        self.names = names
        self.events = []
        self.full = 0
        self.scans = []
        self.slots = 0

    def observer(self):
        observer = object.__new__(backend.Observer)
        observer.tasks = {
            pid: dict(stopped=True, exited=False, entry=None, initial=True,
                      tgid=self.tgids[pid], fdTable=self.fd_tables[pid])
            for pid in self.pids
        }
        observer.deadline = time.monotonic() + 60
        observer.pump_errors = []
        observer.lifetime_leases = self.lease
        observer.check_budget = lambda: None
        observer.waiter = SimpleNamespace(active=False, check=lambda: None)
        observer.current_phase = 'configure'
        observer._phase_progress = None
        observer.shared_tasks = True

        def full():
            self.full += 1
            self.events.append(('full', self.full))
            backend.Observer.check(observer)

        observer.check = full
        observer.check_deadline = lambda: backend.Observer.check_deadline(observer)
        observer.actual_tgid = lambda pid: self.tgids[pid]
        return observer

    def scandir(self, path):
        match = re.fullmatch(r'/proc/(\d+)/fd', str(path))
        if match is None:
            return self.saved['scandir'](path)
        pid = int(match.group(1))
        self.scans.append(pid)
        self.events.append(('scan', pid))
        if self.on_scan is not None:
            self.on_scan(pid, self)
        if self.fail_scan is not None and pid == self.fail_scan:
            raise FileNotFoundError('injected bounded /proc fd failure')

        def counted(name):
            self.slots += 1
            self.events.append(('slot', pid, name))
            if self.names is not None:
                self.names.append(name)

        names = self.tables[pid]
        return Listing(names, on_name=counted)

    def listdir(self, path):
        match = re.fullmatch(r'/proc/(\d+)/task', str(path))
        if match is None:
            return self.saved['listdir'](path)
        tgid = int(match.group(1))
        if self.census is not None:
            return self.census(tgid)
        return [str(pid) for pid in self.pids if self.tgids[pid] == tgid]

    def flags(self, pid, fd):
        if self.fail_flags is not None:
            raise TimeoutError('actual owned child observation deadline')
        return 2

    def position(self, pid, fd):
        return 0

    def __enter__(self):
        self.saved = {
            'scandir': backend.os.scandir,
            'stat': backend.os.stat,
            'listdir': backend.os.listdir,
            'flags': backend.descriptor_flags,
            'position': backend.descriptor_position,
        }
        backend.os.scandir = self.scandir
        backend.os.stat = lambda path: fd_stat(path, self.saved['stat'])
        backend.os.listdir = self.listdir
        backend.descriptor_flags = self.flags
        backend.descriptor_position = self.position
        self.observer = self.observer()
        return self

    def __exit__(self, *args):
        backend.os.scandir = self.saved['scandir']
        backend.os.stat = self.saved['stat']
        backend.os.listdir = self.saved['listdir']
        backend.descriptor_flags = self.saved['flags']
        backend.descriptor_position = self.saved['position']
        return False


class WholeCohortBracket(unittest.TestCase):
    """One live cohort sweep = entry full check, cheap local work, finally full."""

    def test_whole_cohort_pays_exactly_two_full_checks(self):
        pids = [701, 703, 705]
        tables = {pid: ['0', '1', '2'] for pid in pids}
        with Fixture(pids, tables) as fixture:
            ownership = fixture.observer.verify_task_ownership_original()
        self.assertEqual([row['tid'] for row in ownership], pids)
        self.assertEqual([row['tgid'] for row in ownership], pids)
        self.assertEqual(fixture.full, 2,
                         'one entry + one finally live validation for the whole cohort')
        self.assertEqual(fixture.lease.calls, 2,
                         'the real lease set is swept only at the two live boundaries')
        self.assertEqual(fixture.events[0][0], 'full', 'entry validation precedes every real read')
        self.assertEqual(fixture.events[-1][0], 'full', 'trailing validation follows every real read')
        self.assertEqual(len([event for event in fixture.events if event[0] == 'scan']), len(pids))
        self.assertEqual(fixture.slots, len(pids) * 3,
                         'every actual slot name is still listed and compared')

    def test_descendant_tgid_census_uses_the_same_single_bracket(self):
        pids = [711, 713]
        tables = {pid: ['4'] for pid in pids}
        with Fixture(pids, tables, tgids={711: 711, 713: 711},
                     fd_tables={711: 711, 713: 711}) as fixture:
            ownership = fixture.observer.verify_task_ownership_original()
        self.assertEqual([row['tgid'] for row in ownership], [711, 711])
        self.assertEqual(fixture.full, 2)
        self.assertEqual(fixture.events[0][0], 'full')
        self.assertEqual(fixture.events[-1][0], 'full')

    def test_standalone_bounded_fd_slots_keeps_its_own_full_guards(self):
        pids = [721]
        tables = {721: ['3', '0', '12']}
        with Fixture(pids, tables) as fixture:
            self.assertEqual(fixture.observer.bounded_fd_slots(721), ['0', '3', '12'])
        self.assertEqual(fixture.full, 2,
                         'standalone slot scan still validates at entry and in finally')
        self.assertEqual(fixture.lease.calls, 2)

    def test_scan_failure_still_runs_the_trailing_full_check(self):
        pids = [731, 733]
        tables = {pid: ['0'] for pid in pids}
        with Fixture(pids, tables, fail_scan=733) as fixture:
            with self.assertRaises(FileNotFoundError):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2, 'trailing live validation runs after a scan exception')


class LocalRefusal(unittest.TestCase):
    """Cheap per-iteration refusal remains exact and never masks a deadline."""

    def test_deadline_expiry_inside_the_cohort_is_refused(self):
        pids = [741, 743]
        tables = {pid: ['0'] for pid in pids}

        def expire(pid, fixture):
            if pid == 741:
                fixture.observer.deadline = time.monotonic() - 1

        with Fixture(pids, tables, on_scan=expire) as fixture:
            with self.assertRaisesRegex(AssertionError, 'all-stop observer deadline'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_stdio_failure_inside_the_cohort_is_refused(self):
        pids = [751, 753]
        tables = {pid: ['0'] for pid in pids}

        def poison(pid, fixture):
            if pid == 751:
                fixture.observer.pump_errors.append('injected stdio failure')

        with Fixture(pids, tables, on_scan=poison) as fixture:
            with self.assertRaisesRegex(AssertionError, 'actual bounded stdio failed'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_timeout_during_the_cohort_is_not_masked(self):
        pids = [761, 763]
        tables = {pid: ['0'] for pid in pids}
        with Fixture(pids, tables, fail_flags=True) as fixture:
            with self.assertRaisesRegex(TimeoutError, 'actual owned child observation deadline'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2, 'the finally boundary still runs on timeout')

    def test_scan_refuses_above_1024_slots_before_unbounded_collection(self):
        names = []
        with Fixture([771], {771: [str(index) for index in range(5000)]},
                     names=names) as fixture:
            with self.assertRaisesRegex(AssertionError, 'slots unsupported'):
                fixture.observer.bounded_fd_slots(771)
        # The production loop checks the bound before appending, so the 1024
        # retained values stay bounded; only the one look-ahead entry that
        # triggers the refusal was yielded. 5000 real names are never collected.
        self.assertLessEqual(len(names), 1025,
                             'the 1024 slot cap refuses before unbounded collection')
        self.assertEqual(fixture.full, 2)

    def test_scan_failure_in_standalone_slots_still_runs_finally(self):
        with Fixture([781], {781: ['0']}, fail_scan=781) as fixture:
            with self.assertRaises(FileNotFoundError):
                fixture.observer.bounded_fd_slots(781)
        self.assertEqual(fixture.full, 2)


class NegativeOwnership(unittest.TestCase):
    """Every authority/identity disagreement is refused, never cached."""

    def test_lease_break_is_refused_by_the_trailing_boundary(self):
        pids = [791, 793]
        tables = {pid: ['0', '1'] for pid in pids}
        with Fixture(pids, tables, lease=LeaseStub(fail_on=2)) as fixture:
            with self.assertRaisesRegex(LeaseError, 'kernel requested read lease break'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_different_slots_under_one_claimed_fd_table_are_refused(self):
        pids = [801, 803]
        tables = {801: ['0', '1'], 803: ['0', '2']}
        with Fixture(pids, tables, fd_tables={801: 801, 803: 801}) as fixture:
            with self.assertRaisesRegex(AssertionError, 'CLONE_FILES table differs'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_tgid_mismatch_with_kernel_binding_is_refused(self):
        pids = [811, 813]
        tables = {pid: ['0'] for pid in pids}
        with Fixture(pids, tables, tgids={811: 811, 813: 811}) as fixture:
            fixture.observer.actual_tgid = lambda pid: 811 if pid == 811 else 999
            with self.assertRaisesRegex(AssertionError, 'actual TGID differs'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_unregistered_tgid_task_census_is_refused(self):
        pids = [821, 823]
        tables = {pid: ['0'] for pid in pids}

        def census(tgid):
            return ['999999'] if tgid == 821 else ['823']

        with Fixture(pids, tables, tgids={821: 821, 823: 821}, census=census) as fixture:
            with self.assertRaisesRegex(AssertionError, 'unregistered or missing actual TGID task'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.full, 2)

    def test_exited_task_is_excluded_but_others_are_still_validated(self):
        pids = [831, 833]
        tables = {pid: ['0'] for pid in pids}
        with Fixture(pids, tables) as fixture:
            fixture.observer.tasks[831]['exited'] = True
            ownership = fixture.observer.verify_task_ownership_original()
        self.assertEqual([row['tid'] for row in ownership], [833])
        self.assertEqual(fixture.full, 2)


if __name__ == '__main__':
    unittest.main()

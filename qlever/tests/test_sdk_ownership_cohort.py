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
import errno
import importlib.util
import os
import re
import subprocess
import sys
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

    def __init__(self, fail_on=None, guard_fail=None):
        self.calls = 0
        self.guard_calls = 0
        self.fail_on = fail_on
        self.guard_fail = guard_fail

    def guard(self):
        # Cheap admission guard: the stub can inject a sticky refusal, while
        # full lease verdicts remain on the counted check() path.
        self.guard_calls += 1
        if self.guard_fail is not None:
            raise self.guard_fail
        return None

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

        def counted(method):
            def full():
                self.full += 1
                self.events.append(('full', self.full))
                return method(observer)
            return full

        observer.check = counted(backend.Observer.check)
        observer.check_full = counted(backend.Observer.check_full)
        observer.check_deadline = lambda: backend.Observer.check_deadline(observer)
        observer.actual_tgid = lambda pid: self.tgids[pid]
        return observer

    def arm_outer(self):
        """Arm one exact local outer window for the deferred-closing tests."""
        waiter = SimpleNamespace(active=True, deadline=time.monotonic() + 30,
                                 parent_deadline=time.monotonic() + 60,
                                 check=lambda: None)
        self.observer.waiter = waiter
        self.observer.deadline = time.monotonic() + 60
        self.observer.open_outer_lease_window()
        return waiter

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

    def fields(self, pid, fd, *, flags=True, position=True):
        """Native one-read contract: one call returns the requested fields."""
        values = []
        if flags:
            values.append(self.flags(pid, fd))
        if position:
            values.append(self.position(pid, fd))
        return tuple(values) if flags and position else values[0]

    def __enter__(self):
        self.saved = {
            'scandir': backend.os.scandir,
            'stat': backend.os.stat,
            'listdir': backend.os.listdir,
            'flags': backend.descriptor_flags,
            'position': backend.descriptor_position,
            'fields': backend.descriptor_fields,
        }
        backend.os.scandir = self.scandir
        backend.os.stat = lambda path: fd_stat(path, self.saved['stat'])
        backend.os.listdir = self.listdir
        backend.descriptor_flags = self.flags
        backend.descriptor_position = self.position
        backend.descriptor_fields = self.fields
        self.observer = self.observer()
        return self

    def __exit__(self, *args):
        backend.os.scandir = self.saved['scandir']
        backend.os.stat = self.saved['stat']
        backend.os.listdir = self.saved['listdir']
        backend.descriptor_flags = self.saved['flags']
        backend.descriptor_position = self.saved['position']
        backend.descriptor_fields = self.saved['fields']
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
        self.assertEqual(fixture.lease.calls, 1,
                         'the real lease set is swept at the one full closing boundary')
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
        self.assertEqual(fixture.lease.calls, 0,
                         'standalone slots use only cheap guards; their enclosing boundary owns the full sweep')

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
        # These two pids must share ONE declared fd table so the cohort really
        # reads descriptor_fields: with singleton tables the optimized sweep
        # legitimately never touches those fields, and the injected flag failure
        # could not fire. The timeout assertion itself is unchanged.
        with Fixture(pids, tables, fd_tables={pid: 1700 for pid in pids}, fail_flags=True) as fixture:
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

    def test_cohort_refuses_singleton_above_1024_slots_and_still_runs_finally(self):
        """The optimized sweep may skip UNUSED singleton snapshots, never the cap.

        A singleton declared fd table still enumerates its slots through the real
        bounded loop, so a 5000-slot table must be refused - this is the guard for
        the historic "cap removed for singleton owners" bug.
        """
        names = []
        with Fixture([791], {791: [str(index) for index in range(5000)]},
                     names=names) as fixture:
            with self.assertRaisesRegex(AssertionError, 'slots unsupported'):
                fixture.observer.verify_task_ownership_original()
        self.assertLessEqual(len(names), 1025,
                             'the cohort still bounds slot enumeration at 1024')
        self.assertEqual(fixture.full, 2, 'entry and finally both ran')

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
        with Fixture(pids, tables, lease=LeaseStub(fail_on=1)) as fixture:
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


class BarrierSnapshotHarness:
    """Real barrier_original with only kernel/emit/ownership effects mocked."""

    def __init__(self, tasks, *, trace=None, state=None, verify=None, reap=None):
        self.tasks = tasks
        self.trace_callback = trace
        self.state_callback = state
        self.verify_callback = verify
        self.reap_callback = reap
        self.events = []
        self.marker = object()
        self.observer = object.__new__(backend.Observer)
        self.observer.tasks = tasks
        self.observer.pausing = False
        self.observer.shared_tasks = True
        self.observer.serialize_terminal_syscalls = False
        self.observer.unknown_stops = 0
        self.observer.emit = self.emit
        self.observer.verify_task_ownership = self.verify
        self.observer.close_terminal_authorities = self.close
        self.observer.wait_one = self.wait_one
        self.observer.event = self.event
        self.observer.reap_terminal_task = self.reap

    def emit(self, row):
        self.events.append(('emit', tuple(row.get('pids', ()))))
        return self.marker

    def verify(self, peers=()):
        self.events.append(('verify', tuple(sorted(self.tasks))))
        if self.verify_callback is not None:
            self.verify_callback(self.tasks)
        return []

    def close(self, barrier):
        self.events.append(('close',))

    def trace(self, request, pid):
        self.events.append(('trace', pid))
        if self.trace_callback is not None:
            self.trace_callback(self.tasks, pid)

    def state(self, pid):
        self.events.append(('state', pid))
        return self.state_callback(pid) if self.state_callback is not None else 't'

    def reap(self, pid, allow_pending=False):
        self.events.append(('reap', pid))
        if self.reap_callback is not None:
            self.reap_callback(self.tasks, pid)

    def wait_one(self):
        raise AssertionError('barrier must not wait when every live row is stopped')

    def event(self, pid, status, record):
        self.events.append(('event', pid))

    def __enter__(self):
        self.saved = (backend.state, backend.single)
        backend.state = self.state
        backend.single = SimpleNamespace(trace=self.trace)
        return self

    def __exit__(self, *args):
        backend.state, backend.single = self.saved
        return False

    def run(self):
        return self.observer.barrier_original()


class BarrierSnapshot(unittest.TestCase):
    """The two historical-row snapshots must stay exact but allocation-cheap."""

    def test_stable_history_order_and_observable_sequence(self):
        tasks = {
            101: dict(stopped=False, exited=True),
            102: dict(stopped=False, exited=True),
            103: dict(stopped=False, exited=True),
            104: dict(stopped=True, exited=False),
            105: dict(stopped=True, exited=False),
            106: dict(stopped=True, exited=False),
        }
        order = list(tasks)
        with BarrierSnapshotHarness(tasks) as harness:
            result = harness.run()
        self.assertIs(result, harness.marker)
        self.assertFalse(harness.observer.pausing)
        self.assertEqual(list(tasks), order, 'historical rows stay present and ordered')
        self.assertEqual(harness.events, [
            ('state', 104), ('state', 105), ('state', 106),
            ('verify', (101, 102, 103, 104, 105, 106)),
            ('emit', (104, 105, 106)), ('close',),
        ])

    def test_row_status_mutation_is_read_at_the_original_body_point(self):
        tasks = {
            201: dict(stopped=False, exited=True),
            202: dict(stopped=True, exited=False),
            203: dict(stopped=False, exited=False),
            204: dict(stopped=True, exited=False),
        }

        def trace(rows, pid):
            rows[pid]['stopped'] = True
            rows[pid]['observedByTrace'] = True

        with BarrierSnapshotHarness(tasks, trace=trace) as harness:
            result = harness.run()
        self.assertIs(result, harness.marker)
        self.assertTrue(tasks[203]['observedByTrace'])
        self.assertEqual(harness.events, [
            ('trace', 203),
            ('state', 202), ('state', 203), ('state', 204),
            ('verify', (201, 202, 203, 204)),
            ('emit', (202, 203, 204)), ('close',),
        ])

    def test_second_snapshot_sees_insert_delete_and_pid_row_replacement(self):
        tasks = {
            301: dict(stopped=False, exited=True),
            302: dict(stopped=True, exited=False),
            303: dict(stopped=True, exited=False),
            304: dict(stopped=True, exited=False),
            305: dict(stopped=False, exited=False),
        }
        terminal = set()

        def trace(rows, pid):
            rows[pid]['stopped'] = True
            rows[900] = dict(stopped=True, exited=False,
                             terminalAuthority=dict(closed=True))
            terminal.add(900)
            del rows[301]
            del rows[304]
            rows[303] = dict(stopped=True, exited=False,
                             terminalAuthority=dict(closed=True),
                             replacedByCallback=True)
            terminal.add(303)

        def state(pid):
            return 'Z' if pid in terminal else 't'

        def reap(rows, pid):
            terminal.discard(pid)
            rows[pid]['stopped'] = True

        with BarrierSnapshotHarness(tasks, trace=trace, state=state, reap=reap) as harness:
            result = harness.run()
        self.assertIs(result, harness.marker)
        self.assertNotIn(301, tasks)
        self.assertNotIn(304, tasks)
        self.assertTrue(tasks[303]['replacedByCallback'])
        self.assertIn(900, tasks)
        self.assertEqual(harness.events, [
            ('trace', 305),
            ('state', 303), ('reap', 303),
            ('state', 900), ('reap', 900),
            ('state', 302), ('state', 303), ('state', 305), ('state', 900),
            ('verify', (302, 303, 305, 900)),
            ('emit', (302, 303, 305, 900)), ('close',),
        ])

    def test_non_plain_mapping_keeps_items_callback_and_never_copies(self):
        class CallbackMap(dict):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.items_calls = 0

            def items(self):
                self.items_calls += 1
                return super().items()

            def copy(self):
                raise AssertionError('non-plain mapping must keep the list path')

        tasks = CallbackMap({
            401: dict(stopped=False, exited=True),
            402: dict(stopped=True, exited=False),
            403: dict(stopped=True, exited=False),
            404: dict(stopped=True, exited=False),
            405: dict(stopped=True, exited=False),
        })
        with BarrierSnapshotHarness(tasks) as harness:
            result = harness.run()
        self.assertIs(result, harness.marker)
        self.assertEqual(tasks.items_calls, 4,
                         'first snapshot, while view, second snapshot, live view')
        self.assertEqual(harness.events, [
            ('state', 402), ('state', 403), ('state', 404), ('state', 405),
            ('verify', (401, 402, 403, 404, 405)),
            ('emit', (402, 403, 404, 405)), ('close',),
        ])

    def test_primary_exception_identity_and_pausing_cleanup(self):
        sentinel = RuntimeError('trace callback sentinel')
        tasks = {
            501: dict(stopped=False, exited=True),
            502: dict(stopped=True, exited=False),
            503: dict(stopped=False, exited=False),
        }

        def trace(rows, pid):
            raise sentinel

        with BarrierSnapshotHarness(tasks, trace=trace) as harness:
            with self.assertRaises(RuntimeError) as raised:
                harness.run()
        self.assertIs(raised.exception, sentinel)
        self.assertFalse(harness.observer.pausing)
        self.assertEqual(harness.events, [('trace', 503)])


class OuterWindowClosing(unittest.TestCase):
    """Only the exact entry outer claim may use the sticky closing guard."""

    def test_valid_outer_window_avoids_global_sweep_and_keeps_guard(self):
        pids = [901, 903]
        tables = {pid: ['0', '1'] for pid in pids}
        with Fixture(pids, tables) as fixture:
            fixture.arm_outer()
            ownership = fixture.observer.verify_task_ownership_original()
        self.assertEqual([row['tid'] for row in ownership], pids)
        self.assertEqual(fixture.lease.calls, 0,
                         'valid exact outer window must not run the global sweep')
        self.assertGreaterEqual(fixture.lease.guard_calls, 1,
                                'sticky/nonlease closing guard still runs')
        self.assertEqual(len([event for event in fixture.events if event[0] == 'scan']), len(pids))

    def test_outer_window_sticky_guard_refusal(self):
        error = LeaseError('injected sticky guard failure')
        with Fixture([911], {911: ['0']}, lease=LeaseStub(guard_fail=error)) as fixture:
            fixture.arm_outer()
            with self.assertRaises(LeaseError) as raised:
                fixture.observer.verify_task_ownership_original()
        self.assertIs(raised.exception, error)
        self.assertEqual(fixture.lease.calls, 0)

    def test_outer_window_nonlease_refusal(self):
        def poison(pid, fixture):
            fixture.observer.pump_errors.append('injected stdio failure')

        with Fixture([921], {921: ['0']}, on_scan=poison) as fixture:
            fixture.arm_outer()
            with self.assertRaisesRegex(AssertionError, 'actual bounded stdio failed'):
                fixture.observer.verify_task_ownership_original()
        self.assertEqual(fixture.lease.calls, 0)

    def test_outer_window_primary_exception_survives_guard_failure(self):
        primary = OSError(5, 'injected ownership primary')

        def poison(pid, fixture):
            fixture.observer.pump_errors.append('injected trailing guard failure')
            raise primary

        with Fixture([931], {931: ['0']}, on_scan=poison) as fixture:
            fixture.arm_outer()
            with self.assertRaises(OSError) as raised:
                fixture.observer.verify_task_ownership_original()
        self.assertIs(raised.exception, primary)
        self.assertEqual(fixture.lease.calls, 0)

    def test_outer_window_loses_eligibility_on_waiter_phase_deadline_claim(self):
        cases = {
            'waiter': lambda fixture: setattr(
                fixture.observer, 'waiter',
                SimpleNamespace(active=True,
                                deadline=fixture.observer.waiter.deadline,
                                parent_deadline=fixture.observer.waiter.parent_deadline,
                                check=lambda: None)),
            'phase': lambda fixture: setattr(fixture.observer, 'current_phase', 'compile'),
            'deadline': lambda fixture: setattr(
                fixture.observer.waiter, 'deadline',
                fixture.observer.waiter.deadline + 1),
            'claim': lambda fixture: setattr(
                fixture.observer, '_outer_lease_coalesce',
                dict(fixture.observer._outer_lease_coalesce)),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                fired = []
                def change(pid, fixture, mutate=mutate, fired=fired):
                    if not fired:
                        fired.append(True)
                        mutate(fixture)
                with Fixture([941, 943], {941: ['0'], 943: ['0']}, on_scan=change) as fixture:
                    fixture.arm_outer()
                    ownership = fixture.observer.verify_task_ownership_original()
                self.assertEqual([row['tid'] for row in ownership], [941, 943])
                self.assertEqual(fixture.lease.calls, 1,
                                 'changed context must fall back to the global closing sweep')

    def test_outer_window_loses_eligibility_on_thread_change(self):
        with Fixture([951], {951: ['0']}) as fixture:
            fixture.arm_outer()
            actual = backend.threading.get_ident
            backend.threading.get_ident = lambda: actual() + 1
            try:
                ownership = fixture.observer.verify_task_ownership_original()
            finally:
                backend.threading.get_ident = actual
        self.assertEqual([row['tid'] for row in ownership], [951])
        self.assertEqual(fixture.lease.calls, 1,
                         'thread change must fall back to the global closing sweep')

    def test_outer_window_wrong_tgid_census_fd_slot_still_refuse(self):
        with self.subTest(kind='tgid'):
            with Fixture([961], {961: ['0']}) as fixture:
                fixture.arm_outer()
                fixture.observer.actual_tgid = lambda pid: 999
                with self.assertRaisesRegex(AssertionError, 'actual TGID differs'):
                    fixture.observer.verify_task_ownership_original()
            self.assertEqual(fixture.lease.calls, 0)
        with self.subTest(kind='census'):
            with Fixture([971], {971: ['0']}, census=lambda tgid: ['999999']) as fixture:
                fixture.arm_outer()
                with self.assertRaisesRegex(AssertionError, 'unregistered or missing actual TGID task'):
                    fixture.observer.verify_task_ownership_original()
            self.assertEqual(fixture.lease.calls, 0)
        with self.subTest(kind='fd'):
            with Fixture([981], {981: ['0']}, fail_scan=981) as fixture:
                fixture.arm_outer()
                with self.assertRaises(FileNotFoundError):
                    fixture.observer.verify_task_ownership_original()
            self.assertEqual(fixture.lease.calls, 0)
        with self.subTest(kind='slot-cap'):
            names = []
            with Fixture([991], {991: [str(i) for i in range(5000)]}, names=names) as fixture:
                fixture.arm_outer()
                with self.assertRaisesRegex(AssertionError, 'slots unsupported'):
                    fixture.observer.verify_task_ownership_original()
            self.assertLessEqual(len(names), 1025)
            self.assertEqual(fixture.lease.calls, 0)


@unittest.skipUnless(sys.platform.startswith('linux'), 'real read leases are Linux-only')
class RealOuterWindowClosing(unittest.TestCase):
    """Real leases: the deferred ownership close must not become final acceptance."""

    def _harness(self):
        from qlever.tests import test_sdk_lease_bracket_production as production
        harness = production.Harness()
        self.addCleanup(harness.close)
        observer = harness.observer
        waiter = backend.owned_wait.BlockingOwnedWait(time.monotonic() + 120)
        waiter.__enter__()
        self.addCleanup(waiter.__exit__, None, None, None)
        token = waiter.clamp(time.monotonic() + 60)
        self.addCleanup(waiter.restore, token)
        observer.waiter = waiter
        observer.deadline = time.monotonic() + 120
        observer.open_outer_lease_window()
        self.addCleanup(observer.close_outer_lease_window)
        return production, harness, observer

    def test_outer_window_defers_global_ownership_then_complete_rejects_mutated_unrelated_lease(self):
        production, harness, observer = self._harness()
        path = os.path.join(harness.tmp.name, 'lease0.bin')
        before = backend.lifetime_leases.identity(harness.leased[0])
        fired = []
        actual = observer.check_deadline
        def mutate():
            if not fired:
                fired.append(True)
                os.chmod(path, 0o600)
                self.assertNotEqual(backend.lifetime_leases.identity(harness.leased[0]), before)
            return actual()
        observer.check_deadline = mutate
        try:
            ownership = observer.verify_task_ownership_original()
        finally:
            observer.check_deadline = actual
        self.assertTrue(fired)
        self.assertTrue(ownership)
        with self.assertRaises(production.leases.LeaseError):
            harness.lease_set.complete()

    def test_outer_window_sticky_sigio_refuses_before_result_escapes(self):
        production, harness, observer = self._harness()
        path = os.path.join(harness.tmp.name, 'lease0.bin')
        child_code = (
            'import os,sys\n'
            'try:\n'
            ' os.open(sys.argv[1], os.O_WRONLY|os.O_NONBLOCK)\n'
            'except OSError as error:\n'
            ' print(error.errno)\n'
            ' sys.exit(0 if error.errno in (11,35) else 2)\n'
            'else:\n'
            ' sys.exit(3)\n')
        completed = subprocess.run(
            [sys.executable, '-c', child_code, path],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0,
                         'conflicting open must fail with EAGAIN/EWOULDBLOCK: %r' % completed)
        self.assertIn(completed.stdout.strip(), ('11', '35'))
        deadline = time.monotonic() + 5
        while harness.lease_set._failure is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(harness.lease_set._failure,
                             'real conflicting open must latch the parent SIGIO failure')
        with self.assertRaises(production.leases.LeaseError):
            observer.verify_task_ownership_original()


if __name__ == '__main__':
    unittest.main()

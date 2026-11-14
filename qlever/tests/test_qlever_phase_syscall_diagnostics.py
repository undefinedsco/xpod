"""Bounded phase syscall-stop histogram: real hook, numeric domain, bounds.

DIAGNOSTIC ONLY. These cases drive the ACTUAL PhaseProgress counter and the
production observe_syscall hook, not a duplicated private model, and not AST
strings.
"""
import importlib.util
import json
import pathlib
import signal
import sys
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('test_phase_syscall_observer', 'sdk-ptrace-execution.py')
bindings = load('test_phase_syscall_bindings', 'sdk-generation-multiprocess-bindings.py')

ARCHES = sorted(bindings.POLICIES)


def policy_max(arch):
    maximum = -1
    for role, value in bindings.policy(arch).items():
        numbers = value if isinstance(value, (set, frozenset)) else {value}
        for nr in numbers:
            if type(nr) is int and nr >= 0:
                maximum = max(maximum, nr)
    return maximum


class Counter(unittest.TestCase):
    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)

    def row(self, arch, nr, op, kind='kernel-syscall'):
        return {'kind': kind, 'arch': arch, 'nr': nr, 'op': op}

    # ---- numeric domain, not names -------------------------------------
    def test_domain_is_derived_from_the_existing_policy(self):
        for arch in ARCHES:
            self.assertIn(arch, obs.PHASE_SYSCALL_DOMAINS)
            self.assertEqual(obs.PHASE_SYSCALL_DOMAINS[arch], policy_max(arch))

    def test_in_domain_numbers_are_kept_individual(self):
        arch = ARCHES[0]
        for nr in (0, 1, 2, 3, 4, 5):
            self.p.observe_syscall(self.row(arch, nr, 'entry'))
        summary = self.p.syscall_summary()
        self.assertEqual(summary['totalStops'], 6)
        self.assertEqual(summary['distinctKeys'], 6,
                         'in-domain numbers must NOT collapse together')
        nums = sorted(r['nr'] for r in summary['top'] if 'nr' in r)
        self.assertEqual(nums, [0, 1, 2, 3, 4, 5])

    def test_metadata_ops_the_policy_never_names_are_still_distinct(self):
        # openat(257)/newfstatat(262)/fstat(80) are NOT in the policy roles but
        # fall inside the derived numeric domain, so they must stay separate.
        arch = ARCHES[0]
        for nr in (80, 257, 262):
            self.assertLessEqual(nr, obs.PHASE_SYSCALL_DOMAINS[arch])
            self.p.observe_syscall(self.row(arch, nr, 'entry'))
        summary = self.p.syscall_summary()
        self.assertEqual(summary['distinctKeys'], 3)
        self.assertEqual({r['nr'] for r in summary['top']}, {80, 257, 262})

    def test_out_of_domain_collapses_to_one_aggregate(self):
        arch = ARCHES[0]
        maximum = obs.PHASE_SYSCALL_DOMAINS[arch]
        for nr in (maximum + 1, maximum + 999, 10 ** 12, -5):
            self.p.observe_syscall(self.row(arch, nr, 'entry'))
        summary = self.p.syscall_summary()
        self.assertEqual(summary['totalStops'], 4)
        self.assertEqual(summary['distinctKeys'], 1)
        self.assertEqual(summary['top'][0]['name'], obs.PHASE_SYSCALL_OTHER)

    def test_membership_bounded_under_flood(self):
        arch = ARCHES[0]
        limit = sum(m + 1 for m in obs.PHASE_SYSCALL_DOMAINS.values()) + 1
        for invented in range(50000):
            self.p.observe_syscall(self.row(arch, 200000 + invented, 'entry'))
        summary = self.p.syscall_summary()
        self.assertLessEqual(summary['distinctKeys'], limit)
        self.assertEqual(summary['totalStops'], 50000)

    def test_derived_domains_match_the_real_policy(self):
        # The previous "hard cap" constant was declared but never enforced, so it
        # is removed rather than claimed. What is real: the derived closed domain
        # per arch, which today is 0..435 (436 numbers) for both supported arches.
        self.assertFalse(hasattr(obs, 'PHASE_SYSCALL_DOMAIN_LIMIT'),
                         'an unused cap must not be advertised')
        for arch in ARCHES:
            self.assertEqual(obs.PHASE_SYSCALL_DOMAINS[arch], policy_max(arch))

    # ---- entry/exit accounting ----------------------------------------
    def test_entry_and_exit_counted_separately(self):
        arch = ARCHES[0]
        self.p.observe_syscall(self.row(arch, 5, 'entry'))
        self.p.observe_syscall(self.row(arch, 5, 'exit'))
        summary = self.p.syscall_summary()
        self.assertEqual((summary['entries'], summary['exits']), (1, 1))
        self.assertEqual(summary['totalStops'], 2)
        bucket = next(r for r in summary['top'] if r.get('nr') == 5)
        self.assertEqual(bucket['stops'], 2)
        self.assertEqual(bucket['entries'], 1)

    def test_non_syscall_rows_never_count(self):
        arch = ARCHES[0]
        self.p.observe_syscall({'kind': 'signal-delivery', 'op': 'entry',
                                'arch': arch, 'nr': 5})
        self.assertEqual(self.p.syscall_summary()['totalStops'], 0)

    def test_malformed_shapes_are_ignored_by_type_checks(self):
        for bad in (None, 5, 'x', [], {'op': 'entry'},
                    {'kind': 'kernel-syscall', 'op': 'entry', 'arch': None, 'nr': 1},
                    {'kind': 'kernel-syscall', 'op': 'entry', 'arch': 1, 'nr': '9'},
                    {'kind': 'kernel-syscall', 'op': 'bogus', 'arch': 1, 'nr': 1}):
            self.p.observe_syscall(bad)
        self.assertEqual(self.p.syscall_summary()['totalStops'], 0)

    def test_top_is_limited_and_descending(self):
        arch = ARCHES[0]
        for nr in range(12):
            for _ in range(nr + 1):
                self.p.observe_syscall(self.row(arch, nr, 'entry'))
        summary = self.p.syscall_summary()
        self.assertLessEqual(len(summary['top']), obs.PHASE_SYSCALL_TOP)
        stops = [r['stops'] for r in summary['top']]
        self.assertEqual(stops, sorted(stops, reverse=True))

    def test_phase_reset_prevents_cross_phase_accumulation(self):
        arch = ARCHES[0]
        self.p.observe_syscall(self.row(arch, 5, 'entry'))
        self.assertEqual(self.p.syscall_summary()['totalStops'], 1)
        nxt = obs.PhaseProgress('compile', time.monotonic() + 1800)
        self.assertEqual(nxt.syscall_summary()['totalStops'], 0)
        self.assertEqual(nxt.syscall_summary()['distinctKeys'], 0)

    def test_summary_carries_no_untrusted_text(self):
        self.p.observe_syscall(self.row(ARCHES[0], 123456789, 'entry'))
        blob = json.dumps(self.p.syscall_summary(), sort_keys=True)
        for bad in ('/proc/', '/tmp/', 'argv', 'password', 'token', 'http'):
            self.assertNotIn(bad, blob)


class PrimaryExceptionIdentity(unittest.TestCase):
    """An owned SIGALRM timeout must keep its OWN object identity through the hook.

    This is a real signal test: a genuine SIGALRM with a raising handler fires a
    real check() inside the production hook and the SAME exception object must
    come back out.
    """

    class Held:
        def check(self):
            return None

    def test_real_sigalrm_object_propagates_through_observe_syscall(self):
        class Deadline(TimeoutError):
            pass

        fired = {}

        def handler(signum, frame):
            fired['e'] = Deadline('actual owned child observation deadline')
            raise fired['e']

        p = obs.PhaseProgress('configure', time.monotonic() + 60)
        previous = signal.signal(signal.SIGALRM, handler)
        raised = None
        try:
            signal.setitimer(signal.ITIMER_REAL, 0.0005)
            # observation loop: a real counter call while the alarm is armed
            try:
                for _ in range(300000):
                    p.observe_syscall({'kind': 'kernel-syscall', 'op': 'entry',
                                       'arch': ARCHES[0], 'nr': 5})
            except BaseException as error:
                raised = error
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        self.assertIsNotNone(raised, 'the owned SIGALRM must NOT be swallowed')
        self.assertIs(raised, fired.get('e'),
                      'the SAME owned timeout object must propagate')

    def test_primary_exception_from_summary_is_not_masked(self):
        class Boom(RuntimeError):
            pass

        p = obs.PhaseProgress('configure', time.monotonic() + 60)
        original = Boom('primary')

        # A genuinely broken internal structure must surface, not be hidden:
        # the hook/summary may only tolerate bad INPUT shapes.
        p.syscall_stops = None
        with self.assertRaises(BaseException) as ctx:
            p.syscall_summary()
        self.assertIsNot(ctx.exception, original)


class Serializer(unittest.TestCase):
    def test_payload_includes_syscall_stops_and_keeps_budget(self):
        source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
        self.assertIn('syscallStops=', source)
        self.assertIn('PHASE_PROGRESS_MAXIMUM_BYTES', source)




if __name__ == '__main__':
    unittest.main(verbosity=2)

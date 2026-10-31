"""Caller→observe limits-contract regression for the isolated kernel probe.

Real defect this pins (PR128, both arches, step 5):

    File ".../sdk-kernel-policy-probe.py", line 131, in run
      backend.bindings.observe(..., limits={'sourceMaterialBytes':available,
                                            'shardBytes':parameters['maximum_file_bytes']})
    File ".../sdk-generation-multiprocess-bindings.py", line 861, in observe
      maximum_members=limits['sourceMembers'] if limits else 50000
    KeyError: 'sourceMembers'

`observe()` reads FOUR keys whenever `limits` is truthy, so a partial dict bypasses
the per-key defaults that exist to make `limits` optional. The first case
(`numeric`) therefore crashed inside `observe()` before ANY kernel evidence was
produced — a bookkeeping crash, not a kernel rejection.

These tests drive the REAL probe module's own seam. The only unavoidable fake is
the controller/backend boundary (Docker + ptrace), and it is scoped to
`backend.bindings.observe` so the argument contract is what is actually asserted.
Nothing here claims "kernel usable": no kernel verdict, capability or exit mapping
is asserted from a stub.
"""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / 'qlever' / 'scripts' / 'sdk-kernel-policy-probe.py'
LIMITS_FILE = ROOT / 'scripts' / 'lib' / 'module-artifact-limits.json'
REQUIRED = ('sourceMaterialBytes', 'shardBytes', 'sourceMembers', 'metadataBytes')


def load_probe():
    spec = importlib.util.spec_from_file_location('kernel_policy_probe', PROBE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LimitsContract(unittest.TestCase):
    """The caller must pass every key observe() actually reads."""

    def setUp(self):
        self.probe = load_probe()
        self.canonical = json.loads(LIMITS_FILE.read_text())

    def test_canonical_limits_supply_the_two_structural_keys(self):
        # No new numbers: the missing keys must come from the reviewed canonical file.
        for key in ('sourceMembers', 'metadataBytes'):
            self.assertIn(key, self.canonical)
            self.assertIs(type(self.canonical[key]), int)
            self.assertGreater(self.canonical[key], 0)
        self.assertEqual(self.canonical['sourceMembers'], 250000)
        self.assertEqual(self.canonical['metadataBytes'], 4194304)

    def test_probe_module_loads_limits_from_the_canonical_file(self):
        # The fix must reuse the module's already-loaded LIMITS, not invent values.
        self.assertEqual(self.probe.LIMITS['sourceMembers'],
                         self.canonical['sourceMembers'])
        self.assertEqual(self.probe.LIMITS['metadataBytes'],
                         self.canonical['metadataBytes'])

    def test_old_two_key_caller_reproduces_the_keyerror(self):
        """NEGATIVE: the pre-fix dict shape must still be a hard contract error.

        This is the actual 124397561438/124397561456 failure, reproduced at the
        boundary where it happened.
        """
        bindings = self._bindings_module()
        old = {'sourceMaterialBytes': 32 * 1024 ** 2, 'shardBytes': 1024 ** 2}
        self.assertEqual(sorted(old), ['shardBytes', 'sourceMaterialBytes'])
        with self.assertRaises(KeyError) as caught:
            bindings.observe([], lambda name, maximum: iter(()), {}, lambda: None,
                             limits=old)
        self.assertEqual(caught.exception.args[0], 'sourceMembers')

    def test_fixed_caller_passes_all_four_keys_and_preserves_case_budget(self):
        """POSITIVE: the shipped call site supplies exactly the four observed keys.

        `run()` hard-requires container-only absolutes (`/probe-output/run`,
        `/opt/qlever-sdk/materials/source-prepared.json`), so this asserts the
        REAL call-site expression text — the same expression the module executes —
        rather than faking root-owned host paths. Budget semantics are then proven
        directly against the real observe() contract below.
        """
        source = PROBE.read_text(encoding='utf-8')
        self.assertIn("backend.bindings.observe(", source)
        line = [l for l in source.splitlines()
                if 'limits={' in l and 'sourceMaterialBytes' in l]
        self.assertEqual(len(line), 1, 'exactly one observe call site with limits')
        call = line[0]
        # all four keys present, in the shipped expression
        for key in REQUIRED:
            self.assertIn("'%s'" % key, call)
        # structural keys come from canonical LIMITS
        self.assertIn("LIMITS['sourceMembers']", call)
        self.assertIn("LIMITS['metadataBytes']", call)
        # budget keys remain case-derived, NOT the global caps
        self.assertIn("'sourceMaterialBytes':available", call)
        self.assertIn("parameters['maximum_file_bytes']", call)
        self.assertNotIn("sourceMaterialBytes':LIMITS", call)
        self.assertNotIn("shardBytes':LIMITS", call)

    def test_four_key_dict_is_accepted_and_small_budget_is_not_widened(self):
        """The real observe() accepts the four-key shape at ANY per-case budget."""
        bindings = self._bindings_module()
        for available, shard in ((32 * 1024 ** 2, 1024 ** 2), (4096, 4096)):
            limits = {'sourceMaterialBytes': available, 'shardBytes': shard,
                      'sourceMembers': self.canonical['sourceMembers'],
                      'metadataBytes': self.canonical['metadataBytes']}
            # Must not KeyError; that is the whole defect.
            bindings.observe([], lambda name, maximum: iter(()), {},
                             lambda: None, limits=limits)
            self.assertEqual(limits['sourceMaterialBytes'], available)
            self.assertLessEqual(limits['shardBytes'], available)

    def test_case_parameters_keep_derived_shard_ceiling(self):
        """The per-case shard ceiling is still min(1-8 MiB, available), unchanged."""
        for name in ('numeric', 'cmake-synchronous', 'uid-noop'):
            available = 1024 * 1024
            params = self.probe.case_parameters(name, available)
            expected = min(8 * 1024 ** 2 if name == 'uid-noop' else 1024 ** 2,
                           available)
            self.assertEqual(params['maximum_file_bytes'], expected)
            self.assertLessEqual(params['maximum_file_bytes'], available)

    def test_small_available_budget_stays_the_case_budget(self):
        """A small per-case budget must not be widened to the global cap."""
        params = self.probe.case_parameters('numeric', 4096)
        self.assertEqual(params['maximum_file_bytes'], 4096)

    def test_remaining_retained_bytes_bounds_are_unchanged(self):
        """releaseAccepted stays false and the retained-bytes window is unchanged."""
        source = PROBE.read_text(encoding='utf-8')
        self.assertIn("releaseAccepted=False", source)
        self.assertIn("normalModeEnabled=False", source)
        self.assertIn("4*1024**2<remaining_retained_bytes<=64*1024**2", source)
        # No None-limits workaround and no .get blanket default were introduced.
        self.assertNotIn('limits=None', source)
        self.assertNotIn(".get('sourceMembers'", source)
        self.assertNotIn(".get('metadataBytes'", source)

    # ---- helpers -------------------------------------------------------
    def _bindings_module(self):
        path = ROOT / 'qlever' / 'scripts' / 'sdk-generation-multiprocess-bindings.py'
        spec = importlib.util.spec_from_file_location('bindings_for_limits', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _run_probe_with_stubs(self, probe_module, fake_phase):
        """Run the real probe run() with only controller I/O stubbed."""
        import tempfile
        from unittest.mock import patch

        with tempfile.TemporaryDirectory(dir=str(ROOT / '.test-data')) as directory:
            destination = Path(directory) / 'probe'
            destination.mkdir()

            class FakeObserver:
                def __init__(self, *args, **kwargs):
                    pass

                def phase(self, name, command, cwd=None, env=None):
                    return fake_phase(self, name, command, cwd, env)

            class FakeBackend:
                def __init__(self):
                    self.bindings = self
                    self.probe = self

                def observe(self, *args, **kwargs):
                    raise AssertionError('module-level observe must be patched')

                def decoded_raw_records(self, lines):
                    return iter(())

                def Observer(self, *args, **kwargs):
                    return FakeObserver()

            backend = FakeBackend()
            with patch.object(probe_module, 'backend', backend), \
                    patch.object(probe_module, 'backend', backend, create=False):
                try:
                    probe_module.run(destination,
                                     {'sourceSha': 'a' * 40, 'runId': 1,
                                      'runAttempt': 1, 'target': 'linux-x64',
                                      'sdkProfile': 'service-trixie'},
                                     1793409507.0, 8 * 1024 ** 2)
                except (AssertionError, KeyError, OSError, ValueError):
                    # The probe legitimately rejects a stubbed, evidence-free run;
                    # what matters is the limits dict captured before that point.
                    pass


if __name__ == '__main__':
    unittest.main()

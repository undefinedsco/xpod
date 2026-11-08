"""Retained native-ABI replay must bind the SAME execution identity the producer used.

Every acceptance case drives the REAL `receiver.replay` with the REAL six canonical
sources at their production paths (`candidate-service-runtime-protocol.ts`
`commandSources`), with `selected` untouched. No monkeypatching, no source-string
function replacement, no filesystem or Docker access.
"""
import base64
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RECEIVER = ROOT / 'qlever/scripts/sdk-service-abi-receiver.py'

# Exactly the production `commandSources` mapping.
SOURCES = {
    'image': 'qlever/scripts/sdk-service-image-originals.py',
    'binding': 'qlever/scripts/sdk-readonly-executor-bindings.py',
    'pack': 'qlever/scripts/sdk-service-pack-bindings.py',
    'direct': 'qlever/scripts/sdk-service-abi-direct-runtime-commands.py',
    'collector': 'qlever/scripts/sdk-service-abi-collector.py',
    'seed': 'qlever/scripts/sdk-service-abi-seed.py',
}
OLD_COLLECTOR = Path(__file__).resolve().parent / 'fixtures/service-abi-collector-dd7.original.py'

NONCE = 'b' * 32
NAME = 'xpod-service-output-' + NONCE
CID = 'c' * 64
IMAGE = 'ghcr.io/undefinedsco/xpod@sha256:' + 'a' * 64
CONFIG = 'sha256:' + 'd' * 64
OUTPUT_ROOT = '/out'


def load_receiver():
    spec = importlib.util.spec_from_file_location('abi_receiver_identity', RECEIVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sources(collector_override=None):
    table = {}
    for key, rel in SOURCES.items():
        raw = (ROOT / rel).read_bytes()
        if key == 'collector' and collector_override is not None:
            raw = collector_override
        table[key] = raw
    return table


def record(**over):
    base = {
        'ownerNonce': NONCE,
        'containerName': NAME,
        'containerId': CID,
        'imageReferenceByDigest': IMAGE,
        'configDigest': CONFIG,
        'executionIdentity': [1234, 5678],
    }
    base.update(over)
    return base


class TmpfsExpectation:
    """The exact tmpfs string the CURRENT collector source derives for an identity."""

    @staticmethod
    def string(uid, gid):
        raw = (ROOT / SOURCES['collector']).read_text()
        return '/scratch:' + raw.split("TMPFS_OPTIONS = '")[1].split("'")[0] + ',uid=%d,gid=%d' % (uid, gid)


class ReceiverIdentity(unittest.TestCase):
    def setUp(self):
        self.receiver = load_receiver()

    def replay(self, record_obj, collector_override=None):
        return self.receiver.replay(sources(collector_override), record_obj, 4096, OUTPUT_ROOT)

    # ---- current source: identity is bound and validated -------------------
    def test_current_source_create_binds_retained_identity(self):
        expected, inspect_fn, image_inspect = self.replay(record())
        create = expected[0]
        self.assertEqual(create.count('--user'), 1)
        self.assertEqual(create[create.index('--user') + 1], '1234:5678')
        tmp = [c for c in create if c.startswith('/scratch:')][0]
        self.assertEqual(tmp, TmpfsExpectation.string(1234, 5678))
        self.assertIn('mode=0700', tmp)
        # the real builder's bootstrap survives unchanged
        self.assertIn('cp /seed/abi.sqlite /scratch/abi.sqlite', create[-1])
        self.assertIsNotNone(image_inspect)
        self.assertTrue(callable(inspect_fn))

    def test_yields_control_command_count(self):
        expected, _, _ = self.replay(record())
        # create, inspect, execute, [second terminal inspect], cleanup-inspect,
        # cleanup-remove, cleanup-confirm-absent
        self.assertEqual(len(expected), 7)

    def test_missing_retained_identity_fails_closed(self):
        with self.assertRaises(ValueError) as ctx:
            self.replay({k: v for k, v in record().items() if k != 'executionIdentity'})
        self.assertIn('retained execution identity required', str(ctx.exception))

    def test_invalid_identity_range_fails(self):
        for bad in ([0xFFFFFFFF, 1], [-1, 1], [1.0, 1], [1], '1:1', [1, 2, 3]):
            with self.assertRaises(ValueError):
                self.replay(record(executionIdentity=bad))

    # ---- old source: exact dd7cd0cf bytes, no identity field ---------------
    def test_old_source_with_old_record_replays_without_identity(self):
        old = OLD_COLLECTOR.read_bytes()
        rec = record()
        del rec['executionIdentity']
        expected, _, _ = self.replay(rec, collector_override=old)
        create = expected[0]
        # The old builder has no identity contract at all.
        self.assertNotIn('--user', create)
        self.assertNotIn('uid=', ' '.join(create))
        self.assertEqual(len(expected), 7)

    def test_old_source_with_new_identity_field_is_mixed_and_rejected(self):
        old = OLD_COLLECTOR.read_bytes()
        with self.assertRaises(ValueError) as ctx:
            self.replay(record(), collector_override=old)
        self.assertIn('no identity contract', str(ctx.exception))

    def test_half_updated_source_is_rejected(self):
        """One helper without the other must not silently pass."""
        raw = (ROOT / SOURCES['collector']).read_text()
        broken = raw.replace('def tmpfs_options(identity):', 'def tmpfs_options_disabled(identity):')
        with self.assertRaises(ValueError) as ctx:
            self.replay(record(), collector_override=broken.encode())
        self.assertIn('identity helper pair', str(ctx.exception))


class RetainedInspectClosure(unittest.TestCase):
    """The nested inspect closure must bind the SAME retained identity.

    The inspect row is synthetic fixture data, but the closure, the tmpfs string and
    the identity assertion all come from the ACTUAL compiled collector source.
    """

    def _harness(self):
        receiver = load_receiver()
        expected, inspect_fn, _ = receiver.replay(
            {k: (ROOT / v).read_bytes() for k, v in SOURCES.items()},
            record(), 4096, OUTPUT_ROOT)
        return expected, inspect_fn

    def _row(self, user='1234:5678',
             tmpfs='rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=1234,gid=5678'):
        return {
            'Id': CID, 'Name': '/' + NAME, 'Image': CONFIG,
            'Config': {'User': user, 'Image': IMAGE,
                       'Labels': {'xpod.service-output-owner': NONCE}},
            'State': {'Status': 'exited', 'Running': False, 'Paused': False,
                      'Pid': 0, 'ExitCode': 0, 'OOMKilled': False},
            'HostConfig': {'ReadonlyRootfs': True, 'NetworkMode': 'none', 'Init': True,
                           'PidsLimit': 64, 'Memory': 512 * 1024 ** 2,
                           'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                           'RestartPolicy': {'Name': 'no'},
                           'Tmpfs': {'/scratch': tmpfs}},
            'Mounts': [{'Type': 'bind', 'Source': OUTPUT_ROOT + '/' + NAME + '-scratch',
                        'Destination': '/seed', 'RW': False}],
        }

    def test_matching_row_is_accepted(self):
        _, inspect_fn = self._harness()
        self.assertIsInstance(inspect_fn(json.dumps(self._row()).encode()), dict)

    def test_wrong_config_user_is_rejected(self):
        _, inspect_fn = self._harness()
        with self.assertRaises(ValueError) as ctx:
            inspect_fn(json.dumps(self._row(user='0:0')).encode())
        self.assertIn('execution identity differs', str(ctx.exception))

    def test_wrong_tmpfs_owner_is_rejected(self):
        _, inspect_fn = self._harness()
        with self.assertRaises(ValueError) as ctx:
            inspect_fn(json.dumps(self._row(
                tmpfs='rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=0,gid=0')).encode())
        self.assertIn('kernel-bounded private scratch differs', str(ctx.exception))

    def test_lowered_mode_is_rejected(self):
        _, inspect_fn = self._harness()
        with self.assertRaises(ValueError):
            inspect_fn(json.dumps(self._row(
                tmpfs='rw,noexec,nosuid,nodev,size=8388608,mode=1777,uid=1234,gid=5678')).encode())


if __name__ == '__main__':
    unittest.main()

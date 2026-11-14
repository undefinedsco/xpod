"""Actual subprocess acceptance for the Bun role session adapter.

Every case runs a real Python child through the existing finite transport.
The child speaks only the exact ready/shutdown/closed role protocol; no
qualification, Docker operation or file body is produced here.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
ROLE = 'bun-node-addon'

spec = importlib.util.spec_from_file_location(
    'service_abi_transport', ROOT / 'scripts/sdk-service-abi-transport.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
spec = importlib.util.spec_from_file_location(
    'service_abi_bun_role_session',
    ROOT / 'scripts/sdk-service-abi-bun-role-session.py')
session_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session_module)

CHILD = r'''
import json, os, sys
mode, role, nonce, pidfile = sys.argv[1:5]
with open(pidfile, 'w') as file:
    file.write(str(os.getpid()))

def emit(phase, frame_nonce):
    sys.stdout.write(json.dumps({'phase': phase, 'role': role,
        'nonce': frame_nonce}, separators=(',', ':')) + '\n')
    sys.stdout.flush()

if mode == 'bad-nonce':
    emit('ready', 'f' * 32)
else:
    emit('ready', nonce)

line = sys.stdin.readline()
if not line:
    raise SystemExit(3)
if json.loads(line) != {'phase': 'shutdown', 'role': role, 'nonce': nonce}:
    raise SystemExit(4)
emit('closed', nonce)
if mode == 'extra':
    sys.stdout.write('unexpected trailing line\n')
    sys.stdout.flush()
'''


def _ready_line(role=ROLE, nonce=NONCE):
    return (json.dumps({'phase': 'ready', 'role': role, 'nonce': nonce},
                       separators=(',', ':')) + '\n').encode()


def _closed_line(role=ROLE, nonce=NONCE):
    return (json.dumps({'phase': 'closed', 'role': role, 'nonce': nonce},
                       separators=(',', ':')) + '\n').encode()


def _shutdown_line(role=ROLE, nonce=NONCE):
    return (json.dumps({'phase': 'shutdown', 'role': role, 'nonce': nonce},
                       separators=(',', ':')) + '\n').encode()


class BunRoleSessionTests(unittest.TestCase):
    def setUp(self):
        base = ROOT.parent / '.test-data/service-abi-bun-role'
        base.mkdir(parents=True, exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(prefix='actual-', dir=base)
        self.addCleanup(self.scratch.cleanup)

    def command(self, mode, role=ROLE, nonce=NONCE):
        pidfile = Path(self.scratch.name) / (mode + '.pid')
        return ([sys.executable, '-c', CHILD, mode, role, nonce, str(pidfile)],
                pidfile)

    def deadline(self):
        return time.monotonic() + 20

    def observe(self, mode, *, role=ROLE, nonce=NONCE, reserve=None,
                capture=None):
        charged = {'total': 0}

        def ledger(count):
            charged['total'] += count
            if reserve is not None:
                reserve(count)

        command, pidfile = self.command(mode, role, nonce)
        result = session_module.observe(
            command, role=role, nonce=nonce, parent_deadline=self.deadline(),
            reserve=ledger, transport=transport, check=lambda: None,
            capture_membership=capture or (lambda: {'adapter': 'classic-level'}))
        return result, charged, pidfile

    def assert_absent(self, pidfile):
        self.assertTrue(pidfile.exists())
        pid = int(pidfile.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pid, 0)

    def test_ready_capture_shutdown_closed_actual_streams_and_wait(self):
        charged = {'total': 0}
        hook = {'calls': 0}

        def reserve(count):
            charged['total'] += count

        def capture():
            hook['calls'] += 1
            hook['charged'] = charged['total']
            return {'adapter': 'classic-level', 'version': 'actual'}

        command, pidfile = self.command('normal')
        deadline = self.deadline()
        result = session_module.observe(
            command, role=ROLE, nonce=NONCE, parent_deadline=deadline,
            reserve=reserve, transport=transport, check=lambda: None,
            capture_membership=capture)
        self.assertEqual(hook['calls'], 1)
        self.assertEqual(hook['charged'], len(_ready_line()))
        self.assertLess(hook['charged'], charged['total'])
        self.assertEqual(result['command'], command)
        self.assertEqual(result['role'], ROLE)
        self.assertEqual(result['nonce'], NONCE)
        self.assertEqual(result['membership'],
                         {'adapter': 'classic-level', 'version': 'actual'})
        self.assertEqual(result['stdin'], _shutdown_line())
        self.assertEqual(result['stdout'], _ready_line() + _closed_line())
        self.assertEqual(result['stderr'], b'')
        cleanup = result['cleanup']
        self.assertIs(cleanup['signalAttempted'], True)
        self.assertIs(cleanup['actualRootWait'], True)
        self.assertEqual(cleanup['actualRootReturnCode'], 0)
        self.assertIs(cleanup['ownedGroupAbsent'], True)
        self.assertEqual(cleanup['cleanupErrors'], [])
        self.assertEqual(cleanup['parentDeadlineMonotonic'], deadline)
        self.assert_absent(pidfile)

    def test_wrong_nonce_is_rejected_before_membership_capture(self):
        captured = []

        command, pidfile = self.command('bad-nonce', role='bun-sqlite-extension')
        with self.assertRaisesRegex(ValueError, 'different nonce'):
            session_module.observe(
                command, role='bun-sqlite-extension', nonce=NONCE,
                parent_deadline=self.deadline(), reserve=lambda count: None,
                transport=transport, check=lambda: None,
                capture_membership=lambda: captured.append(1) or {'ok': True})
        self.assertEqual(captured, [])
        self.assert_absent(pidfile)

    def test_capture_hook_failure_preserves_original_error_and_cleans_up(self):
        error = RuntimeError('actual membership hook failed')
        calls = []

        def capture():
            calls.append(1)
            raise error

        command, pidfile = self.command('normal', role='bun-sqlite-extension')
        with self.assertRaises(RuntimeError) as raised:
            session_module.observe(
                command, role='bun-sqlite-extension', nonce=NONCE,
                parent_deadline=self.deadline(), reserve=lambda count: None,
                transport=transport, check=lambda: None,
                capture_membership=capture)
        self.assertIs(raised.exception, error)
        self.assertEqual(calls, [1])
        self.assert_absent(pidfile)

    def test_extra_output_after_closed_is_rejected(self):
        command, pidfile = self.command('extra')
        with self.assertRaisesRegex(ValueError,
                                    'unexpected trailing protocol stdout'):
            session_module.observe(
                command, role=ROLE, nonce=NONCE,
                parent_deadline=self.deadline(), reserve=lambda count: None,
                transport=transport, check=lambda: None,
                capture_membership=lambda: {'adapter': 'classic-level'})
        self.assert_absent(pidfile)

    def test_shared_reserve_failure_cleans_up_the_actual_group(self):
        error = LookupError('shared ledger refused the byte')
        charged = {'total': 0}

        def reserve(count):
            charged['total'] += count
            raise error

        command, pidfile = self.command('normal')
        with self.assertRaises(LookupError) as raised:
            session_module.observe(
                command, role=ROLE, nonce=NONCE,
                parent_deadline=self.deadline(), reserve=reserve,
                transport=transport, check=lambda: None,
                capture_membership=lambda: {'adapter': 'classic-level'})
        self.assertIs(raised.exception, error)
        self.assertEqual(charged['total'], len(_ready_line()))
        self.assert_absent(pidfile)


if __name__ == '__main__':
    unittest.main()

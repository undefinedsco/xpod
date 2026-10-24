"""Mechanical role-membership fixture for the host-side ABI observer.

These are synthetic proc/files trees on ordinary local bytes. They prove the
observer's file-identity and retention mechanics only; they are not evidence
that any real container image or service master produced these values.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'scripts'
TEST_ROOT = HERE.parents[1] / '.test-data/service-abi-role-membership'
TEST_ROOT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('abi_host_session', HERE / 'sdk-service-abi-host-session.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
bspec=importlib.util.spec_from_file_location('read_budget', HERE/'sdk-service-abi-read-budget.py')
budget_module=importlib.util.module_from_spec(bspec);bspec.loader.exec_module(budget_module)


class Ledger:
    def __init__(self, out):
        self.out = Path(out)
        self.out.mkdir(parents=True)
        self.refs = {}
        self.total = 0
        self.budget = types.SimpleNamespace(check=lambda _=0: None)

    def reserve(self, count):
        self.total += count
        return count

    def settle(self, reserved, refs, maximum=None):
        for ref in refs:
            target = self.out / ref['path']
            assert target.is_file()
            assert hashlib.sha256(target.read_bytes()).hexdigest() == ref['sha256']
            self.refs[ref['path']] = dict(ref)


class Fixture:
    """A synthetic /proc/<pid> whose named files carry actual stat identity."""

    def __init__(self, directory):
        self.root = Path(directory).resolve()
        self.proc = self.root / 'proc'
        self.files = self.root / 'files'
        self.pid = 4242
        self.base = self.proc / str(self.pid)
        self.base.mkdir(parents=True)
        self.files.mkdir()
        (self.base / 'root').symlink_to(self.files)
        self.write('/opt/xpod/qlever/bin/xpod_qlever_local_runtime', b'\x7fELF actual runtime')
        self.write('/opt/xpod/qlever/lib/libxpod_qlever_adapter.so', b'\x7fELF actual member')
        self.write('/lib64/ld-linux-x86-64.so.2', b'actual loader bytes')
        self.write('/opt/xpod/qlever/share/data.txt', b'ignored data')
        self.write('/usr/local/bin/bun', b'actual bun executable')
        self.executable = None
        self.rows = []

    def write(self, name, body):
        target = self.files / name.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        return target

    def row(self, start, permissions, name, offset=0):
        target = self.files / name.lstrip('/')
        value = os.stat(target)
        return (f'{start:012x}-{start + 0x1000:012x} {permissions} {offset:08x} '
                f'{os.major(value.st_dev):02x}:{os.minor(value.st_dev):02x} {value.st_ino} {name}')

    def install(self, executable):
        target = self.write('/opt/xpod/qlever/bin/xpod_qlever_local_runtime',
                            b'\x7fELF actual runtime')
        self.executable = executable
        (self.base / 'exe').symlink_to(self.files / executable.lstrip('/'))
        self.rows = [
            self.row(0x7f0000000000, 'r-xp', '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'),
            self.row(0x7f0000001000, 'r-xp', '/opt/xpod/qlever/lib/libxpod_qlever_adapter.so'),
            self.row(0x7f0000002000, 'r--p', '/opt/xpod/qlever/lib/libxpod_qlever_adapter.so', 0x1000),
            self.row(0x7f0000003000, 'r-xp', '/lib64/ld-linux-x86-64.so.2'),
            self.row(0x7f0000004000, 'r--p', '/opt/xpod/qlever/share/data.txt'),
            self.row(0x7f0000005000, 'r-xp', executable),
            '7f0000006000-7f0000007000 rw-p 00000000 00:00 0 ',
            '7f0000009000-7f000000a000 rw-p 00000000 00:00 0 [heap]',
        ]
        (self.base / 'maps').write_text('\n'.join(self.rows) + '\n')

    def observe(self, ledger, **options):
        # Real /proc/<pid>/exe is a magic link whose text is the in-root path.
        # This fixture has no mount namespace, so only readlink's text is
        # emulated; the identity and held bytes still come from the real file.
        real_readlink = os.readlink

        def readlink(path):
            if Path(path) == self.base / 'exe':
                return self.executable
            return real_readlink(path)

        with patch.object(module.os, 'readlink', side_effect=readlink):
            return module.observe_process(self.pid, retained=ledger,
                                          proc_root=str(self.proc), **options)


class DefaultMembershipTests(unittest.TestCase):
    def test_default_prefix_and_qlever_scope_unchanged(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture = Fixture(directory)
            fixture.install('/opt/xpod/qlever/bin/xpod_qlever_local_runtime')
            ledger = Ledger(fixture.root / 'out')
            result = fixture.observe(ledger)
            observation = json.loads((ledger.out / result['observation']['path']).read_text())
            self.assertEqual(result['maps']['path'], 'abi-membership/maps.original')
            self.assertEqual(result['observation']['path'], 'abi-membership/observation.original.json')
            self.assertEqual(observation['executablePath'], module.DEFAULT_EXECUTABLE)
            scopes = {row['path']: row['scope'] for row in observation['members']}
            self.assertEqual(scopes[module.DEFAULT_EXECUTABLE], 'runtime-sdk')
            self.assertEqual(scopes['/lib64/ld-linux-x86-64.so.2'], 'loader-or-system')
            self.assertNotIn('/usr/local/bin/bun', scopes)
            self.assertEqual(observation['allFileMappings'], 6)
            self.assertEqual(observation['selectedMappings'], 5)
            self.assertEqual(observation['ignoredDataMappings'], 1)
            self.assertEqual(observation['anonymousMappings'], 2)
            self.assertEqual(observation['retainedRuntimeAndLoaderBytes'],
                             sum(row['bytes'] for row in observation['members'] if row['retained']))
            self.assertFalse(observation['serviceAbiVerified'])

    def test_role_prefix_separates_maps_members_and_observation(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture = Fixture(directory)
            fixture.install('/opt/xpod/qlever/bin/xpod_qlever_local_runtime')
            ledger = Ledger(fixture.root / 'out')
            first = fixture.observe(ledger, original_prefix='abi-membership/role-a')
            second = fixture.observe(ledger, original_prefix='abi-membership/role-b')
            self.assertEqual(first['maps']['path'], 'abi-membership/role-a/maps.original')
            self.assertEqual(second['maps']['path'], 'abi-membership/role-b/maps.original')
            self.assertNotEqual(first['observation']['path'], second['observation']['path'])
            self.assertTrue(all(ref['path'].startswith('abi-membership/role-a/')
                                for ref in first['members']))
            self.assertTrue(all(ref['path'].startswith('abi-membership/role-b/')
                                for ref in second['members']))


class ExternalExecutableTests(unittest.TestCase):
    def test_external_bun_is_held_but_keeps_loader_or_system_scope(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture = Fixture(directory)
            fixture.install('/usr/local/bin/bun')
            ledger = Ledger(fixture.root / 'out')
            result = fixture.observe(ledger, original_prefix='abi-membership/external',
                                     expected_executable='/usr/local/bin/bun')
            observation = json.loads((ledger.out / result['observation']['path']).read_text())
            external = next(row for row in observation['members']
                            if row['path'] == '/usr/local/bin/bun')
            self.assertEqual(external['scope'], 'loader-or-system')
            self.assertIs(external['retained'], True)
            self.assertEqual(external['original']['bytes'], len(b'actual bun executable'))
            self.assertEqual(external['original']['sha256'],
                             hashlib.sha256(b'actual bun executable').hexdigest())
            self.assertEqual(observation['executableSha256'], external['sha256'])
            self.assertEqual(observation['retainedRuntimeAndLoaderBytes'],
                             sum(row['bytes'] for row in observation['members'] if row['retained']))
            self.assertIn(external['original']['path'], ledger.refs)

    def test_actual_executable_never_trusts_the_declaration_alone(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture = Fixture(directory)
            fixture.install('/usr/local/bin/bun')
            ledger = Ledger(fixture.root / 'out')
            with self.assertRaisesRegex(ValueError, 'actual executable path differs'):
                fixture.observe(ledger, expected_executable=module.DEFAULT_EXECUTABLE)
            self.assertFalse((ledger.out / 'abi-membership/observation.original.json').exists())

    def test_wrong_expected_executable_is_rejected_before_observation(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture = Fixture(directory)
            fixture.install('/opt/xpod/qlever/bin/xpod_qlever_local_runtime')
            ledger = Ledger(fixture.root / 'out')
            with self.assertRaisesRegex(ValueError, 'actual executable path differs'):
                fixture.observe(ledger, expected_executable='/opt/xpod/qlever/bin/other')
            self.assertFalse((ledger.out / 'abi-membership/observation.original.json').exists())


class ArtifactReferenceTests(unittest.TestCase):
    def test_product_fd_stream_reuses_artifact_without_raising_retained_budget(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture=Fixture(directory)
            large=b'x'*(9*1024**2)
            fixture.write('/opt/xpod/qlever/lib/libxpod_qlever_adapter.so',large)
            fixture.install('/usr/local/bin/bun')
            ledger=Ledger(fixture.root/'out')
            result=fixture.observe(ledger,expected_executable='/usr/local/bin/bun',reference_runtime_members=True,read_budget=budget_module.SharedReadBudget(128*1024**2,lambda:None))
            observation=json.loads((ledger.out/result['observation']['path']).read_text())
            member=next(r for r in observation['members'] if r['path'].endswith('libxpod_qlever_adapter.so'))
            self.assertEqual(member['sha256'],hashlib.sha256(large).hexdigest())
            self.assertIsNone(member['original'])
            self.assertFalse(member['retained'])
            self.assertLess(ledger.total,module.MAX_TOTAL)
            self.assertEqual(observation['streamedMemberBytes'],sum(r['bytes'] for r in observation['members']))
            self.assertEqual(module.MAX_FILE,8*1024**2)
            self.assertEqual(module.MAX_TOTAL,8*1024**2)

    def test_two_role_observations_share_read_charges_without_reset(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture=Fixture(directory);fixture.install('/usr/local/bin/bun')
            shared=budget_module.SharedReadBudget(131072,lambda:None)
            first=fixture.observe(Ledger(fixture.root/'one'),expected_executable='/usr/local/bin/bun',reference_runtime_members=True,read_budget=shared)
            used=shared.consumed
            fixture.observe(Ledger(fixture.root/'two'),expected_executable='/usr/local/bin/bun',reference_runtime_members=True,read_budget=shared)
            self.assertEqual(shared.consumed,2*used)
            with self.assertRaisesRegex(ValueError,'one parent-owned'):
                fixture.observe(Ledger(fixture.root/'missing'),expected_executable='/usr/local/bin/bun',reference_runtime_members=True)


class UnsafeDeclarationTests(unittest.TestCase):
    def test_unsafe_prefixes_are_rejected_before_io(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture_root = Path(directory).resolve()
            unsafe = ('', '.', '..', '../escape', '/absolute', 'a//b', 'a/../b',
                      'a\\b', 'a\x00b', './a', 'a/')
            for index, prefix in enumerate(unsafe):
                with self.subTest(prefix=prefix), self.assertRaisesRegex(
                        ValueError, 'canonical safe relative original prefix'):
                    module.observe_process(99, retained=Ledger(fixture_root / ('out-' + str(index))),
                                           proc_root=str(fixture_root / 'missing'),
                                           original_prefix=prefix)

    def test_noncanonical_expected_executable_is_rejected_before_io(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as directory:
            fixture_root = Path(directory).resolve()
            unsafe = ('relative/path', '/opt/xpod/qlever/bin/xpod_qlever_local_runtime/',
                      '//opt/xpod/qlever/bin/xpod_qlever_local_runtime',
                      '/opt/xpod/qlever/../qlever/bin/xpod_qlever_local_runtime',
                      '/opt/xpod/qlever/bin//xpod_qlever_local_runtime', '/')
            for index, executable in enumerate(unsafe):
                with self.subTest(executable=executable), self.assertRaisesRegex(
                        ValueError, 'canonical absolute expected executable'):
                    module.observe_process(99, retained=Ledger(fixture_root / ('out-' + str(index))),
                                           proc_root=str(fixture_root / 'missing'),
                                           expected_executable=executable)


if __name__ == '__main__':
    unittest.main()

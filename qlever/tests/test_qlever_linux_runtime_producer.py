import importlib.util
import json
import io
import tarfile
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'qlever/scripts/produce-linux-runtime-archive.py'
spec = importlib.util.spec_from_file_location('native_runtime_producer', SCRIPT)
producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)


class NativeRuntimeProducerTests(unittest.TestCase):
    def test_only_exact_actual_target_image_digest_is_accepted(self):
        reference = 'ghcr.io/example/module@sha256:' + 'a' * 64
        actual = dict(id='sha256:' + 'b' * 64, os='linux', architecture='amd64', repoDigests=[reference])
        self.assertEqual(producer.verify_image_observation(actual, reference, 'linux-x64'), actual['id'])
        for changed in [dict(architecture='arm64'), dict(os='darwin'), dict(repoDigests=[]), dict(id='image-tag')]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                producer.verify_image_observation(dict(actual, **changed), reference, 'linux-x64')
        with self.assertRaises(RuntimeError): producer.verify_image_observation(actual, reference, 'linux-arm64')

    def test_tags_mutable_or_malformed_inputs_never_select_a_native_source(self):
        for reference in ['ghcr.io/example/module:latest', 'debian:bookworm', 'ghcr.io/example/module@sha256:' + 'a' * 63,
                          'ghcr.io/example/module@sha256:' + 'a' * 64 + '\n', 'http://example/host']:
            with self.subTest(reference=reference), self.assertRaises(RuntimeError): producer.immutable_image(reference)

    def test_preparation_uses_fixed_canonical_abi_policy_under_least_privilege(self):
        command = producer.preparation_command('sha256:' + 'b' * 64, 'linux-x64', Path('/owned/source'), Path('/owned/out'),
                                               ROOT, Path('/owned/cid'), 'c' * 64)
        self.assertEqual(command[:3], ['docker', 'run', '--init'])
        self.assertNotIn('--privileged', command); self.assertNotIn('--rm', command)
        for flag, value in [('--network', 'none'), ('--cap-drop', 'ALL'), ('--security-opt', 'no-new-privileges')]:
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn('--read-only', command)
        mounts = [command[index + 1] for index, arg in enumerate(command) if arg == '--mount']
        self.assertEqual(sum('readonly' in mount for mount in mounts), 2)
        self.assertEqual(sum('dst=/out' in mount and 'readonly' not in mount for mount in mounts), 1)
        self.assertIn('/workspace/qlever/scripts/prepare-linux-physical-runtime.py', command)
        self.assertEqual(command[command.index('--original-manifest-sha256') + 1], 'c' * 64)
        self.assertEqual(command[command.index('--target') + 1], 'linux-x64')

    def test_mount_or_image_injection_is_rejected_and_ownership_is_not_writable_inside_container(self):
        with self.assertRaises(RuntimeError):
            producer.preparation_command('sha256:' + 'b' * 64, 'linux-x64', Path('/input,readonly'), Path('/out'), ROOT, Path('/owned/cid'), 'c' * 64)
        with self.assertRaises(RuntimeError):
            producer.preparation_command('--privileged', 'linux-x64', Path('/input'), Path('/out'), ROOT, Path('/owned/cid'), 'c' * 64)
        source = SCRIPT.read_text()
        self.assertIn("payload = output / 'physical'", source)
        self.assertIn("ownership = output / 'ownership'", source)
        self.assertIn("output / 'original', payload, ROOT, cidfile", source)

    def test_copy_stream_enforces_declared_budget_and_keeps_already_observed_originals(self):
        parent = ROOT / '.test-data/linux-producer-budget'; parent.mkdir(parents=True, exist_ok=True)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, content in [('profile/first', b'keep'), ('profile/second', b'overflow')]:
                member = tarfile.TarInfo(name); member.size = len(content); tar.addfile(member, io.BytesIO(content))
        with tempfile.TemporaryDirectory(dir=parent) as temporary, patch.object(producer.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * producer.GIB)):
            destination = Path(temporary) / 'copied'
            with tarfile.open(fileobj=io.BytesIO(archive.getvalue()), mode='r|') as tar:
                with self.assertRaisesRegex(RuntimeError, 'budget exceeded'):
                    producer.bounded_copy_members(tar, destination, 'profile', 8)
            self.assertEqual((destination / 'first').read_bytes(), b'keep')
            self.assertFalse((destination / 'second').exists())

    def test_copy_stream_rejects_traversal_and_links_without_native_or_docker_execution(self):
        parent = ROOT / '.test-data/linux-producer-budget'; parent.mkdir(parents=True, exist_ok=True)
        for name, link in [('profile/../escape', False), ('profile/link', True)]:
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                member = tarfile.TarInfo(name)
                if link: member.type = tarfile.SYMTYPE; member.linkname = '/outside'
                tar.addfile(member)
            with tempfile.TemporaryDirectory(dir=parent) as temporary, tarfile.open(fileobj=io.BytesIO(archive.getvalue()), mode='r|') as tar:
                with self.assertRaises(RuntimeError): producer.bounded_copy_members(tar, Path(temporary) / 'out', 'profile', 8)

    def test_archive_budget_and_free_floor_preserve_partial_original(self):
        parent = ROOT / '.test-data/linux-producer-budget'; parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary, patch.object(producer, 'ARCHIVE_BYTES', 8), \
                patch.object(producer.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * producer.GIB)):
            output = Path(temporary) / 'archive'
            with output.open('xb') as original:
                writer = producer.BoundedArchiveWriter(original, Path(temporary)); writer.write(b'keep')
                with self.assertRaisesRegex(RuntimeError, 'byte budget'): writer.write(b'too large')
                with patch.object(producer.shutil, 'disk_usage', return_value=SimpleNamespace(free=producer.HARD_FREE_BYTES - 1)):
                    with self.assertRaisesRegex(RuntimeError, 'free-space'): writer.write(b'x')
            self.assertEqual(output.read_bytes(), b'keep')

    def test_copy_transport_stops_before_unbounded_header_or_trailer_reads(self):
        source = io.BytesIO(b'123456789')
        bounded = producer.BoundedCopyReader(source, 4)
        self.assertEqual(bounded.read(2), b'12')
        with self.assertRaisesRegex(RuntimeError, 'transport budget'): bounded.read(10 ** 9)
        self.assertEqual(source.tell(), 5)

    def test_stage_and_storage_budgets_never_disable_the_one_gib_floor(self):
        self.assertGreaterEqual(producer.HARD_FREE_BYTES, 1024 ** 3)
        self.assertGreater(producer.STOP_FREE_BYTES, producer.HARD_FREE_BYTES)
        self.assertGreater(producer.FRESH_FREE_BYTES, producer.STOP_FREE_BYTES)
        with patch.object(producer.shutil, 'disk_usage', side_effect=[SimpleNamespace(free=9 * producer.GIB), SimpleNamespace(free=3 * producer.GIB)]):
            self.assertEqual(producer.measured_free(['/output', '/docker']).free, 3 * producer.GIB)
        source = SCRIPT.read_text()
        self.assertNotIn('fresh_bytes=0', source); self.assertNotIn('stop_bytes=0', source)
        self.assertIn('SDK_METADATA_BYTES - tree_bytes(contracts)', source)
        self.assertIn('target=None if cleanup else output', source)

    def test_receipt_is_material_only_and_preserves_input_and_abi_byte_relationships(self):
        source = SCRIPT.read_text()
        self.assertIn("status='native-build-test-materials', releaseAccepted=False", source)
        self.assertIn("get('priorSdkImage') != sdk_image", source)
        self.assertIn('abiReceiptSha256=digest', source)
        self.assertIn('runtimeBinarySha256=digest', source)
        self.assertIn("stage(role + '-absent'", source)
        self.assertIn("source-trees-after", source)
        self.assertLess(source.index("raise RuntimeError('Producer source changed')"), source.index("with archive.open('xb')"))
        self.assertNotIn('nativeAccepted=True', source)


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
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

    def test_receipt_is_material_only_and_preserves_input_and_abi_byte_relationships(self):
        source = SCRIPT.read_text()
        self.assertIn("status='native-build-test-materials', releaseAccepted=False", source)
        self.assertIn("get('priorSdkImage') != sdk_image", source)
        self.assertIn('abiReceiptSha256=digest', source)
        self.assertIn('runtimeBinarySha256=digest', source)
        self.assertIn("stage(role + '-absent'", source)
        self.assertIn("source-trees-after", source)
        self.assertLess(source.index("raise RuntimeError('Producer source changed')"), source.index('with tarfile.open(archive'))
        self.assertNotIn('nativeAccepted=True', source)


if __name__ == '__main__':
    unittest.main()

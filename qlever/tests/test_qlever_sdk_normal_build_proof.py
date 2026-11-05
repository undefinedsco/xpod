import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('sdk_normal_proof', ROOT / 'qlever/scripts/sdk-normal-build-proof.py')
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)

FILES = [
    '.github/workflows/candidate.yml',
    '.github/workflows/publish-qlever-runtime-sdk.yml',
    '.dockerignore',
    'scripts/lib/module-artifact-limits.json',
    'scripts/lib/independent-admission/normal-sdk-gates.json',
    'scripts/agentfs-native-ci/supervise.py',
    'docker/qlever-runtime-sdk/Dockerfile.normal',
    'docker/qlever-runtime-sdk/Dockerfile.normal.incremental',
    'docker/qlever-local-runtime/Dockerfile',
    'qlever/qlever.lock.json',
    'qlever/scripts/apply-patches.py',
    'qlever/scripts/build-qlever-runtime-sdk.sh',
    'qlever/scripts/qlever_compiler_profile.py',
    'qlever/scripts/sync-patched-source.py',
    'qlever/scripts/check-qlever-real-adapter-build.cjs',
    'qlever/scripts/check-qlever-real-runtime.cjs',
    'qlever/scripts/check-qlever-upstream-patches.cjs',
]


def sha(body):
    return hashlib.sha256(body).hexdigest()


class NormalBuildProof(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.test-data/sdk-normal-build-proof').mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(ROOT / '.test-data/sdk-normal-build-proof', ignore_errors=True)

    def repo(self, directory):
        root = Path(directory) / 'repo'
        root.mkdir()
        for name in FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        (root / 'qlever/patches').mkdir(parents=True)
        (root / 'qlever/patches/0001-test.patch').write_text('fixture patch\n')
        git = lambda *args: subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
        git('init')
        git('add', '.')
        git('-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'fixture')
        return root, git('rev-parse', 'HEAD')

    def body(self, root, commit, prior=None):
        return proof.identity_body(root, commit, 'service-trixie', 'linux-x64',
                                   'profile-identity', 'docker/qlever-runtime-sdk/Dockerfile.normal', prior)

    def test_real_normal_dockerfile_full_immutable_image_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix='real-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            root, commit = self.repo(directory)
            body = self.body(root, commit)
            self.assertRegex(body['toolchain']['baseImage'], r'^debian:trixie-[0-9]+-slim@sha256:[a-f0-9]{64}$')
            self.assertEqual(body['inputHash'], sha(proof.canonical({k: v for k, v in body.items() if k != 'inputHash'})))
            self.assertIn('scripts/lib/module-artifact-limits.json', body['files'])
            self.assertIn('docker/qlever-local-runtime/Dockerfile', body['files'])
            self.assertIn('.dockerignore', body['files'])

    def test_incremental_recipe_prior_and_refreshed_inputs_change_identity(self):
        prior = 'sha256:' + '9' * 64
        other = 'sha256:' + '8' * 64
        with tempfile.TemporaryDirectory(prefix='incremental-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            root, commit = self.repo(directory)
            cold = self.body(root, commit)
            incremental = self.body(root, commit, prior)
            self.assertEqual(cold['recipe'], {'kind': 'cold', 'dockerfile': 'docker/qlever-runtime-sdk/Dockerfile.normal', 'priorImage': None})
            self.assertEqual(incremental['recipe'], {'kind': 'incremental', 'dockerfile': 'docker/qlever-runtime-sdk/Dockerfile.normal.incremental', 'priorImage': prior})
            self.assertNotEqual(cold['inputHash'], incremental['inputHash'])
            self.assertNotEqual(incremental['inputHash'], self.body(root, commit, other)['inputHash'])
            path = root / 'docker/qlever-runtime-sdk/Dockerfile.normal.incremental'
            original = path.read_bytes()
            path.write_bytes(original + b'\n# changed incremental recipe\n')
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd=root)
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'incremental'], cwd=root)
            changed = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            self.assertNotEqual(self.body(root, changed, prior)['inputHash'], incremental['inputHash'])
            self.assertTrue((ROOT / 'docker/qlever-runtime-sdk/Dockerfile.normal.incremental').is_file())

    def test_mutable_or_malformed_base_image_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='mutable-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            root, commit = self.repo(directory)
            dockerfile = root / 'docker/qlever-runtime-sdk/Dockerfile.normal'
            text = dockerfile.read_text()
            dockerfile.write_text(text.replace('@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258', ''))
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd=root)
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'mutable'], cwd=root)
            commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            with self.assertRaisesRegex(ValueError, 'immutable full SDK base image'):
                self.body(root, commit)
            dockerfile.write_text(text.replace('debian:trixie-20260803-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258', 'debian:trixie-slim'))
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd=root)
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'mutable-tag'], cwd=root)
            commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            with self.assertRaisesRegex(ValueError, 'immutable full SDK base image'):
                self.body(root, commit)

    def test_every_actual_copy_input_changes_the_full_identity(self):
        with tempfile.TemporaryDirectory(prefix='inputs-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            root, commit = self.repo(directory)
            baseline = self.body(root, commit)['inputHash']
            for name in ['.dockerignore', 'scripts/lib/module-artifact-limits.json', 'scripts/lib/independent-admission/normal-sdk-gates.json', 'scripts/agentfs-native-ci/supervise.py',
                         'docker/qlever-local-runtime/Dockerfile', 'docker/qlever-runtime-sdk/Dockerfile.normal',
                         'qlever/qlever.lock.json', 'qlever/scripts/build-qlever-runtime-sdk.sh']:
                path = root / name
                original = path.read_bytes()
                if name.endswith('.json'):
                    value = json.loads(original)
                    value['fixtureMutation'] = 'changed'
                    path.write_text(json.dumps(value, sort_keys=True) + '\n')
                else:
                    path.write_bytes(original + b'\nchanged\n')
                subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd=root)
                subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'changed'], cwd=root)
                changed_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
                self.assertNotEqual(self.body(root, changed_commit)['inputHash'], baseline, name)
                path.write_bytes(original)
                subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd=root)
                subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SDK fixture', '-c', 'user.email=sdk-fixture@example.invalid', 'commit', '-m', 'restored'], cwd=root)
                commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()

    def test_candidate_finder_accepts_a_trusted_named_zip_and_keeps_index_unverified(self):
        index = {'schemaVersion': 1, 'kind': 'qlever-sdk-normal-build-proof-index', 'model': proof.MODEL,
                 'inputHash': 'c' * 64, 'sdkProfile': 'service-trixie', 'target': 'linux-x64'}
        with tempfile.TemporaryDirectory(prefix='candidate-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            out = Path(directory) / 'lookup'
            zip_path = Path(directory) / 'proof.zip'
            with __import__('zipfile').ZipFile(zip_path, 'w') as bundle:
                bundle.writestr(proof.INDEX_NAME, json.dumps(index))
            digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
            row = {'id': 7, 'name': 'qlever-sdk-normal-proof-service-trixie-linux-x64-' + 'c' * 64,
                   'digest': 'sha256:' + digest, 'expired': False, 'created_at': '2026-01-01T00:00:00Z'}
            args = type('Args', (), {'repository': 'undefinedsco/xpod', 'profile': 'service-trixie', 'target': 'linux-x64',
                                     'input_hash': 'c' * 64, 'out': str(out)})()
            def fake_api(url, token, maximum=4 * 1024 ** 2):
                return {'artifacts': [row]} if 'name=' in url else {'artifacts': []}
            def fake_download(url, token, destination, maximum=16 * 1024 ** 2):
                Path(destination).write_bytes(zip_path.read_bytes())
                return digest, zip_path.stat().st_size
            with __import__('unittest.mock').mock.patch.object(proof, 'api_json', side_effect=fake_api), \
                 __import__('unittest.mock').mock.patch.object(proof, 'download', side_effect=fake_download), \
                 __import__('unittest.mock').mock.patch.dict(os.environ, {'GH_TOKEN': 'test-token'}):
                value = proof.candidate(args)
            self.assertEqual(value['kind'], 'qlever-sdk-normal-candidate')
            self.assertEqual(value['proofArtifact']['digest'], digest)
            self.assertEqual(value['index'], index)

    def test_candidate_finder_rejects_digest_mismatch_and_missing_artifact(self):
        with tempfile.TemporaryDirectory(prefix='candidate-neg-', dir=ROOT / '.test-data/sdk-normal-build-proof') as directory:
            base = Path(directory)
            row = {'id': 8, 'name': 'qlever-sdk-normal-proof-service-trixie-linux-x64-' + 'c' * 64,
                   'digest': 'sha256:' + '0' * 64, 'expired': False, 'created_at': '2026-01-01T00:00:00Z'}
            args = type('Args', (), {'repository': 'undefinedsco/xpod', 'profile': 'service-trixie', 'target': 'linux-x64',
                                     'input_hash': 'c' * 64, 'out': str(base / 'lookup')})()
            def fake_api(url, token, maximum=4 * 1024 ** 2):
                return {'artifacts': [row]} if 'name=' in url else {'artifacts': []}
            def fake_download(url, token, destination, maximum=16 * 1024 ** 2):
                Path(destination).write_bytes(b'not-the-digest')
                return hashlib.sha256(b'not-the-digest').hexdigest(), 12
            with __import__('unittest.mock').mock.patch.object(proof, 'api_json', side_effect=fake_api), \
                 __import__('unittest.mock').mock.patch.object(proof, 'download', side_effect=fake_download), \
                 __import__('unittest.mock').mock.patch.dict(os.environ, {'GH_TOKEN': 'test-token'}):
                with self.assertRaisesRegex(ValueError, 'digest differs'):
                    proof.candidate(args)
            def empty_api(url, token, maximum=4 * 1024 ** 2):
                return {'artifacts': []}
            args.out = str(base / 'empty')
            with __import__('unittest.mock').mock.patch.object(proof, 'api_json', side_effect=empty_api), \
                 __import__('unittest.mock').mock.patch.dict(os.environ, {'GH_TOKEN': 'test-token'}):
                self.assertEqual(proof.candidate(args)['found'], False)


if __name__ == '__main__':
    unittest.main()

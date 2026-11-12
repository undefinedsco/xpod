"""Unit fixtures for transport identity and safe extraction; no native admission."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
EXTRACTOR = runpy.run_path(str(ROOT / 'scripts/diagnostics/extract-qlever-artifact.py'))
SOURCE = 'a' * 40


class QleverArtifactMaterials(unittest.TestCase):
    def fixture(self, root, artifact_id='991', duplicate=False):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            for name, body, mode in [('manifest.json', b'{}', 0o644), ('bin/runtime', b'unit-only', 0o755)]:
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(body), mode
                tar.addfile(entry, io.BytesIO(body))
        zipped = root / 'original.zip'
        with zipfile.ZipFile(zipped, 'w') as target:
            target.writestr('qlever-local-runtime-darwin-arm64.tar.gz', archive.getvalue())
            target.writestr('qlever-local-acceptance.json', b'{"unitOnly":true}')
            target.writestr('SOURCE/retained.txt', b'not extracted, retained in original ZIP')
            if duplicate:
                target.writestr('qlever-local-acceptance.json', b'{}')
        digest = hashlib.sha256(zipped.read_bytes()).hexdigest()
        metadata = {'id': int(artifact_id), 'expired': False, 'digest': 'sha256:' + digest,
                    'name': 'qlever-local-runtime-darwin-arm64-' + SOURCE,
                    'workflow_run': {'id': 992, 'head_sha': SOURCE}}
        meta = root / 'metadata.json'
        meta.write_text(json.dumps(metadata))
        return zipped, meta, digest, metadata

    def rejected(self, fn):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            fn()

    def test_future_artifact_retains_exact_originals_and_derived_authority(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned)
            zipped, meta, digest, metadata = self.fixture(root)
            destination = root / 'materials'
            with contextlib.redirect_stdout(io.StringIO()):
                EXTRACTOR['main'](str(zipped), str(destination), digest, str(meta), '991')
            self.assertEqual(zipped.read_bytes(), (destination / 'qlever-native-artifact.zip').read_bytes())
            with zipfile.ZipFile(zipped) as original:
                for name in EXTRACTOR['SELECTED']:
                    self.assertEqual(original.read(name), (destination / name).read_bytes())
            self.assertFalse((destination / 'SOURCE').exists())
            self.assertEqual((destination / 'runtime/bin/runtime').stat().st_mode & 0o777, 0o755)
            authority = json.loads((destination / 'qlever-native-authority.json').read_text())
            self.assertEqual(authority['sourceSha'], SOURCE)
            self.assertEqual(authority['artifactId'], '991')
            self.assertEqual(authority['digest'], metadata['digest'])

    def test_diagnostic_default_still_rejects_another_artifact_id(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned)
            zipped, meta, digest, _ = self.fixture(root)
            self.rejected(lambda: EXTRACTOR['main'](str(zipped), str(root / 'out'), digest, str(meta)))
            self.assertFalse((root / 'out').exists())

    def test_metadata_substitutions_are_rejected(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned)
            _, _, digest, metadata = self.fixture(root)
            for field, wrong in [('id', 993), ('expired', True), ('digest', 'sha256:' + '0' * 64),
                                 ('name', 'another-artifact'), ('workflow_run', {'head_sha': 'b' * 40})]:
                altered = {**metadata, field: wrong}
                self.rejected(lambda: EXTRACTOR['metadata_authority'](altered, digest, '991', SOURCE))

    def test_changed_download_fails_before_materials_are_written(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned)
            zipped, meta, digest, _ = self.fixture(root)
            zipped.write_bytes(zipped.read_bytes() + b'changed')
            self.rejected(lambda: EXTRACTOR['main'](str(zipped), str(root / 'out'), digest, str(meta), '991'))
            self.assertFalse((root / 'out').exists())

    def test_duplicate_selected_member_is_not_silently_overwritten(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned)
            zipped, meta, digest, _ = self.fixture(root, duplicate=True)
            self.rejected(lambda: EXTRACTOR['main'](str(zipped), str(root / 'out'), digest, str(meta), '991'))
            self.assertFalse((root / 'out').exists())


if __name__ == '__main__':
    unittest.main()

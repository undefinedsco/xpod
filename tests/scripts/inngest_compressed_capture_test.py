"""Real controlled input capture under a retained-byte budget, without tools."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('controlled_compressed', ROOT / 'scripts/lib/inngest-controlled-build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class CompressedCapture(unittest.TestCase):
    def test_complete_input_fits_by_compression_without_raising_retained_ceiling(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.test-data') as temporary:
            work = Path(temporary)
            source = work / 'source'
            source.mkdir()
            payload = b'complete retained input\n' * 8192
            file = source / 'fixture.bin'
            file.write_bytes(payload)
            rows = {'fixture.bin': {'kind': 'file', 'bytes': len(payload)}}
            with patch.object(build, '_retained_byte_ceiling', 32768):
                budget = build.MaterialBudget(work)
                group = build.capture_domain(work, 'before-dependencies', 'dependencies', rows, source, budget)
                self.assertGreater(len(payload), 32768)
                self.assertLessEqual(budget.charged, 32768)
                self.assertEqual(budget.charged, build.total_check(work))
            self.assertEqual(len(group['archives']), 1)
            archive = group['archives'][0]
            self.assertEqual(archive['encoding'], 'gzip-blocks-v1')
            packed = (work / archive['path']).read_bytes()
            self.assertEqual(hashlib.sha256(packed).hexdigest(), archive['sha256'])
            index_ref = archive['index']
            index_bytes = (work / index_ref['path']).read_bytes()
            self.assertEqual(hashlib.sha256(index_bytes).hexdigest(), index_ref['sha256'])
            index = json.loads(index_bytes)
            for block in index['blocks']:
                decoded = gzip.decompress(packed[block['offset']:block['offset'] + block['bytes']])
                self.assertEqual(len(decoded), block['expandedBytes'])
                self.assertLessEqual(len(decoded), build.LIMITS['rangeBytes'])
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(packed)), mode='r:') as stream:
                self.assertEqual(stream.getnames(), ['fixture.bin'])
                self.assertEqual(stream.extractfile('fixture.bin').read(), payload)
            self.assertEqual(file.read_bytes(), payload)

    def test_tight_budget_rejects_without_committing_index_or_inventory(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.test-data') as temporary:
            work = Path(temporary)
            source = work / 'source'
            source.mkdir()
            (source / 'fixture.bin').write_bytes(b'complete input' * 8192)
            with patch.object(build, '_retained_byte_ceiling', 1):
                with self.assertRaisesRegex(ValueError, 'shared retained material total'):
                    build.capture_domain(work, 'before-dependencies', 'dependencies', {'fixture.bin': {}}, source, build.MaterialBudget(work))
            self.assertFalse(list((work / 'materials').rglob('*.index.json')))
            self.assertFalse(list((work / 'materials').rglob('*inventory*.json')))


if __name__ == '__main__':
    unittest.main()

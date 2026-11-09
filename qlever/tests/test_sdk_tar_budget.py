import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
import tempfile
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tar_budget',ROOT/'qlever/scripts/sdk-tar-budget.py')
budget=importlib.util.module_from_spec(spec);spec.loader.exec_module(budget)

class TarBudgetTest(unittest.TestCase):
    def test_exact_size_including_pax_and_record_padding(self):
        for name in ['short', 'long/'+'x'*180, 'unicode/文件.h']:
            for size in [0,1,511,512,513,9216,9728]:
                info=tarfile.TarInfo(name);info.size=size
                stream=io.BytesIO()
                with tarfile.open(fileobj=stream,mode='w') as archive:
                    archive.addfile(info,io.BytesIO(b'x'*size))
                self.assertEqual(len(stream.getvalue()),budget.archive_bytes(budget.member_bytes(info)))
    def test_payload_fits_but_encoded_archive_rejected(self):
        info=tarfile.TarInfo('long/'+'x'*180);info.size=9216
        with self.assertRaisesRegex(ValueError,'encoded tar'):
            budget.require_fit(budget.member_bytes(info),10240)
        budget.require_fit(budget.member_bytes(info),20480)
    def test_actual_input_shards_and_single_member_rejection(self):
        spec=importlib.util.spec_from_file_location('inner_tar_test',ROOT/'qlever/scripts/sdk-inner-materials.py')
        inner=importlib.util.module_from_spec(spec);spec.loader.exec_module(inner)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);files=[root/'first',root/'second']
            for path in files:path.write_bytes(b'x'*5000)
            before={str(path):inner.file_identity(path) for path in files}
            with patch.object(inner.tar_budget,'SHARD_LIMIT',10240):
                # require_fit has a production default; enforce the actual patched limit too.
                with patch.object(inner.tar_budget,'require_fit',lambda count: budget.require_fit(count,10240)):
                    result=inner.archive_inputs(files,root/'materials/domains',before)
                    self.assertEqual(len(result['shards']),2)
                    for row in result['shards']:
                        self.assertEqual((root/'materials'/row['path']).stat().st_size,10240)
                    files[0].write_bytes(b'x'*10000)
                    with self.assertRaisesRegex(ValueError,'encoded tar'):
                        inner.archive_inputs([files[0]],root/'rejected/domains',{str(files[0]):inner.file_identity(files[0])})
    def test_multiple_members_include_headers_and_final_padding(self):
        infos=[tarfile.TarInfo('x'*180),tarfile.TarInfo('second')]
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as archive:
            for info in infos:archive.addfile(info)
        self.assertEqual(len(stream.getvalue()),budget.archive_bytes(sum(map(budget.member_bytes,infos))))

if __name__=='__main__':unittest.main()

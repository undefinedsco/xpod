"""One generic tar parser, old Debian defaults and explicit normal bounds."""
import importlib.util
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('result_context',HERE/'sdk-readonly-result-context.py');context=importlib.util.module_from_spec(spec);spec.loader.exec_module(context)

def pax_tar(count,long=False):
    raw=io.BytesIO()
    with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as archive:
        for index in range(count):
            name=('x'*4080+str(index)) if long else 'materials/'+str(index)
            info=tarfile.TarInfo(name);info.pax_headers={'mtime':'1.1'};archive.addfile(info)
    return raw.getvalue()

def consume(data,**kwargs):
    ledger={'members':0,'bytes':0};guard=context.binary.TarHeaderGuard(io.BytesIO(data),ledger,lambda:None,**kwargs)
    with tarfile.open(fileobj=guard,mode='r|',bufsize=65536) as archive:
        for member in archive:pass
    while guard.read(65536):pass
    return ledger

class TarGuardTest(unittest.TestCase):
    def test_old_default_129_rejects_new_fixed_normal_accepts(self):
        data=pax_tar(129)
        with self.assertRaisesRegex(ValueError,'metadata single/aggregate'):consume(data)
        self.assertEqual(consume(data,metadata_members=context.LIMITS['sourceMembers'])['members'],129)
    def test_explicit_count_and_aggregate_metadata_bounds_remain(self):
        with self.assertRaisesRegex(ValueError,'metadata single/aggregate'):consume(pax_tar(3),metadata_members=2)
        with self.assertRaisesRegex(ValueError,'metadata single/aggregate'):consume(pax_tar(1100,long=True),metadata_members=context.LIMITS['sourceMembers'])
        for value in [0,-1,True,context.LIMITS['sourceMembers']+1]:
            with self.assertRaises(ValueError):consume(b'',metadata_members=value)
    def test_actual_inner_tar_bytes_hash_and_originals_bound_before_write(self):
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w') as archive:
            info=tarfile.TarInfo('materials/build-inner.json');info.size=3;archive.addfile(info,io.BytesIO(b'{}\n'))
        original=data.getvalue();base=HERE.parents[1]/'.test-data/sdk-readonly-tar-guard';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as temporary:
            destination=Path(temporary)/'inner';result=context.copy_inner_stream(io.BytesIO(original),destination,lambda:None,3)
            self.assertEqual(result['sourceStream'],{'bytes':len(original),'sha256':hashlib.sha256(original).hexdigest()})
            self.assertEqual(result['files'],[{'path':'inner/build-inner.json','bytes':3,'sha256':hashlib.sha256(b'{}\n').hexdigest()}]);self.assertEqual((destination/'build-inner.json').read_bytes(),b'{}\n')
        with tempfile.TemporaryDirectory(dir=base) as temporary:
            destination=Path(temporary)/'inner'
            with self.assertRaisesRegex(ValueError,'before opening'):context.copy_inner_stream(io.BytesIO(original),destination,lambda:None,2)
            self.assertEqual(list(destination.iterdir()),[])
if __name__=='__main__':unittest.main()

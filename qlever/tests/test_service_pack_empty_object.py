import hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('collector',ROOT/'qlever/scripts/sdk-service-image-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def parse(self,object_name=None,ref_sha=None,index_empty=False):
  sha=hashlib.sha256(b'').hexdigest();name=object_name or sha;reference=dict(path='objects/'+name+'.original',bytes=0,sha256=ref_sha or sha)
  index=json.dumps(dict(schemaVersion=1,kind='actual-service-pack-manifest-inputs',originals=[reference])).encode()
  raw=io.BytesIO()
  with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as tar:
   for path,body in [('materials.json',b'' if index_empty else index),('objects/'+name+'.original',b'')]:
    row=tarfile.TarInfo('service-pack-originals/'+path);row.size=len(body);tar.addfile(row,io.BytesIO(body))
  parent=ROOT/'.test-data/service-pack-empty-object';parent.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=parent) as directory:
   file=Path(directory)/'metadata.original.tar';file.write_bytes(raw.getvalue());return m.service_pack_sidecar_tar(file,lambda:None)
 def test_canonical_empty_object(self):self.assertEqual(list(self.parse()['originals'].values()),[b''])
 def test_wrong_empty_object_filename(self):
  with self.assertRaises(ValueError):self.parse(object_name='a'*64)
 def test_wrong_empty_reference_hash(self):
  with self.assertRaises(ValueError):self.parse(ref_sha='a'*64)
 def test_empty_index(self):
  with self.assertRaises(ValueError):self.parse(index_empty=True)
if __name__=='__main__':unittest.main()

import ast,hashlib,importlib.util,io,os,re,stat,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];file=ROOT/'qlever/scripts/sdk-service-image-originals.py';tree=ast.parse(file.read_text())
def need(v,m):
 if not v:raise ValueError(m)
import json
from types import SimpleNamespace
g={"tarfile":tarfile,"need":need,"META":4*1024**2,"CHUNK":65536,"LIMITS":json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())}
node=next(n for n in ast.parse((ROOT/'qlever/scripts/sdk-debian-binary-originals.py').read_text()).body if isinstance(n,ast.ClassDef) and n.name=='TarHeaderGuard');exec(compile(ast.Module(body=[node],type_ignores=[]),'sole-original-guard','exec'),g);guard=SimpleNamespace(TarHeaderGuard=g['TarHeaderGuard'])
ns=dict(os=os,stat=stat,Path=Path,hashlib=hashlib,re=re,tarfile=tarfile,META=4*1024**2,need=need,load=lambda _:guard)
nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ['Retained','retain_pack_body_tar']];exec(compile(ast.Module(body=nodes,type_ignores=[]),str(file),'exec'),ns)
class Tests(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.addCleanup(self.tmp.cleanup);self.out=Path(self.tmp.name).resolve();self.body=b'actual package body'*10000;self.sha=hashlib.sha256(self.body).hexdigest();self.expected=dict(path='service-pack-bodies/objects/0001-'+self.sha+'.original',bytes=len(self.body),sha256=self.sha);self.ret=ns['Retained'](self.out,type('Budget',(),{'check':lambda *a:None})())
 def raw(self,kind='file',extra=False,ordinal=1):
  data=io.BytesIO()
  with tarfile.open(fileobj=data,mode='w',format=tarfile.PAX_FORMAT) as tar:
   row=tarfile.TarInfo(Path(self.expected['path']).name);row.size=len(self.body)
   if kind=='pax':row.pax_headers={'comment':'unknown'}
   if kind=='link':row.type=tarfile.SYMTYPE;row.linkname='other';row.size=0
   tar.addfile(row,io.BytesIO(self.body))
   if extra:row=tarfile.TarInfo('extra');row.size=1;tar.addfile(row,io.BytesIO(b'x'))
  b=data.getvalue();p=self.out/('cp'+str(ordinal)+'.raw.tar');p.write_bytes(b);ref=dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest());self.ret.reserve(len(b));self.ret.refs[ref['path']]=ref;return ref
 def test_full_raw_and_extracted_copy_both_charged(self):
  ref=self.raw();r=ns['retain_pack_body_tar'](ref,self.expected,self.ret);self.assertTrue(r['bodyOriginalCaptured']);self.assertEqual((self.out/r['original']['path']).read_bytes(),self.body);self.assertEqual(self.ret.total,ref['bytes']+len(self.body))
 def test_samehash_different_physical_ordinals_both_charged(self):
  a=self.raw();ns['retain_pack_body_tar'](a,self.expected,self.ret);self.expected['path']=self.expected['path'].replace('0001-','0002-');b=self.raw(ordinal=2);ns['retain_pack_body_tar'](b,self.expected,self.ret);self.assertEqual(self.ret.total,a['bytes']+b['bytes']+2*len(self.body))
 def test_remaining_refusal_before_body_read_or_output_creation(self):
  ref=self.raw();self.ret.total=32*ns['META']-1
  with patch.object(os,'read',side_effect=AssertionError('must not read')):r=ns['retain_pack_body_tar'](ref,self.expected,self.ret)
  self.assertFalse(r['bodyOriginalCaptured']);self.assertFalse((self.out/'output').exists())
 def test_extra_link_pax_refuse(self):
  for i,(kind,extra) in enumerate([('file',True),('link',False),('pax',False)]):
   ref=self.raw(kind,extra,ordinal=i)
   with self.assertRaises((ValueError,tarfile.TarError)):ns['retain_pack_body_tar'](ref,self.expected,self.ret)
   p=self.out/'output'/self.expected['path']
   if p.exists():p.unlink()
 def test_raw_hash_required_before_registering_body(self):
  ref=self.raw();ref['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'full raw tar'):ns['retain_pack_body_tar'](ref,self.expected,self.ret)
  self.assertEqual(set(self.ret.refs),{'cp1.raw.tar'})
 def test_raw_ref_requires_same_ledger(self):
  ref=self.raw();self.ret.refs.clear()
  with self.assertRaisesRegex(ValueError,'same retained'):ns['retain_pack_body_tar'](ref,self.expected,self.ret)
 def test_wrong_size_and_escape_refuse(self):
  ref=self.raw()
  for expected in [dict(self.expected,bytes=1),dict(self.expected,path='../escape')]:
   with self.assertRaises(ValueError):ns['retain_pack_body_tar'](ref,expected,self.ret)
if __name__=='__main__':unittest.main()

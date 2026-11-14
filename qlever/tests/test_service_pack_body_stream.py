import ast,hashlib,os,stat,tempfile,unittest
from pathlib import Path
p=Path(__file__).parents[1]/'scripts/sdk-service-image-originals.py'
tree=ast.parse(p.read_text());nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ['Retained','retain_pack_body_stream']]
def need(condition,reason):
 if not condition:raise ValueError(reason)
ns=dict(os=os,stat=stat,Path=Path,hashlib=hashlib,re=__import__('re'),META=4*1024**2,need=need)
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(p),'exec'),ns)
class Budget:
 def __init__(self):self.calls=0
 def check(self,unused):self.calls+=1
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]);self.addCleanup(self.t.cleanup);self.root=Path(self.t.name).resolve();self.src=self.root/'source';self.data=b'actual-body'*100000;self.src.write_bytes(self.data)
  self.b=Budget();self.ret=ns['Retained'](self.root/'out',self.b);self.expected=dict(bytes=len(self.data),sha256=hashlib.sha256(self.data).hexdigest())
 def test_full_stream_real_bytes_same_parent_budget(self):
  result=ns['retain_pack_body_stream'](self.src,self.expected,self.ret);ref=result['original'];self.assertEqual((self.ret.out/ref['path']).read_bytes(),self.data);self.assertEqual(self.ret.total,len(self.data));self.assertGreater(self.b.calls,10);self.assertIn('same-call-pack-body-role-and-tar-membership-unverified',result['pending'])
 def test_remaining_refusal_before_allocation(self):
  self.ret.total=32*ns['META']-10;result=ns['retain_pack_body_stream'](self.src,self.expected,self.ret);self.assertFalse(result['bodyOriginalCaptured']);self.assertFalse(self.ret.out.exists());self.assertEqual(self.ret.refs,{})
 def test_bad_sha_and_symlink_rejected(self):
  bad=dict(self.expected,sha256='0'*64)
  with self.assertRaises(ValueError):ns['retain_pack_body_stream'](self.src,bad,self.ret)
  self.assertEqual(self.ret.refs,{});self.assertEqual(self.ret.total,len(self.data))
  alias=self.root/'link';alias.symlink_to(self.src)
  with self.assertRaises(ValueError):ns['retain_pack_body_stream'](alias,self.expected,self.ret)
 def test_duplicate_body_not_recharged(self):
  ns['retain_pack_body_stream'](self.src,self.expected,self.ret)
  with self.assertRaises(ValueError):ns['retain_pack_body_stream'](self.src,self.expected,self.ret)
  self.assertEqual(self.ret.total,len(self.data))
 def test_shared_parent_ledger_not_reset(self):
  self.ret.total=123;ns['retain_pack_body_stream'](self.src,self.expected,self.ret);self.assertEqual(self.ret.total,123+len(self.data))
 def test_already_read_prefix_mutation_rejected(self):
  def clock(unused):
   self.b.calls+=1
   if self.b.calls==4:
    with self.src.open('r+b') as stream:stream.write(b'X')
  self.b.check=clock
  with self.assertRaises(ValueError):ns['retain_pack_body_stream'](self.src,self.expected,self.ret)
  self.assertEqual(self.ret.refs,{})
 def test_absolute_budget_failure_preserves_partial_charge(self):
  def clock(unused):
   self.b.calls+=1
   if self.b.calls==5:raise TimeoutError('same parent end')
  self.b.check=clock
  with self.assertRaises(TimeoutError):ns['retain_pack_body_stream'](self.src,self.expected,self.ret)
  self.assertEqual(self.ret.refs,{})
  self.assertGreater(self.ret.total,0)
if __name__=='__main__':unittest.main()

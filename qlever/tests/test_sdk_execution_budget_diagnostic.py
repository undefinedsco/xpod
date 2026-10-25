import ast,contextlib,io,json,pathlib,sys,threading,unittest,re
HERE=pathlib.Path(__file__).resolve().parent
tree=ast.parse((HERE.parent/'scripts/sdk-ptrace-execution.py').read_text())
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and any(isinstance(f,ast.FunctionDef) and f.name=='claim' for f in n.body))
fn=next(f for f in cls.body if isinstance(f,ast.FunctionDef) and f.name=='claim')
ns=dict(threading=threading,json=json,sys=sys,re=re)
helper=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='completed_capture_storage_census');exec(compile(ast.Module(body=[helper],type_ignores=[]),'<actual-storage-census>','exec'),ns)
reserve=next(f for f in cls.body if isinstance(f,ast.FunctionDef) and f.name=='reserve_generated_bytes')
exec(compile(ast.Module(body=[reserve],type_ignores=[]),'<actual-reservation>','exec'),ns)
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<actual-frozen-claim>','exec'),ns)
class Subject:
 claim=ns['claim']
 reserve_generated_bytes=ns['reserve_generated_bytes']
 def __init__(self):
  self.claim_bytes={'raw-wire':20,'capture-body':50,'stdio':10,'provider-other':10};self.current_phase='compile';self.generated_vma=None;self.budget_context={}
  self.domain_lock=threading.Lock();self.domain_bytes=90;self.maximum_bytes=100;self.capture_bytes=50
  self.captures=[dict(kind='fd-capture',role='source-read',original=dict(bytes=30)),dict(kind='write-original',original=dict(bytes=20))]
 def check_budget(self):pass
class Broken:
 def __init__(self,operation):self.operation=operation
 def write(self,data):
  if self.operation=='write':raise OSError('diagnostic write fault')
 def flush(self):raise OSError('diagnostic flush fault')
class Tests(unittest.TestCase):
 def rejection(self,s,stream):
  with contextlib.redirect_stderr(stream),self.assertRaisesRegex(AssertionError,'^shared execution original byte bound$'):s.claim(11)
  self.assertEqual(s.domain_bytes,90)
 def test_actual_summary(self):
  s=Subject();stream=io.StringIO();self.rejection(s,stream);row=json.loads(stream.getvalue().split(' ',1)[1]);self.assertEqual(row['completedObservationReferences']['source-read'],dict(count=1,bytes=30));self.assertEqual(row['completedRetainedEntityBytes'],50)
 def test_reused_entity_observations_are_not_reported_as_physical_bytes(self):
  s=Subject();s.captures.append(dict(s.captures[0]));stream=io.StringIO();self.rejection(s,stream);row=json.loads(stream.getvalue().split(' ',1)[1]);self.assertEqual(row['completedRetainedEntityBytes'],50);self.assertEqual(row['completedObservationReferencedBytes'],80);self.assertEqual(row['completedObservationReferences']['source-read'],dict(count=2,bytes=60));self.assertNotIn('completedCaptures',row)
 def test_success_does_not_inspect(self):
  s=Subject();s.captures=None;s.claim(10);self.assertEqual(s.domain_bytes,100)
 def test_write_failure(self):self.rejection(Subject(),Broken('write'))
 def test_flush_failure(self):self.rejection(Subject(),Broken('flush'))
 def test_bad_metadata(self):
  for row in [None,{},dict(kind='fd-capture',original=dict(bytes='bad'))]:
   s=Subject();s.captures=[row];self.rejection(s,io.StringIO())
 def test_generated_reservation(self):
  s=Subject();s.generated_vma=type('V',(),dict(reserved=8,spending_thread=-1))();self.rejection(s,io.StringIO());self.assertEqual(s.generated_vma.reserved,8)
 def test_fixed_output(self):
  s=Subject();s.captures=[dict(kind='unknown',original=dict(bytes=1))]*10000;stream=io.StringIO();self.rejection(s,stream);self.assertLess(len(stream.getvalue()),2048);self.assertEqual(len(json.loads(stream.getvalue().split(' ',1)[1])['completedObservationReferences']),8)
 def test_disjoint_success_and_rejected_claims(self):
  s=Subject();s.maximum_bytes=1000
  for category in s.claim_bytes:s.claim(3,category=category)
  s.claim(2)
  self.assertEqual(s.claim_bytes,{'raw-wire':23,'capture-body':53,'stdio':13,'provider-other':15})
  self.assertEqual(sum(s.claim_bytes.values()),s.domain_bytes)
  before=dict(s.claim_bytes)
  with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(AssertionError):s.claim(1000,category='raw-wire')
  self.assertEqual(s.claim_bytes,before)
 def test_reservation_spending_still_counts_physical_claim_once(self):
  s=Subject();s.generated_vma=type('V',(),dict(reserved=10,spending_thread=threading.get_ident()))()
  s.claim(10,category='capture-body');self.assertEqual(s.generated_vma.reserved,0);self.assertEqual(sum(s.claim_bytes.values()),100)
 def test_reservation_context_and_unchanged_rejection(self):
  s=Subject();s.generated_vma=type('V',(),dict(reserved=4))();s.generated_vma.origins={(1,2):dict(sequence=42)};s.budget_context=dict(role='write-before',pid=4,fd=8,identity=[1,2,3,100],writeCount=8,writeOffset=100,path='x'*4096,pathTruncated=True,pathSha256='a'*64)
  for stream in [io.StringIO(),Broken('write'),Broken('flush')]:
   with contextlib.redirect_stderr(stream),self.assertRaisesRegex(AssertionError,'^same remaining execution ledger cannot reserve generated checkpoint$'):s.reserve_generated_bytes(7)
   self.assertEqual(s.generated_vma.reserved,4);self.assertEqual(s.domain_bytes,90)
   if isinstance(stream,io.StringIO):
    self.assertLess(len(stream.getvalue().encode()),4096);row=json.loads(stream.getvalue().split(' ',1)[1]);self.assertEqual(row['context']['writeOffset'],100);self.assertEqual(row['context']['originSequence'],42);self.assertEqual(len(row['context']['path']),128);self.assertEqual(sum(row['successfulClaimBytes'].values()),90)
 def test_reservation_success_does_not_inspect_context(self):
  s=Subject();s.budget_context=None;s.generated_vma=type('V',(),dict(reserved=4))();s.reserve_generated_bytes(6);self.assertEqual(s.generated_vma.reserved,10);self.assertEqual(s.domain_bytes,90)
if __name__=='__main__':unittest.main()

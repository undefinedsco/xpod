"""Execute the production receiver's BTI branches with bounded retained originals."""
import ast,copy,importlib.util,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('bti_binding_policy',ROOT/'sdk-executable-memory-policy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
tree=ast.parse((ROOT/'sdk-generation-multiprocess-bindings.py').read_text())
def branch(kind):
 for node in ast.walk(tree):
  if isinstance(node,ast.If) and ast.unparse(node.test)=="kind == '"+kind+"'":return compile(ast.fix_missing_locations(ast.Module(body=node.body,type_ignores=[])),str(ROOT/'sdk-generation-multiprocess-bindings.py'),'exec')
 raise AssertionError('production branch missing')
BEFORE=branch('bti-hardening-before');AFTER=branch('bti-hardening-after')
ORDER=compile(ast.fix_missing_locations(ast.Module(body=[next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='verify_stopped_original_order')],type_ignores=[])),str(ROOT/'sdk-generation-multiprocess-bindings.py'),'exec')
def need(value,message):
 if not value:raise ValueError(message)
class BtiBindingTests(unittest.TestCase):
 def fixture(self):
  mapping=dict(startHex='1000',endHex='3000',permissions='r-xp',inode=9,path='/bin/tool',deviceMajor=1,deviceMinor=2,fileOffset=0)
  entry=dict(pid=7,sequence=10,arch=m.BTI_ARCH,nr=226,args=[4096,8192,21,0,0,0])
  before=dict(pid=7,sequence=13,entrySequence=10,barrierSequence=11,model='held-rx-bti-hardening-v1',mapsOriginal='before',mappingSequences=[8],pageSize=4096)
  actual=dict(pid=7,sequence=14,arch=m.BTI_ARCH,result=0,isError=False)
  after=dict(pid=7,sequence=17,entrySequence=10,exitSequence=14,beforeSequence=13,barrierSequence=15,model=before['model'],mapsOriginal='after')
  maps={'before':[mapping],'after':[copy.deepcopy(mapping)]};identity=[258,9,0o100755,8192,1,1]
  for value in [entry,before,actual,after]:value['phase']='configure'
  originals={name:dict(observedPid=7,phase='configure',sequence=sequence) for name,sequence in [('before',12),('after',16)]}
  env=dict(need=need,memory_checker=m,bti_mode=before['model'],memory_mode=m.MODEL,entries={10:entry},exits={10:actual},barriers={11:dict(sequence=11,pids=[7],phase='configure'),15:dict(sequence=15,pids=[7],phase='configure')},bti_originals={},bti_completed=set(),retained_entries=set(),exclusive=None,latest_execution_sequence=10,approved_rx={8:dict(pid=7,mapping=mapping,lifetimeLeaseSequence=4,identity=identity)},lease_tokens={1:dict(acquisitionSequence=4,identity=identity)},tool_ref=lambda reference,kind:originals[reference],tool_maps=lambda reference:maps[reference],tool_barrier=lambda row:need(row['barrierSequence'] in [11,15],'barrier'))
  exec(ORDER,env);env['test_originals']=originals
  return env,before,after,maps
 def execute(self,env,row,code):env['row']=row;exec(code,env)
 def test_success_and_kernel_error_exit_both_require_after_maps(self):
  for result,error in [(0,False),(-22,True),(-12,True)]:
   env,before,after,_=self.fixture();env['exits'][10].update(result=result,isError=error)
   self.execute(env,before,BEFORE);env['latest_execution_sequence']=14;self.execute(env,after,AFTER)
   self.assertEqual(env['bti_completed'],{10});self.assertIsNone(env['exclusive']);self.assertEqual(env['entries'],{})
 def test_prior_mapping_lease_and_barrier_are_required(self):
  for mutation in ['prior','lease','barrier','sequence','pid']:
   env,before,after,_=self.fixture()
   if mutation=='prior':env['approved_rx'].clear()
   elif mutation=='lease':env['lease_tokens'].clear()
   elif mutation=='barrier':env['latest_execution_sequence']=12
   elif mutation=='sequence':before['mappingSequences']=[10]
   else:env['approved_rx'][8]['pid']=8
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.execute(env,before,BEFORE)
 def test_changed_backing_offset_permissions_or_exit_reject(self):
  for mutation in ['offset','inode','write','exit','peer','missing']:
   env,before,after,maps=self.fixture();self.execute(env,before,BEFORE)
   if mutation=='offset':maps['after'][0]['fileOffset']=4096
   elif mutation=='inode':maps['after'][0]['inode']=10
   elif mutation=='write':maps['after'][0]['permissions']='rwxp'
   elif mutation=='exit':after['exitSequence']=999
   elif mutation=='peer':env['exclusive']=(8,10)
   else:env['bti_originals'].clear()
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.execute(env,after,AFTER)
 def test_old_or_other_phase_maps_rejected_at_both_boundaries(self):
  for side in ['before','after']:
   for change in [dict(sequence=5),dict(sequence=10),dict(sequence=11),dict(sequence=13 if side=='before' else 17),dict(phase='compile')]:
    env,before,after,_=self.fixture()
    if side=='after':self.execute(env,before,BEFORE)
    env['test_originals'][side].update(change)
    with self.subTest(side=side,change=change),self.assertRaises(ValueError):self.execute(env,before if side=='before' else after,BEFORE if side=='before' else AFTER)
 def test_phase_and_boundary_links_must_agree(self):
  for target in ['barrier','entry','exit']:
   env,before,after,_=self.fixture()
   if target=='exit':
    self.execute(env,before,BEFORE);env['exits'][10]['phase']='compile';row,code=after,AFTER
   else:
    (env['barriers'][11] if target=='barrier' else env['entries'][10])['phase']='compile';row,code=before,BEFORE
   with self.subTest(target=target),self.assertRaises(ValueError):self.execute(env,row,code)
if __name__=='__main__':unittest.main()

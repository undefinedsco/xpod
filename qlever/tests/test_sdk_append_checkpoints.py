"""Append effects are projections until a retained FD full-byte checkpoint."""
import copy,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
b=load('append_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');m=b.bindings
fixture=load('append_fixture',ROOT/'qlever/tests/test_sdk_actual_write_projection.py')
class Tests(unittest.TestCase):
 def fixture(self):
  rows,originals=fixture.ProtocolTests().fixture();window=next(r for r in rows if r['kind']=='actual-write-window');window.update(format='bounded-append-effect-v1',initialBefore=window['before']);window['before']={k:window['before'][k] for k in ['bytes','sha256']}
  transition=next(r for r in rows if r['kind']=='actual-write-transition');post=transition['after'];transition['after']={k:post[k] for k in ['bytes','sha256']};transition.update(afterObservation='uncheckpointed-append-projection',actualAppendEffect=transition['after'].copy())
  # Preserve original sequence refs using an integer insertion gap.
  for row in rows:
   for key,value in list(row.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(value) is int:row[key]=value*10
  read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);checkpoint=dict(kind='append-full-checkpoint',sequence=read['sequence']+1,phase='configure',transitionSequence=transition['sequence'],identity=transition['afterIdentity'],original=post,reason='captured-access',entrySequence=read['sequence'])
  barrier=next(r for r in rows[rows.index(read)+1:] if r['kind']=='all-stop-barrier');checkpoint.update(sequence=barrier['sequence']+1,barrierSequence=barrier['sequence'],closedTrackedWaits=False)
  rows.insert(rows.index(barrier)+1,checkpoint);return rows,originals
 def inspect(self,rows,originals):
  rows=copy.deepcopy(rows);mapping={row['sequence']:i+1 for i,row in enumerate(rows)}
  for row in rows:
   for key,value in list(row.items()):
    if (key=='sequence' or key.endswith('Sequence') or key=='baseline') and type(value) is int:row[key]=mapping.get(value,value)
  return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda name,_:originals[name],{})
 def test_append_requires_actual_full_checkpoint(self):
  rows,values=self.fixture();report=self.inspect(rows,values);self.assertEqual(report['outputs'][0]['bytes'],3);self.assertFalse(report['overallSdkSourceVerified'])
  with self.assertRaisesRegex(ValueError,'checkpoint'):self.inspect([r for r in rows if r['kind']!='append-full-checkpoint'],values)
 def test_changed_prefix_identity_and_fake_projection_rejected(self):
  for mutation in ['prefix','identity','effect','offset','bool']:
   rows,values=self.fixture();cp=next(r for r in rows if r['kind']=='append-full-checkpoint');tr=next(r for r in rows if r['kind']=='actual-write-transition');window=next(r for r in rows if r['kind']=='actual-write-window')
   if mutation=='prefix':
    # Self-consistent retained checkpoint ref cannot match the projected buffer.
    cp['original']=dict(path='tampered.original',bytes=3,sha256=hashlib.sha256(b'xbc').hexdigest());values['tampered.original']=b'xbc'
   elif mutation=='identity':cp['identity']=list(cp['identity']);cp['identity'][1]+=1
   elif mutation=='effect':tr['actualAppendEffect']['sha256']='0'*64
   elif mutation=='offset':window['offset']=1
   else:window['position']=True
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows,values)
 def test_phase_final_missing_checkpoint_rejected_without_consumer(self):
  rows,values=self.fixture();rows=rows[:next(i for i,r in enumerate(rows) if r['kind']=='kernel-syscall' and r.get('nr')==0)]+[rows[-1]]
  with self.assertRaisesRegex(ValueError,'phase ended'):self.inspect(rows,values)
 def test_exec_mapping_and_fd_replacement_must_checkpoint_before_actual_exit(self):
  for nr in [3,9,59,77,82,91,292,322,436]:
   rows,values=self.fixture();read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);rows=rows[:rows.index(read)];seq=rows[-1]['sequence'];entry=dict(kind='kernel-syscall',phase='configure',sequence=seq+10,pid=7,arch=0xc000003e,op='entry',nr=nr,args=[0,0,0,0,0,0]);exit=dict(kind='kernel-syscall',phase='configure',sequence=seq+20,pid=7,arch=0xc000003e,op='exit',entrySequence=entry['sequence'],result=0,isError=False);wait=dict(kind='actual-wait-exit',phase='configure',sequence=seq+30,pid=7,returnCode=0)
   with self.subTest(nr=nr),self.assertRaisesRegex(ValueError,'before actual syscall exit'):self.inspect(rows+[entry,exit,wait],values)
 def test_nonappend_overwrite_cannot_consume_uncheckpointed_prefix(self):
  rows,values=self.fixture();window=next(r for r in rows if r['kind']=='actual-write-window');transition=next(r for r in rows if r['kind']=='actual-write-transition');read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);rows=rows[:rows.index(read)];seq=rows[-1]['sequence']
  entry=dict(kind='kernel-syscall',phase='configure',sequence=seq+10,pid=7,arch=0xc000003e,op='entry',nr=1,args=[4,1000,3,0,0,0]);barrier=dict(kind='all-stop-barrier',phase='configure',sequence=seq+20,pids=[7],osStates=['t']);second=copy.deepcopy(window);second.update(sequence=seq+30,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],format='bounded-write-delta-v1',beforeIdentity=transition['afterIdentity'],before=transition['after'],initialBefore=None,baseline=transition['sequence'])
  with self.assertRaisesRegex(ValueError,'nonappend write before'):self.inspect(rows+[entry,barrier,second],values)
 def test_checkpoint_fd_identity_prefix_tamper_and_allstop(self):
  for mode in ['good','tamper','running','fd-reuse']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
    root=Path(directory);file=root/'file';file.write_bytes(b'abc');fd=os.open(file,os.O_RDONLY);identity=b.probe.identity(os.fstat(fd));observer=b.Observer(root,root,root);observer.raw=(root/'raw').open('wb');observer.current_phase='configure';observer.check=lambda:None
    observer.barrier=lambda:dict(sequence=2);observer.tasks={7:dict(stopped=mode!='running',exited=False)};observer.retained.add(fd);digest=hashlib.sha256(b'abc');observer.append_chains[tuple(identity[:2])]=dict(held=fd,identity=identity,digest=digest,dirty=True,transition=dict(sequence=1))
    if mode=='tamper':file.write_bytes(b'xbc');observer.append_chains[tuple(identity[:2])]['identity']=b.probe.identity(os.fstat(fd)) # simulate a self-consistent identity claim, full bytes must still reject
    if mode=='fd-reuse':os.close(fd);(root/'other').write_bytes(b'abc');other=os.open(root/'other',os.O_RDONLY);self.assertEqual(other,fd)
    try:
     if mode=='good':self.assertEqual(len(observer.checkpoint_appends('phase-final')),1)
     else:
      with self.assertRaises(AssertionError):observer.checkpoint_appends('phase-final')
    finally:observer.close();observer.raw.close()
 def test_boundary_syscalls_cover_exec_mapping_fd_replacement_and_chmod(self):
  for arch,nrs in [(0xc000003e,[3,9,59,77,82,91,292,322,436]),(0xc00000b7,[24,25,38,52,57,222,221,281,436])]:
   for nr in nrs:self.assertTrue(m.append_boundary_syscall(arch,nr))
if __name__=='__main__':unittest.main()

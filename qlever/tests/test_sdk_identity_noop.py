"""One identity-axis implementation; pure fixtures never enroll source facts."""
import copy,hashlib,importlib.util,json,unittest,inspect
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
f=load('identity_cause_fixture',ROOT/'qlever/tests/test_sdk_setresuid_core_cause.py')
backend=f.backend;m=backend.tool_providers
class Tests(unittest.TestCase):
 def test_normal_wrapper_enables_only_reviewed_identity_and_terminal_models(self):
  defaults=inspect.signature(backend.Observer.__init__).parameters
  for name in ['verified_identity_noop','terminal_exit_evidence','verified_setresuid_noop']:self.assertIs(defaults[name].default,False)
  marker=RuntimeError('stop-before-platform-observation')
  with patch.object(backend.Observer,'__init__',side_effect=marker) as init:
   with self.assertRaises(RuntimeError) as caught:
    backend.SdkExecutionObserver(Path('.'),'/opt/qlever-sdk/source','/opt/qlever-sdk/build',deadline_monotonic=backend.time.monotonic()+10,check_budget=lambda:None,maximum_bytes=1024,maximum_stdio_bytes=1024)
  self.assertIs(caught.exception,marker)
  self.assertTrue(init.call_args.kwargs['verified_identity_noop']);self.assertTrue(init.call_args.kwargs['terminal_exit_evidence'])
  self.assertNotIn('verified_setresuid_noop',init.call_args.kwargs)
 def fixture(self,arch=0xc000003e,axis='Gid'):
  rows=f.Tests().fixture();nr={0xc000003e:{'Uid':117,'Gid':119},0xc00000b7:{'Uid':147,'Gid':149}}[arch][axis]
  rows[0].pop('setresuidNoopModel');rows[0]['setresIdentityNoopModel']='actual-stopped-setres-identity-noop-v1'
  for r in rows:
   if r['kind']=='kernel-syscall':
    r['arch']=arch
    if r['op']=='entry':r['nr']=nr
   if r['kind'] in ['setresuid-noop-entry-original','setresuid-noop-exit-original']:
    r['kind']=r['kind'].replace('setresuid-noop','identity-noop');r['identityAxis']=axis;o=r['observation'];o.update(arch=arch,nr=nr,identityAxis=axis)
    if axis=='Gid':o['kind']=o['kind'].replace('setresuid','setresgid')
  return rows
 def inspect(self,rows):return f.Tests().inspect(rows)
 def test_same_full_raw_parser_closure_for_both_axes_and_both_abis(self):
  for arch in [0xc000003e,0xc00000b7]:
   for axis in ['Uid','Gid']:
    with self.subTest(arch=arch,axis=axis):
     result=self.inspect(self.fixture(arch,axis));self.assertFalse(result['overallSdkSourceVerified']);self.assertEqual(result['toolchainProcessAuthorityIntervals'][0]['actualAuthorityCaptures'],2)
 def test_wrong_axis_model_abi_and_unclosed_pairs_refuse(self):
  for mutation in ['old-model','no-model','mixed-model','entry-axis','exit-axis','nr','missing-exit','barrier','error','result']:
   rows=self.fixture()
   if mutation=='old-model':rows[0].pop('setresIdentityNoopModel');rows[0]['setresuidNoopModel']='actual-stopped-setresuid-noop-v1'
   elif mutation=='no-model':rows[0].pop('setresIdentityNoopModel')
   elif mutation=='mixed-model':rows[0]['setresuidNoopModel']='actual-stopped-setresuid-noop-v1'
   elif mutation=='entry-axis':rows[6]['identityAxis']='Uid'
   elif mutation=='exit-axis':rows[9]['identityAxis']='Uid'
   elif mutation=='nr':rows[4]['nr']=120
   elif mutation=='missing-exit':rows.pop(9)
   elif mutation=='barrier':rows[8]['pids']=[]
   elif mutation=='error':rows[7]['isError']=True
   elif mutation=='result':rows[7]['result']=1
   with self.subTest(mutation=mutation),self.assertRaises((ValueError,KeyError)):self.inspect(rows)
 def test_effective_filesystem_group_and_other_authority_roles_are_not_inferred(self):
  raw=f.f.status();args=[0xffffffff,0,0xffffffff,0,0,0]
  for arch,nr in [(0xc000003e,119),(0xc00000b7,149)]:
   self.assertEqual(m.identity_noop_entry(arch,nr,args,raw,pid=10,tracer=2)['Gid'],[0]*4)
   for changed in [raw.replace('Gid: 0 0 0 0','Gid: 0 0 0 1'),raw.replace('TracerPid: 2','TracerPid: 0')]:
    with self.assertRaises(ValueError):m.identity_noop_entry(arch,nr,args,changed,pid=10,tracer=2)
   for changed in [raw.replace('Groups: 0','Groups: 1'),raw.replace('Uid: 0 0 0 0','Uid: 0 0 0 1')]:
    with self.assertRaises(ValueError):m.verify_identity_noop_transition(arch,nr,args,raw,changed,pid=10,tracer=2,result=0)
   with self.assertRaises(ValueError):m.setresuid_noop_entry(arch,nr,args,raw,pid=10,tracer=2)
   with self.assertRaises(ValueError):m.verify_authority_syscall(arch,nr,args)
 def test_real_core_dispatch_uses_same_lease_and_exclusive_barriers_for_gid(self):
  for arch in [0xc000003e,0xc00000b7]:
   rows=self.fixture(arch);entry=rows[6]['observation'];exit=rows[9]['observation'];o=object.__new__(backend.Observer);o.capture_toolchain=False;o.generated_vma=None;o.generated_vma_output=False;o.tasks={10:dict(stopped=False,exited=False,entry=None,initial=True)};o.process_authority=True;o.verified_setresuid_noop=False;o.verified_identity_noop=True;o.deny_optional_io_uring=False;o.exclusive=None;o.pausing=False;o.check=lambda:None;o.rows=[]
   def emit(row):
    value=dict(row,sequence=len(o.rows)+5,phase='configure');o.rows.append(value);return value
   o.emit=emit;o.barrier=lambda:emit(dict(kind='all-stop-barrier',pids=[10],osStates=['t']))
   class Transition:
    axis='Gid';closed=False
    def __init__(self,*args,**kw):self.observation=entry
    def finish(self,**kw):return exit
    def close(self):self.closed=True
   with patch.object(m,'StoppedIdentityNoopTransition',Transition),patch.object(backend.single,'syscall',return_value=(dict(op='entry',arch=arch,nr=entry['nr'],args=entry['args']),None)):o.event(10,34175)
   lease=o.tasks[10]['setresuidTransition'];self.assertEqual(o.exclusive,(10,5));self.assertFalse(lease.closed)
   with patch.object(backend.single,'syscall',return_value=(dict(op='exit',arch=arch,result=0,isError=False),None)):o.event(10,34175)
   self.assertTrue(lease.closed);self.assertIsNone(o.exclusive);self.assertEqual(o.rows[2]['identityAxis'],'Gid');self.assertEqual(o.rows[5]['identityAxis'],'Gid')
 def test_real_held_fd_lease_for_both_identity_axes_preserves_all_raw_guards(self):
  runtime=load('identity_actual_fd_fixture',ROOT/'qlever/tests/test_sdk_setresuid_runtime.py')
  for arch in [0xc000003e,0xc00000b7]:
   for axis in ['Uid','Gid']:
    fixture=runtime.Tests();fixture.setUp()
    try:
     nr={0xc000003e:{'Uid':117,'Gid':119},0xc00000b7:{'Uid':147,'Gid':149}}[arch][axis]
     lease=runtime.m.StoppedIdentityNoopTransition(49,arch,nr,[0xffffffff,0,0xffffffff,0,0,0],fixture.check,entry_sequence=1,barrier_sequence=2,stopped_wait_status=34175)
     fd=lease.fds['status'];exit=fixture.finish(lease);pair=runtime.m.verify_identity_noop_original_pair(lease.observation,exit)
     self.assertEqual(lease.observation['identityAxis'],axis);self.assertEqual(exit['identityAxis'],axis);self.assertEqual(pair['pid'],49);self.assertTrue(lease.closed)
     with self.assertRaises(OSError):runtime.os.fstat(fd)
     if axis=='Gid':
      with self.assertRaises(ValueError):runtime.m.verify_setresuid_original_pair(lease.observation,exit)
    finally:fixture.doCleanups()
if __name__=='__main__':unittest.main()

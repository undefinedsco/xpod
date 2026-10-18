"""Pure producer/parser authority contracts; not actual kernel or SDK evidence."""
import copy,hashlib,importlib.util,io,json,os,tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
p=load('authority_provider','qlever/scripts/sdk-tool-provider-originals.py');b=load('authority_bindings','qlever/scripts/sdk-generation-multiprocess-bindings.py')
MOUNTS=b'149 1 0:1 / / ro - overlay overlay ro\n'
def status(pid=10):return '\n'.join(['Pid:\t'+str(pid),'TracerPid:\t2','Uid:\t0 0 0 0','Gid:\t0 0 0 0','Groups:\t0','NoNewPrivs:\t1',*[key+':\t0000000000000000' for key in p._CAPS]])+'\n'
def observation(pid=10):
 ref=dict(path='capture-0000.original',bytes=len(MOUNTS),sha256=hashlib.sha256(MOUNTS).hexdigest())
 return dict(schemaVersion=1,kind='actual-stopped-tracee-process-authority',pid=pid,observerPid=2,statusOriginals=[status(pid)]*2,namespaces={role:dict(link=role+':['+str(index)+']',identity=[1,index,0o100444,0,0,0],held=dict(descriptor=index,identity=[1,index,0o100444,0,0,0])) for index,role in enumerate(['mnt','pid','user'],10)},rootIdentity=[1,20,0o40755,4096,0,0],rootHeld=dict(descriptor=20,identity=[1,20,0o40755,4096,0,0]),mountinfoOriginal=ref)
def fixture(*,omit_initial=False,omit_terminal=False,nr=39,corrupt_exit=None):
 rows=[];originals={'capture-0000.original':MOUNTS}
 def emit(kind,**fields):
  row=dict(kind=kind,phase='configure',sequence=len(rows)+1,**fields);rows.append(row);return row
 emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',processAuthorityModel=p.AUTHORITY_MODEL)
 barrier=emit('all-stop-barrier',pids=[10],osStates=['t']);emit('toolchain-original',captureKind='mountinfo',observedPid=10,original=observation()['mountinfoOriginal'])
 if not omit_initial:emit('toolchain-process-authority',pid=10,role='initial-root',eventSequence=None,barrierSequence=barrier['sequence'],observation=observation())
 entry=emit('kernel-syscall',pid=10,arch=0xc000003e,op='entry',nr=157,args=[nr,0,0,0,0,0]);emit('kernel-syscall',pid=10,arch=0xc000003e,op='exit',entrySequence=entry['sequence'],result=1,isError=False)
 event=emit('ptrace-event',pid=10,event=6);barrier=emit('all-stop-barrier',pids=[10],osStates=['t']);sample=observation()
 if corrupt_exit:corrupt_exit(sample)
 if not omit_terminal:emit('toolchain-process-authority',pid=10,role='exit-stop',eventSequence=event['sequence'],barrierSequence=barrier['sequence'],observation=sample)
 emit('actual-wait-exit',pid=10,returnCode=0);return rows,originals
def observe(rows,originals):return b.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,maximum:originals[name])
class Authority(unittest.TestCase):
 def test_actual_status_requires_nnp_and_every_zero_capability_set(self):
  self.assertEqual(p.status_authority(status(),pid=10,tracer=2)['noNewPrivs'],1)
  for before,after in [('NoNewPrivs:\t1','NoNewPrivs:\t0'),('CapBnd:\t0000000000000000','CapBnd:\t0000000000000001'),('CapAmb:\t0000000000000000','CapAmb:\t1'),('TracerPid:\t2','TracerPid:\t3')]:
   with self.assertRaises(ValueError):p.status_authority(status().replace(before,after),pid=10,tracer=2)
  with self.assertRaises(ValueError):p.status_authority(status()+'NoNewPrivs:\t1\n',pid=10,tracer=2)
 def test_unique_arch_policy_refuses_all_mount_authority_and_foreign_fd_mutators_before_resume(self):
  for arch,rules in p._AUTHORITY_SYSCALLS.items():
   for nr in rules['blocked']:
    with self.assertRaisesRegex(ValueError,'before resume'):p.verify_authority_syscall(arch,nr,[0]*6)
   p.verify_authority_syscall(arch,rules['prctl'],[39,0,0,0,0,0]);p.verify_authority_syscall(arch,rules['prctl'],[15,123,0,0,0,0])
   for option in [38,47,4,22,0x59616d61,59,999]:
    with self.assertRaises(ValueError):p.verify_authority_syscall(arch,rules['prctl'],[option,0,0,0,0,0])
  with self.assertRaises(ValueError):p.verify_authority_syscall(0xc000003e,0x40000000+165,[0]*6)
  for flag in [0x20000,0x2000000,0x4000000,0x8000000,0x10000000,0x20000000,0x40000000]:
   with self.assertRaises(ValueError):b.inspect_shared_clone_flags(17|flag)
 def test_complete_raw_interval_proves_only_the_owned_task_scope(self):
  rows,originals=fixture();result=observe(rows,originals);self.assertTrue(result['toolchainProcessAuthorityIntervalVerified']);self.assertEqual(result['toolchainProcessAuthorityIntervals'][0]['actualAuthorityCaptures'],2);self.assertFalse(result['toolchainProcessAuthorityIntervals'][0]['toolchainLifetimeImmutabilityVerified']);self.assertFalse(result['toolchainSourceClosureVerified']);self.assertIn('toolchain-provider-namespace-external-writer-and-backing-snapshot-authority-unverified',result['toolchainProcessAuthorityPending'])
 def test_fully_resequenced_missing_boundary_or_changed_privilege_namespace_root_never_passes(self):
  cases=[dict(omit_initial=True),dict(omit_terminal=True),dict(nr=38),dict(corrupt_exit=lambda row:row['namespaces']['mnt'].update(link='mnt:[99]',identity=[1,99,0o100444,0,0,0])),dict(corrupt_exit=lambda row:row['rootIdentity'].__setitem__(1,99)),dict(corrupt_exit=lambda row:row.update(statusOriginals=[status().replace('CapEff:\t0000000000000000','CapEff:\t1')]*2))]
  for case in cases:
   rows,originals=fixture(**case)
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_child_exec_and_terminal_boundaries_retain_same_security_identity(self):
  interval=p.ProcessAuthorityInterval(10)
  interval.sample(dict(pid=10,role='initial-root',eventSequence=None,observation=observation()),MOUNTS);interval.child(10,11);interval.sample(dict(pid=11,role='initial-child',eventSequence=None,observation=observation(11)),MOUNTS);interval.event(11,4,5)
  with self.assertRaises(ValueError):interval.syscall(dict(pid=11,arch=0xc000003e,nr=1,args=[0]*6))
  interval.sample(dict(pid=11,role='exec-stop',eventSequence=5,observation=observation(11)),MOUNTS)
  for pid,seq in [(11,8),(10,10)]:interval.event(pid,6,seq);interval.sample(dict(pid=pid,role='exit-stop',eventSequence=seq,observation=observation(pid)),MOUNTS);interval.wait(pid)
  self.assertEqual(interval.finish()['trackedProcesses'],2)
 def test_held_descriptor_survives_temporary_close_and_rejects_replacement(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'namespace';path.write_bytes(b'object');lease=p.ProcessAuthorityHandles()
   fd=os.open(path,os.O_RDONLY)
   try:anchor=lease.bind('mnt',fd)
   finally:os.close(fd)
   self.assertFalse(os.get_inheritable(anchor['descriptor']))
   fd=os.open(path,os.O_RDONLY)
   try:self.assertEqual(lease.bind('mnt',fd),anchor)
   finally:os.close(fd)
   replacement=Path(directory)/'other';replacement.write_bytes(b'object');os.replace(replacement,path);fd=os.open(path,os.O_RDONLY)
   try:
    with self.assertRaisesRegex(ValueError,'held authority'):lease.bind('mnt',fd)
   finally:os.close(fd)
   lease.close()
   with self.assertRaises(OSError):os.fstat(anchor['descriptor'])
   with self.assertRaisesRegex(ValueError,'already closed'):lease.bind('mnt',0)
 def test_no_namespace_timestamp_or_anchor_identity_is_discarded(self):
  for mutation in [lambda value:value['namespaces']['mnt']['identity'].__setitem__(4,1),lambda value:value['namespaces']['mnt']['held']['identity'].__setitem__(5,1),lambda value:value['namespaces']['mnt']['held'].update(descriptor=99),lambda value:value.pop('rootHeld')]:
   rows,originals=fixture(corrupt_exit=mutation)
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_child_setup_checks_actual_readback_and_never_calls_a_candidate(self):
  calls=[]
  class Libc:
   def prctl(self,option,*args):calls.append(('prctl',option,args));return int(option==23 and args[0] in [0,8])
   def capset(self,*args):calls.append(('capset',));return 0
  def read(name,*args,**kwargs):return io.BytesIO(b'40\n' if str(name).endswith('cap_last_cap') else status(42).encode())
  with patch('ctypes.CDLL',return_value=Libc()),patch.object(p.os,'getpid',return_value=42),patch('builtins.open',side_effect=read):p.restrict_child_authority()
  self.assertEqual(calls[0][:2],('prctl',38));self.assertEqual(calls[-1],('capset',));self.assertEqual([call[2][0] for call in calls if call[:2]==('prctl',24)],[0,8])
if __name__=='__main__':unittest.main()

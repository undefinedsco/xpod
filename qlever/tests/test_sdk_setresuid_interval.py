"""Pure same-raw interval protocol fixtures, never capability issuance."""
import copy,hashlib,importlib.util,json,unittest
from pathlib import Path
p=Path(__file__).parents[1]/'scripts/sdk-tool-provider-originals.py';s=importlib.util.spec_from_file_location('provider_interval',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
MOUNTS=b'149 1 0:1 / / ro - overlay overlay ro\n'
def status():return 'Pid: 10\nTgid: 10\nState: t (tracing stop)\nTracerPid: 2\nUid: 0 0 0 0\nGid: 0 0 0 0\nGroups: 0\nNoNewPrivs: 1\nSigQ: 0/1000\n'+''.join(k+': 0000000000000000\n' for k in m._CAPS)
def original(data,ino):return dict(data=data,bytes=len(data.encode()),sha256=hashlib.sha256(data.encode()).hexdigest(),identity=[1,ino,0o100444,0,0,0])
def setup():
 ns={role:dict(link=role+':['+str(ino)+']',identity=[1,ino,0o100444,0,0,0],held=dict(descriptor=ino,identity=[1,ino,0o100444,0,0,0])) for ino,role in enumerate(['mnt','pid','user'],10)}
 base=dict(schemaVersion=1,kind='actual-stopped-tracee-process-authority',pid=10,observerPid=2,statusOriginals=[status()]*2,namespaces=ns,rootIdentity=[1,20,0o40755,4096,0,0],rootHeld=dict(descriptor=20,identity=[1,20,0o40755,4096,0,0]),mountinfoOriginal=dict(path='capture.original',bytes=len(MOUNTS),sha256=hashlib.sha256(MOUNTS).hexdigest()))
 interval=m.ProcessAuthorityInterval(10);interval.sample(dict(pid=10,role='initial-root',eventSequence=None,observation=base),MOUNTS)
 value=dict(statusOriginals=[original(status(),90)]*2,statOriginals=[original('10 (fixture) '+' '.join(['t']+['0']*18+['123'])+'\n',91)]*2,processIdentity=[1,92,0o40755,0,0,0],processStarttime='123',taskGroup=10,namespaces={owner+':'+role:{k:v for k,v in row.items() if k!='held'} for owner in ['tracee','observer'] for role,row in ns.items()},uname=dict(sysname='Linux',nodename='pure-fixture',release='fixture',version='fixture',machine='x86_64'))
 entry=dict(schemaVersion=1,kind='actual-stopped-setresuid-entry',pid=10,observerPid=2,observerNativeTid=2,arch=0xc000003e,nr=117,args=[0xffffffff,0,0xffffffff,0,0,0],entrySequence=5,sequence=5,barrierSequence=6,stoppedWaitStatus=34175,observation=value)
 exit=copy.deepcopy(entry);exit.update(kind='actual-stopped-setresuid-exit',sequence=9,barrierSequence=10,result=0)
 raw=dict(kind='kernel-syscall',phase='configure',pid=10,op='entry',sequence=5,arch=entry['arch'],nr=117,args=entry['args'],waitStatus=34175)
 end=dict(kind='kernel-syscall',phase='configure',pid=10,op='exit',sequence=9,entrySequence=5,arch=entry['arch'],result=0,isError=False,waitStatus=34175)
 barrier=dict(kind='all-stop-barrier',phase='configure',sequence=6,pids=[10],osStates=['t']);last=copy.deepcopy(barrier);last['sequence']=10
 return interval,entry,exit,raw,end,barrier,last,base
class Tests(unittest.TestCase):
 def test_complete_pair_is_narrow_and_default_remains_strict(self):
  i,e,x,r,z,b,c,base=setup();i.begin_setresuid_original(e,r,b);i.consume_verified_setresuid_pair(e,x,z,c);self.assertEqual(i.setresuid_count,1)
  with self.assertRaises(ValueError):i.syscall(r)
  i.event(10,6,20);i.sample(dict(pid=10,role='exit-stop',eventSequence=20,observation=base),MOUNTS);i.wait(10);self.assertFalse(i.finish()['toolchainLifetimeImmutabilityVerified'])
 def test_missing_or_duplicate_entry_and_finish_refuse(self):
  i,e,x,r,z,b,c,_=setup()
  with self.assertRaises(ValueError):i.consume_verified_setresuid_pair(e,x,z,c)
  i.begin_setresuid_original(e,r,b)
  for action in [lambda:i.begin_setresuid_original(e,r,b),lambda:i.finish(),lambda:i.event(10,6,20),lambda:i.wait(10),lambda:i.syscall(dict(pid=10,arch=e['arch'],nr=1,args=[0]*6)),lambda:i.child(10,11)]:
   with self.assertRaises(ValueError):action()
 def test_entry_kernel_and_barrier_cannot_be_json_claims(self):
  for mutate in [lambda r,b:r.update(nr=118),lambda r,b:r.update(waitStatus=0),lambda r,b:r.update(kind='caller-claim'),lambda r,b:b.update(pids=[]),lambda r,b:b.update(osStates=['R']),lambda r,b:b.update(sequence=7)]:
   i,e,x,r,z,b,c,_=setup();mutate(r,b)
   with self.assertRaises(ValueError):i.begin_setresuid_original(e,r,b)
 def test_exit_error_phase_and_entry_identity_refuse(self):
  for mutate in [lambda e,x,z,c:z.update(entrySequence=4),lambda e,x,z,c:z.update(isError=True),lambda e,x,z,c:z.update(result=True),lambda e,x,z,c:z.update(phase='compile'),lambda e,x,z,c:c.update(pids=[]),lambda e,x,z,c:e.update(args=[0]*6)]:
   i,e,x,r,z,b,c,_=setup();i.begin_setresuid_original(e,r,b);mutate(e,x,z,c)
   with self.assertRaises(ValueError):i.consume_verified_setresuid_pair(e,x,z,c)
   self.assertTrue(i.setresuid_pending)
 def test_consumed_cannot_repeat_and_saved_entry_is_deep(self):
  i,e,x,r,z,b,c,_=setup();i.begin_setresuid_original(e,r,b);i.consume_verified_setresuid_pair(e,x,z,c)
  with self.assertRaises(ValueError):i.consume_verified_setresuid_pair(e,x,z,c)
  i,e,x,r,z,b,c,_=setup();i.begin_setresuid_original(e,r,b);e['observation']['namespaces']['tracee:user']['identity'][1]=999
  with self.assertRaises(ValueError):i.consume_verified_setresuid_pair(e,x,z,c)
 def test_pending_exec_and_changed_interval_namespace_refuse(self):
  i,e,x,r,z,b,c,_=setup();i.exec_pending[10]=3
  with self.assertRaises(ValueError):i.begin_setresuid_original(e,r,b)
  i,e,x,r,z,b,c,_=setup();i.baseline['namespaces']['user']['identity'][1]=999
  with self.assertRaises(ValueError):i.begin_setresuid_original(e,r,b)
if __name__=='__main__':unittest.main()

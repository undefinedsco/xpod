"""Lifecycle/ledger mechanics with scripted Docker records; not image authority."""
import hashlib,importlib.util,json,tempfile,time,types,unittest
from pathlib import Path
R=Path(__file__).resolve().parents[1]
def load(name):
 s=importlib.util.spec_from_file_location(name,R/'scripts'/('sdk-service-abi-'+name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
collector=load('role-collector');commands=load('role-commands')
class TestCollector(unittest.TestCase):
 def setUp(self):
  base=R.parent/'.test-data/service-abi-role-collector';base.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=base);self.addCleanup(self.tmp.cleanup);self.source=Path(self.tmp.name).resolve();p=self.source/'qlever/scripts';p.mkdir(parents=True);(p/'sdk-service-abi-role-probe.mjs').write_bytes((R/'scripts/sdk-service-abi-role-probe.mjs').read_bytes());self.out=self.source/'out';self.out.mkdir();self.total=0;self.refs={};self.end=time.monotonic()+30;self.cid='b'*64;self.image='ghcr.io/undefinedsco/xpod@sha256:'+'c'*64;self.config='sha256:'+'d'*64;self.nonce='e'*32;self.role='bun-node-addon';self.exists=False;self.started=False;self.calls=[];self.fail_create=False;self.fail_session=False
  self.budget=types.SimpleNamespace(end=self.end,check=lambda n=0:None)
 def reserve(self,n):self.total+=n;return n
 def settle(self,n,refs,*a):
  for row in refs:self.assertEqual(hashlib.sha256((self.out/row['path']).read_bytes()).hexdigest(),row['sha256']);self.refs[row['path']]=dict(row)
  self.total-=n-sum(r['bytes']for r in refs)
 def capture_bounded_control(self,label,argv,retained,source,**kw):
  self.calls.append(argv);raw=b''
  if argv[1]=='create':
   self.exists=True
   if self.fail_create:raise RuntimeError('create transport failed after actual creation')
   raw=(self.cid+'\n').encode()
  elif argv[1]=='inspect':
   raw=json.dumps([{'Id':self.cid,'Name':'/xpod-service-abi-'+self.role+'-'+self.nonce,'Image':self.config,'Config':{'Image':self.image,'Labels':{'org.xpod.service-abi-owner':self.nonce,'org.xpod.service-abi-role':self.role},'Entrypoint':['/usr/local/bin/bun'],'Cmd':['/probe.mjs',self.role,self.nonce]},'HostConfig':{'ReadonlyRootfs':True,'NetworkMode':'none','CapDrop':['ALL'],'Init':True,'Memory':512*1024**2,'PidsLimit':64,'NanoCpus':10**9,'RestartPolicy':{'Name':'no'},'SecurityOpt':['no-new-privileges'],'Tmpfs':{'/scratch':'rw,noexec,nosuid,nodev,size=8388608,mode=0700','/tmp':'rw,noexec,nosuid,nodev,size=16777216,mode=0700'}},'State':{'Status':'exited'if self.started else'created','Running':False,'Pid':0,'ExitCode':0,'OOMKilled':False},'Mounts':[{'Type':'bind','Source':str(self.source/'qlever/scripts/sdk-service-abi-role-probe.mjs'),'Destination':'/probe.mjs','RW':False}]}]).encode()
  elif argv[1]=='wait':raw=b'0\n'
  elif argv[1]=='rm':self.exists=False;raw=(self.cid+'\n').encode()
  elif argv[1]=='ps':raw=(self.cid+'\n').encode()if self.exists else b''
  result={}
  for k,b in [('receipt',b'{}'),('stdin',b''),('stdout',raw),('stderr',b'')]:
   p=self.out/(label+'-'+k);p.write_bytes(b);result[k]=dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest())
  return result
 def observe(self,argv,**kw):
  self.started=True
  if self.fail_session:raise LookupError('actual session rejected')
  membership=kw['capture_membership']();raw=b'actual mechanical stream';kw['reserve'](len(raw));return dict(command=argv,role=self.role,nonce=self.nonce,membership=membership,cleanup={'actualRootWait':True,'actualRootReturnCode':0,'ownedGroupAbsent':True,'cleanupErrors':[]},stdin=b'',stdout=raw,stderr=b'')
 def run_collector(self):
  host=types.SimpleNamespace(role_container_pid_provider=lambda *a,**k:lambda:42,observe_process=lambda pid,**k:{'observation':{'fixture':pid},'readBudgetIdentity':id(k['read_budget'])})
  return collector.collect(self.role,image=self.image,config=self.config,nonce=self.nonce,source=self.source,retained=self,commands=commands,bun_session=self,host_session=host,transport=object(),control=self,read_budget=self,elf_module=object(),deadline=self.end,assert_current=lambda:None)
 def test_complete_lifecycle_and_same_ledger(self):
  result=self.run_collector();self.assertFalse(self.exists);self.assertTrue(result['ownedContainerAbsent']);self.assertEqual(result['session']['observation']['membership']['readBudgetIdentity'],id(self));self.assertEqual(self.total,sum(p.stat().st_size for p in self.out.rglob('*')if p.is_file()));self.assertIn('wait',[a[1]for a in self.calls]);self.assertFalse(result['serviceAbiVerified'])
 def test_create_failed_after_actual_creation_is_recovered_and_removed(self):
  self.fail_create=True
  with self.assertRaisesRegex(RuntimeError,'create transport failed'):self.run_collector()
  self.assertFalse(self.exists);self.assertIn('rm',[a[1]for a in self.calls]);self.assertGreater(self.total,2*1024**2)
 def test_session_failure_preserves_error_and_removes_owned_container(self):
  self.fail_session=True
  with self.assertRaisesRegex(LookupError,'actual session rejected'):self.run_collector()
  self.assertFalse(self.exists);self.assertGreater(self.total,1024**2)
if __name__=='__main__':unittest.main()

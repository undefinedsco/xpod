import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
p=Path(__file__).parents[1]/'scripts/sdk-tool-provider-originals.py'
s=importlib.util.spec_from_file_location('provider',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.calls=0
  for owner in ['49','self']:
   (self.root/owner/'ns').mkdir(parents=True)
   for role in ['user','pid','mnt']:(self.root/owner/'ns'/role).write_bytes(b'namespace')
  (self.root/'self/ns/user').unlink();os.link(self.root/'49/ns/user',self.root/'self/ns/user')
  self.status=self.root/'49/status';self.status.write_text(self.raw())
  (self.root/'49/stat').write_text('49 (fixture) '+ ' '.join(['t']+['0']*18+['1234'])+'\n')
  oldopen,oldstat,oldreadlink=os.open,os.stat,os.readlink
  def mapped(path):
   v=os.fspath(path)
   return str(self.root/v[6:]) if v.startswith('/proc/') else path
  def op(path,*a,**kw):return oldopen(mapped(path),*a,**kw)
  def st(path,*a,**kw):return oldstat(mapped(path),*a,**kw)
  def link(path,*a,**kw):
   if os.fspath(path).startswith('/proc/') and '/ns/' in os.fspath(path):
    return Path(path).name+':['+str(oldstat(mapped(path)).st_ino)+']'
   return oldreadlink(path,*a,**kw)
  for name,fn in [('open',op),('stat',st),('readlink',link)]:
   x=patch.object(m.os,name,fn);x.start();self.addCleanup(x.stop)
 def raw(self,uid='0 0 0 0',state='t',groups='0'):
  return f'Pid: 49\nTgid: 49\nTracerPid: {os.getpid()}\nState: {state} (tracing stop)\nUid: {uid}\nGid: 0 0 0 0\nGroups: {groups}\nNoNewPrivs: 1\n'+''.join(k+': 0000000000000000\n' for k in m._CAPS)
 def check(self):self.calls+=1
 def entry(self,**kw):
  args=dict(entry_sequence=1,barrier_sequence=2,stopped_wait_status=(133<<8)|127);args.update(kw)
  return m.StoppedSetresuidTransition(49,0xc000003e,117,[0xffffffff,0,0xffffffff,8,0,0],self.check,**args)
 def finish(self,obj,**kw):
  args=dict(exit_sequence=3,barrier_sequence=4,stopped_wait_status=(133<<8)|127,result=0);args.update(kw);return obj.finish(**args)
 def test_actual_file_descriptors_and_raw(self):
  obj=self.entry();fd=obj.fds['status'];row=self.finish(obj)
  self.assertEqual(m.verify_setresuid_original_pair(obj.observation,row)['pid'],49)
  wrong=json.loads(json.dumps(row));wrong['observation']['statusOriginals'][0]['sha256']='0'*64
  with self.assertRaises(ValueError):m.verify_setresuid_original_pair(obj.observation,wrong)
  self.assertTrue(obj.closed);self.assertEqual(row['observation']['processStarttime'],'1234');self.assertGreater(self.calls,20)
  for raw in row['observation']['statusOriginals']:
   self.assertEqual(raw['sha256'],m.hashlib.sha256(raw['data'].encode()).hexdigest())
  with self.assertRaises(OSError):os.fstat(fd)
 def test_changed_authority_closes(self):
  obj=self.entry();self.status.write_text(self.raw(groups='1'))
  with self.assertRaises(ValueError):self.finish(obj)
  self.assertTrue(obj.closed)
 def test_named_replacement_rejected(self):
  obj=self.entry();self.status.unlink();self.status.write_text(self.raw())
  with self.assertRaises(ValueError):self.finish(obj)
  self.assertTrue(obj.closed)
 def test_namespace_change_rejected(self):
  obj=self.entry();path=self.root/'49/ns/user';path.unlink();path.write_bytes(b'new')
  with self.assertRaises(ValueError):self.finish(obj)
  self.assertTrue(obj.closed)
 def test_running_and_badwait_rejected(self):
  self.status.write_text(self.raw(state='R'))
  with self.assertRaises(ValueError):self.entry()
  self.status.write_text(self.raw())
  with self.assertRaises(ValueError):self.entry(stopped_wait_status=0)
 def test_error_and_budget_close(self):
  obj=self.entry()
  with self.assertRaises(ValueError):self.finish(obj,result=-1)
  self.assertTrue(obj.closed)
  def expired():raise TimeoutError('absolute budget')
  self.check=expired
  with self.assertRaises(TimeoutError):self.entry()
 def test_foreign_user_namespace_entry_rejected(self):
  path=self.root/'self/ns/user';path.unlink();path.write_bytes(b'foreign')
  with self.assertRaises(ValueError):self.entry()
 def test_replay_sequence_and_self_consistent_status_rejected(self):
  obj=self.entry();row=self.finish(obj)
  wrong=json.loads(json.dumps(row));wrong['entrySequence']=999
  with self.assertRaises(ValueError):m.verify_setresuid_original_pair(obj.observation,wrong)
  wrong=json.loads(json.dumps(row))
  for value in wrong['observation']['statusOriginals']:
   value['data']=value['data'].replace('Groups: 0','Groups: 1');value['bytes']=len(value['data'].encode());value['sha256']=m.hashlib.sha256(value['data'].encode()).hexdigest()
  with self.assertRaises(ValueError):m.verify_setresuid_original_pair(obj.observation,wrong)
 def test_missing_original_and_invalid_abi_rejected(self):
  obj=self.entry();row=self.finish(obj);wrong=json.loads(json.dumps(row));wrong['observation']['statOriginals']=[]
  with self.assertRaises(ValueError):m.verify_setresuid_original_pair(obj.observation,wrong)
  with self.assertRaises(ValueError):m.StoppedSetresuidTransition(49,0,117,[0xffffffff,0,0xffffffff,0,0,0],self.check,entry_sequence=1,barrier_sequence=2,stopped_wait_status=34175)
if __name__=='__main__':unittest.main()

"""Tiny normal parent recipe/custody tests; never downloads or compiles."""
import importlib.util,json,tempfile,unittest,time,signal
from unittest.mock import patch
from pathlib import Path
FILE=Path(__file__).with_name('api-module-producer.py')
spec=importlib.util.spec_from_file_location('api_parent',FILE);api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
ROOT=FILE.parent.parent
class Contract(unittest.TestCase):
 def test_finalization_absolute_deadline_covers_blocking_io_and_restores_timer(self):
  old=signal.getsignal(signal.SIGALRM);started=time.monotonic()
  with self.assertRaises(TimeoutError):
   with api.parent_finalization_deadline(started+.03):time.sleep(.3)
  self.assertLess(time.monotonic()-started,.2)
  self.assertEqual(signal.getsignal(signal.SIGALRM),old);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
  with self.assertRaises(TimeoutError):
   with api.parent_finalization_deadline(time.monotonic()-.001):self.fail('expired tail executed')
  with api.parent_finalization_deadline(time.monotonic()+1):api.check_parent_deadline()
 def test_explicit_plan(self):
  old=api.phase_plan(ROOT,Path('/owned/out'),'1.2.3','linux-arm64')
  new=api.phase_plan(ROOT,Path('/owned/out'),'1.2.3','linux-arm64','xpod-controlled-inngest-build-v1',1000000000)
  self.assertEqual(len(old),11);self.assertEqual(len(new),20)
  names=[n for n,_,_ in new]
  self.assertNotIn('native-material',names);self.assertNotIn('native-inputs',names)
  self.assertLess(names.index('inngest-controlled-ui-build'),names.index('inngest-controlled-ui-materialize'))
  self.assertLess(names.index('inngest-controlled-ui-materialize'),names.index('inngest-controlled-go-build'))
  for n,c,_ in new:
   if n in ('stage','pack'):self.assertEqual(c[-4:],['--native-source-kind','xpod-controlled-inngest-build-v1','--native-build-originals','/owned/out/controlled-inngest-work'])
   if n=='inngest-controlled-prepare':self.assertEqual(c[0],'/usr/bin/python3');self.assertEqual(c[-2:],['--retained-byte-ceiling','1000000000'])
  with self.assertRaises(ValueError):api.phase_plan(ROOT,'/owned/out','1.2.3','windows-x64','xpod-controlled-inngest-build-v1',1000)
 def test_exact_staging_context(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temp:
   event=Path(temp)/'event.json';sha='a'*40
   env=dict(GITHUB_REPOSITORY=api.REPOSITORY,GITHUB_SHA=sha,GITHUB_EVENT_NAME='push',GITHUB_REF='refs/heads/staging',GITHUB_EVENT_PATH=str(event),GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='1',GITHUB_WORKFLOW_REF=api.REPOSITORY+'/'+api.WORKFLOW+'@refs/heads/staging',GITHUB_WORKFLOW_SHA=sha)
   body=dict(ref='refs/heads/staging',after=sha,deleted=False);event.write_text(json.dumps(body))
   self.assertEqual(api.context(env,dict(sha=sha,status=''))['runHeadSha'],sha)
   for key,value in [('after','b'*40),('ref','refs/heads/main'),('deleted',True)]:
    event.write_text(json.dumps({**body,key:value}))
    with self.assertRaises(ValueError):api.context(env,dict(sha=sha,status=''))
 def test_retained_move_only_selected_originals(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temp:
   output=Path(temp);work=output/'controlled-inngest-work';work.mkdir()
   def original(name,data):
    p=work/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return api.reference(p,work)
   binary=original('products/inngest',b'binary');license=original('source/LICENSE.md',b'terms');source=original('originals/inngest-source.tar.gz',b'source')
   preparation=original('preparation.original.json',json.dumps(dict(originals=[source])).encode())
   inputs=original('inputs.original.json',b'{}');ignored=original('home/private-secret',b'not uploaded')
   group=dict(archives=[],inventories=[])
   collection=dict(preparation=preparation,inputs=inputs,binary=binary,license=license,sourceArchive=source,originals={x:group for x in ['source','dependencies','toolchain']},generated=dict(originals=group,removedOriginals=[]))
   original('controlled-build-materials.json',json.dumps(collection).encode());charged=[]
   before=(work/binary['path']).stat();ref=api.retain_controlled_originals(output,charged.append);destination=output/'source-materials/native-builds/inngest'
   self.assertTrue((destination/'products/inngest').is_file());self.assertTrue((work/'home/private-secret').is_file());self.assertFalse((destination/'home').exists());self.assertEqual((destination/'products/inngest').stat().st_ino,before.st_ino)
   self.assertEqual(sum(p.stat().st_size for p in destination.rglob('*') if p.is_file()),sum(charged));self.assertEqual(ref['path'],'source-materials/native-builds/inngest/controlled-build-materials.json')
 def test_installed_schema_dispatch_checks_actual_bytes(self):
  spec=importlib.util.spec_from_file_location('api_consumer',FILE.with_name('api-module-consumer.py'));consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temp:
   root=Path(temp);binary=root/'node_modules/inngest-cli/bin/inngest';binary.parent.mkdir(parents=True);binary.write_bytes(b'actual')
   index=root/'provenance/native/inngest/index.json';index.parent.mkdir(parents=True)
   value=dict(schemaVersion=2,sourceKind='xpod-controlled-inngest-build-v1',target='linux-arm64',sourceCommit='0d75b0b305010b5e90a627703e9d1df4464b1e39',binary=dict(path='node_modules/inngest-cli/bin/inngest',bytes=6,sha256=api.sha_file(binary)))
   runner=object.__new__(consumer.Runner);runner.checked={'target':dict(target='linux-arm64',platform='linux',arch='arm64')};runner.plan={'bun':'not-executed'}
   # This test covers the installed index selector; the independent native-file
   # verifier and actual runtime probe have their own execution tests.
   with patch.object(consumer.lifecycle.targets,'native_files',return_value={'scope':'byte-selector-only'}):
    index.write_text(json.dumps(value));runner.verify_installed('node',root,{'xpodModule':{'id':'api'}})
    for change in [dict(sourceKind='other'),dict(target='linux-x64'),dict(schemaVersion=3),dict(binary={**value['binary'],'bytes':7}),dict(binary={**value['binary'],'sha256':'0'*64})]:
     index.write_text(json.dumps({**value,**change}))
     with self.assertRaises(ValueError):runner.verify_installed('node',root,{'xpodModule':{'id':'api'}})
if __name__=='__main__':unittest.main()

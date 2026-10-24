import hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parents[3]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
snapshots=load('build_snapshot_test','scripts/service-build-observations.py')
bindings=load('build_bindings_test','qlever/scripts/sdk-service-pack-bindings.py')
class BuildObservations(unittest.TestCase):
 def setUp(self):(ROOT/'.test-data').mkdir(parents=True,exist_ok=True)
 def test_actual_source_and_generated_partition_full_identity_and_hash(self):
  with tempfile.TemporaryDirectory(prefix='service-build-snapshots-',dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);(root/'src').mkdir();(root/'dist').mkdir();(root/'node_modules').mkdir();(root/'src/input.ts').write_bytes(b'input');(root/'dist/output.js').write_bytes(b'output');(root/'node_modules/unclaimed').write_bytes(b'dependency')
   before=snapshots.snapshot(root,lambda:None);self.assertEqual([r[0] for r in before['rows']],['src/input.ts']);self.assertEqual(before['rows'][0][2],hashlib.sha256(b'input').hexdigest());self.assertEqual(len(before['rows'][0][1]),7)
   after=snapshots.snapshot(root,lambda:None,paths=[r[0] for r in before['rows']]);self.assertEqual(before,after)
   outputs=snapshots.snapshot(root,lambda:None,generated=True);self.assertEqual([r[0] for r in outputs['rows']],['dist/output.js'])
   (root/'src/input.ts').write_bytes(b'other');self.assertNotEqual(before,snapshots.snapshot(root,lambda:None,paths=['src/input.ts']))
 def test_fifo_directory_and_oversize_refuse_before_leaf_open(self):
  with tempfile.TemporaryDirectory(prefix='service-build-snapshots-',dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);os.mkfifo(root/'fifo');(root/'directory').mkdir()
   with open(root/'oversize','wb') as out:out.truncate(snapshots.LIMITS['shardBytes']+1)
   with mock.patch.object(snapshots.os,'open') as opened:
    for name in ['fifo','directory','oversize']:
     with self.assertRaisesRegex(ValueError,'before open'):snapshots.sample(root,name,lambda:None)
    opened.assert_not_called()
 def test_same_parent_model_all_stage_raws_and_actual_build_charge(self):
  end=1793000000000;raw=b'actual raw';phase={};captured={};source='a'*40
  def receipt(command):return dict(command=command,exit=0,signal=None,resourceStop=None,supervisorError=None,cleanupErrors=[],actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True,rawOverflow=False,actualRawPipeEof=True,retainedRawBytes=len(raw),rawSHA256=hashlib.sha256(raw).hexdigest(),rawByteLimit=bindings.META,startedUTC='2026-10-26T03:30:00.000Z',closedUTC='2026-10-26T03:30:00.000Z')
  # Timestamp is fixed inside the same 900s parent, never a new test window.
  import datetime
  stamp=datetime.datetime.fromtimestamp((end-1000)/1000,datetime.timezone.utc).isoformat()
  for name,argv in bindings.BUILD_COMMANDS:
   row=receipt(list(argv));row.update(startedUTC=stamp,closedUTC=stamp);phase[name+'.receipt.json']=json.dumps(row).encode();phase[name+'.raw.log']=raw
  for name in ['build-inputs.before.json','build-inputs.after.json','build-outputs.after.json']:phase[name]=b'{}'
  charged=sum(map(len,phase.values()));allocation=32*bindings.META-charged-3*bindings.META
  row=receipt(['node','/app/scripts/run-npm-pack.cjs','.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals',source,str(end),str(allocation)]);row.update(startedUTC=stamp,closedUTC=stamp);phase['pack.receipt.json']=json.dumps(row).encode();phase['pack.raw.log']=raw
  for name,body in phase.items():
   name='service-pack-phase/'+name;captured[name]=dict(path=name,bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
  parent=dict(sourceSha=source,authorityVerified=False,retainedCeilingBytes=32*bindings.META,originals=list(captured.values()),chargedOriginalBytes=sum(r['bytes'] for r in captured.values()),deadlineUnixMs=end,workingDirectory=dict(path='/app',canonicalPath='/app',identity=['1','2','16877','4096','3','4','2'],completedIdentity=['1','2','16877','8192','5','6','3']),parentModel=bindings.BUILD_PARENT_MODEL,buildChargedOriginalBytes=charged,workerRetainedCeilingBytes=allocation)
  collection=dict(sourceSha=source,authorityVerified=False,details=dict(completion='actual-pack-returned',budget=dict(deadlineUnixMs=end,retainedCeilingBytes=allocation)))
  self.assertTrue(bindings.verify_pack_parent(collection,parent,phase,captured)['parentRawClosureVerified'])
  for key in ['build-ui.raw.log','build-inputs.before.json']:
   wrong=dict(phase);del wrong[key]
   with self.assertRaises(ValueError):bindings.verify_pack_parent(collection,parent,wrong,captured)
  wrong=dict(parent,workerRetainedCeilingBytes=allocation+1)
  with self.assertRaises(ValueError):bindings.verify_pack_parent(collection,wrong,phase,captured)
  for key in ['cleanupErrors','resourceStop','supervisorError','signal']:
   wrong=dict(phase);value=json.loads(wrong['build-ui.receipt.json']);del value[key];wrong['build-ui.receipt.json']=json.dumps(value).encode()
   refs=dict(captured);name='service-pack-phase/build-ui.receipt.json';refs[name]=dict(path=name,bytes=len(wrong['build-ui.receipt.json']),sha256=hashlib.sha256(wrong['build-ui.receipt.json']).hexdigest())
   updated=dict(parent,originals=list(refs.values()),chargedOriginalBytes=sum(r['bytes'] for r in refs.values()))
   with self.assertRaises(ValueError):bindings.verify_pack_parent(collection,updated,wrong,refs)
if __name__=='__main__':unittest.main()

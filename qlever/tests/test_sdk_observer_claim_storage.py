"""Physical claim accounting through actual observer file/pipe APIs, without ptrace authority."""
import contextlib,importlib.util,io,json,os,pathlib,tempfile,time,unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('claim_storage_observer',ROOT/'qlever/scripts/sdk-ptrace-execution.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
class Tests(unittest.TestCase):
 def test_actual_capture_indexed_shards_and_pipe_are_disjoint(self):
  parent=ROOT/'.test-data/observer-claim-storage';parent.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=parent) as directory:
   root=pathlib.Path(directory);out=root/'out';out.mkdir();data=b'actual-body'*7000;source=root/'source';source.write_bytes(data)
   b=core.Observer(out,root,root,maximum_bytes=2**20,maximum_file_bytes=2**18,indexed_raw_records=True);b.current_phase='compile';b.deadline=time.monotonic()+20;b.raw=core.ShardedRaw(out,'compile',65536);b.raw_encoder=core.probe.IndexedRawEncoder()
   try:
    with source.open('rb') as reader:ref=b.snapshot_write_original(reader.fileno(),len(data))
    self.assertEqual((out/ref['path']).read_bytes(),data)
    for i in range(500):b.emit(dict(kind='diagnostic-test-event',value='x'*180,index=i))
    read,write=os.pipe();pump=core.BoundedPipePump(read,out/'stdout',65536,lambda count:b.claim(count,category='stdio'),b.pump_errors);pump.start();os.write(write,b'actual stdout');os.close(write);pump.finish(b.check)
    b.claim(7) # Provider/other charge is independently classified.
    raw_bytes=sum(path.stat().st_size for path in b.raw.paths)
    self.assertGreater(len(b.raw.paths),1);self.assertEqual(b.claim_bytes,{'raw-wire':raw_bytes,'capture-body':len(data),'stdio':13,'provider-other':7});self.assertEqual(sum(b.claim_bytes.values()),b.domain_bytes)
    before=dict(b.claim_bytes);b.maximum_bytes=b.domain_bytes;stream=io.StringIO()
    with contextlib.redirect_stderr(stream),self.assertRaisesRegex(AssertionError,'shared execution original byte bound'):b.emit(dict(kind='refused'))
    diagnostic=json.loads(stream.getvalue().split(' ',1)[1]);self.assertEqual(diagnostic['successfulClaimBytes'],before);self.assertEqual(diagnostic['currentRawShards'],dict(count=len(b.raw.paths),bytes=raw_bytes));self.assertEqual(b.claim_bytes,before);self.assertEqual(sum(path.stat().st_size for path in b.raw.paths),raw_bytes)
   finally:b.raw.close()
if __name__=='__main__':unittest.main()

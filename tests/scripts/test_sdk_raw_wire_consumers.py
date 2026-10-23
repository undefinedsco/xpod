"""Compressed/legacy consumer boundaries; synthetic rows do not issue authority."""
import importlib.util,json,hashlib,zlib,tempfile,zipfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
reader=load('sdk-raw-wire-reader');tools=load('sdk-observed-tool-originals');materials=load('sdk-toolchain-materials')
def ref(path,data):return dict(path=path,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def wire(path,raw):
 c=zlib.compressobj(wbits=31);encoded=c.compress(raw)+c.flush();r=ref(path,encoded);r['wire']=dict(model='kernel-raw-gzip-v1',encoded={k:r[k] for k in ['bytes','sha256']},logical={k:ref(path,raw)[k] for k in ['bytes','sha256']});return r,encoded
class Consumers(unittest.TestCase):
 def test_adapter_legacy_compressed_and_outer_binding(self):
  raw=b'{"sequence":1}\n';r,data=wire('raw',raw)
  args=dict(check=lambda:None,maximum_encoded=1024,maximum_logical=1024)
  self.assertEqual(list(reader.iter_shard_records([data],r,**args)),[raw])
  self.assertEqual(list(reader.iter_shard_records([raw],ref('raw',raw),**args)),[raw])
  with self.assertRaises(ValueError):list(reader.iter_shard_records([data],dict(r,sha256='0'*64),**args))
  with self.assertRaises(ValueError):list(reader.iter_shard_records([data],r,**dict(args,maximum_logical=1)))
 def test_tool_scanner_exhausts_even_without_selected_tools(self):
  root=ROOT/'.test-data/raw-consumers';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as tmp:
   payload={};phases=[]
   for name in ['configure','compile']:
    path='inner/toolchain-execution/'+name+'.gz';r,data=wire(path,(json.dumps(dict(phase=name,sequence=1,kind='synthetic-non-tool'))+'\n').encode());payload[path]=data
    indexpath='inner/toolchain-execution/'+name+'.json';indexdata=b'{"schemaVersion":1,"files":[]}';payload[indexpath]=indexdata
    phases.append(dict(name=name,rawTraceShards=[r],captures=dict(indexes=[ref(indexpath,indexdata)],files=0,bytes=0),toolFileSnapshots=dict(indexes=[],files=0,bytes=0)))
   def run():
    p=Path(tmp)/'data.zip'
    with zipfile.ZipFile(p,'w') as z:
     for name,data in payload.items():z.writestr(name,data)
    return tools.observe(p,dict(remainingMilliseconds=30000,phases=phases,verifiedRows=[],verifiedToolSnapshots=[]))
   self.assertFalse(run()['wholeToolchainVerified'])
   # A decoder that returns after finding zero selected rows would miss this.
   path=phases[-1]['rawTraceShards'][0]['path'];payload[path]=payload[path][:-1]
   with self.assertRaises(ValueError):run()
 def test_failure_diagnostic_decodes_and_rejects_trailer(self):
  root=ROOT/'.test-data/raw-consumers';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as tmp:
   p=Path(tmp);stdout=b'';stderr=b'failure\n';(p/'stdout.raw').write_bytes(stdout);(p/'stderr.raw').write_bytes(stderr)
   raw=(json.dumps(dict(kind='actual-wait-exit',pid=7,returnCode=1,sequence=1))+'\n').encode();r,data=wire(str(p/'raw.gz'),raw);(p/'raw.gz').write_bytes(data)
   result=dict(trackingReceipt=dict(actualRootPid=7,actualRootReturnCode=1,actualTrackedWait=True,trackedProcessesClosed=True),commandReceipt=dict(stdout=ref('stdout.raw',stdout),stderr=ref('stderr.raw',stderr)),rawTraceShards=[r])
   self.assertEqual(materials.failure_diagnostic(result,p,p,lambda:None)['nonzeroWaitCount'],1)
   (p/'raw.gz').write_bytes(data[:-1])
   with self.assertRaises(ValueError):materials.failure_diagnostic(result,p,p,lambda:None)
if __name__=='__main__':unittest.main()

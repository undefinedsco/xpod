"""Actual finalize copy/reference control flow; no observer/kernel execution."""
import hashlib,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('observer_imports',ROOT/'qlever/scripts/sdk-toolchain-materials.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NAMES=['sdk-ptrace-execution.py','sdk-ptrace-kernel.py','sdk-execution-originals-util.py','sdk-generation-multiprocess-bindings.py','sdk-blocking-owned-wait.py','sdk-tool-provider-originals.py','sdk-generated-vma-originals.py','sdk-coordinated-wait.py']
class Tests(unittest.TestCase):
 def test_finalize_preserves_complete_current_source_bodies_and_refs(self):
  parent=ROOT/'.test-data/observer-imports';parent.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=parent) as tmp:
   root=Path(tmp);sources=root/'source';sources.mkdir();out=root/'out';out.mkdir();session=m.Session.__new__(m.Session);session.out=out;session.directory=out/'toolchain-execution';session.directory.mkdir();session.phases=[];session.results=[];session.budget=types.SimpleNamespace(check=lambda:None,deadline_unix=123);mount=session.directory/'mount';mount.write_bytes(b'actual mount placeholder');session.observer=types.SimpleNamespace(source_provider_originals=dict(mountinfo=dict(path='mount')))
   for name in NAMES:(sources/name).write_bytes(('actual body '+name).encode())
   upstream=out/'upstream';upstream.write_text(json.dumps(dict(postpatchInventory={})));inner=dict(inputsBefore={},inputsAfter={},symlinkOriginals={},generationMetadata={})
   upstream_ref=m.commands.ref(upstream,out);session.phases=[dict(name='configure',**{field:upstream_ref for field in ['receipt','stdout','stderr','trackingReceipt']})];session.results=[dict(captureFiles=[],rawTraceShards=[],toolFileSnapshots=[])]
   with patch.object(m,'HERE',sources):reference,total=session.finalize(inner,m.commands.ref(upstream,out),dict(files=[],pending=[]))
   self.assertEqual(reference,m.commands.ref(session.directory/'final-materials.json',out));self.assertGreater(total,0)
   collection=json.loads((out/reference['path']).read_text());observer=collection['phases'][0]['backend']['observerOriginals'];self.assertEqual([r['sourcePath'] for r in observer],['qlever/scripts/'+name for name in NAMES]);self.assertEqual([r['file'] for r in observer],[m.commands.ref(session.directory/name,out) for name in NAMES])
   for name in NAMES:self.assertEqual((session.directory/name).read_bytes(),(sources/name).read_bytes());self.assertEqual(m.commands.ref(session.directory/name,out)['sha256'],hashlib.sha256((sources/name).read_bytes()).hexdigest())
   # A real phase uses the same observer list; no caller supplies its file set.
   (sources/NAMES[-1]).unlink();out2=root/'missing';out2.mkdir();session.out=out2;session.directory=out2/'toolchain-execution';session.directory.mkdir()
   with patch.object(m,'HERE',sources):
    with self.assertRaisesRegex(ValueError,'sdk-coordinated-wait'):session.finalize(inner,{},dict(files=[],pending=[]))
if __name__=='__main__':unittest.main()

"""Actual file snapshots/encoding only; no child success or SDK authority."""
import base64,contextlib,hashlib,importlib.util,io,json,os,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];spec=importlib.util.spec_from_file_location('commands_failure',ROOT/'qlever/scripts/sdk-command-materials.py');commands=importlib.util.module_from_spec(spec);spec.loader.exec_module(commands)
class Failure(unittest.TestCase):
 def test_actual_full_small_raw_and_large_marked_tail_preserve_full_sha(self):
  base=ROOT/'.test-data/prepared-child-failure';base.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=base) as temp:
   root=Path(temp).resolve();stage=root/'stages/fetchcontent-prepare';stage.mkdir(parents=True);raw=b'actual public FetchContent error\n';(stage/'stderr.raw').write_bytes(raw);large=b'x'*20000;(stage/'stdout.raw').write_bytes(large);receipt={'exit':1,'signal':None,'actualWait':True,'rawClosedBeforeHash':True};(stage/'command.receipt.json').write_text(json.dumps(receipt));(root/'stages/fetchcontent-prepare.receipt.json').write_text(json.dumps(dict(receipt,ownedGroupAbsentAfterWait=True)));(root/'stages/fetchcontent-prepare.raw.log').write_bytes(b'actual wrapper')
   nested=root/'fetchcontent/googletest/git/commands/clone';nested.mkdir(parents=True);(nested/'receipt.json').write_text(json.dumps({'exit':128,'signal':None,'actualWait':True}));(nested/'stdout.original').write_bytes(b'');(nested/'stderr.original').write_bytes(b'actual Git transport error');value=commands.failed_stage_originals('fetchcontent-prepare',root,lambda:None);self.assertEqual(len(value['nestedGitCommands']),1);self.assertEqual(base64.b64decode(value['nestedGitCommands'][0]['stderr']['data']),b'actual Git transport error');self.assertEqual(value['stage'],'fetchcontent-prepare');self.assertLess(len(json.dumps(value).encode()),65500)
   stderr=value['originals']['stderr'];self.assertEqual(base64.b64decode(stderr['data']),raw);self.assertTrue(stderr['fullBytesIncluded']);self.assertEqual(stderr['sha256'],hashlib.sha256(raw).hexdigest())
   stdout=value['originals']['stdout'];self.assertFalse(stdout['fullBytesIncluded']);self.assertEqual(stdout['offset'],len(large)-8192);self.assertEqual(stdout['sha256'],hashlib.sha256(large).hexdigest());self.assertEqual(json.loads(base64.b64decode(value['originals']['receipt']['data']))['exit'],1)
   def expired():raise TimeoutError('same deadline')
   with self.assertRaises(TimeoutError):commands.failed_stage_originals('fetchcontent-prepare',root,expired)
   (stage/'stderr.raw').unlink();(stage/'stderr.raw').symlink_to(stage/'stdout.raw')
   with self.assertRaises(ValueError):commands.failed_stage_originals('fetchcontent-prepare',root,lambda:None)
 def test_real_prepare_control_flow_preserves_first_failure_and_emits_actual_child_originals(self):
  spec=importlib.util.spec_from_file_location('inner_prepare_failure',ROOT/'qlever/scripts/sdk-inner-materials.py');inner=importlib.util.module_from_spec(spec);spec.loader.exec_module(inner)
  class OriginalFailure(RuntimeError):pass
  class Budget:
   def check(self,*args):pass
   def timeout(self,*args):return 1
  base=ROOT/'.test-data/prepared-child-control';base.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=base) as temp:
   root=Path(temp).resolve();calls=[]
   def capture(name,command,out,*args,**kwargs):
    calls.append(name)
    if name=='source-prepare':return {'name':name}
    stage=out/'stages'/name;stage.mkdir(parents=True);(stage/'stderr.raw').write_bytes(b'actual child refused fixed source');(stage/'stdout.raw').write_bytes(b'');(stage/'command.receipt.json').write_text(json.dumps({'exit':1,'signal':None,'actualWait':True}));(out/'stages'/ (name+'.receipt.json')).write_text(json.dumps({'exit':1,'actualWait':True,'ownedGroupAbsentAfterWait':True}));(out/'stages'/(name+'.raw.log')).write_bytes(b'wrapper');raise OriginalFailure('original actual child exit1')
   stream=io.StringIO()
   with patch.dict(os.environ,{'XPOD_QLEVER_SDK_IDENTITY':json.dumps({'sdkProfile':'module-bookworm-gcc12'})}),patch.object(inner,'initialize_budget',return_value=Budget()),patch.object(inner.profile_module,'compiler_spec',return_value={'profile':'module-bookworm-gcc12'}),patch.object(inner.commands,'capture',side_effect=capture),contextlib.redirect_stderr(stream):
    with self.assertRaisesRegex(OriginalFailure,'original actual child exit1'):inner.prepare_materials(root,root/'source',root/'build',root/'materials',2)
   self.assertEqual(calls,['source-prepare','fetchcontent-prepare']);self.assertNotIn('XPOD_QLEVER_UPSTREAM_MATERIALS_DIR',os.environ);line=stream.getvalue().strip();self.assertTrue(line.startswith('SDK_PREPARED_STAGE_FAILURE '));value=json.loads(line.split(' ',1)[1]);self.assertEqual(base64.b64decode(value['originals']['stderr']['data']),b'actual child refused fixed source');self.assertFalse((root/'materials/source-prepared.json').exists())

if __name__=='__main__':unittest.main()

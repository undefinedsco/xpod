"""Pure endpoint composition only; not kernel/original verification or a cap.

The module is imported as the ACTUAL production module (not an AST-extracted
function in a fake scope). The previous extraction re-created only
`retained_metadata_chain`, so the real fail-only diagnostic helper it calls was
undefined and the fixture diverged from production. Importing the module keeps
every existing assertion and also exercises the real bounded diagnostic.
"""
import copy,importlib.util,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'scripts/sdk-generation-multiprocess-bindings.py'
spec=importlib.util.spec_from_file_location('sdk_generation_multiprocess_bindings_retained',SOURCE)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
join=module.retained_metadata_chain
class Tests(unittest.TestCase):
 def setUp(self):
  self.pre=[1,2,33188,1571,40,50];self.ren=[1,2,33188,1571,40,60];self.mode=[1,2,33261,1571,40,70]
  self.producer=dict(sequence=10,path='/build/temp',identity=self.pre)
  self.rename=(dict(kind='actual-rename-window',producerCaptureSequence=10,fromPath='/build/temp',toPath='/build/final',beforeIdentity=self.pre),dict(sequence=20,afterIdentity=self.ren))
  self.chmod=(dict(kind='actual-mode-window',beforeIdentity=self.ren),dict(sequence=30,afterIdentity=self.mode))
  self.consumer=dict(sequence=40,path='/build/final',identity=self.mode)
 def test_rename_then_chmod_exact_full_six(self):self.assertEqual(join(self.producer,self.consumer,[self.rename,self.chmod]),[20,30])
 def test_chmod_then_rename(self):
  mode=copy.deepcopy(self.chmod);mode[0]['beforeIdentity']=self.pre;mode[1]['sequence']=20
  rename=copy.deepcopy(self.rename);rename[0]['beforeIdentity']=self.mode;rename[1].update(sequence=30,afterIdentity=[*self.mode[:5],80]);consumer=dict(self.consumer,identity=[*self.mode[:5],80]);self.assertEqual(join(self.producer,consumer,[mode,rename]),[20,30])
 def test_no_post_only_gap_bridge(self):
  rename=copy.deepcopy(self.rename);rename[0]['beforeIdentity'][5]+=1
  with self.assertRaisesRegex(ValueError,'gap'):join(self.producer,self.consumer,[rename,self.chmod])
 def test_every_preimage_identity_axis_is_required(self):
  for index in range(6):
   with self.subTest(axis=index):
    chmod=copy.deepcopy(self.chmod);chmod[0]['beforeIdentity'][index]+=1
    with self.assertRaises(ValueError):join(self.producer,self.consumer,[self.rename,chmod])
 def test_wrong_producer_path_and_changed_rename_metadata(self):
  for key,value in [('producerCaptureSequence',9),('fromPath','/other')]:
   rename=copy.deepcopy(self.rename);rename[0][key]=value
   with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
  for index in range(5):
   rename=copy.deepcopy(self.rename);rename[1]['afterIdentity'][index]+=1
   with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
 def test_missing_duplicate_reordered_and_after_consumer_refuse(self):
  for states in [[self.chmod],[self.rename],[self.rename,self.rename,self.chmod],[self.chmod,self.rename]]:
   with self.assertRaises(ValueError):join(self.producer,self.consumer,states)
  rename=copy.deepcopy(self.rename);rename[1]['sequence']=41
  with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
 def test_wrong_final_ctime_path_or_inode_refuses(self):
  for index in range(6):
   consumer=copy.deepcopy(self.consumer);consumer['identity'][index]+=1
   with self.assertRaises(ValueError):join(self.producer,consumer,[self.rename,self.chmod])
  with self.assertRaises(ValueError):join(self.producer,dict(self.consumer,path='/wrong'),[self.rename,self.chmod])
 def test_generated_unmap_checkpoint_uses_the_same_exact_metadata_chain(self):
  producer=dict(self.producer,kind='generated-vma-operation-exit',operation='unmap')
  rename=copy.deepcopy(self.rename);rename[0]['generatedCheckpointSequence']=rename[0].pop('producerCaptureSequence')
  self.assertEqual(join(producer,self.consumer,[rename,self.chmod]),[20,30])
  for mutation in ['wrong-checkpoint','ordinary-reference','both-references','missing-change']:
   changed=copy.deepcopy(rename)
   if mutation=='wrong-checkpoint':changed[0]['generatedCheckpointSequence']=9
   elif mutation=='ordinary-reference':changed[0]['producerCaptureSequence']=changed[0].pop('generatedCheckpointSequence')
   elif mutation=='both-references':changed[0]['producerCaptureSequence']=10
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):
    join(producer,self.consumer,[changed]if mutation=='missing-change'else [changed,self.chmod])
 def test_unknown_operation_cannot_fill_ctime_gap(self):
  rename=copy.deepcopy(self.rename);rename[0]['kind']='retained-fd-rename-binding'
  with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
if __name__=='__main__':unittest.main()

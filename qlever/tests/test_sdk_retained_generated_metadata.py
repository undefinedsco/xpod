"""Protocol state accounting only; real closed-transaction probes are separate."""
import copy,importlib.util,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('retained_metadata_base',ROOT/'qlever/scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
LIMIT=4*1024**2
CLOSE=dict(kind='exclusive-captured-syscall-exit',pid=10,entrySequence=1,sequence=4)
class Tests(unittest.TestCase):
 def runtime(self,retained=True):return m.Runtime(types.SimpleNamespace(generated_vma_parked_wait=True,retained_generated_metadata=retained))
 def verifier(self,retained=True):return m.create_verifier(m,lambda _:None,lambda _:[],model=m.PARKED_WAIT_MODEL,retained_metadata=retained)
 def test_old_model_keeps_the_same_cumulative_four_mib_limit(self):
  for owner in [self.runtime(False),self.verifier(False)]:
   with self.subTest(owner=type(owner).__name__),self.assertRaisesRegex(ValueError,'metadata bound'):
    for _ in range(140):owner.charge_metadata(dict(payload='x'*32768))
 def test_many_closed_transactions_release_only_transient_metadata(self):
  for owner in [self.runtime(),self.verifier()]:
   for _ in range(140):
    owner.charge_metadata(dict(payload='x'*32768))
    if isinstance(owner,m.Runtime):owner.metadata_close_entry=(10,1,4)
    else:owner.metadata_closed_operation=(10,1,4)
    owner.checkpoint_metadata(CLOSE)
   self.assertLess(owner.metadata_bytes,32768);self.assertLess(owner.metadata_high_water,LIMIT)
 def test_open_or_unreferenced_runtime_transaction_cannot_release(self):
  for mode in ['missing-close','wrong-close','active','pending','scheduled']:
   owner=self.runtime();owner.charge_metadata(dict(payload='x'*100));owner.metadata_close_entry=None if mode=='missing-close'else (10,1,4);before=owner.metadata_bytes;close=dict(CLOSE)
   if mode=='wrong-close':close['sequence']=5
   elif mode=='active':owner.active={}
   elif mode=='pending':owner.pending[10]={}
   elif mode=='scheduled':owner.round={}
   with self.subTest(mode=mode),self.assertRaises(ValueError):owner.checkpoint_metadata(close)
   self.assertEqual(owner.metadata_bytes,before)
 def test_reader_requires_its_actual_closed_own_operation(self):
  for mode in ['missing-close','wrong-close','transaction','mapping-entry','fd-binding','scheduled']:
   owner=self.verifier();owner.metadata_closed_operation=None if mode=='missing-close'else (10,1,4);close=dict(CLOSE)
   if mode=='wrong-close':close['entrySequence']=2
   elif mode=='transaction':owner.transaction={}
   elif mode=='mapping-entry':owner.pending_mapping_entries.add(1)
   elif mode=='fd-binding':owner.fd_bindings[1]={}
   elif mode=='scheduled':owner.scheduled_rows=[]
   with self.subTest(mode=mode),self.assertRaises(ValueError):owner.checkpoint_metadata(close)
 def test_retained_facts_still_share_the_same_hard_limit(self):
  for owner in [self.runtime(),self.verifier()]:
   owner.checkpoints[1]=dict(payload='x'*LIMIT)
   if isinstance(owner,m.Runtime):owner.metadata_close_entry=(10,1,4)
   else:owner.metadata_closed_operation=(10,1,4)
   with self.assertRaisesRegex(ValueError,'retained generated metadata bound'):owner.checkpoint_metadata(CLOSE)
 def test_live_shared_containers_are_counted_once_but_distinct_facts_remain(self):
  child=dict(payload='x'*1000);shared=m.retained_metadata_bytes([child,child]);distinct=m.retained_metadata_bytes([child,copy.deepcopy(child)])
  self.assertLess(shared,distinct)
  for value in [object(),float('inf'),b'unmodeled-body']:
   with self.assertRaises(ValueError):m.retained_metadata_bytes(value)
 def test_retained_model_does_not_silently_apply_to_older_streams(self):
  with self.assertRaises(ValueError):m.create_verifier(m,lambda _:None,lambda _:[],model=m.COORDINATED_WAIT_MODEL,retained_metadata=True)
if __name__=='__main__':unittest.main()

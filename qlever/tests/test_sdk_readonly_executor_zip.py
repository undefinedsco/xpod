"""Real tiny ZIP transport only, no genuine SDK cap or candidate execution."""
import copy,hashlib,importlib.util,json,tempfile,unittest,zipfile
from pathlib import Path
from qlever.tests.test_sdk_readonly_executor import fixture,ID,b,e
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('zip_original_probe',ROOT/'qlever/scripts/sdk-zip-originals.py');z=importlib.util.module_from_spec(spec);spec.loader.exec_module(z)
TESTDATA=ROOT/'.test-data/sdk-readonly-executor';TESTDATA.mkdir(parents=True,exist_ok=True)
def ref(name,data):return dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def archive(path):
 record,raw,values=fixture();record=e.rooted_collection(record);raw={'readonly-executor/'+name:data for name,data in raw.items()};body=json.dumps(record).encode();collection=ref('readonly-executor/executor.collection.json',body);raw[collection['path']]=body
 master=dict(identity=ID,readonlyExecutor=collection,originals=[ref(name,data) for name,data in raw.items()]);body=json.dumps(master).encode();raw['materials.json']=body;masterref=ref('materials.json',body)
 with zipfile.ZipFile(path,'w') as target:
  for name,data in raw.items():target.writestr(name,data)
 h=values['hostBefore'];provider=dict(mountNamespaceIdentityDecimal=[str(v) for v in h['namespaces']['mnt']['identity']],rootIdentityDecimal=[str(v) for v in h['rootIdentity']],mountNamespace=h['namespaces']['mnt']['link'],provider=dict(mount='/',mountId=99,mountOptions=['ro']))
 return dict(identity=ID,masterReference=masterref,providers=[provider],remainingMilliseconds=1000)
class Zip(unittest.TestCase):
 def test_real_archive_exact_master_refs_outer_originals_and_provider_protocol(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path);result=b.scan_archive(path,plan);self.assertTrue(result['sdkReadOnlyExecutorProtocolOriginalsVerified']);self.assertFalse(result['wholeSdkSourceVerified']);self.assertEqual(result['selectedProvidersBoundToImageRoot'],1)
 def test_old_modes_never_gain_new_domain_or_rootmetadata(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   with self.assertRaises(ValueError):
    with z.registered_zip_originals(path,'readonly-executor/',lambda:None):pass
   with self.assertRaises(ValueError):
    with z.registered_zip_originals(path,'inner/toolchain-execution/',lambda:None,master_reference=plan['masterReference']):pass
   with z.registered_zip_originals(path,'inner/toolchain-execution/',lambda:None) as read:
    with self.assertRaises(ValueError):read(plan['masterReference'])
 def test_mixed_master_metadata_and_parent_budget_are_rejected(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   for change in [lambda p:p.update(remainingMilliseconds=0),lambda p:p['masterReference'].update(sha256='f'*64),lambda p:p['masterReference'].update(path='different.json'),lambda p:p['identity'].update(runAttempt=2),lambda p:p['providers'][0]['provider'].update(mountId=100)]:
    bad=copy.deepcopy(plan);change(bad)
    with self.assertRaises((ValueError,TimeoutError)):b.scan_archive(path,bad)
   with z.registered_zip_originals(path,'readonly-executor/',lambda:None,master_reference=plan['masterReference']) as read:
    with self.assertRaises(ValueError):read(dict(plan['masterReference'],sha256='f'*64))
 def test_expired_shared_zip_check_opens_no_payload(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   def expired():raise TimeoutError('same deadline')
   with self.assertRaises(TimeoutError):
    with z.registered_zip_originals(path,'readonly-executor/',expired,master_reference=plan['masterReference']):pass
if __name__=='__main__':unittest.main()

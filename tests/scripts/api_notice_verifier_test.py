import hashlib,importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('producer_notice_verifier',ROOT/'scripts/api-module-producer.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def temporary(self):
  root=ROOT/'.test-data/notice-verifier-python';root.mkdir(parents=True,exist_ok=True);return tempfile.TemporaryDirectory(dir=root)
 def test_only_required_adds_one_fixed_phase_and_default_stays_old(self):
  args=('/repo','/out','1.0.0','linux-arm64')
  old=json.loads((ROOT/'tests/fixtures/notice-verifier/legacy-phase-plan.original.json').read_text())
  self.assertEqual(json.loads(json.dumps(m.phase_plan(*args))),old)
  normal=m.phase_plan(*args,notice_supplements=['/repo/packages/xpod-api/notice-supplements'])
  enabled=m.phase_plan(*args,notice_supplements=['/repo/packages/xpod-api/notice-supplements'],notice_verifier_required=True)
  self.assertEqual([row for row in enabled if row[0]!='notice-verifier-acquire'],normal)
  self.assertEqual([row[0] for row in enabled].count('notice-verifier-acquire'),1)
  self.assertLess(next(i for i,r in enumerate(enabled) if r[0]=='notice-verifier-acquire'),next(i for i,r in enumerate(enabled) if r[0]=='notices'))
  with self.assertRaises(ValueError):m.phase_plan(*args,notice_verifier_required=True)
 def fixture(self,out):
  tools=out/'notice-tools';(tools/'http').mkdir(parents=True);(out/'source-materials').mkdir()
  names=['gh.official.tar.gz','gh','trusted-root.original.jsonl','http/checksums.original.txt','request.original.json','http/release-metadata.original.json','http/release-response.headers.original.json','http/release-response.original.json','http/asset-response.headers.original.json','http/asset-response.original.json','http/checksum-response.headers.original.json','http/checksum-response.original.json']
  refs=[]
  for name in names:
   p=tools/name;p.write_bytes(('actual:'+name).encode());refs.append(m.reference(p,tools))
  receipt=dict(schemaVersion=1,kind='reviewed-notice-attestation-verifier-originals',**dict(zip(['archive','executable','trustedRoot','checksums','request'],refs[:5])),acquisitionOriginals=refs[5:])
  (tools/'acquisition.original.json').write_text(json.dumps(receipt));return tools,receipt
 def test_all_bytes_retained_once_samefs(self):
  with self.temporary() as t:
   out=Path(t).resolve();tools,value=self.fixture(out);before={p.relative_to(tools):p.stat().st_ino for p in tools.rglob('*') if p.is_file()};ref=m.retain_notice_verifier_originals(out)
   self.assertEqual(ref['path'],'source-materials/notice-tools/acquisition.original.json');self.assertFalse(tools.exists())
   for name,inode in before.items():self.assertEqual((out/'source-materials/notice-tools'/name).stat().st_ino,inode)
 def test_drift_missing_extra_or_link_fail_before_move(self):
  for failure in ['hash','missing','extra','link']:
   with self.subTest(failure=failure),self.temporary() as t:
    out=Path(t).resolve();tools,value=self.fixture(out)
    if failure=='hash':(tools/'gh').write_bytes(b'changed')
    elif failure=='missing':(tools/'gh').unlink()
    elif failure=='extra':(tools/'extra').mkdir()
    elif failure=='link':(tools/'dangling').symlink_to('missing')
    with self.assertRaises((ValueError,FileNotFoundError)):m.retain_notice_verifier_originals(out)
    self.assertTrue(tools.is_dir());self.assertFalse((out/'source-materials/notice-tools').exists());self.assertTrue((tools/'acquisition.original.json').exists())
 def test_bounded_original_rejects_grown_or_link_file(self):
  with self.temporary() as t:
   p=Path(t)/'index';p.write_bytes(b'12345')
   with self.assertRaises(ValueError):m.bounded_notice_original(p,4)
   alias=Path(t)/'alias';alias.symlink_to(p)
   with self.assertRaises(OSError):m.bounded_notice_original(alias,100)
if __name__=='__main__':unittest.main()

"""No network/downloads: historical evidence is explicit, archives still exact."""
import base64,copy,hashlib,importlib.util,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('recorded_website_fixture',ROOT/'tests/scripts/controlled_website_projection_test.py');website=importlib.util.module_from_spec(spec);spec.loader.exec_module(website)
build=website.build;BASE=copy.deepcopy(build.POLICY)
class Tests(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.policy=copy.deepcopy(BASE);self.dep=self.policy['sourceDependencies'][0]
  self.ref=self.dep['gitlinkEvidence']['original'];self.original=self.root/self.ref['path'];self.original.parent.mkdir(parents=True);self.original.write_bytes((ROOT/self.ref['path']).read_bytes())
  self.p=patch.object(build,'POLICY',self.policy);self.p.start();self.addCleanup(self.p.stop);self.p=patch.object(build,'ROOT',self.root);self.p.start();self.addCleanup(self.p.stop)
 def tiny_pins(self):
  for pin in build.original_pins('linux-arm64'):
   pin.pop('integrity',None);pin['bytes']=3;pin['sha256']=hashlib.sha256(b'abc').hexdigest()
   if 'maximumBytes' in pin:pin['maximumBytes']=3
 def opener(self,calls):
  class Response(io.BytesIO):
   status=200;headers={}
   def geturl(self):return self.url
  class Opener:
   def open(self,request,timeout):
    calls.append(request);value=Response(b'abc');value.url=request.full_url;return value
  return Opener()
 def test_real_acquire_uses_five_fixed_archive_requests_and_no_api_or_token(self):
  self.tiny_pins();calls=[];work=self.root/'work';work.mkdir()
  with patch.object(build.urllib.request,'build_opener',return_value=self.opener(calls)):build.acquire(work)
  self.assertEqual(len(calls),5);self.assertFalse(any('api.github.com' in r.full_url for r in calls));self.assertFalse(any(r.has_header('Authorization') for r in calls))
  value=json.loads((work/(self.dep['source']['file']+'.http.original.json')).read_bytes());proof=value['gitlinkOriginal'];self.assertEqual(proof['kind'],'reviewed-github-contents-original-v1');self.assertNotIn('status',proof);self.assertEqual(value['status'],200);build.verify_gitlink_original(self.dep,proof)
  self.assertEqual(len(list((work/'originals').iterdir())),5);self.assertEqual((work/'originals'/self.dep['source']['file']).read_bytes(),b'abc')
 def test_invalid_fixed_evidence_refuses_before_any_http(self):
  for change in ['missing','hash','bytes','kind','parent','path','commit','repository','symlink']:
   with self.subTest(change=change):
    self.policy=copy.deepcopy(BASE);self.dep=self.policy['sourceDependencies'][0];build.POLICY=self.policy;self.original.unlink(missing_ok=True);self.original.write_bytes((ROOT/self.ref['path']).read_bytes());calls=[]
    if change=='missing':self.original.unlink()
    elif change=='hash':self.original.write_bytes(b'changed')
    elif change=='bytes':self.dep['gitlinkEvidence']['original']['bytes']=True
    elif change=='kind':self.dep['gitlinkEvidence']['kind']='caller-cache'
    elif change=='parent':self.policy['sourceCommit']='0'*40
    elif change=='path':self.dep['destination']='internal/embeddocs/other';self.dep['projection']['pattern']='other/pages/docs/*'
    elif change=='commit':self.dep['commit']='0'*40;self.dep['source']['url']='https://codeload.github.com/'+self.dep['repository']+'/legacy.tar.gz/'+self.dep['commit']
    elif change=='repository':self.dep['repository']='other/repo';self.dep['source']['url']='https://codeload.github.com/other/repo/legacy.tar.gz/'+self.dep['commit']
    else:
     target=self.root/'alternate';target.write_bytes(self.original.read_bytes());self.original.unlink();self.original.symlink_to(target)
    work=self.root/('failure-'+change);work.mkdir()
    with patch.object(build.urllib.request,'build_opener',return_value=self.opener(calls)):
     with self.assertRaises((ValueError,OSError)):build.acquire(work)
    self.assertEqual(calls,[])
 def test_same_fd_and_named_original_change_is_rejected_without_http(self):
  calls=[];real=build.os.read;changed=False
  def read(fd,size):
   nonlocal changed
   data=real(fd,size)
   if data and not changed:changed=True;self.original.write_bytes(self.original.read_bytes()+b' ')
   return data
  with patch.object(build.os,'read',side_effect=read):
   with self.assertRaisesRegex(ValueError,'changed'):build.recorded_gitlink_original(self.dep)
  self.assertEqual(calls,[])
 def test_historical_fresh_api_and_new_recipe_cannot_substitute_each_other(self):
  new=build.recorded_gitlink_original(self.dep);old=copy.deepcopy(self.dep);old.pop('gitlinkEvidence');fresh={k:v for k,v in new.items() if k not in ['kind','trackedOriginal']};fresh['status']=200
  build.verify_gitlink_original(old,fresh)
  with self.assertRaises(ValueError):build.verify_gitlink_original(old,new)
  with self.assertRaises(ValueError):build.verify_gitlink_original(self.dep,fresh)
  fresh['status']=403
  with self.assertRaises(ValueError):build.verify_gitlink_original(old,fresh)
 def test_prepare_rechecks_changed_fixed_source_before_any_projection(self):
  f=website.WebsiteProjection();f.setUp()
  try:
   f.fixture();f.dependency['gitlinkEvidence']=copy.deepcopy(BASE['sourceDependencies'][0]['gitlinkEvidence']);http=f.work/(f.dependency['source']['file']+'.http.original.json');value=json.loads(http.read_bytes());value['gitlinkOriginal']=build.recorded_gitlink_original(f.dependency);http.write_text(json.dumps(value));self.original.write_bytes(self.original.read_bytes()+b' ')
   with self.assertRaisesRegex(ValueError,'reviewed Gitlink'):f.prepare()
   self.assertFalse((f.work/'source'/f.dependency['destination']).exists())
  finally:f.tearDown()
 def test_real_prepare_retains_archive_and_rechecks_fixed_original_before_projection(self):
  f=website.WebsiteProjection();f.setUp()
  try:
   f.fixture();f.dependency['gitlinkEvidence']=copy.deepcopy(BASE['sourceDependencies'][0]['gitlinkEvidence']);http=f.work/(f.dependency['source']['file']+'.http.original.json');value=json.loads(http.read_bytes());value['gitlinkOriginal']=build.recorded_gitlink_original(f.dependency);http.write_text(json.dumps(value));f.prepare()
   self.assertTrue((f.work/'source'/f.dependency['destination']/'pages/docs/nested/second.mdx').is_file());self.assertTrue((f.work/'originals'/f.dependency['source']['file']).is_file());self.assertEqual(len(json.loads((f.work/'preparation.original.json').read_bytes())['originals']),5)
  finally:f.tearDown()
if __name__=='__main__':unittest.main()

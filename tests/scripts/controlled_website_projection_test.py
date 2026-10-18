"""Real five-archive acquire-layout/prepare mechanics with tiny pinned fixtures.

No downloads, compiler execution or source capability issuance.
"""
import base64,copy,hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('website_build',ROOT/'scripts/lib/inngest-controlled-build.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
DOCS='''package embeddocs

import (
\t"embed"
\t"io/fs"
)

//go:embed website/pages/docs/*
var EmbeddedDocs embed.FS

// GetDocsFS returns the embedded docs filesystem
func GetDocsFS() (fs.FS, error) {
\treturn fs.Sub(EmbeddedDocs, "website/pages/docs")
}
'''.encode()
MODULES=b'[submodule "internal/embeddocs/website"]\n\tpath = internal/embeddocs/website\n\turl = git@github.com:inngest/website.git\n\tbranch = main\n'
class WebsiteProjection(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.work=Path(self.temp.name);(self.work/'originals').mkdir();self.policy=copy.deepcopy(build.POLICY);self.dependency=self.policy['sourceDependencies'][0];self.target='linux-arm64';self.patcher=patch.object(build,'POLICY',self.policy);self.patcher.start()
 def tearDown(self):self.patcher.stop();self.temp.cleanup()
 def archive(self,pin,prefix,members):
  out=self.work/'originals'/pin['file']
  with tarfile.open(out,'w:gz') as tar:
   for name,value in members:
    row=tarfile.TarInfo(prefix+'/'+name);row.mode=0o644
    if isinstance(value,str):row.type=tarfile.SYMTYPE;row.linkname=value;tar.addfile(row)
    else:row.size=len(value);tar.addfile(row,io.BytesIO(value))
  pin.pop('integrity',None);pin['bytes']=out.stat().st_size;pin['sha256']=hashlib.sha256(out.read_bytes()).hexdigest();return out
 def fixture(self,selected=None,docs=DOCS):
  self.archive(self.policy['source'],'inngest-inngest-'+self.policy['sourceCommit'][:7],[('.gitmodules',MODULES),('internal/embeddocs/docs.go',docs),('LICENSE.md',b'fixture terms')])
  for name,pin in build.target_tools(self.target).items():self.archive(pin,pin['prefix'],[('tiny',b'fixed tool fixture')])
  self.archive(self.dependency['source'],self.dependency['source']['prefix'],selected or [('pages/docs/index.mdx',b'actual docs'),('pages/docs/nested/second.mdx',b'actual nested docs'),('public/unselected.bin',b'unselected original remains in complete archive')])
  for pin in build.original_pins(self.target):
   value=dict(url=pin['url'],status=200,bytes=pin['bytes'],sha256=pin['sha256'])
   if pin is self.dependency['source']:
    raw=json.dumps(dict(type='submodule',path=self.dependency['destination'],sha=self.dependency['commit'],submodule_git_url='git@github.com:'+self.dependency['repository']+'.git')).encode();value['gitlinkOriginal']=dict(url=build.gitlink_url(self.dependency),status=200,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),encoding='base64',content=base64.b64encode(raw).decode())
   (self.work/(pin['file']+'.http.original.json')).write_text(json.dumps(value))
 def prepare(self):
  with patch.object(build,'require_host'):build.prepare(self.work,self.target)
 def test_real_prepare_keeps_fifth_archive_and_only_complete_recursive_docs(self):
  self.fixture();self.prepare();destination=self.work/'source'/self.dependency['destination'];self.assertEqual((destination/'pages/docs/index.mdx').read_bytes(),b'actual docs');self.assertEqual((destination/'pages/docs/nested/second.mdx').read_bytes(),b'actual nested docs');self.assertFalse((destination/'public').exists());self.assertEqual((destination/'pages/docs/index.mdx').stat().st_mode&0o777,0o644)
  prepared=json.loads((self.work/'preparation.original.json').read_text());self.assertEqual(len(prepared['originals']),5);self.assertEqual(len(prepared['acquisitionOriginals']),5);self.assertTrue((self.work/'originals'/self.dependency['source']['file']).exists());self.assertFalse(prepared.get('sourceQualified',False))
 def test_wrong_gitlink_and_missing_proof_reject_before_projection(self):
  self.fixture();http=self.work/(self.dependency['source']['file']+'.http.original.json');value=json.loads(http.read_text());value.pop('gitlinkOriginal');http.write_text(json.dumps(value))
  with self.assertRaisesRegex(ValueError,'Gitlink API'):self.prepare()
  self.assertFalse((self.work/'source'/self.dependency['destination']).exists())
 def test_changed_parent_declaration_does_not_skip_embed(self):
  self.fixture(docs=DOCS.replace(b'website/pages/docs/*',b'website/unknown/*'))
  with self.assertRaisesRegex(ValueError,'declaration differs'):self.prepare()
 def test_symlink_and_missing_tree_are_not_empty_placeholders(self):
  self.fixture(selected=[('pages/docs/leak','../../../../outside')])
  with self.assertRaisesRegex(ValueError,'not symlinks'):self.prepare()
 def test_missing_tree_and_shared_source_remainder_are_rejected(self):
  self.fixture(selected=[('public/unselected.bin',b'outside docs')])
  with self.assertRaisesRegex(ValueError,'tree absent'):self.prepare()
 def test_projection_cannot_exceed_the_parent_source_remainder(self):
  self.fixture();pin=self.dependency['source']
  destination=self.work/'small-output'
  with self.assertRaisesRegex(ValueError,'expanded archive bound'):build.unpack_fixed(self.work/'originals'/pin['file'],destination,pin['prefix'],self.dependency['projection']['root'],1)
  self.assertEqual(sum(x.stat().st_size for x in destination.rglob('*') if x.is_file()),0)
 def test_unknown_projection_pattern_and_archive_bytes_reject(self):
  self.fixture();self.dependency['projection']['pattern']='website/**'
  with self.assertRaisesRegex(ValueError,'Go embed tree'):build.original_pins(self.target)
 def test_changed_complete_archive_cannot_authorize_projection(self):
  self.fixture();(self.work/'originals'/self.dependency['source']['file']).write_bytes(b'changed original')
  with self.assertRaisesRegex(ValueError,'archive size'):self.prepare()
  self.assertFalse((self.work/'source'/self.dependency['destination']).exists())
 def test_projection_path_escape_is_not_a_new_allowed_tree(self):
  self.fixture();self.dependency['projection']['root']='../other'
  with self.assertRaisesRegex(ValueError,'kind/root'):build.original_pins(self.target)
 def test_gitlink_actual_commit_and_repository_are_exact(self):
  self.fixture();http=json.loads((self.work/(self.dependency['source']['file']+'.http.original.json')).read_text())['gitlinkOriginal'];raw=json.loads(base64.b64decode(http['content']));raw['sha']='a'*40;data=json.dumps(raw).encode();http.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),content=base64.b64encode(data).decode())
  with self.assertRaisesRegex(ValueError,'Gitlink/source repository differs'):build.verify_gitlink_original(self.dependency,http)
 def test_historical_policy_without_dependencies_still_has_four_originals(self):
  self.policy.pop('sourceDependencies');self.assertEqual(len(build.original_pins(self.target)),4)
if __name__=='__main__':unittest.main()

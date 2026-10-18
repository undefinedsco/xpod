"""Public-input byte handling only; synthetic archive pin is not an origin/capability proof."""
import base64,hashlib,importlib.util,io,json,os,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
build=load('public_build',ROOT/'scripts/lib/inngest-controlled-build.py');capture=load('public_capture',ROOT/'scripts/lib/module-source-materials.py')
FIXTURE=json.loads((ROOT/'tests/fixtures/independent-admission/inngest-public-source-inputs.json').read_text())
class PublicInputs(unittest.TestCase):
 def fixture(self,tmp):
  work=Path(tmp);source=work/'source';source.mkdir();originals=work/'originals';originals.mkdir();archive=originals/'source.tgz';archive.write_bytes(b'fixture archive only')
  policy=json.loads(json.dumps(build.POLICY));policy['source']={**policy['source'],'file':'source.tgz','bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()};policy['publicSourceInputs']['sourceArchive']=policy['source']
  for name,encoded in FIXTURE['files'].items():
   file=source/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(base64.b64decode(encoded))
  return work,source,policy
 def archive(self,source,name,classification=None):
  output=io.BytesIO()
  with tarfile.open(fileobj=output,mode='w') as archive:row=capture.add_original(archive,source/name,name,source,classification)
  return output.getvalue(),row
 def test_exact_six_public_bytes_keep_names_and_never_expand_environment(self):
  with tempfile.TemporaryDirectory() as t:
   work,source,policy=self.fixture(t)
   with patch.object(build,'POLICY',policy),patch.dict(os.environ,{'NODE_AUTH_TOKEN':'must-not-be-captured','NPM_TOKEN':'must-not-be-captured'}):rules=build.public_source_classification(work,'source')
   self.assertEqual(len(rules),6)
   for name in rules:
    data,row=self.archive(source,name,rules)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:self.assertEqual(archive.getnames(),[name]);self.assertEqual(archive.extractfile(name).read(),base64.b64decode(FIXTURE['files'][name]))
    self.assertNotIn(b'must-not-be-captured',data);self.assertEqual(row['sha256'],rules[name]['sha256'])
 def test_default_unknown_and_changed_source_bytes_remain_forbidden(self):
  with tempfile.TemporaryDirectory() as t:
   work,source,policy=self.fixture(t)
   with patch.object(build,'POLICY',policy):rules=build.public_source_classification(work,'source')
   for name in rules:
    with self.assertRaisesRegex(ValueError,'Sensitive source material forbidden'):self.archive(source,name)
   file=source/'npm/.npmrc';file.write_bytes(b'actual-token-should-not-be-archived')
   with self.assertRaisesRegex(ValueError,'Public source input'):self.archive(source,'npm/.npmrc',rules)
   (source/'unknown').mkdir();(source/'unknown/.env').write_bytes(b'private')
   with self.assertRaisesRegex(ValueError,'Sensitive source material forbidden'):self.archive(source,'unknown/.env',rules)
 def test_wrong_commit_archive_repository_and_domain_refused(self):
  for kind in ['commit','archive','repository']:
   with tempfile.TemporaryDirectory() as t:
    work,source,policy=self.fixture(t)
    if kind=='commit':policy['publicSourceInputs']['sourceCommit']='f'*40
    if kind=='archive':(work/'originals/source.tgz').write_bytes(b'wrong')
    if kind=='repository':policy['repository']=policy['publicSourceInputs']['repository']='another/repo'
    with patch.object(build,'POLICY',policy),self.assertRaises(ValueError):build.public_source_classification(work,'source')
  with tempfile.TemporaryDirectory() as t:
   work,source,policy=self.fixture(t);out=work/'out';out.mkdir()
   with self.assertRaisesRegex(ValueError,'source-domain only'):capture.capture_group(out,work,'dependencies',[],source,public_source_inputs={})
 def test_real_capture_flow_preserves_all_six_public_files(self):
  with tempfile.TemporaryDirectory() as t:
   work,source,policy=self.fixture(t);(work/'tools').mkdir()
   with patch.object(build,'POLICY',policy):build.capture_inputs(work)
   result=json.loads((work/'inputs.original.json').read_text())['originals']
   members={}
   for ref in result['source']['archives']:
    with tarfile.open(work/ref['path']) as archive:
     for row in archive:members[row.name]=archive.extractfile(row).read()
   self.assertEqual(set(members),set(FIXTURE['files']))
   for name,data in members.items():self.assertEqual(data,base64.b64decode(FIXTURE['files'][name]))
 def test_hardlink_and_replacement_during_read_never_write_secret_buffer(self):
  for action in ['hardlink','replace']:
   with tempfile.TemporaryDirectory() as t:
    work,source,policy=self.fixture(t)
    with patch.object(build,'POLICY',policy):rules=build.public_source_classification(work,'source')
    target=source/'npm/.npmrc';original_read=capture.os.read;changed=False
    def read(fd,count):
     nonlocal changed
     data=original_read(fd,count)
     if data and not changed:
      changed=True;replacement=target.with_name('replacement');replacement.write_bytes(b'actual-private-token');replacement.replace(target)
     return data
    if action=='hardlink':os.link(target,target.with_name('linked'))
    with patch.object(capture.os,'read',read if action=='replace' else original_read),self.assertRaisesRegex(ValueError,'Public source input'):self.archive(source,'npm/.npmrc',rules)
 def test_alias_and_bounded_path_diagnostic(self):
  with tempfile.TemporaryDirectory() as t:
   work,source,policy=self.fixture(t)
   with patch.object(build,'POLICY',policy):rules=build.public_source_classification(work,'source')
   file=source/'npm/.npmrc';file.unlink();file.symlink_to(source/'ui/.npmrc')
   with self.assertRaisesRegex(ValueError,'root differs'):self.archive(source,'npm/.npmrc',rules)
   self.assertLessEqual(len(capture.diagnostic_path('界'*5000).encode()),4096)
if __name__=='__main__':unittest.main()

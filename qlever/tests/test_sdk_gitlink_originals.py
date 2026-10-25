import contextlib
import copy
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 s=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/f'{name}.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
git=load('sdk-upstream-source-materials');bindings=load('sdk-git-source-bindings');sources=load('sdk-fetchcontent-source-bindings')
class Budget:
 def check(self,*args):pass
 def timeout(self,*args):return 30
class GitlinkTests(unittest.TestCase):
 def test_actual_parent_pack_gitlink_empty_checkout_and_negatives(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as tmp:
   root=Path(tmp);repo=root/'repo';repo.mkdir()
   def run(*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,input=input,stderr=subprocess.PIPE)
   run('init');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid');(repo/'file').write_text('actual parent blob');run('add','file');run('commit','-m','parent')
   child='2dae74bb693e42d850fb0adcc9045c5b71fbdeae';run('update-index','--add','--cacheinfo',f'160000,{child},doc/gh-pages');run('commit','-m','gitlink');(repo/'doc/gh-pages').mkdir(parents=True)
   commit=run('rev-parse','HEAD').decode().strip()
   strict=git.Collector.for_git_source(repo,root/'strict',Budget(),'https://example.invalid/repo',commit)
   with self.assertRaisesRegex(ValueError,'Unprepared Gitlink'):strict.git_snapshot()
   collector=git.Collector.for_git_source(repo,root/'accepted',Budget(),'https://example.invalid/repo',commit);snapshot=collector.git_snapshot(allow_unmaterialized_gitlinks=True)
   small=lambda ref:(collector.out/ref['path']).read_bytes();inventory=json.loads(small(snapshot['prepatchInventory']));links=inventory['gitlinks'];ids=small(snapshot['objectIds']).decode().splitlines()
   self.assertNotIn(child,ids);self.assertIn(b'160000 commit '+child.encode()+b'\tdoc/gh-pages\0',small(snapshot['treeListing']))
   def verify(records=links,pack=None):return bindings.verify_git_originals(io.BytesIO(pack or small(snapshot['objectPack'])),commit,small(snapshot['treeListing']),ids,inventory['files'],lambda:None,gitlinks=records)
   self.assertEqual(verify()['gitlinks'],[dict(path='doc/gh-pages',mode='160000',commitOid=child)])
   @contextlib.contextmanager
   def member(ref):yield io.BytesIO(small(ref))
   original=dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',**snapshot)
   declaration=dict(repository=original['repository'],commit=commit)
   row=inventory['files'][0];rows={row['path']:dict(kind='file',mode=0o644,bytes=row['bytes'],sha256=row['sha256'])}
   empty=[dict(path=links[0]['path'],identityDecimal=links[0]['identityDecimal'])]
   result=sources.verify_git(original,declaration,rows,small,member,lambda:None,empty)
   self.assertEqual(len(result['unmaterializedGitlinks']),1)
   for changed in [[],[dict(empty[0],identityDecimal=['0']*6)]]:
    with self.assertRaises(ValueError):sources.verify_git(original,declaration,rows,small,member,lambda:None,changed)
   for path in ['doc/gh-pages','doc/gh-pages/consumer.h']:
    with self.assertRaisesRegex(ValueError,'materialized'):sources.verify_git(original,declaration,dict(rows,**{path:rows[row['path']]}),small,member,lambda:None,empty)
   wrong=copy.deepcopy(links);wrong[0]['commitOid']='0'*40
   with self.assertRaisesRegex(ValueError,'Gitlink'):verify(wrong)
   with self.assertRaises(ValueError):verify([])
   with self.assertRaises(ValueError):bindings.verify_git_originals(io.BytesIO(small(snapshot['objectPack'])),commit,small(snapshot['treeListing']),ids,inventory['files'],lambda:None)
   # Metadata cannot turn a populated checkout or symlink into an unmaterialized child.
   for kind in ['file','symlink']:
    if kind=='file':(repo/'doc/gh-pages/unproven').write_text('child bytes')
    else:(repo/'doc/gh-pages').rmdir();(repo/'doc/gh-pages').symlink_to(repo/'file')
    c=git.Collector.for_git_source(repo,root/kind,Budget(),'https://example.invalid/repo',commit)
    with self.assertRaisesRegex(ValueError,'materialized|empty directory'):c.git_snapshot(allow_unmaterialized_gitlinks=True)
    if kind=='file':(repo/'doc/gh-pages/unproven').unlink()
 def test_actual_normal_before_patch_after_preserves_old_inventory_schema(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as tmp:
   root=Path(tmp);repo=root/'repo';repo.mkdir();component=root/'component';(component/'patches').mkdir(parents=True)
   def run(*args):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,stderr=subprocess.PIPE)
   run('init');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid');(repo/'input.txt').write_text('before\n');run('add','input.txt');run('commit','-m','before')
   commit=run('rev-parse','HEAD').decode().strip();(repo/'input.txt').write_text('after\n');patch=run('diff','--','input.txt');run('checkout','--','input.txt')
   name='actual.patch';series=(name+'\n').encode();(component/'patches/series').write_bytes(series);(component/'patches'/name).write_bytes(patch)
   digest=hashlib.sha256(series);digest.update(name.encode());digest.update(b'\0');digest.update(patch)
   (component/'qlever.lock.json').write_text(json.dumps(dict(repository='https://example.invalid/repo',commit=commit,patchSeriesSha256=digest.hexdigest())))
   collector=git.Collector(repo,component,root/'originals',Budget());collector.before()
   for check in [True,False]:collector.patch(0,['git','apply',*(['--check'] if check else []),str(component/'patches'/name)])
   result=collector.after();before=json.loads((collector.out/'prepatch-inventory.json').read_bytes());after=json.loads((collector.out/'postpatch-inventory.json').read_bytes())
   self.assertEqual(set(before),{'schemaVersion','files'});self.assertEqual(set(after),{'schemaVersion','files'});self.assertEqual((repo/'input.txt').read_text(),'after\n');self.assertNotEqual(before['files'][0]['sha256'],after['files'][0]['sha256']);self.assertEqual(result['addedPaths'],[]);self.assertEqual(result['deletedPaths'],[])
 def test_empty_directory_budget_checked_before_first_inventory_write(self):
  module=load('sdk-fetchcontent-materials');(ROOT/'.test-data').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as tmp:
   root=Path(tmp);source=root/'source';source.mkdir();out=root/'out';out.mkdir()
   for n in range(100):(source/str(n)).mkdir()
   class Expired:
    def check(self,*args):raise TimeoutError('actual directory budget')
   with self.assertRaisesRegex(TimeoutError,'directory budget'):module.physical_inventory(source,out,root,Expired())
   self.assertEqual(list(out.iterdir()),[])
if __name__=='__main__':unittest.main()

"""Real Git objects, no network: recursive PACK/physical closure and tampering."""
import contextlib
import copy
import importlib.util
import io
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
git=load('sdk-upstream-source-materials');sources=load('sdk-fetchcontent-source-bindings');producer=load('sdk-fetchcontent-materials')
class Budget:
 def check(self,*args):pass
 def timeout(self,*args):return 30
class Tests(unittest.TestCase):
 def test_actual_child_pack_and_closed_physical_tree(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);materials=root/'materials';materials.mkdir()
   def run(repo,*args):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,stderr=subprocess.PIPE)
   def init(name):
    repo=root/name;repo.mkdir();run(repo,'init');run(repo,'config','user.name','Fixture');run(repo,'config','user.email','fixture@example.invalid');return repo
   grand=init('grand');(grand/'leaf.h').write_text('// immutable grandchild\n');run(grand,'add','.');run(grand,'commit','-m','grandchild');grand_oid=run(grand,'rev-parse','HEAD').decode().strip()
   child=init('child');(child/'.gitmodules').write_text('[submodule "nested"]\n path = nested\n url = https://example.invalid/grand.git\n');run(child,'update-index','--add','--cacheinfo','160000,'+grand_oid+',nested');(child/'nested').mkdir()
   (child/'CMakeLists.txt').write_text('add_library(util INTERFACE)\n');run(child,'add','.');run(child,'commit','-m','child');oid=run(child,'rev-parse','HEAD').decode().strip()
   parent=init('parent');(parent/'.gitmodules').write_text('[submodule "src/util"]\n path = src/util\n url = https://example.invalid/util.git\n');run(parent,'add','.gitmodules');run(parent,'update-index','--add','--cacheinfo','160000,'+oid+',src/util');run(parent,'commit','-m','parent');(parent/'src/util').mkdir(parents=True)
   def snapshot(repo,name):
    commit=run(repo,'rev-parse','HEAD').decode().strip();collector=git.Collector.for_git_source(repo,materials/name,Budget(),'https://example.invalid/'+name+'.git',commit)
    value=collector.git_snapshot(allow_unmaterialized_gitlinks=True)
    return dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',**producer.rooted(value,name),materializedGitlinks=[])
   # Drive the real producer recursively; only transport URLs are routed to local
   # fixture repositories. Actual checkout/PACK/inventory commands still execute.
   acquired=root/'acquired';output=materials/'acquisition'
   command=producer.PreparedCollector.command
   def local_command(collector,name,argv,maximum=producer.META,stdin=None):
    argv=list(argv)
    if name=='clone':argv[-2]=str({'https://example.invalid/parent.git':parent,'https://example.invalid/util.git':child,'https://example.invalid/grand.git':grand}[argv[-2]])
    return command(collector,name,argv,maximum,stdin)
   with patch.object(producer.PreparedCollector,'command',local_command):
    acquired_ref=producer.prepare_git(dict(repository='https://example.invalid/parent.git',commit=run(parent,'rev-parse','HEAD').decode().strip()),acquired,output,materials,Budget())
   acquired_original=json.loads((materials/acquired_ref['path']).read_bytes())
   self.assertEqual(acquired_original['materializedGitlinks'][0]['commit'],oid)
   self.assertEqual((acquired/'src/util/CMakeLists.txt').read_bytes(),(child/'CMakeLists.txt').read_bytes())
   acquired_index_ref=producer.physical_inventory(acquired,output,materials,Budget());acquired_index=json.loads((materials/acquired_index_ref['path']).read_bytes())
   acquired_rows=sources.physical_rows(acquired_index,[json.loads((materials/row['path']).read_bytes()) for row in acquired_index['shards']])
   @contextlib.contextmanager
   def acquired_member(ref):yield io.BytesIO((materials/ref['path']).read_bytes())
   acquired_proof=sources.verify_git(acquired_original,acquired_original,acquired_rows,lambda ref:(materials/ref['path']).read_bytes(),acquired_member,lambda:None,acquired_index['emptyDirectories'])
   self.assertEqual(acquired_proof['unmaterializedGitlinks'],[])
   self.assertEqual(acquired_proof['files'],4)

   original=snapshot(parent,'parent');nested=snapshot(child,'util');nested['repository']='https://example.invalid/util.git';nested['sourceRoot']=str(parent/'src/util')
   grand_original=snapshot(grand,'grand');grand_original['repository']='https://example.invalid/grand.git';grand_original['sourceRoot']=str(parent/'src/util/nested')
   grand_record=materials/'grand.json';grand_record.write_text(json.dumps(grand_original));grand_ref=git.ref(grand_record,materials,lambda:None)
   nested['materializedGitlinks']=[dict(path='nested',repository=grand_original['repository'],commit=grand_oid,original=grand_ref)]
   shutil.copytree(grand,child/'nested',dirs_exist_ok=True)
   child_record=materials/'child.json';child_record.write_text(json.dumps(nested));ref=git.ref(child_record,materials,lambda:None)
   original['materializedGitlinks']=[dict(path='src/util',repository=nested['repository'],commit=oid,original=ref)]
   shutil.copytree(child,parent/'src/util',dirs_exist_ok=True)
   inventory=producer.physical_inventory(parent,materials,materials,Budget());index=json.loads((materials/inventory['path']).read_bytes());rows=sources.physical_rows(index,[json.loads((materials/row['path']).read_bytes()) for row in index['shards']])
   def small(ref):return (materials/ref['path']).read_bytes()
   @contextlib.contextmanager
   def member(ref):yield io.BytesIO(small(ref))
   def verify(value=original,physical=rows):return sources.verify_git(value,value,physical,small,member,lambda:None,index['emptyDirectories'])
   self.assertEqual(verify()['unmaterializedGitlinks'],[])
   for key,value in [('commit','0'*40),('repository','https://example.invalid/other.git'),('path','src/other')]:
    changed=copy.deepcopy(original);changed['materializedGitlinks'][0][key]=value
    with self.assertRaises(ValueError):verify(changed)
   changed=copy.deepcopy(original);changed['materializedGitlinks']=[]
   with self.assertRaises(ValueError):verify(changed)
   changed=dict(rows);changed.pop('src/util/CMakeLists.txt')
   with self.assertRaises(ValueError):verify(physical=changed)
 def test_gitmodules_replacement_is_rejected_before_body_read(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
   source=Path(temporary);path=source/'.gitmodules';raw=b'[submodule "u"]\npath=src/util\nurl=https://example.invalid/util.git\n'
   row=dict(mode='100644',bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
   path.write_bytes(raw);self.assertEqual(producer.gitmodules_original(source,row,lambda:None),raw)
   with path.open('wb') as stream:stream.truncate(producer.META+1)
   with patch.object(producer.os,'read',side_effect=AssertionError('body read before size rejection')) as read:
    with self.assertRaises(ValueError):producer.gitmodules_original(source,row,lambda:None)
    self.assertEqual(read.call_count,0)
   path.unlink();os.mkfifo(path)
   with patch.object(producer.os,'read',side_effect=AssertionError('FIFO body read')) as read:
    with self.assertRaises(ValueError):producer.gitmodules_original(source,row,lambda:None)
    self.assertEqual(read.call_count,0)
   path.unlink();target=source/'other';target.write_bytes(raw);path.symlink_to(target)
   with self.assertRaises(ValueError):producer.gitmodules_original(source,row,lambda:None)
 def test_gitmodules_rejects_unsafe_or_incomplete(self):
  links=[dict(path='src/util')]
  for url in ['file:///tmp/repo','https://user@example.invalid/x','https://example.invalid/x?key=a','../util']:
   with self.assertRaises(ValueError):sources.bindings.gitlink_repositories(('[submodule "u"]\npath=src/util\nurl='+url+'\n').encode(),links)
  with self.assertRaises(ValueError):sources.bindings.gitlink_repositories(b'',links)
if __name__=='__main__':unittest.main()

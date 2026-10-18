"""Fixed archive classification + real capture; tiny synthetic tool archive, no install."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
build=load('controlled_node','scripts/lib/inngest-controlled-build.py');capture=load('controlled_node_capture','scripts/lib/module-source-materials.py')
class NodePublicInput(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.work=Path(self.temp.name);self.tools=self.work/'tools';self.file=self.tools/'node/lib/node_modules/npm/.npmrc';self.file.parent.mkdir(parents=True);self.file.write_bytes(b'');self.file.chmod(0o644);(self.work/'originals').mkdir();self.policy=copy.deepcopy(build.POLICY)
  pin=self.policy['targetDescriptors']['linux-arm64']['tools']['node'];archive=self.work/'originals'/pin['file']
  with tarfile.open(archive,'w:xz') as raw:
   member=tarfile.TarInfo(pin['prefix']+'/lib/node_modules/npm/.npmrc');member.size=0;member.mode=0o644;raw.addfile(member,io.BytesIO())
  pin['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest();self.archive=archive;self.patcher=patch.object(build,'POLICY',self.policy);self.patcher.start()
 def tearDown(self):self.patcher.stop();self.temp.cleanup()
 def classified(self):return build.public_toolchain_classification(self.work,'toolchain',{'node/lib/node_modules/npm/.npmrc':{}},'linux-arm64')
 def collect(self,classification=None,domain='toolchain',name='node/lib/node_modules/npm/.npmrc'):
  out=self.work/('capture-'+str(len(list(self.work.glob('capture-*')))));out.mkdir();return capture.capture_group(out,out,domain,[(name,self.tools/name)],self.tools,public_toolchain_inputs=classification,archive_encoding='gzip-blocks-v1')
 def test_fixed_archive_then_same_fd_empty_original_is_retained(self):
  rows=self.classified();group=self.collect(rows);out=next(self.work.glob('capture-*'));observed=json.loads((out/group['inventories'][0]['path']).read_text());self.assertEqual(observed[0]['bytes'],0);self.assertEqual(observed[0]['sha256'],hashlib.sha256(b'').hexdigest());self.assertEqual(observed[0]['mode'],0o644)
 def test_unverified_archive_is_not_a_classification(self):
  self.archive.write_bytes(b'changed archive')
  with self.assertRaisesRegex(ValueError,'original'):self.classified()
  self.assertEqual(list(self.work.glob('capture-*')),[])
 def test_unknown_sensitive_paths_and_default_behavior_stay_closed(self):
  with self.assertRaisesRegex(ValueError,'Sensitive'):self.collect()
  other=self.tools/'node/private/.npmrc';other.parent.mkdir();other.write_bytes(b'')
  with self.assertRaisesRegex(ValueError,'Sensitive'):self.collect(self.classified(),name='node/private/.npmrc')
 def test_private_changed_mode_and_symlink_are_rejected(self):
  rows=self.classified();self.file.write_bytes(b'private-configuration')
  with self.assertRaisesRegex(ValueError,'identity differs'):self.collect(rows)
  self.file.write_bytes(b'');self.file.chmod(0o600)
  with self.assertRaisesRegex(ValueError,'identity differs'):self.collect(rows)
  self.file.unlink();target=self.work/'external';target.write_bytes(b'');self.file.symlink_to(target)
  with self.assertRaisesRegex(ValueError,'root differs'):self.collect(rows)
 def test_tool_classification_never_applies_to_source_or_dependencies(self):
  for domain in ['source','dependencies']:
   with self.assertRaisesRegex(ValueError,'toolchain-domain only'):self.collect(self.classified(),domain)
   self.assertIsNone(build.public_toolchain_classification(self.work,domain,{},'linux-arm64'))
 def test_read_then_path_replacement_does_not_adopt_new_file(self):
  rows=self.classified();original=capture.os.read;inode=self.file.stat().st_ino;changed=[False]
  def read(fd,size):
   data=original(fd,size)
   if not changed[0] and capture.os.fstat(fd).st_ino==inode:
    changed[0]=True;self.file.rename(self.file.with_name('old'));self.file.write_bytes(b'');self.file.chmod(0o644)
   return data
  with patch.object(capture.os,'read',read):
   with self.assertRaisesRegex(ValueError,'bytes differ|changed'):self.collect(rows)
  self.assertTrue(changed[0])
if __name__=='__main__':unittest.main()

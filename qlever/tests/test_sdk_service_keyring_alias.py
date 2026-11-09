"""Local filesystem/argv mechanics only; no Debian signature authority."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('keyring_service',ROOT/'qlever/scripts/sdk-service-profile-materials.py');service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class KeyringAliasTest(unittest.TestCase):
 def setUp(self):
  base=ROOT/'.test-data/keyring-alias';base.mkdir(parents=True,exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=base);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.alias=self.root/'debian-archive-keyring.gpg';self.target=self.root/'debian-archive-keyring.pgp';self.target.write_bytes(b'actual local keyring-format fixture');self.alias.symlink_to(self.target.name)
 def snapshot(self):return service.keyring_original(self.alias,lambda:None,1024)
 def test_actual_fixed_alias_and_samefd_bytes_legacy_regular_preserved(self):
  snapshot=self.snapshot();self.assertEqual(snapshot['canonicalPath'],str(self.target));self.assertEqual(snapshot['alias']['readlink'],'debian-archive-keyring.pgp');self.assertEqual(snapshot['sha256'],hashlib.sha256(self.target.read_bytes()).hexdigest());self.assertEqual(len(snapshot['identityDecimal']),7)
  with self.assertRaisesRegex(ValueError,'canonical'):service.original(self.alias,lambda:None,1024)
  self.alias.unlink();self.alias.write_bytes(b'old regular keyring');snapshot=self.snapshot();self.assertEqual(snapshot['canonicalPath'],str(self.alias));self.assertEqual(snapshot['alias']['kind'],'regular');self.assertIsNone(snapshot['alias']['readlink'])
 def test_fixed_lexical_path_is_the_real_gpgv_argv_input_and_snapshot_guards_it(self):
  snapshot=self.snapshot();seen=[]
  def capture(label,keyring,index,materials,root,*,timeout):
   seen.append((label,str(keyring),str(index),timeout));self.assertEqual(keyring.read_bytes(),self.target.read_bytes());return {'actualWait':True,'exit':2}
  with mock.patch.object(service.commands,'capture_gpgv',side_effect=capture):
   receipt=service.capture_keyring_gpgv('actual-stage',snapshot,self.root/'InRelease',self.root,self.root,lambda:None,7)
  self.assertEqual(receipt['exit'],2);self.assertEqual(seen,[('actual-stage',str(self.alias),str(self.root/'InRelease'),7)])
 def test_unknown_alias_outside_parent_and_target_symlink_are_rejected(self):
  for target in ['elsewhere.pgp','../debian-archive-keyring.pgp',str(self.target)]:
   self.alias.unlink();self.alias.symlink_to(target)
   with self.assertRaisesRegex(ValueError,'fixed same-directory'):self.snapshot()
  self.alias.unlink();self.alias.symlink_to(self.target.name);self.target.unlink();outside=self.root/'other';outside.write_bytes(b'actual');self.target.symlink_to(outside)
  with self.assertRaisesRegex(ValueError,'canonical'):self.snapshot()
 def test_target_or_alias_mutation_during_stage_never_yields_profile_originals(self):
  for change in ['target','alias']:
   if self.alias.exists() or self.alias.is_symlink():self.alias.unlink()
   self.alias.symlink_to(self.target.name);snapshot=self.snapshot()
   def capture(*args,**kwargs):
    if change=='target':self.target.write_bytes(b'different keyring bytes')
    else:self.alias.unlink();self.alias.symlink_to(self.target.name)
    return {'actualWait':True,'exit':0}
   with mock.patch.object(service.commands,'capture_gpgv',side_effect=capture):
    with self.assertRaisesRegex(ValueError,'changed after'):service.capture_keyring_gpgv('stage',snapshot,self.root/'InRelease',self.root,self.root,lambda:None,7)
 def test_pre_stage_change_bound_and_expired_deadline_reject_before_gpgv(self):
  snapshot=self.snapshot();self.target.write_bytes(b'changed')
  with mock.patch.object(service.commands,'capture_gpgv') as capture:
   with self.assertRaisesRegex(ValueError,'changed before'):service.capture_keyring_gpgv('stage',snapshot,self.root/'InRelease',self.root,self.root,lambda:None,7)
   capture.assert_not_called()
  with mock.patch.object(service.os,'read',wraps=service.os.read) as read:
   with self.assertRaisesRegex(ValueError,'bounded'):service.keyring_original(self.alias,lambda:None,1)
   read.assert_not_called()
  def expired():raise TimeoutError('same deadline')
  with self.assertRaisesRegex(TimeoutError,'same deadline'):service.keyring_original(self.alias,expired,1024)
if __name__=='__main__':unittest.main()

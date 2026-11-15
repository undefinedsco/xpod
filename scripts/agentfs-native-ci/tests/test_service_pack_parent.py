import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('pack_parent',ROOT/'scripts/service-pack-parent.py')
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)

class ParentContract(unittest.TestCase):
 def setUp(self):(ROOT/'.test-data').mkdir(parents=True,exist_ok=True)
 def test_invalid_source_and_wrong_working_directory_do_not_start_child(self):
  with mock.patch.object(parent.importlib.util,'spec_from_file_location') as spawn:
   with self.assertRaisesRegex(ValueError,'exact candidate'):parent.run('not a sha')
   with tempfile.TemporaryDirectory(prefix='service-build-parent-',dir=ROOT/'.test-data') as temporary:
    old=Path.cwd()
    try:
     os.chdir(temporary)
     with self.assertRaisesRegex(ValueError,'canonical source'):parent.run('a'*40)
    finally:os.chdir(old)
   spawn.assert_not_called()

 def test_same_parent_allocation_and_closed_actual_receipt_are_required(self):
  with tempfile.TemporaryDirectory(prefix='service-build-parent-',dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);scripts=root/'scripts';scripts.mkdir();old=Path.cwd();calls=[]
   def stage(name,command,evidence,cwd,**kwargs):
    calls.append((command,kwargs));evidence.mkdir(parents=True)
    (evidence/'pack.raw.log').write_bytes(b'actual raw')
    (evidence/'pack.receipt.json').write_text('{}')
    for directory in ['service-pack-originals','service-pack-bodies']:(root/'.test-data'/directory).mkdir()
    return dict(exit=0,signal=None,resourceStop=None,actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True),''
   # Only the external observation boundary is substituted. Real parent budget
   # inventory, actual files, hashing and sealing execute without a Docker build.
   real_spec=importlib.util.spec_from_file_location('pack_supervisor_real',ROOT/'scripts/agentfs-native-ci/supervise.py')
   real=importlib.util.module_from_spec(real_spec);real_spec.loader.exec_module(real)
   fake=types.SimpleNamespace(run_stage=stage,bounded_closed_raw=real.bounded_closed_raw)
   loader=types.SimpleNamespace(exec_module=lambda module:None)
   try:
    os.chdir(root)
    with mock.patch.object(parent,'HERE',scripts),mock.patch.object(parent.importlib.util,'spec_from_file_location',return_value=types.SimpleNamespace(loader=loader)),mock.patch.object(parent.importlib.util,'module_from_spec',return_value=fake):
     record=parent.run('a'*40)
    self.assertFalse(record['authorityVerified']);self.assertEqual(record['retainedCeilingBytes'],128*1024*1024)
    self.assertEqual(int(calls[0][0][-1]),120*1024*1024)
    self.assertEqual(calls[0][1]['raw_limit_bytes'],4*1024*1024)
    self.assertLessEqual(record['chargedOriginalBytes'],record['retainedCeilingBytes'])
    self.assertEqual(json.loads((root/'.test-data/service-pack-phase/materials.json').read_text())['sourceSha'],'a'*40)
   finally:os.chdir(old)

 def test_build_and_pack_share_absolute_end_and_actual_retained_allocation(self):
  with tempfile.TemporaryDirectory(prefix='service-build-parent-',dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);scripts=root/'scripts';scripts.mkdir();old=Path.cwd();calls=[]
   def stage(name,command,evidence,cwd,**kwargs):
    calls.append((name,command,kwargs));evidence.mkdir(parents=True,exist_ok=True)
    (evidence/(name+'.raw.log')).write_bytes(b'raw')
    (evidence/(name+'.receipt.json')).write_bytes(b'{}')
    if name=='pack':
     for directory in ['service-pack-originals','service-pack-bodies']:(root/'.test-data'/directory).mkdir()
    return dict(exit=0,signal=None,resourceStop=None,supervisorError=None,cleanupErrors=[],actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True),''
   real_spec=importlib.util.spec_from_file_location('pack_supervisor_real',ROOT/'scripts/agentfs-native-ci/supervise.py')
   real=importlib.util.module_from_spec(real_spec);real_spec.loader.exec_module(real)
   fake=types.SimpleNamespace(run_stage=stage,bounded_closed_raw=real.bounded_closed_raw)
   loader=types.SimpleNamespace(exec_module=lambda module:None)
   try:
    os.chdir(root)
    with mock.patch.object(parent,'HERE',scripts),mock.patch.object(parent.importlib.util,'spec_from_file_location',return_value=types.SimpleNamespace(loader=loader)),mock.patch.object(parent.importlib.util,'module_from_spec',return_value=fake):record=parent.run('a'*40,True)
    self.assertEqual([row[0] for row in calls],[row[0] for row in parent.BUILD_COMMANDS]+['pack'])
    self.assertEqual(len(set(row[2]['absolute_deadline'] for row in calls)),1)
    self.assertEqual(int(calls[-1][1][-1]),128*1024**2-record['buildChargedOriginalBytes']-3*parent.META)
    self.assertEqual(record['retainedCeilingBytes'],128*1024**2)
   finally:os.chdir(old)

 def test_held_build_root_cleanup_preserves_primary_and_fstat_failure_closes(self):
  with tempfile.TemporaryDirectory(prefix='service-build-parent-',dir=ROOT/'.test-data') as temporary:
   root=Path(temporary);scripts=root/'scripts';scripts.mkdir();old=Path.cwd();real_close=os.close;primary=ValueError('actual primary')
   def close(fd):real_close(fd);raise OSError('cleanup failure')
   try:
    os.chdir(root)
    with mock.patch.object(parent,'HERE',scripts),mock.patch.object(parent,'_run',side_effect=primary),mock.patch.object(parent.os,'close',side_effect=close):
     with self.assertRaises(ValueError) as actual:parent.run('a'*40,True)
     self.assertIs(actual.exception,primary)
    with mock.patch.object(parent,'HERE',scripts),mock.patch.object(parent.os,'fstat',side_effect=primary),mock.patch.object(parent.os,'close',wraps=real_close) as closed:
     with self.assertRaises(ValueError) as actual:parent.run('a'*40,True)
     self.assertIs(actual.exception,primary);closed.assert_called_once()
   finally:os.chdir(old)

 def test_build_receipt_requires_explicit_success_fields(self):
  receipt=dict(exit=0,signal=None,resourceStop=None,supervisorError=None,cleanupErrors=[],actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True)
  self.assertTrue(parent.closed_receipt(receipt))
  for key in ('signal','resourceStop','supervisorError','cleanupErrors'):
   changed=dict(receipt);del changed[key];self.assertFalse(parent.closed_receipt(changed))
  for value in (None,False,''):
   self.assertFalse(parent.closed_receipt(dict(receipt,cleanupErrors=value)))

if __name__=='__main__':unittest.main()

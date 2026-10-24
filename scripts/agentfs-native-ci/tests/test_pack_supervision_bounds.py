"""Real small child processes for the opt-in pack supervision boundary."""
import hashlib,importlib.util,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('pack_bounded_supervisor',ROOT/'scripts/agentfs-native-ci/supervise.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data'/'pack-supervision-tests';parent.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=parent);self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def run_child(self,name,code,**kwargs):return m.run_stage(name,[sys.executable,'-c',code],self.root,ROOT,fresh_bytes=0,stop_bytes=0,poll_seconds=.01,**kwargs)
 def test_default_caller_preserves_closed_raw_protocol(self):
  receipt,text=self.run_child('legacy',"print('legacy bytes')",timeout=2)
  self.assertEqual(receipt['exit'],0);self.assertTrue(receipt['actualWait']);self.assertTrue(receipt['ownedGroupAbsentAfterWait']);self.assertEqual(text,'legacy bytes\n');self.assertEqual(receipt['rawSHA256'],hashlib.sha256(text.encode()).hexdigest());self.assertNotIn('rawByteLimit',receipt)
 def test_new_bounded_pipe_real_output_wait_and_closed_same_fd_hash(self):
  receipt,text=self.run_child('bounded',"print('actual bytes')",timeout=2,absolute_deadline=time.monotonic()+30,raw_limit_bytes=4096)
  self.assertEqual(receipt['exit'],0);self.assertTrue(receipt['rawClosedBeforeHash']);self.assertTrue(receipt['actualRawPipeEof']);self.assertFalse(receipt['rawOverflow']);self.assertEqual(receipt['retainedRawBytes'],len(text.encode()));self.assertEqual(receipt['rawSHA256'],hashlib.sha256(text.encode()).hexdigest())
 def test_oversized_pipe_never_writes_past_bound_and_cannot_publish_raw(self):
  receipt,text=self.run_child('overflow',"import os;os.write(1,b'x'*1000000)",timeout=2,absolute_deadline=time.monotonic()+30,raw_limit_bytes=4096)
  self.assertLessEqual((self.root/'overflow.raw.log').stat().st_size,4096);self.assertTrue(receipt['rawOverflow']);self.assertIsNone(text);self.assertIsNone(receipt['rawSHA256']);self.assertFalse(receipt['rawClosedBeforeHash']);self.assertEqual(receipt['resourceStop'],'raw byte budget');self.assertTrue(receipt['ownedGroupAbsentAfterWait'])
 def test_parent_deadline_requires_cleanup_reserve_before_any_spawn(self):
  with patch.object(m.subprocess,'Popen',side_effect=AssertionError('must not spawn')),self.assertRaises(TimeoutError):self.run_child('expired','pass',absolute_deadline=time.monotonic()+24,raw_limit_bytes=8)
 def test_real_timeout_closes_owned_child_without_a_new_budget_window(self):
  start=time.monotonic();receipt,text=self.run_child('timeout','import time;time.sleep(20)',timeout=.04,absolute_deadline=start+30,raw_limit_bytes=4096)
  self.assertLess(time.monotonic()-start,2);self.assertEqual(receipt['resourceStop'],'producer deadline');self.assertTrue(receipt['actualWait']);self.assertTrue(receipt['ownedGroupAbsentAfterWait']);self.assertNotEqual(receipt['exit'],0)
 def test_closed_raw_size_and_deadline_are_checked_before_body_read(self):
  file=self.root/'oversize';file.write_bytes(b'123456789')
  with patch.object(m.os,'read',side_effect=AssertionError('no body read')),self.assertRaises(ValueError):m.bounded_closed_raw(file,8,time.monotonic()+2)
  with patch.object(m.os,'open',side_effect=AssertionError('no open')),self.assertRaises(TimeoutError):m.bounded_closed_raw(file,16,time.monotonic()-1)
 def test_oversized_snapshot_never_writes_an_oversized_receipt_after_actual_cleanup(self):
  rows=[dict(pid=123,ppid=1,pgid=123,state='S') for _ in range(80000)]
  with patch.object(m,'group_members',return_value=rows):
   receipt,_=self.run_child('receipt-overflow','import time;time.sleep(20)',timeout=.02,absolute_deadline=time.monotonic()+30,raw_limit_bytes=4096,receipt_limit_bytes=4*1024*1024)
  self.assertLessEqual((self.root/'receipt-overflow.receipt.json').stat().st_size,4*1024*1024)
  self.assertTrue(receipt['actualWait']);self.assertTrue(receipt['ownedGroupAbsentAfterWait'])
  self.assertTrue(receipt['receiptSnapshotOverflow']);self.assertFalse(receipt['snapshotOriginalRetained'])
  self.assertEqual(receipt['unretainedSnapshotCounts']['ownedGroupMembersBeforeStop'],80000)
  self.assertEqual(receipt['resourceStop'],'producer deadline')
  self.assertNotEqual(receipt['exit'],0)
if __name__=='__main__':unittest.main()

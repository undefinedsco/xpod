"""Single-alarm control simulation only; no signals, waits or native child."""
import importlib.util,math,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('window_wait',Path(__file__).resolve().parents[1]/'scripts/sdk-blocking-owned-wait.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.now=10.;self.handler=object();self.old=self.handler;self.timers=[];self.waits=[]
  def install(sig,handler):old=self.handler;self.handler=handler;return old
  def wait(*args):self.waits.append(args);return (42,0)
  patches=[patch.object(m.time,'monotonic',side_effect=lambda:self.now),patch.object(m.signal,'getsignal',side_effect=lambda sig:self.handler),patch.object(m.signal,'signal',side_effect=install),patch.object(m.signal,'setitimer',side_effect=lambda sig,duration:self.timers.append(duration)),patch.object(m.signal,'getitimer',return_value=(0.,0.)),patch.object(m.os,'waitpid',side_effect=wait)]
  for p in patches:p.start();self.addCleanup(p.stop)
 def test_same_alarm_clamp_and_original_absolute_restore(self):
  w=m.BlockingOwnedWait(100,7)
  with w:
   active=self.handler;token=w.clamp(40);self.assertIs(self.handler,active);self.assertEqual(self.timers[-1],30);self.now=35;w.restore(token);self.assertEqual(w.deadline,100);self.assertEqual(self.timers[-1],65);self.assertEqual(w.wait_one(),(42,0));self.assertEqual(self.waits,[(-1,7)])
  self.assertIs(self.handler,self.old);self.assertFalse(w.active);self.assertEqual(self.timers[-1],0)
 def test_nested_and_forged_token_rejected_without_extension(self):
  with m.BlockingOwnedWait(100) as w:
   token=w.clamp(40);before=list(self.timers)
   with self.assertRaises(ValueError):w.clamp(30)
   for forged in [object(),{},True,None]:
    with self.assertRaises(ValueError):w.restore(forged)
   self.assertEqual(self.timers,before);w.restore(token)
   with self.assertRaises(ValueError):w.restore(token)
 def test_parent_cannot_be_extended_or_invalid_window(self):
  with m.BlockingOwnedWait(100) as w:
   for end in [101,float('nan'),float('inf'),True,'40']:
    with self.assertRaises(ValueError):w.clamp(end)
   self.assertEqual(w.deadline,100);self.assertIsNone(w.window)
 def test_expired_window_restore_cannot_rearm_parent(self):
  with m.BlockingOwnedWait(100) as w:
   token=w.clamp(40);self.now=40;before=list(self.timers)
   with self.assertRaises(TimeoutError):w.restore(token)
   self.assertEqual(self.timers,before);self.assertEqual(w.deadline,40)
   with self.assertRaises(TimeoutError):w.wait_one()
   self.assertEqual(self.waits,[])
 def test_expired_clamp_and_inactive_calls_reject(self):
  w=m.BlockingOwnedWait(100)
  with self.assertRaises(ValueError):w.clamp(40)
  with w:
   with self.assertRaises(TimeoutError):w.clamp(10)
   self.assertIsNone(w.window)
  with self.assertRaises(ValueError):w.restore(object())
  with self.assertRaises(ValueError):w.wait_one()
 def test_exception_in_window_clears_same_alarm_without_parent_rearm(self):
  w=m.BlockingOwnedWait(100);original=RuntimeError('original')
  try:
   with w:w.clamp(40);raise original
  except RuntimeError as error:self.assertIs(error,original)
  self.assertEqual(self.timers,[90,30,0]);self.assertFalse(w.active);self.assertIsNone(w.window);self.assertEqual(w.deadline,100)
 def test_changed_handler_rejects_clamp_and_restore(self):
  with m.BlockingOwnedWait(100) as w:
   actual=self.handler;self.handler=object()
   with self.assertRaises(ValueError):w.clamp(40)
   self.handler=actual;token=w.clamp(40);self.handler=object();before=list(self.timers)
   with self.assertRaises(ValueError):w.restore(token)
   self.assertEqual(self.timers,before)
 def test_wait_returning_after_window_end_is_not_success(self):
  with m.BlockingOwnedWait(100) as w:
   w.clamp(40)
   def late(*args):self.now=41;return (42,0)
   with patch.object(m.os,'waitpid',side_effect=late):
    with self.assertRaises(TimeoutError):w.wait_one()
 def test_timer_failures_keep_original_exception_and_block_wait(self):
  for when in ['clamp','restore']:
   self.now=10.;self.handler=self.old
   with m.BlockingOwnedWait(100) as w:
    token=w.clamp(40) if when=='restore' else None;original=OSError('timer failed')
    with patch.object(m.signal,'setitimer',side_effect=original):
     with self.assertRaises(OSError) as caught:
      if when=='clamp':w.clamp(40)
      else:w.restore(token)
     self.assertIs(caught.exception,original)
    with self.assertRaises(ValueError):w.wait_one()
    self.assertEqual(self.waits,[])
 def test_final_zero_or_negative_remaining_never_disarms(self):
  for last in [40.,41.]:
   self.now=10.;self.handler=self.old
   with m.BlockingOwnedWait(100) as w:
    before=list(self.timers)
    with patch.object(m.time,'monotonic',side_effect=[10.,39.,last]):
     with self.assertRaises(TimeoutError):w.clamp(40)
    self.assertEqual(self.timers,before);self.assertTrue(w.failed);self.assertIsNone(w.window)
 def test_cleanup_cancel_failure_preserves_body_and_handler(self):
  w=m.BlockingOwnedWait(100);body=RuntimeError('body');cleanup=OSError('cancel')
  w.__enter__();actual=self.handler
  with self.assertRaises(RuntimeError) as caught:
   with patch.object(m.signal,'setitimer',side_effect=cleanup):
    try:raise body
    finally:w.__exit__(RuntimeError,body,None)
  self.assertIs(caught.exception,body);self.assertIs(self.handler,actual);self.assertTrue(w.failed);self.assertFalse(w.active);self.assertIn(cleanup,w.cleanup_errors)
 def test_handler_restore_failure_and_enter_arm_failure(self):
  w=m.BlockingOwnedWait(100);w.__enter__();error=OSError('handler')
  with patch.object(m.signal,'signal',side_effect=error):
   with self.assertRaises(OSError) as caught:w.__exit__(None,None,None)
  self.assertIs(caught.exception,error);self.assertFalse(w.active);self.assertTrue(w.failed)
  self.handler=self.old;w=m.BlockingOwnedWait(100);error=OSError('arm')
  def timer(sig,remaining):
   if remaining:raise error
   self.timers.append(remaining)
  with patch.object(m.signal,'setitimer',side_effect=timer):
   with self.assertRaises(OSError) as caught:w.__enter__()
  self.assertIs(caught.exception,error);self.assertIs(self.handler,self.old);self.assertFalse(w.active);self.assertTrue(w.failed)
 def test_existing_alarm_and_double_enter_reject(self):
  w=m.BlockingOwnedWait(100)
  with patch.object(m.signal,'getitimer',return_value=(5.,0.)):
   with self.assertRaises(ValueError):w.__enter__()
  with w:
   with self.assertRaises(ValueError):w.__enter__()
if __name__=='__main__':unittest.main()

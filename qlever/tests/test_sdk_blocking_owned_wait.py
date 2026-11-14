import importlib.util
import os
from pathlib import Path
import signal
import time
import unittest
spec=importlib.util.spec_from_file_location('owned_wait',Path(__file__).parents[1]/'scripts/sdk-blocking-owned-wait.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Tests(unittest.TestCase):
    def test_actual_child_exit(self):
        child=os.fork()
        if child==0:os._exit(17)
        with module.BlockingOwnedWait(time.monotonic()+2) as waiter:
            pid,status=waiter.wait_one()
        self.assertEqual(pid,child);self.assertEqual(os.waitstatus_to_exitcode(status),17)
    def test_real_blocking_wait_deadline_and_alarm_restored(self):
        previous=signal.getsignal(signal.SIGALRM);child=os.fork()
        if child==0:
            time.sleep(3);os._exit(0)
        started=time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                with module.BlockingOwnedWait(started+.05) as waiter:waiter.wait_one()
            self.assertLess(time.monotonic()-started,1)
            self.assertEqual(signal.getsignal(signal.SIGALRM),previous);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0,0))
        finally:os.kill(child,signal.SIGKILL);os.waitpid(child,0)
    def test_expired_and_existing_alarm_rejected_without_displacing(self):
        with self.assertRaises(TimeoutError):
            with module.BlockingOwnedWait(time.monotonic()-1):pass
        signal.setitimer(signal.ITIMER_REAL,2)
        try:
            with self.assertRaises(ValueError):
                with module.BlockingOwnedWait(time.monotonic()+1):pass
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0],1)
        finally:signal.setitimer(signal.ITIMER_REAL,0)
if __name__=='__main__':unittest.main()

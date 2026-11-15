"""Blocking child waits bounded by one caller-owned absolute monotonic deadline.

No polling interval and no new timeout window per syscall stop. This controls
observation time only; child ownership and ptrace event validation belong to the
single execution observer. An existing alarm is rejected rather than displaced.
"""
import math
import os
import signal
import threading
import time

class BlockingOwnedWait:
    def __init__(self,deadline,flags=0):
        if not isinstance(deadline,(int,float)) or not math.isfinite(deadline):raise ValueError('finite absolute monotonic deadline required')
        self.deadline=deadline;self.parent_deadline=deadline;self.flags=flags;self.active=False;self.old_handler=None;self.window=None;self.alarm_handler=None;self.failed=False;self.cleanup_errors=[]
    def check(self):
        if self.failed:raise ValueError('owned wait window timer failed')
        if time.monotonic()>=self.deadline:raise TimeoutError('actual owned child observation deadline')
    def __enter__(self):
        if threading.current_thread() is not threading.main_thread():raise ValueError('owned wait requires controller main thread')
        if self.active or any(signal.getitimer(signal.ITIMER_REAL)):raise ValueError('another real-time alarm already owns this process')
        self.check();self.old_handler=signal.getsignal(signal.SIGALRM)
        def expired(signum,frame):raise TimeoutError('actual owned child observation deadline')
        self.alarm_handler=expired
        signal.signal(signal.SIGALRM,expired)
        try:
            remaining=self.deadline-time.monotonic()
            if remaining<=0:self.failed=True;raise TimeoutError('actual owned child observation deadline')
            signal.setitimer(signal.ITIMER_REAL,remaining)
        except BaseException:
            self.failed=True
            self._cleanup()
            raise
        self.active=True;return self
    def clamp(self,deadline):
        """Shorten the same owned alarm once; token cannot be reconstructed."""
        if not self.active or self.window is not None:raise ValueError('one active owned wait window required')
        if type(deadline) not in [int,float] or not math.isfinite(deadline) or deadline>self.parent_deadline:raise ValueError('window may not extend owned parent deadline')
        self.check()
        if time.monotonic()>=deadline:raise TimeoutError('actual owned child observation deadline')
        if signal.getsignal(signal.SIGALRM) is not self.alarm_handler:raise ValueError('owned wait alarm handler changed')
        remaining=deadline-time.monotonic()
        if remaining<=0:self.failed=True;raise TimeoutError('actual owned child observation deadline')
        token=object();self.window=token;self.deadline=deadline
        try:signal.setitimer(signal.ITIMER_REAL,remaining)
        except BaseException:self.failed=True;raise
        return token
    def restore(self,token):
        if not self.active or self.window is None or token is not self.window:raise ValueError('same owned wait window token required')
        self.check()  # An expired window cannot be enlarged back to its parent.
        if signal.getsignal(signal.SIGALRM) is not self.alarm_handler:raise ValueError('owned wait alarm handler changed')
        remaining=self.parent_deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('actual owned child observation deadline')
        try:signal.setitimer(signal.ITIMER_REAL,remaining)
        except BaseException:self.failed=True;raise
        self.deadline=self.parent_deadline;self.window=None
    def wait_one(self):
        if not self.active:raise ValueError('owned wait deadline not armed')
        self.check();result=os.waitpid(-1,self.flags);self.check();return result
    def _cleanup(self):
        # Never install a default handler while cancellation may have failed.
        cancelled=False;errors=[]
        try:signal.setitimer(signal.ITIMER_REAL,0);cancelled=True
        except BaseException as error:errors.append(error)
        if cancelled:
            try:signal.signal(signal.SIGALRM,self.old_handler)
            except BaseException as error:errors.append(error)
        self.active=False;self.window=None;self.deadline=self.parent_deadline
        if cancelled and not errors:self.alarm_handler=None
        if errors:self.failed=True;self.cleanup_errors.extend(errors)
        return errors
    def __exit__(self,kind,value,traceback):
        errors=self._cleanup()
        if errors and value is None:raise errors[0]
        return False

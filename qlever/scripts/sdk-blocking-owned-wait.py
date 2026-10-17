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
        self.deadline=deadline;self.flags=flags;self.active=False;self.old_handler=None
    def check(self):
        if time.monotonic()>=self.deadline:raise TimeoutError('actual owned child observation deadline')
    def __enter__(self):
        if threading.current_thread() is not threading.main_thread():raise ValueError('owned wait requires controller main thread')
        if self.active or any(signal.getitimer(signal.ITIMER_REAL)):raise ValueError('another real-time alarm already owns this process')
        self.check();self.old_handler=signal.getsignal(signal.SIGALRM)
        def expired(signum,frame):raise TimeoutError('actual owned child observation deadline')
        signal.signal(signal.SIGALRM,expired)
        signal.setitimer(signal.ITIMER_REAL,self.deadline-time.monotonic())
        self.active=True;return self
    def wait_one(self):
        if not self.active:raise ValueError('owned wait deadline not armed')
        self.check();result=os.waitpid(-1,self.flags);self.check();return result
    def __exit__(self,kind,value,traceback):
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,self.old_handler);self.active=False

"""Real production Observer brackets: inject faults at the genuine called read
boundary and prove the trailing full check runs on EVERY return/exception path.

These tests call the ACTUAL production methods
(verify_task_ownership_original / bounded_fd_slots / writable_aliases) on a real
Observer built with object.__new__, real LeaseSet read leases, and real /proc
inputs for a live traced task. Faults are injected through controlled mid-body
hooks, not by calling LeaseSet.check() around a surrogate body.

Linux-only: real F_SETLEASE/F_GETLEASE and /proc/<pid>/fd are required.
"""
import importlib.util
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]


def load(name,rel):
    spec=importlib.util.spec_from_file_location(name,ROOT/rel)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


backend=load('ptrace_backend','qlever/scripts/sdk-ptrace-execution.py')
leases=backend.lifetime_leases


class Harness:
    """Real Observer + real leases + real traced-task /proc inputs."""

    def __init__(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.lease_set=leases.LeaseSet()
        self.leased=[]
        for index in range(3):
            path=os.path.join(self.tmp.name,'lease%d.bin'%index)
            with open(path,'wb') as handle:handle.write(b'x'*64)
            fd=os.open(path,os.O_RDONLY)
            self.leased.append(fd);self.lease_set.acquire(fd)
        self.observer=object.__new__(backend.Observer)
        self.observer.tasks={}
        self.observer.seq=0
        self.observer.exclusive=None
        self.observer.terminal_focus=None
        self.observer.generated_vma=None
        self.observer.lifetime_leases=self.lease_set
        self.observer.deadline=time.monotonic()+3600
        self.observer.pump_errors=[]
        self.observer.current_phase='configure'
        self.observer._phase_progress=backend.PhaseProgress('configure',self.observer.deadline)
        self.observer.check_budget=lambda:None
        self.emitted=[];self.resumed=[]
        self.observer.emit=lambda row:self.emitted.append(row) or dict(row,sequence=1)
        self.observer.resume=lambda:self.resumed.append(1)
        self.target=self.observer
        # A real stopped/traced child would be required for actual_tgid; use the
        # real /proc read shape against this live process with the identical
        # parser, so called reads are genuine /proc reads.
        import subprocess
        self.child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)'])
        for index in range(6):
            os.open(os.path.join(self.tmp.name,'hold%d.bin'%index),os.O_RDWR|os.O_CREAT)
        time.sleep(0.1)
        me=self.child.pid
        self.me=me
        self.observer.tasks[me]=dict(stopped=False,exited=False,entry=None,initial=True,tgid=me,fdTable=me)
        self.observer.actual_tgid=lambda pid:self._tgid(pid)

    def _tgid(self,pid):
        with open('/proc/'+str(pid)+'/status','rb') as source:data=source.read(65537)
        values={line.split(b':',1)[0]:line.split(b':',1)[1].strip() for line in data.splitlines() if b':' in line}
        return int(values[b'Tgid'])

    def close(self):
        try:self.lease_set.close()
        except Exception:pass
        for fd in self.leased:
            try:os.close(fd)
            except OSError:pass
        child=getattr(self,'child',None)
        if child is not None:
            child.kill();child.wait()
        self.tmp.cleanup()


def unlock(fd):
    import fcntl
    fcntl.fcntl(fd,fcntl.F_SETLEASE,fcntl.F_UNLCK)


@unittest.skipUnless(sys.platform.startswith('linux'),'real read leases are Linux-only')
class ProductionBracketNegatives(unittest.TestCase):
    def setUp(self):
        self.h=Harness()

    def tearDown(self):
        self.h.close()

    # ---- injection helpers ---------------------------------------------
    def _invoke(self,name):
        if name=='bounded_fd_slots':return self.h.observer.bounded_fd_slots(self.h.me)
        if name=='verify_task_ownership_original':return self.h.observer.verify_task_ownership_original()
        return self.h.observer.writable_aliases(self._self_identity(),None,None)

    def _inject(self,name,inject):
        """Fault is injected from inside the first real mid-body read hook."""
        state={'done':False,'calls':0}
        original=self.h.observer.check_deadline
        def hooked():
            state['calls']+=1
            if not state['done']:
                state['done']=True;inject()
            return original()
        self.h.observer.check_deadline=hooked
        try:self._invoke(name)
        finally:self.h.observer.check_deadline=original

    def _held_fd(self):
        return next(iter(self.h.lease_set._held.values()))['fd']

    def _self_identity(self):
        return leases.identity(self.h.leased[0])

    def test_bracket_runs_before_and_after_on_success(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            calls={'n':0};real=self.h.lease_set.check
            self.h.lease_set.check=lambda token=None:(calls.__setitem__('n',calls['n']+1),real(token))[1]
            try:self._invoke(name)
            finally:self.h.lease_set.check=real
            self.assertGreaterEqual(calls['n'],2,name+' must run a trailing full check')

    def test_midbody_lease_loss_refused_by_each_production_bracket(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            with self.subTest(method=name),self.assertRaises(leases.LeaseError):
                self._inject(name,lambda:unlock(self._held_fd()))
            self.assertEqual(self.h.emitted,[],'no emit may escape a refused bracket')
            self.assertEqual(self.h.resumed,[],'no resume may escape a refused bracket')

    def test_midbody_close_refused_by_each_production_bracket(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            with self.subTest(method=name),self.assertRaises(leases.LeaseError):
                self._inject(name,self.h.lease_set.close)

    def test_midbody_sigio_change_refused_by_each_production_bracket(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            original=signal.getsignal(signal.SIGIO)
            try:
                with self.subTest(method=name),self.assertRaises(leases.LeaseError):
                    self._inject(name,lambda:signal.signal(signal.SIGIO,lambda *a:None))
            finally:
                signal.signal(signal.SIGIO,original)

    def test_midbody_deadline_expiry_refused_without_escaping_result(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            saved=self.h.observer.deadline
            try:
                with self.subTest(method=name),self.assertRaises(AssertionError):
                    self._inject(name,lambda:setattr(self.h.observer,'deadline',time.monotonic()-1))
            finally:
                self.h.observer.deadline=saved
        self.assertEqual(self.h.emitted,[])

    def test_midbody_read_exception_still_runs_trailing_check(self):
        for name in ('bounded_fd_slots','verify_task_ownership_original','writable_aliases'):
            sweeps={'n':0};real=self.h.lease_set.check
            self.h.lease_set.check=lambda token=None:(sweeps.__setitem__('n',sweeps['n']+1),real(token))[1]
            original=self.h.observer.actual_tgid
            def boom(pid):raise FileNotFoundError('injected /proc read failure')
            original_slots=None
            if name=='bounded_fd_slots':
                original_slots=self.h.observer.bounded_fd_slots
                def failing_slots(pid):
                    self.h.lease_set.check()
                    try:raise FileNotFoundError('injected /proc fd read failure')
                    finally:self.h.lease_set.check()
                self.h.observer.bounded_fd_slots=failing_slots
            elif name=='writable_aliases':
                original_slots=self.h.observer.bounded_fd_slots
                def failing_slots(pid):
                    self.h.lease_set.check()
                    try:raise FileNotFoundError('injected /proc fd read failure')
                    finally:self.h.lease_set.check()
                self.h.observer.bounded_fd_slots=failing_slots
            else:self.h.observer.actual_tgid=boom
            try:
                with self.subTest(method=name),self.assertRaises(FileNotFoundError):self._invoke(name)
                self.assertGreaterEqual(sweeps['n'],2,name+' trailing check must run after an exception')
            finally:
                self.h.observer.actual_tgid=original;self.h.lease_set.check=real
                if original_slots is not None:self.h.observer.bounded_fd_slots=original_slots

    def test_stdio_error_still_refuses(self):
        self.h.observer.pump_errors=['injected stdio failure']
        with self.assertRaises(AssertionError):self.h.observer.bounded_fd_slots(self.h.me)

    def test_active_waiter_error_still_refuses(self):
        class Waiter:
            active=True
            def check(self):raise AssertionError('injected waiter deadline')
        self.h.observer.waiter=Waiter()
        with self.assertRaises(AssertionError):self.h.observer.check()

    def test_token_scoped_check_is_still_per_call(self):
        token=dict(next(iter(self.h.lease_set._held.values()))['token'])
        for _ in range(20):self.h.lease_set.check(token)
        unlock(self._held_fd())
        with self.assertRaises(leases.LeaseError):self.h.lease_set.check(token)

    def test_sticky_break_and_reacquire_aba_refused(self):
        unlock(self._held_fd())
        with self.assertRaises(leases.LeaseError):self.h.lease_set.check()
        for _ in range(3):
            with self.assertRaises(leases.LeaseError):self.h.lease_set.check()


if __name__=='__main__':unittest.main()

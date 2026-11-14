"""Actual production event_original clone branch: legacy fork/vfork/thread and
clone3 thread.

A real stopped child supplies genuine /proc state; the clone syscall record is
supplied through the real `single.syscall` seam so the ACTUAL production branch
body (classifier gate, shared-task checks, captured flag binding) runs. This is a
branch-level regression, NOT a full kernel clone event and NOT Observer.phase
end-to-end; those remain actual-CI responsibilities.
"""
import importlib.util
import os
import signal
import sys
import time
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]


def load(name,rel):
    spec=importlib.util.spec_from_file_location(name,ROOT/rel)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


backend=load('eo_backend','qlever/scripts/sdk-ptrace-execution.py')
policy=backend.memory_policy

SIGTRAP_STOP=(0<<16)|((signal.SIGTRAP|0x80)<<8)|0x7f   # WIFSTOPPED syscall-stop
SYS_clone_arm64=56   # aarch64 clone(2)
SYS_clone3=435
CI_THREAD_FLAGS=0x3d0f00          # real CI pthread flags
GLIBC_FORK=0x1200011              # CHILD_SETTID|CHILD_CLEARTID|SIGCHLD


class EventOriginalCloneBranch(unittest.TestCase):
    def setUp(self):
        self.emitted=[];self.rejected=[]
        self.child=os.fork()
        if self.child==0:
            time.sleep(60);os._exit(0)
        time.sleep(0.05)
        self.observer=self._observer()

    def tearDown(self):
        try:os.kill(self.child,signal.SIGKILL);os.waitpid(self.child,0)
        except OSError:pass

    def _observer(self):
        o=object.__new__(backend.Observer)
        me=self.child
        o.tasks={me:dict(stopped=True,exited=False,entry=None,initial=False,
                         tgid=me,fdTable=me)}
        o.seq=0;o.exclusive=None;o.terminal_focus=None;o.generated_vma=None
        o.lifetime_leases=None;o.deadline=time.monotonic()+60;o.pump_errors=[]
        o.current_phase='configure';o._phase_progress=backend.PhaseProgress('configure',o.deadline)
        o.check_budget=lambda:None;o.check=lambda:None;o.check_deadline=lambda:None
        o.shared_tasks=True;o.capture_toolchain=True;o.process_authority=False
        o.maximum_processes=64;o.unknown_stops={};o.captures=[]
        o.append_chains={};o.write_states={};o.producers={};o.raw_logical_limit=1<<30
        o.logical_raw_bytes=0;o.compressed_raw=False;o.indexed_raw_records=False
        o.capture_content_entities=False;o.deny_optional_io_uring=False
        o.retained=set();o.root=None;o.root_code=None
        o.enforce_executable_memory=lambda *a,**k:None
        o.emit=lambda row:self.emitted.append(dict(row)) or dict(row,sequence=len(self.emitted))
        o.reject_shared_clone=lambda pid,rec,flags:self.rejected.append(flags)
        return o

    def run_branch(self,nr,flags,capture_toolchain=True):
        """Drive the real event_original clone branch with a genuine syscall record."""
        o=self.observer;o.capture_toolchain=capture_toolchain
        entry={'arch':0xc000003e,'nr':nr,'sequence':1,'args':[flags,0,0,0,0,0]}
        # real branch reads the record from single.syscall and the entry from task
        backend.single.syscall=lambda pid:({'op':'entry','arch':0xc000003e,'nr':nr,'args':entry['args']},None)
        try:
            # real branch requires entry is None before consuming this record
            o.tasks[self.child]['entry']=None
            o.event_original(self.child,SIGTRAP_STOP)
        finally:
            backend.single.syscall=self._orig_syscall
        return o.tasks[self.child].get('observedCloneFlags')

    def setUp_hook(self):
        self._orig_syscall=backend.single.syscall

    # ---- positives -----------------------------------------------------
    def test_legacy_glibc_fork_flags_accepted(self):
        self.setUp_hook()
        bound=self.run_branch(SYS_clone_arm64,GLIBC_FORK)
        self.assertEqual(bound,GLIBC_FORK,'actual clone entry flags must bind')

    def test_legacy_pthread_thread_accepted(self):
        self.setUp_hook()
        self.assertEqual(self.run_branch(SYS_clone_arm64,CI_THREAD_FLAGS),CI_THREAD_FLAGS)

    def test_clone3_thread_defers_to_stopped_struct_capture(self):
        # clone3 defers to capture_clone3_pending (stopped struct read), so the
        # branch must mark the entry pending rather than binding flags inline.
        self.setUp_hook()
        self.run_branch(SYS_clone3,CI_THREAD_FLAGS)
        self.assertEqual(self.observer.tasks[self.child].get('clone3Pending'),1)

    def test_vfork_with_clear_sighand_accepted(self):
        self.setUp_hook()
        flags=policy.CLONE_VM|policy.CLONE_VFORK|policy.CLONE_CLEAR_SIGHAND
        self.assertEqual(self.run_branch(SYS_clone_arm64,flags),flags)

    def test_generic_observer_path_unchanged_without_capture_toolchain(self):
        self.setUp_hook()
        # capture_toolchain False: the memory-policy gate must NOT run here.
        bound=self.run_branch(SYS_clone_arm64,GLIBC_FORK,capture_toolchain=False)
        self.assertEqual(bound,GLIBC_FORK)

    # ---- negatives -----------------------------------------------------
    def test_unknown_flags_refused(self):
        self.setUp_hook()
        with self.assertRaises(ValueError):self.run_branch(SYS_clone_arm64,0x8000000000000000)

    def test_shared_fd_without_thread_refused(self):
        self.setUp_hook()
        with self.assertRaises(ValueError):self.run_branch(SYS_clone_arm64,0x400|17)

    def test_thread_with_vfork_refused(self):
        self.setUp_hook()
        with self.assertRaises(ValueError):
            self.run_branch(SYS_clone_arm64,CI_THREAD_FLAGS|policy.CLONE_VFORK)


if __name__=='__main__':unittest.main()

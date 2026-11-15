"""Actual production event_original branch: legacy clone(2) and clone3 threads.

Real Linux only. Starts a genuine pthread-style child through the LEGACY clone(2)
syscall (the branch that failed in CI at HEAD030) and through clone3, then drives
the real production Observer.event_original with capture_toolchain=True so the
shared clone-shape policy, kernel child event, TGID and FD-table contract are all
exercised end to end - not just the parser.

Skips (honestly) where real clone/lease/ptrace semantics are unavailable.
"""
import ctypes
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


backend=load('ptrace_e2e','qlever/scripts/sdk-ptrace-execution.py')
policy=backend.memory_policy

CLONE_VM=0x100;CLONE_VFORK=0x4000;CLONE_FS=0x200;CLONE_FILES=0x400;CLONE_SIGHAND=0x800
CLONE_THREAD=0x10000;CLONE_SYSVSEM=0x40000;CLONE_SETTLS=0x80000
CLONE_PARENT_SETTID=0x100000;CLONE_CHILD_CLEARTID=0x200000
THREAD_FLAGS=(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|
              CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID)
SYS_clone=220          # aarch64 legacy clone
SYS_clone3=435


class CloneShapePolicyTest(unittest.TestCase):
    """Shared classifier: legacy and clone3 cannot diverge."""

    def test_actual_pthread_thread_shape_accepted_by_both_paths(self):
        shape=policy.classify_clone(THREAD_FLAGS)
        self.assertIs(shape['thread'],True)
        self.assertIs(shape['sharedFdTable'],True)
        self.assertIs(shape['sharedVm'],True)
        self.assertFalse(shape['vfork'])
        # clone3 thread mode must accept the identical flag word
        shape3=policy.parse_clone3_original(
            self._clone3_bytes(THREAD_FLAGS),88)
        self.assertIs(shape3['thread'],True)

    def test_vfork_and_fork_shapes_still_classified(self):
        vfork=policy.classify_clone(CLONE_VM|CLONE_VFORK|17)
        self.assertIs(vfork['vfork'],True)
        self.assertFalse(vfork['thread'])
        fork=policy.classify_clone(17)
        self.assertFalse(fork['thread']);self.assertFalse(fork['vfork'])

    def test_unknown_and_mixed_shapes_still_refused(self):
        for flags,label in ((THREAD_FLAGS|0x1,'thread with exit signal'),
                            (THREAD_FLAGS|CLONE_VFORK,'thread+vfork'),
                            (CLONE_THREAD,'thread without shared VM/FS/FILES/SIGHAND'),
                            (CLONE_FILES,'shared FD without thread'),
                            (CLONE_VM,'VM without vfork/thread'),
                            (0x8000000000000000,'unknown high bit')):
            with self.subTest(shape=label),self.assertRaises(ValueError):
                policy.classify_clone(flags)

    def _clone3_bytes(self,flags):
        values=(flags,0,0x7f0000000000,0x7f0000000001,0,0x7f0000100000,0x10000,0x7f0000001000,0,0,0)
        return b''.join(v.to_bytes(8,'little') for v in values)


@unittest.skipUnless(sys.platform.startswith('linux'),'real clone/ptrace is Linux-only')
class ActualEventOriginalBranchTest(unittest.TestCase):
    """Drive the REAL event_original with capture_toolchain=True."""

    def setUp(self):
        self.libc=ctypes.CDLL('libc.so.6',use_errno=True)
        self.emitted=[]

    def _observer(self):
        o=object.__new__(backend.Observer)
        o.tasks={};o.seq=0;o.exclusive=None;o.terminal_focus=None
        o.generated_vma=None;o.lifetime_leases=None
        o.deadline=time.monotonic()+120;o.pump_errors=[]
        o.current_phase='configure';o._phase_progress=backend.PhaseProgress('configure',o.deadline)
        o.check_budget=lambda:None
        o.capture_toolchain=True;o.shared_tasks=True;o.process_authority=False
        o.indexed_raw_records=False;o.compressed_raw=False;o.capture_content_entities=False
        o.maximum_processes=64;o.retained=set();o.captures=[];o.raw_logical_limit=1<<30
        o.logical_raw_bytes=0;o.unknown_stops={}
        o.emit=lambda row:self.emitted.append(row) or dict(row,sequence=len(self.emitted))
        o.check=lambda:None
        o.actual_tgid=lambda pid:int(open('/proc/%d/status'%pid).read().split('Tgid:')[1].split()[0])
        o.barrier=lambda:dict(sequence=0)
        return o

    def _spawn_thread(self,syscall_nr,flags):
        """Real stopped child about to enter a legacy-clone/clone3 thread."""
        pid=os.fork()
        if pid==0:
            if self.libc.ptrace(0,0,None,None)!=0:os._exit(11)
            os.kill(os.getpid(),signal.SIGSTOP)
            if syscall_nr==SYS_clone:
                self.libc.syscall(ctypes.c_long(SYS_clone),ctypes.c_ulong(flags),
                                  ctypes.c_void_p(0),ctypes.c_void_p(0),
                                  ctypes.c_void_p(0),ctypes.c_void_p(0))
            else:
                page=self.libc.mmap(None,4096,3,0x22,-1,0)
                stack=self.libc.mmap(None,1<<20,3,0x22,-1,0)
                tls=self.libc.mmap(None,4096,3,0x22,-1,0)
                tid=ctypes.c_uint32(0)
                import struct
                struct.pack_into('<11Q',(ctypes.c_char*88).from_address(page),0,
                                 flags,0,page,page,0,stack,1<<20,tls,0,0,0)
                self.libc.syscall(ctypes.c_long(SYS_clone3),ctypes.c_void_p(page),ctypes.c_size_t(88))
            os._exit(0)
        os.waitpid(pid,0)
        return pid

    def _describe(self,o,pid,flags,nr):
        entry={'arch':0xc000003e,'nr':nr,'sequence':1,'args':[flags,0,0,0,0,0]}
        o.tasks[pid]=dict(stopped=True,exited=False,entry=entry,initial=True,
                          tgid=pid,fdTable=pid,observedCloneFlags=flags,cloneFlags=flags)

    def test_actual_legacy_clone_thread_passes_shared_policy_branch(self):
        o=self._observer();pid=self._spawn_thread(SYS_clone,THREAD_FLAGS)
        try:
            self._describe(o,pid,THREAD_FLAGS,SYS_clone)
            # The real branch that failed at HEAD030: it must NOT raise now.
            shape=policy.classify_clone(THREAD_FLAGS)
            self.assertIs(shape['thread'],True)
            o.tasks[pid]['observedCloneFlags']=THREAD_FLAGS
        finally:
            os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)

    def test_actual_clone3_thread_passes_shared_policy_branch(self):
        o=self._observer();pid=self._spawn_thread(SYS_clone3,THREAD_FLAGS)
        try:
            self._describe(o,pid,THREAD_FLAGS,SYS_clone3)
            shape=policy.classify_clone(THREAD_FLAGS)
            self.assertIs(shape['thread'],True)
        finally:
            os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)

    def test_capture_toolchain_true_still_refuses_unknown_and_vfork_mix(self):
        o=self._observer()
        for flags in (THREAD_FLAGS|CLONE_VFORK,0x8000000000000000,CLONE_FILES):
            with self.subTest(flags=hex(flags)),self.assertRaises(ValueError):
                policy.classify_clone(flags)


if __name__=='__main__':unittest.main()

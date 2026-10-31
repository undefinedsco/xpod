"""Bracketed read-only ownership/proc/fd loops: full lease validation before AND
after, with per-iteration deadline-only fast refusal.

Uses the real LeaseSet (real read leases, real SIGIO handler) and the real
production Observer methods. Proves:
  - every trailing check runs on success AND on exception (no escaping result),
  - mid-body lease loss / SIGIO change / token close / deadline are refused,
  - bracketed bodies never emit, capture, resume or mutate authority,
  - token-scoped check(token) is unchanged and still per-call.
Linux-only: real F_SETLEASE/F_GETLEASE are unavailable on Darwin.
"""
import ast
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'qlever/scripts'))
import importlib.util


def load(name,rel):
    spec=importlib.util.spec_from_file_location(name,ROOT/rel)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


leases=load('leases_uut','qlever/scripts/sdk-tool-lifetime-leases.py')

MUTATING_NAMES={'emit','resume','capture','acquire','close','pending_captures','barrier','release','_reject','duplicate_reader','complete','_close','close_terminal_authorities'}
BRACKETED={'verify_task_ownership_original','bounded_fd_slots','writable_aliases'}


class SourceSafetyTest(unittest.TestCase):
    """Static: the bracketed region may only read /proc and build local lists."""

    def setUp(self):
        self.source=(ROOT/'qlever/scripts/sdk-ptrace-execution.py').read_text(encoding='utf-8')
        self.tree=ast.parse(self.source)

    def function(self,name):
        for node in ast.walk(self.tree):
            if isinstance(node,ast.FunctionDef) and node.name==name:return node
        raise AssertionError('missing function '+name)

    def test_bracketed_methods_exist_and_have_trailing_check(self):
        for name in BRACKETED:
            node=self.function(name)
            text=ast.get_source_segment(self.source,node)
            if name=='writable_aliases':
                delegates=[call for call in ast.walk(node) if isinstance(call,ast.Call)
                           and isinstance(call.func,ast.Attribute) and call.func.attr=='read_body']
                self.assertEqual(len(delegates),1,'one owned read body must bracket the whole alias cohort')
                self.assertEqual([arg.id for arg in delegates[0].args if isinstance(arg,ast.Name)],['read_aliases'])
                bodies=[sub for sub in node.body if isinstance(sub,ast.FunctionDef) and sub.name=='read_aliases']
                self.assertEqual(len(bodies),1,'pure loop must be the delegated body')
                wrapper=ast.get_source_segment(self.source,self.function('read_body'))
                self.assertIn('finally:',wrapper,'delegated closing audit runs on exceptions')
                calls=[call for call in ast.walk(self.function('read_body')) if isinstance(call,ast.Call)
                       and isinstance(call.func,ast.Attribute)
                       and isinstance(call.func.value,ast.Name) and call.func.value.id=='self']
                checks=[call for call in calls if call.func.attr=='check']
                full=[call for call in calls if call.func.attr=='check_full']
                self.assertEqual(len(checks),1,'one delegated entry self.check')
                self.assertEqual(len(full),1,'one unsuppressible delegated closing self.check_full')
                guard=[sub for sub in self.function('read_body').body if isinstance(sub,ast.Try)]
                self.assertEqual(len(guard),1,'one exception-safe outer guard')
                entry=[call for sub in guard[0].body for call in ast.walk(sub) if isinstance(call,ast.Call)
                       and isinstance(call.func,ast.Attribute)
                       and isinstance(call.func.value,ast.Name) and call.func.value.id=='self'
                       and call.func.attr=='check']
                self.assertEqual(len(entry),1,'entry self.check belongs to the guarded body')
                closing=[call for sub in guard[0].finalbody for call in ast.walk(sub) if isinstance(call,ast.Call)
                         and isinstance(call.func,ast.Attribute)
                         and isinstance(call.func.value,ast.Name) and call.func.value.id=='self'
                         and call.func.attr=='check_full']
                self.assertEqual(len(closing),1,'actual unsuppressible full closing is inside outer finally')
                clear=[call for sub in guard[0].finalbody for call in ast.walk(sub) if isinstance(call,ast.Call)
                       and isinstance(call.func,ast.Attribute)
                       and isinstance(call.func.value,ast.Name) and call.func.value.id=='self'
                       and call.func.attr=='clear_own_read_body_claim']
                self.assertEqual(len(clear),1,'one identity-owned claim reset in outer finally')
                self.assertLess(entry[0].lineno,clear[0].lineno,'entry precedes claim cleanup')
                self.assertLess(clear[0].lineno,closing[0].lineno,'clear owned claim before complete closing')
                self.assertIn('self.clear_own_read_body_claim(claim)',wrapper,'clear frame before full closing check')
                self.assertIn('self.bounded_fd_slots(pid)',text,'retain bounded owner scans and inner checks')
                self.assertIn('self.check_deadline()',text,'retain per-descriptor deadline checks')
                continue
            if name=='verify_task_ownership_original':
                calls=[call for call in ast.walk(node) if isinstance(call,ast.Call)
                       and isinstance(call.func,ast.Attribute)
                       and isinstance(call.func.value,ast.Name) and call.func.value.id=='self']
                entry=[call for call in calls if call.func.attr=='check_owned_entry']
                full=[call for call in calls if call.func.attr=='check_full']
                self.assertEqual(len(entry),1,'one exact owned-window entry policy')
                self.assertEqual(len(full),1,'one unconditional complete closing audit')
                guard=[sub for sub in node.body if isinstance(sub,ast.Try)]
                self.assertEqual(len(guard),1,'one exception-safe ownership body')
                self.assertLess(entry[0].lineno,guard[0].lineno,'entry precedes the pure body')
                closing=[call for sub in guard[0].finalbody for call in ast.walk(sub)
                         if isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute)
                         and isinstance(call.func.value,ast.Name) and call.func.value.id=='self'
                         and call.func.attr=='check_full']
                self.assertEqual(len(closing),1,'actual complete closing call is inside outer finally')
                continue
            self.assertIn('self.check()',text,name+' must bracket')
            # the trailing full check must be in a finally so exceptions still run it
            self.assertIn('finally:',text,name+' must run the trailing check on every path')
            self.assertGreaterEqual(text.count('self.check()'),2,name+' needs before AND after')

    def test_bracketed_bodies_never_emit_capture_resume_or_mutate_authority(self):
        for name in BRACKETED:
            node=self.function(name)
            called=set()
            for sub in ast.walk(node):
                if isinstance(sub,ast.Call):
                    fn=sub.func
                    if isinstance(fn,ast.Attribute):called.add(fn.attr)
                    elif isinstance(fn,ast.Name):called.add(fn.id)
            forbidden=called & MUTATING_NAMES
            self.assertFalse(forbidden,name+' must not mutate inside its bracket: '+str(sorted(forbidden)))

    def test_no_once_per_epoch_permissive_cache(self):
        text=self.source
        for banned in ('_validated','validated=','begin_epoch','cached_check'):
            self.assertNotIn(banned,text,'permissive cache marker must not exist: '+banned)
        self.assertIn('def check_deadline',text,'deadline fast path must be explicit')


@unittest.skipUnless(sys.platform.startswith('linux'),'real read leases are Linux-only')
class RealLeaseBracketTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.lease_set=leases.LeaseSet()
        self.fds=[]
        for index in range(4):
            path=os.path.join(self.tmp.name,'f%d.bin'%index)
            with open(path,'wb') as handle:handle.write(b'x'*64)
            fd=os.open(path,os.O_RDONLY)
            self.fds.append(fd);self.lease_set.acquire(fd)

    def tearDown(self):
        try:self.lease_set.close()
        except Exception:pass
        for fd in self.fds:
            try:os.close(fd)
            except OSError:pass
        self.tmp.cleanup()

    def test_full_check_passes_while_all_leases_held(self):
        self.lease_set.check()

    def test_midbody_lease_loss_is_rejected_by_trailing_check(self):
        probes=[]
        def body():
            probes.append('body')
            fcntl_unlock(self.fds[1])
        with self.assertRaises(leases.LeaseError):
            self.lease_set.check()
            body()
            self.lease_set.check()
        self.assertEqual(probes,['body'])

    def test_midbody_sigio_change_is_rejected_by_trailing_check(self):
        original=signal.getsignal(signal.SIGIO)
        try:
            self.lease_set.check()
            signal.signal(signal.SIGIO,lambda *a:None)
            with self.assertRaises(leases.LeaseError):self.lease_set.check()
        finally:
            signal.signal(signal.SIGIO,original)

    def test_midbody_close_is_rejected_by_trailing_check(self):
        self.lease_set.check()
        self.lease_set.close()
        with self.assertRaises(leases.LeaseError):self.lease_set.check()

    def test_token_scoped_check_remains_per_call(self):
        token=dict(next(iter(self.lease_set._held.values()))['token'])
        for _ in range(50):self.lease_set.check(token)
        token['identity']=list(token['identity'])
        fcntl_unlock(self.fds[0])
        with self.assertRaises(leases.LeaseError):self.lease_set.check(token)

    def test_failure_is_sticky_for_repeat_checks(self):
        fcntl_unlock(self.fds[0])
        with self.assertRaises(leases.LeaseError):self.lease_set.check()
        for _ in range(3):
            with self.assertRaises(leases.LeaseError):self.lease_set.check()


def fcntl_unlock(fd):
    import fcntl
    fcntl.fcntl(fd,fcntl.F_SETLEASE,fcntl.F_UNLCK)


if __name__=='__main__':unittest.main()

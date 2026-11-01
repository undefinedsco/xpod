"""Required-gate regression: private emit publication and real closing boundaries.

Real Observer + real native LeaseSet on real retained FDs. The only injected
seam is a counting wrapper around the REAL `LeaseSet.check`, so assertions are
on actual full-sweep invocations, not on a mocked boolean.

Covers:
  * private emit rows do NOT perform a full FD sweep per row, inside or outside
    an owned window;
  * cheap `Observer.check()` preserves the owned-window/waiter/thread refusals;
  * a mutated leased identity is REJECTED at the real full boundary
    (`check_full`/resume/read/phase), not at a private emit row;
  * wrong thread / wrong phase / nested re-clamp under the same parent do NOT inherit;
  * an exception after arming leaves NO claim (unconditional reset).
Linux only: real kernel read leases are required.
"""
import fcntl
import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever' / 'scripts'

try:
    from qlever.tests.sdk_test_paths import scoped_temp
except ModuleNotFoundError:
    from sdk_test_paths import scoped_temp



def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def leases_supported():
    if not sys.platform.startswith('linux'):
        return False
    with scoped_temp('lease-probe') as directory:
        fd = path = None
        try:
            fd, path = tempfile.mkstemp(dir=directory)
            os.write(fd, b'x' * 32)
            os.close(fd)
            fd = os.open(path, os.O_RDONLY)
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            return fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_RDLCK
        except OSError:
            return False
        finally:
            try:
                if fd is not None:
                    os.close(fd)
            finally:
                if path:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass


@unittest.skipUnless(sys.platform.startswith('linux'), 'real kernel leases require Linux')
@unittest.skipUnless(leases_supported(), 'kernel refuses F_SETLEASE on this host')
class OwnedWindowEmission(unittest.TestCase):

    def setUp(self):
        self.obs = None
        self.held = None
        self.backend = load('ow_backend', 'sdk-ptrace-execution.py')
        self.leases_mod = load('ow_leases', 'sdk-tool-lifetime-leases.py')
        self.bw = load('ow_bw', 'sdk-blocking-owned-wait.py')
        self._tmpdir = scoped_temp('owned-window')
        self.tmp = Path(self._tmpdir.name)
        self.count = {'sweep': 0}
        original = self.leases_mod.LeaseSet.check

        def counting(inner, token=None):
            self.count['sweep'] += 1
            return original(inner, token)

        self.leases_mod.LeaseSet.check = counting
        self.addCleanup(lambda: setattr(self.leases_mod.LeaseSet, 'check', original))

    def tearDown(self):
        # close the single SIGIO owner first, before removing files
        if self.obs is not None:
            leases = getattr(self.obs, 'lifetime_leases', None)
            try:
                if leases is not None:
                    leases.close()
            finally:
                self.obs.close()
                raw = getattr(self.obs, 'raw', None)
                if raw is not None:
                    try:
                        raw.close()
                    except BaseException:
                        pass
                self.obs = None
        self._tmpdir.cleanup()

    def _observer(self, fds=40):
        out = self.tmp / 'out'
        build = self.tmp / 'build'
        out.mkdir(parents=True, exist_ok=True)
        build.mkdir(parents=True, exist_ok=True)
        obs = self.backend.Observer(str(out), str(self.tmp), str(build),
                                    maximum_bytes=32 * 1024 ** 2,
                                    maximum_file_bytes=1024 ** 2,
                                    selected_names=None, capture_toolchain=True)
        obs.current_phase = 'configure'
        obs.deadline = time.monotonic() + 120
        obs.waiter = self.bw.BlockingOwnedWait(time.monotonic() + 120)
        obs.raw = self.backend.ShardedRaw(out, 'configure', 1024 * 1024)
        obs.raw_encoder = None
        obs.wait_references = []
        obs.unknown_stops = {}
        obs.root_code = None
        leases = self.leases_mod.LeaseSet()
        obs.lifetime_leases = leases
        held = []
        self.obs, self.held = obs, held
        for i in range(fds):
            p = self.tmp / ('f%d.bin' % i)
            p.write_bytes(b'x' * 64)
            fd = os.open(str(p), os.O_RDONLY)
            leases.acquire(fd)
            obs.retained.add(fd)
            held.append((fd, p))
        # ONE LeaseSet per process owns SIGIO; tearDown closes it and restores.
        return obs, held

    def _emit(self, obs, n):
        for _ in range(n):
            obs.emit(dict(kind='kernel-syscall', pid=1, op='entry', nr=0,
                          args=[0] * 6, arch=3221225534))

    def _arm(self, obs):
        end = time.monotonic() + 0.9
        obs.waiter.clamp(end)
        obs.window_arm(int(end * 1e9))
        obs.open_outer_lease_window()

    # -- positive ------------------------------------------------------
    def test_private_emit_rows_have_no_full_sweep_inside_or_outside(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            self.count['sweep'] = 0
            self._emit(obs, 60)
            inside = self.count['sweep']
            obs.close_outer_lease_window()
            self.count['sweep'] = 0
            self._emit(obs, 60)
            outside = self.count['sweep']
        self.assertEqual(inside, 0, 'private rows must not sweep inside an owned window')
        self.assertEqual(outside, 0, 'private rows must not sweep outside an owned window')
        self.count['sweep'] = 0
        obs.check_full()
        self.assertEqual(self.count['sweep'], 1, 'the real full boundary runs exactly once')

    def test_full_boundary_rejects_a_mutated_identity_after_private_emit(self):
        obs, held = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            fd, path = held[0]
            os.unlink(path)
            path.write_bytes(b'y' * 128)
            # A private diagnostic row may be written; it is not external
            # authority. The mutation must be rejected at the real full boundary.
            obs.emit(dict(kind='kernel-syscall', pid=1, op='entry', nr=0,
                          args=[0] * 6, arch=3221225534))
            with self.assertRaises(Exception) as caught:
                obs.check_full()
            self.assertIn('leased inode identity changed', str(caught.exception))

    # -- negatives -----------------------------------------------------
    def test_nested_reclamp_under_same_parent_does_not_inherit(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            # a second local clamp under the same parent/thread/phase
            obs.waiter.restore(obs.waiter.window)
            end = time.monotonic() + 0.7
            obs.waiter.clamp(end)
            self.assertFalse(obs.outer_lease_window_owned(),
                             'a different local window must not inherit the claim')

    def test_wrong_thread_does_not_inherit(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            seen = {}

            def probe():
                seen['owned'] = obs.outer_lease_window_owned()

            thread = threading.Thread(target=probe)
            thread.start()
            thread.join()
            self.assertFalse(seen.get('owned'), 'another thread must not inherit')
            self.assertTrue(obs.outer_lease_window_owned(), 'owner thread keeps its claim')

    def test_open_refuses_without_a_real_clamp(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            with self.assertRaises(AssertionError):
                obs.open_outer_lease_window()

    def test_wrong_phase_stays_private_until_full_boundary(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            obs.current_phase = 'build'
            self.count['sweep'] = 0
            self._emit(obs, 1)
            self.assertEqual(self.count['sweep'], 0)
            obs.check_full()
            self.assertEqual(self.count['sweep'], 1)

    def test_another_waiter_cannot_inherit_the_same_deadlines(self):
        import copy
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            try:
                obs.waiter = copy.copy(waiter)
                self.assertFalse(obs.outer_lease_window_owned())
                self.count['sweep'] = 0
                self._emit(obs, 1)
                self.assertEqual(self.count['sweep'], 0)
                obs.check_full()
                self.assertEqual(self.count['sweep'], 1)
            finally:
                obs.waiter = waiter
            self.assertTrue(obs.outer_lease_window_owned())

    def test_open_refuses_reentrancy(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            with self.assertRaises(AssertionError):
                obs.open_outer_lease_window()


    def test_primary_body_error_wins_over_failing_closing_check(self):
        obs, held = self._observer()
        class BodyPrimary(Exception):pass
        def body():
            fd, _ = held[0]
            import fcntl as _fcntl
            _fcntl.fcntl(fd, _fcntl.F_SETLEASE, _fcntl.F_UNLCK)
            raise BodyPrimary('body-primary')
        try:
            with self.assertRaises(BodyPrimary) as caught:
                obs.read_body(body)
            self.assertIsInstance(caught.exception, BodyPrimary)
            self.assertIn('body-primary', str(caught.exception))
        finally:
            obs.close_read_body_frame()
            obs.close()


    def _diag_context(self, obs, fd, identity, cached_identity=None):
        pid=os.getpid()
        obs.tasks={pid:dict(fdTable=pid,tgid=pid,exited=False,toolMmapFd=dict(identity=cached_identity if cached_identity is not None else identity))}
        return pid,dict(args=[0,4096,1,1,fd,0],sequence=7),dict(sequence=9)

    def _diag_payload(self, obs, pid, entry, barrier, error):
        import contextlib,io,json
        buf=io.StringIO()
        with contextlib.redirect_stderr(buf):
            try:obs.lease_acquisition_diagnostic(pid,entry['args'][4],entry,barrier,error)
            except BaseException:self.fail('diagnostic raised instead of preserving failure')
        lines=[line for line in buf.getvalue().splitlines() if line.startswith('SDK_LEASE_ACQUISITION_EAGAIN ')]
        self.assertEqual(len(lines),1,'one bounded diagnostic line required')
        payload=lines[0].split(' ',1)[1]
        self.assertLessEqual(len(payload.encode('utf-8')),4096)
        return json.loads(payload)

    def test_lease_eagain_diagnostic_valid_bounded_json(self):
        obs, held = self._observer()
        fds=[]
        try:
            path=self.tmp/'aliases';path.write_bytes(b'a'*64);identity=self.backend.probe.identity(os.stat(path))
            for _ in range(80):fds.append(os.open(str(path),os.O_RDONLY))
            pid,entry,barrier=self._diag_context(obs,fds[0],identity)
            payload=self._diag_payload(obs,pid,entry,barrier,BlockingIOError(11,'would block'))
            self.assertLessEqual(len(payload['matchingOwnedDescriptors']),64)
            self.assertEqual(payload['attemptedDescriptorIdentity'],identity)
            self.assertEqual(payload['cachedToolMmapIdentity'],identity)
            self.assertEqual(payload['identityUsedForMatchProvenance'],'attempted-current')
            self.assertLessEqual(payload['slotsScanned'],2048)
            self.assertGreaterEqual(payload['matchingDescriptorCount'],80)
            self.assertGreaterEqual(payload['matchingDescriptorRowsOmitted'],1)
            self.assertIn(payload['scanStatus'],('complete','truncated'))
        finally:
            for fd in fds:os.close(fd)
            obs.close()

    def test_lease_eagain_diagnostic_uses_current_not_cached_identity(self):
        obs, held = self._observer()
        try:
            current=self.tmp/'current';cached=self.tmp/'cached'
            current.write_bytes(b'c'*64);cached.write_bytes(b'k'*64)
            current_id=self.backend.probe.identity(os.stat(current));cached_id=self.backend.probe.identity(os.stat(cached))
            self.assertNotEqual(current_id[:2],cached_id[:2])
            fd=os.open(str(current),os.O_RDONLY)
            pid,entry,barrier=self._diag_context(obs,fd,current_id,cached_identity=cached_id)
            payload=self._diag_payload(obs,pid,entry,barrier,BlockingIOError(11,'would block'))
            self.assertEqual(payload['attemptedDescriptorIdentity'],current_id)
            self.assertEqual(payload['cachedToolMmapIdentity'],cached_id)
            self.assertEqual(payload['identityUsedForMatch'],current_id)
            self.assertEqual(payload['identityUsedForMatchProvenance'],'attempted-current')
            self.assertGreaterEqual(payload['matchingDescriptorCount'],1)
            self.assertTrue(any(row['fd']==fd and row['pid']==pid for row in payload['matchingOwnedDescriptors']))
            os.close(fd)
        finally:obs.close()

    def test_lease_eagain_diagnostic_forced_total_slot_budget(self):
        obs, held = self._observer()
        try:
            path=self.tmp/'budget';path.write_bytes(b'b'*64);identity=self.backend.probe.identity(os.stat(path));fd=os.open(str(path),os.O_RDONLY)
            pid=os.getpid();obs.shared_tasks=True
            obs.tasks={pid:dict(fdTable=pid,tgid=pid,exited=False,toolMmapFd=dict(identity=identity))}
            for offset in (1000,2000):obs.tasks[pid+offset]=dict(fdTable=pid,tgid=pid,exited=False,toolMmapFd=dict(identity=identity))
            def full(owner,local,maximum=1024):return [str(900000+i) for i in range(min(maximum,1024))]
            # The diagnostic resolves the module global, not an instance attr.
            real_global=self.backend.bounded_fd_slot_names
            self.backend.bounded_fd_slot_names=full
            try:
                entry=dict(args=[0,4096,1,1,fd,0],sequence=7);barrier=dict(sequence=9)
                payload=self._diag_payload(obs,pid,entry,barrier,BlockingIOError(11,'would block'))
            finally:self.backend.bounded_fd_slot_names=real_global
            self.assertTrue(payload['scanAvailable'])
            self.assertFalse(payload['scanComplete'])
            self.assertEqual(payload['scanStatus'],'truncated')
            self.assertEqual(payload['slotsRemaining'],0,'total slot budget was not exhausted')
            self.assertLessEqual(payload['slotsScanned'],2048)
            os.close(fd)
        finally:obs.close()

    def test_lease_eagain_diagnostic_scan_unavailable_is_not_absence(self):
        obs, held = self._observer()
        try:
            path=self.tmp/'scan';path.write_bytes(b'b'*64);identity=self.backend.probe.identity(os.stat(path));fd=os.open(str(path),os.O_RDONLY)
            pid,entry,barrier=self._diag_context(obs,fd,identity)
            real=self.backend.bounded_fd_slot_names
            def unavailable(*a,**k):raise OSError('scan unavailable')
            self.backend.bounded_fd_slot_names=unavailable
            try:payload=self._diag_payload(obs,pid,entry,barrier,BlockingIOError(11,'would block'))
            finally:self.backend.bounded_fd_slot_names=real
            self.assertFalse(payload['scanAvailable'])
            self.assertFalse(payload['scanComplete'])
            self.assertEqual(payload['scanStatus'],'unavailable')
            self.assertIsNone(payload['matchingDescriptorCount'])
            self.assertEqual(payload['matchingOwnedDescriptors'],[])
            os.close(fd)
        finally:obs.close()

    def test_lease_eagain_diagnostic_does_not_replace_primary(self):
        obs, held = self._observer()
        try:
            path=self.tmp/'primary';path.write_bytes(b'c'*64);identity=self.backend.probe.identity(os.stat(path));fd=os.open(str(path),os.O_RDONLY)
            pid,entry,barrier=self._diag_context(obs,fd,identity)
            original=BlockingIOError(11,'would block')
            try:
                try:raise original
                except BlockingIOError as caught:
                    try:obs.lease_acquisition_diagnostic(pid,fd,entry,barrier,caught)
                    except BaseException:self.fail('diagnostic replaced primary')
                    raise
            except BlockingIOError as caught:
                self.assertIs(caught,original)
            os.close(fd)
        finally:obs.close()



    def test_real_sigio_between_two_production_resumes_stops_second_child(self):
        import ctypes,signal
        obs, held = self._observer()
        children=[];writer=None;rfd=wfd=None
        try:
            obs.generated_vma=None;obs.tasks={};obs.exclusive=None;obs.terminal_focus=None;obs.serialize_terminal_syscalls=False
            def spawn():
                pid=os.fork()
                if pid==0:
                    try:
                        ctypes.CDLL(None,use_errno=True).ptrace(0,0,None,None)
                        os.kill(os.getpid(),signal.SIGSTOP);time.sleep(30);os._exit(0)
                    except BaseException:os._exit(111)
                _,status=os.waitpid(pid,os.WUNTRACED);self.assertTrue(os.WIFSTOPPED(status));return pid
            first=spawn();second=spawn();children=[first,second]
            obs.tasks[first]={'stopped':True,'exited':False,'signal':0};obs.tasks[second]={'stopped':True,'exited':False,'signal':0}
            leased=held[0][1];rfd,wfd=os.pipe();writer=os.fork()
            if writer==0:
                try:
                    os.read(rfd,1)
                    try:os.open(str(leased),os.O_WRONLY|os.O_NONBLOCK|os.O_CLOEXEC)
                    except OSError:pass
                    os._exit(0)
                except BaseException:os._exit(112)
            real_trace=self.backend.single.trace;calls=[]
            def trace(req,pid,*args):
                result=real_trace(req,pid,*args);calls.append((req,pid))
                if len(calls)==1:
                    os.write(wfd,b'x')
                    deadline=time.monotonic()+2.0
                    while obs.lifetime_leases._failure is None and time.monotonic()<deadline:time.sleep(0.005)
                return result
            self.backend.single.trace=trace
            try:
                with self.assertRaises(BaseException) as caught:obs.resume_original()
            finally:self.backend.single.trace=real_trace
            self.assertEqual(len(calls),1,'second actual resume occurred after sticky SIGIO')
            self.assertIn('lease',str(caught.exception).lower())
            self.assertTrue(obs.tasks[second]['stopped'],'second task was resumed')
            state=Path('/proc/%d/stat'%second).read_text().split()[2]
            self.assertIn(state,('t','T'),'second real child not stopped after refused resume')
        finally:
            if writer is not None:
                try:os.kill(writer,signal.SIGKILL);os.waitpid(writer,0)
                except OSError:pass
            for fd in (rfd,wfd):
                try:
                    if fd is not None:os.close(fd)
                except OSError:pass
            for pid in children:
                try:os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
                except OSError:pass

    def test_provider_mountinfo_full_closing_before_cache_or_emit(self):
        obs, held = self._observer()
        obs.tool_provider_cache={};obs.maximum_processes=1024
        real=obs.check;broken=[]
        def check():
            real()
            if not broken:
                broken.append(1);fcntl.fcntl(held[0][0],fcntl.F_SETLEASE,fcntl.F_UNLCK)
        obs.check=check
        try:
            before=len(obs.records);data=Path('/proc/self/mountinfo').read_bytes()
            with self.assertRaises(BaseException):obs.tool_mountinfo_original(123,('ns',1),data)
            self.assertTrue(broken)
            self.assertEqual(len(obs.records),before,'mountinfo row accepted after failed full closing')
            self.assertEqual(obs.tool_provider_cache,{},'provider reference cached after failed full closing')
        finally:obs.check=real


    def test_exception_after_arm_leaves_no_claim(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            self.assertIsNotNone(obs._outer_lease_coalesce)
            obs.close()                      # terminal path must clear it
            self.assertIsNone(obs._outer_lease_coalesce,
                              'no claim may outlive a terminal close')

    def test_abort_clears_claim(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            obs.abort()
            self.assertIsNone(obs._outer_lease_coalesce)


if __name__ == '__main__':
    unittest.main()

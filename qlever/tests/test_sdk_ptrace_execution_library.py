"""Library contract/budget tests; actual ptrace execution is a queued Linux probe."""
import importlib.util
from pathlib import Path
import tempfile
import os
import hashlib
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Tests(unittest.TestCase):
    def test_sdk_policy_modes_keep_the_same_parent_budget_and_strict_generic_default(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        mounts=b'1 0 0:1 / / ro - overlay overlay rw\n'
        original_read=Path.read_bytes
        def read(path):
            return mounts if path==Path('/proc/self/mountinfo') else original_read(path)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            end=time.monotonic()+10;check=lambda:None
            # Mount input is a fixture; no child or kernel execution is claimed.
            with patch.object(Path,'read_bytes',read):
                observer=module.SdkExecutionObserver(Path(directory),Path('/opt/qlever-sdk/source'),Path('/opt/qlever-sdk/build'),deadline_monotonic=end,check_budget=check,maximum_bytes=4096,maximum_stdio_bytes=1024)
            try:
                self.assertTrue(observer.deny_optional_io_uring and observer.verified_identity_noop and observer.terminal_exit_evidence)
                self.assertFalse(observer.verified_setresuid_noop)
                self.assertTrue(observer.shared_tasks and observer.capture_toolchain)
                self.assertEqual(observer.deadline_monotonic,end);self.assertIs(observer.check_budget,check)
                self.assertEqual((observer.maximum_bytes,observer.maximum_stdio_bytes),(4096,1024))
                self.assertEqual(observer.domain_bytes,len(mounts))
            finally:observer.close()
            generic=module.Observer(directory,directory,directory)
            try:self.assertFalse(generic.deny_optional_io_uring or generic.verified_setresuid_noop or generic.verified_identity_noop or generic.terminal_exit_evidence)
            finally:generic.close()
    def test_shards_preserve_exact_bytes_and_order(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            stream=module.ShardedRaw(Path(directory),'compile',8);stream.write(b'first\n');stream.write(b'next\n');self.assertEqual(stream.tell(),11);stream.close()
            self.assertEqual([path.name for path in stream.paths],['compile.trace-0000.jsonl','compile.trace-0001.jsonl']);self.assertEqual(b''.join(path.read_bytes() for path in stream.paths),b'first\nnext\n')
    def test_normal_phase_must_use_fixed_argv_and_existing_deadline(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            # Pure argument checks only: no constructor, kernel provider, ptrace or cap is simulated.
            backend=object.__new__(module.SdkExecutionObserver);backend.sdk_failed=False;backend.sdk_phase_index=0;backend.deadline_monotonic=time.monotonic()+10;backend.retained=set()
            with self.assertRaisesRegex(AssertionError,'fixed actual SDK phase argv'):
                backend.phase('configure',['/bin/true'],time.monotonic()+1,cwd='/',env={},stdoutPath='/unused',stderrPath='/unused')
            with self.assertRaisesRegex(AssertionError,'existing SDK deadline'):
                backend.phase('configure',['bash','/components/qlever/scripts/build-qlever-runtime-sdk.sh','configure-prepared'],time.monotonic()+100,cwd='/',env={},stdoutPath='/unused',stderrPath='/unused')
            backend.close()
    def test_effective_source_ro_includes_superblock_and_rejects_rw(self):
        for flags,superflags in [('ro','rw'),('rw','ro')]:
            raw=('1 0 0:1 / / '+flags+' - overlay overlay '+superflags+'\n').encode()
            self.assertEqual(module.probe.effective_readonly('/opt/qlever-sdk/source',raw)['mount'],'/')
        with self.assertRaisesRegex(AssertionError,'writable'):
            module.probe.effective_readonly('/opt/qlever-sdk/source',b'1 0 0:1 / / rw - overlay overlay rw\n')
    def test_remaining_tightens_private_ledger_without_reset_or_increase(self):
        observer=module.Observer('/unused','/unused','/unused',maximum_bytes=100)
        observer.claim(20);self.assertEqual(observer.tighten_remaining(30),50)
        observer.claim(30);self.assertEqual(observer.domain_bytes,50)
        with self.assertRaisesRegex(AssertionError,'shared execution'):observer.claim(1)
        self.assertEqual(observer.tighten_remaining(1000),50)
        self.assertEqual(observer.tighten_remaining(0),50)
        for invalid in [-1,True,1.5]:
            with self.assertRaisesRegex(AssertionError,'remaining source'):observer.tighten_remaining(invalid)
    def test_actual_preexisting_build_inputs_are_sealed_once_with_held_FDs(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);build=root/'build';build.mkdir();out=root/'originals';out.mkdir()
            paths=[build/'.xpod-source-prepared',build/'arbitrary-prepared.conf']
            for path in paths:path.write_bytes(b'prepared-17')
            backend=module.Observer(out,root/'source',build);backend.deadline=time.monotonic()+5;backend.current_phase='configure';backend.raw=(out/'raw.jsonl').open('xb')
            try:
                backend.seal_prepared_build_inputs();self.assertEqual(set(backend.prepared_inputs),set(map(str,paths)))
                self.assertEqual(len(backend.captures),2)
                for path in paths:
                    row,fd,data=backend.prepared_inputs[str(path)];self.assertEqual(os.pread(fd,100,0),b'prepared-17');self.assertEqual(row['original']['sha256'],hashlib.sha256(b'prepared-17').hexdigest())
                held=backend.prepared_inputs[str(paths[0])][1];before=os.fstat(held).st_ino;paths[0].write_bytes(b'prepared-18')
                self.assertEqual(os.fstat(held).st_ino,before);self.assertEqual(os.pread(held,100,0),b'prepared-18')
                with self.assertRaisesRegex(AssertionError,'precede'):backend.seal_prepared_build_inputs()
            finally:backend.raw.close();backend.close()
    def test_canonical_budget_cannot_be_increased(self):
        with self.assertRaisesRegex(AssertionError,'canonical shared execution'):
            module.SdkExecutionObserver(Path('/unused'),Path('/opt/qlever-sdk/source'),Path('/opt/qlever-sdk/build'),deadline_monotonic=time.monotonic()+1,check_budget=lambda:None,maximum_bytes=4*1024**3+1,maximum_stdio_bytes=1000)

class ActualStdioTests(unittest.TestCase):
    def pipe_case(self,maximum_stream,maximum_domain,data):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            observer=module.Observer(Path(directory),Path(directory),Path(directory),maximum_bytes=maximum_domain)
            read_fd,write_fd=os.pipe();errors=[];target=Path(directory)/'stdout.raw';pump=module.BoundedPipePump(read_fd,target,maximum_stream,observer.claim,errors)
            pid=os.fork()
            if pid==0:
                try:os.close(read_fd);os.write(write_fd,data);os.close(write_fd);os._exit(0)
                except BaseException:os._exit(70)
            os.close(write_fd);pump.start();waited,status=os.waitpid(pid,0);pump.thread.join(2)
            self.assertFalse(pump.thread.is_alive());self.assertEqual(waited,pid)
            return target.read_bytes(),errors,pump,observer.domain_bytes
    def test_actual_pipe_bytes_are_hashed_and_charged(self):
        content,errors,pump,charged=self.pipe_case(1024,1024,b'actual stdout')
        self.assertEqual(content,b'actual stdout');self.assertEqual(errors,[]);self.assertEqual(charged,len(content));self.assertEqual(pump.sha256,hashlib.sha256(content).hexdigest())
    def test_actual_large_write_rejected_before_unbounded_disk_write(self):
        for stream,domain in [(32,10000),(10000,32)]:
            content,errors,pump,charged=self.pipe_case(stream,domain,b'x'*4096)
            self.assertTrue(errors);self.assertLessEqual(len(content),32);self.assertIsNone(pump.sha256);self.assertLessEqual(charged,domain)
    @unittest.skipUnless(Path('/usr/bin/bash').is_file(),'fixed Debian SDK executable is tested by queued Linux context')
    def test_actual_fixed_bash_execve_from_directory_without_relative_bash(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            read_fd,write_fd=os.pipe();pid=os.fork()
            if pid==0:
                os.close(read_fd);os.chdir(directory);os.dup2(write_fd,1);os.close(write_fd)
                command=['bash','-c','printf actual-fixed-bash'];os.execve(module.actual_executable(command),command,{'PATH':'/usr/bin:/bin','LANG':'C'})
            os.close(write_fd);content=os.read(read_fd,1024);os.close(read_fd);waited,status=os.waitpid(pid,0)
            self.assertEqual(waited,pid);self.assertEqual(os.waitstatus_to_exitcode(status),0);self.assertEqual(content,b'actual-fixed-bash')

if __name__=='__main__':unittest.main()

"""Actual fixed filesystem/child originals, not ptrace or SDK qualification."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('cmake_failed_originals',ROOT/'qlever/scripts/sdk-toolchain-materials.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def fixture(self):
        base=ROOT/'.test-data/sdk-cmake-failure-originals';base.mkdir(parents=True,exist_ok=True)
        temporary=tempfile.TemporaryDirectory(dir=base);self.addCleanup(temporary.cleanup);root=Path(temporary.name)
        out=root/'materials';build=root/'build';stage=out/'stages/configure';stage.mkdir(parents=True);(build/'CMakeFiles').mkdir(parents=True)
        nested=out/'generation/configure';nested.mkdir(parents=True)
        return out,build,stage,nested
    def capture(self,out,build,stage,remaining=lambda:16*1024**2):
        return m.cmake_failure_originals(out,build,stage,lambda:None,remaining)
    def test_actual_nested_failed_child_receipt_and_streams_plus_complete_and_partial_logs(self):
        out,build,stage,nested=self.fixture()
        with self.assertRaises(SystemExit) as failure:
            m.commands.exec_child([sys.executable,'-c','import sys;print("compiler-stdout");sys.stderr.write("compiler-error\\n");sys.exit(3)'],nested)
        self.assertEqual(failure.exception.code,3)
        data=b'header'+b'x'*(300*1024)+b'actual-end-error';(build/'CMakeFiles/CMakeError.log').write_bytes(data)
        output=io.StringIO()
        with contextlib.redirect_stderr(output):m.emit_cmake_failure_originals(out,build,stage,lambda:None,lambda:16*1024**2)
        lines=output.getvalue().splitlines();self.assertTrue(all(len(line.encode())<65500 for line in lines))
        summary=json.loads(lines[0].split(' ',1)[1]);rows=summary['originals'];self.assertFalse(summary['authorityVerified'])
        actual={row['sourceRelativePath']:row for row in rows if row['status']=='retained'}
        self.assertEqual(actual['generation/configure/stderr.raw']['sourceSha256'],hashlib.sha256((nested/'stderr.raw').read_bytes()).hexdigest())
        self.assertEqual(json.loads((nested/'command.receipt.json').read_bytes())['exit'],3)
        partial=actual['CMakeFiles/CMakeError.log'];self.assertFalse(partial['complete']);self.assertEqual(partial['sourceSha256'],hashlib.sha256(data).hexdigest());self.assertEqual(partial['sourceOffset'],len(data)-m.CMAKE_FAILURE_RETAIN_LIMIT)
        chunks={}
        for line in lines[1:]:
            item=json.loads(line.split(' ',1)[1]);raw=base64.b64decode(item['data']);self.assertEqual(hashlib.sha256(raw).hexdigest(),item['sha256']);chunks.setdefault(item['path'],[]).append((item['offset'],raw))
        for row in actual.values():
            body=b''.join(value for _,value in sorted(chunks.get(row['original']['path'],[])))
            self.assertEqual(body,(out/row['original']['path']).read_bytes());self.assertEqual(hashlib.sha256(body).hexdigest(),row['original']['sha256'])
    def test_actual_failed_phase_control_flow_exports_nested_raw_then_preserves_failure(self):
        out,build,stage,nested=self.fixture();stage.rmdir();(nested/'stderr.raw').write_bytes(b'actual nested compiler failure')
        session=m.Session.__new__(m.Session);session.out=out;session.build=build
        session.budget=types.SimpleNamespace(end=time.monotonic()+100,timeout=lambda cap,reserve:1,check=lambda reserve=0:None)
        def failed(name,argv,deadline,**options):
            directory=Path(options['stdoutPath']).parent
            (directory/'stdout.raw').write_bytes(b'');(directory/'stderr.raw').write_bytes(b'')
            ref=lambda path:dict(m.commands.ref(path,out),path=str(path))
            trace=out/'trace.jsonl';trace.write_text('')
            return dict(commandReceipt=dict(exit=1,signal=None,actualWait=True,stdout=ref(directory/'stdout.raw'),stderr=ref(directory/'stderr.raw')),trackingReceipt=dict(actualRootPid=10,actualRootReturnCode=1,actualTrackedWait=True,trackedProcessesClosed=True),rawTraceShards=[ref(trace)])
        session.observer=types.SimpleNamespace(tighten_remaining=lambda amount:None,phase=failed)
        output=io.StringIO()
        with contextlib.redirect_stderr(output),self.assertRaisesRegex(ValueError,'Actual observer phase failed'):
            session.phase('configure',['fixed'],[],1,1)
        summary=json.loads(next(line.split(' ',1)[1] for line in output.getvalue().splitlines() if line.startswith('SDK_CMAKE_FAILURE_ORIGINALS ')))
        self.assertEqual(summary['failedPhase']['actualRootReturnCode'],1)
        self.assertEqual(summary['failedPhase']['trackingReceipt'],m.commands.ref(out/'stages/configure/tracking.receipt.json',out))
        self.assertTrue(any(row['status']=='retained' and row['sourceRelativePath']=='generation/configure/stderr.raw' for row in summary['originals']))
        self.assertIn('SDK_CMAKE_FAILURE_ORIGINAL_CHUNK ',output.getvalue())

    def test_source_size_and_shared_remaining_are_checked_before_any_body_read(self):
        for mode in ('source','remaining'):
            out,build,stage,nested=self.fixture();file=nested/'stderr.raw'
            with file.open('wb') as stream:stream.truncate(m.CMAKE_FAILURE_SOURCE_LIMIT+1 if mode=='source' else 100)
            with patch.object(m.os,'read',side_effect=AssertionError('body read before bound')):
                summary,payloads=self.capture(out,build,stage,lambda:0 if mode=='remaining' else 16*1024**2)
            row=next(row for row in summary['originals'] if row['sourceRelativePath'].endswith('stderr.raw'))
            self.assertEqual(row['status'],'source-byte-bound' if mode=='source' else 'retained-byte-budget');self.assertEqual(payloads,[]);self.assertEqual(list(stage.iterdir()),[])
    def test_file_and_parent_symlinks_and_hardlinks_are_not_followed(self):
        out,build,stage,nested=self.fixture();outside=build/'outside';outside.write_bytes(b'not a log')
        (nested/'stdout.raw').symlink_to(outside);os.link(outside,nested/'stderr.raw')
        (build/'CMakeFiles').rmdir();(build/'CMakeFiles').symlink_to(nested,target_is_directory=True)
        summary,payloads=self.capture(out,build,stage)
        self.assertEqual(payloads,[]);self.assertTrue(all(row['status'] in ('missing','unavailable') for row in summary['originals']))
    def test_source_mutation_during_read_cannot_obtain_retained_reference(self):
        out,build,stage,nested=self.fixture();file=nested/'stderr.raw';file.write_bytes(b'actual');original=m.os.read;changed=False
        def read(fd,size):
            nonlocal changed
            raw=original(fd,size)
            if not changed:
                changed=True
                with file.open('ab') as stream:stream.write(b'changed')
            return raw
        with patch.object(m.os,'read',side_effect=read):summary,payloads=self.capture(out,build,stage)
        row=next(row for row in summary['originals'] if row['sourceRelativePath'].endswith('stderr.raw'));self.assertEqual(row['status'],'unavailable');self.assertEqual(payloads,[])
    def test_original_observer_exception_is_preserved_when_deadline_and_stderr_fail(self):
        out,build,stage,nested=self.fixture();stage.rmdir();original=ValueError('original observer failure')
        session=m.Session.__new__(m.Session);session.out=out;session.build=build
        session.budget=types.SimpleNamespace(end=time.monotonic()+100,timeout=lambda cap,reserve:1,check=lambda reserve=0:(_ for _ in ()).throw(TimeoutError('expired')))
        session.observer=types.SimpleNamespace(tighten_remaining=lambda amount:None,phase=lambda *args,**kwargs:(_ for _ in ()).throw(original))
        class Broken:
            def write(self,_):raise OSError('closed diagnostic stderr')
            def flush(self):raise OSError('closed diagnostic stderr')
        with contextlib.redirect_stderr(Broken()):
            with self.assertRaises(ValueError) as failed:session.phase('configure',['fixed'],[],1,1)
        self.assertIs(failed.exception,original)

if __name__=='__main__':unittest.main()

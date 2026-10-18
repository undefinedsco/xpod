"""Real retained bytes with synthetic waits; no kernel or SDK qualification."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import types
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('failure_adapter',ROOT/'qlever/scripts/sdk-toolchain-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class FailureDiagnosticTests(unittest.TestCase):
    def fixture(self,out,directory):
        directory.mkdir(parents=True,exist_ok=True);stdout=directory/'stdout.raw';stderr=directory/'stderr.raw'
        stdout.write_bytes(b'closed output');stderr.write_bytes(b'x'*40000)
        trace=out/'trace.jsonl';trace.write_text('\n'.join(json.dumps(row) for row in [dict(kind='actual-child-binding',parentPid=10,childPid=11),dict(kind='actual-wait-exit',pid=11,returnCode=2,sequence=7,actualExecImage='/usr/bin/tool')])+'\n')
        ref=lambda path:dict(module.commands.ref(path,out),path=str(path))
        return dict(commandReceipt=dict(exit=2,signal=None,actualWait=True,stdout=ref(stdout),stderr=ref(stderr)),trackingReceipt=dict(actualRootPid=10,actualRootReturnCode=2,actualTrackedWait=True,trackedProcessesClosed=True),rawTraceShards=[ref(trace)])
    def test_whole_originals_and_bounded_tail_references(self):
        parent=ROOT/'.test-data/sdk-failure-diagnostic';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            out=Path(temporary);directory=out/'stages/configure';result=self.fixture(out,directory)
            value=module.failure_diagnostic(result,out,directory,lambda:None)
            self.assertEqual(value['actualRootReturnCode'],2)
            self.assertEqual(value['nonzeroWaits'][0]['actualImageParentChain'][0]['actualExecImage'],'/usr/bin/tool')
            excerpt=value['stderrExcerpt'];self.assertEqual((excerpt['offset'],excerpt['bytes']),(40000-32768,32768))
            self.assertEqual(base64.b64decode(excerpt['data']),(directory/'stderr.raw').read_bytes()[excerpt['offset']:])
            self.assertEqual(excerpt['original'],module.commands.ref(directory/'stderr.raw',out))
            self.assertLess(len(json.dumps(value).encode()),65500)
            (directory/'stderr.raw').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'reference differs'):module.failure_diagnostic(result,out,directory,lambda:None)
    def test_failed_phase_emits_diagnostic_and_still_raises_before_success_collection(self):
        parent=ROOT/'.test-data/sdk-failure-diagnostic';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            out=Path(temporary);session=module.Session.__new__(module.Session);session.out=out
            session.budget=types.SimpleNamespace(end=time.monotonic()+10,timeout=lambda cap,reserve:1,check=lambda:None)
            session.observer=types.SimpleNamespace(tighten_remaining=lambda amount:None,phase=lambda name,argv,deadline,**options:self.fixture(out,Path(options['stdoutPath']).parent))
            output=io.StringIO()
            with contextlib.redirect_stderr(output),self.assertRaisesRegex(ValueError,'Actual observer phase failed'):
                session.phase('configure',['fixed'],[],1,1)
            self.assertIn('SDK_OBSERVER_PHASE_FAILURE {',output.getvalue())
            self.assertIn('"actualRootReturnCode": 2',output.getvalue())
            self.assertNotIn('SDK_OBSERVER_PHASE_FAILURE_UNAVAILABLE',output.getvalue())

if __name__=='__main__':unittest.main()

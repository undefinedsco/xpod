"""Producer serialization tests; mocked observer does not prove kernel custody."""
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('toolchain_adapter',ROOT/'qlever/scripts/sdk-toolchain-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class AdapterTests(unittest.TestCase):
    def test_cross_directory_originals_and_actual_remaining_are_counted_once(self):
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);session=module.Session.__new__(module.Session);session.out=out
            session.directory=out/'toolchain-execution';session.directory.mkdir()
            (session.directory/'trace').write_bytes(b'123')
            stage_dir=out/'stages/configure';stage_dir.mkdir(parents=True)
            stage={}
            for field in ['receipt','stdout','stderr','trackingReceipt']:
                path=stage_dir/field;path.write_bytes(b'12345');stage[field]=module.commands.ref(path,out)
            session.phases=[stage,stage]  # Repeated refs do not duplicate originals.
            self.assertEqual(session.original_bytes(),23)
            self.assertEqual(module.remaining_source_bytes(out,limit=24),1)
            with self.assertRaisesRegex(ValueError,'remaining shared budget'):module.remaining_source_bytes(out,limit=22)

    def test_archive_refuses_before_writing_when_execution_consumed_remaining(self):
        spec=importlib.util.spec_from_file_location('inner_archive_budget',ROOT/'qlever/scripts/sdk-inner-materials.py')
        inner=importlib.util.module_from_spec(spec);spec.loader.exec_module(inner)
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            root=Path(directory);source=root/'input';source.write_bytes(b'actual input')
            with patch.object(inner,'check_budget'):
                with self.assertRaisesRegex(ValueError,'archive exceeds remaining'):
                    inner.archive_inputs([source],root/'archive',{str(source.resolve()):inner.file_identity(source)},remaining_bytes=lambda:0)
            self.assertEqual(list((root/'archive').iterdir()),[])

    def test_single_instance_typed_receipts_and_tampered_capture_rejected(self):
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        instances=[]
        class Observer:
            def __init__(self,out,*args,**kwargs):self.out=out;self.calls=[];self.maximum_stdio_bytes=kwargs['maximum_stdio_bytes'];self.maximum_bytes=kwargs['maximum_bytes'];instances.append(self)
            def tighten_remaining(self,remaining):self.remaining=remaining
            def phase(self,name,argv,deadline,**options):
                self.calls.append(name)
                for key in ['stdoutPath','stderrPath']:Path(options[key]).write_bytes(b'actual stream')
                trace=self.out/(name+'.jsonl');trace.write_bytes(b'{"sequence":1}\n')
                capture=self.out/(name+'.capture');capture.write_bytes(b'actual capture')
                ref=lambda path:dict(module.commands.ref(path,self.out),path=str(path))
                captured=ref(capture)
                if name=='compile':capture.write_bytes(b'changed capture')
                return dict(commandReceipt=dict(exit=0,signal=None,actualWait=True),trackingReceipt=dict(actualTrackedWait=True,trackedProcessesClosed=True),rawTraceShards=[ref(trace)],captureFiles=[captured])
            def abort(self):self.aborted=True
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);budget=types.SimpleNamespace(end=time.monotonic()+50,timeout=lambda cap,reserve:1)
            with patch.object(module,'load',return_value=types.SimpleNamespace(SdkExecutionObserver=Observer)):
                session=module.Session(out,'/source','/build',budget,lambda:None,1024)
                row=session.phase('configure',['fixed'],[],1,1)
                self.assertEqual(row['closureKind'],'ptrace-tracked-phase-v1')
                self.assertNotIn('supervisionReceipt',row)
                self.assertNotIn('ownedGroupAbsent',json.loads((out/row['trackingReceipt']['path']).read_text()))
                with self.assertRaisesRegex(ValueError,'Execution original changed'):session.phase('compile',['fixed'],[],1,1)
                session.abort()
                self.assertEqual(len(instances),1)
                self.assertEqual(instances[0].maximum_stdio_bytes,module.commands.RAW_LIMIT)
                self.assertGreaterEqual(instances[0].remaining,0)
                self.assertEqual(instances[0].calls,['configure','compile'])
                self.assertTrue(instances[0].aborted)

if __name__=='__main__':unittest.main()

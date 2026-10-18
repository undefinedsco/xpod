"""Producer serialization tests; mocked observer does not prove kernel custody."""
import importlib.util
import json
from pathlib import Path
import tempfile
import tarfile
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

    def test_tool_index_preserves_parent_phase_mode_and_full_shard_pending(self):
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);session=module.Session.__new__(module.Session);session.out=out;session.directory=out/'toolchain-execution';session.directory.mkdir();session.tool_files=[];session.tool_captures=set()
            payload=session.directory/'capture.original';payload.write_bytes(b'actual executable')
            ref=module.commands.ref(payload,out)
            row=dict(actualOriginalPath='/usr/bin/tool (deleted)',identity=[1,2,0o100755,ref['bytes'],3,4],actualMode=0o100755,sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase='configure',rawEventKind='toolchain-original',captureSequence=7,original=ref)
            reference=lambda original:original
            for changed,captures in [({**row,'phase':'compile'},[ref]),({**row,'actualMode':0o100644},[ref]),(row,[])]:
                with self.assertRaises(ValueError):session.tool_snapshots('configure',[changed],captures,reference)
            result=session.tool_snapshots('configure',[row],[ref],reference)
            self.assertEqual((result['files'],result['bytes']),(1,ref['bytes']))
            saved=json.loads((out/result['indexes'][0]['path']).read_text())
            self.assertEqual(saved['rows'][0],row)
            self.assertEqual(len(list(session.directory.glob('*.original'))),1)
            with self.assertRaisesRegex(ValueError,'repeated across phases'):
                session.tool_snapshots('compile',[{**row,'phase':'compile'}],[ref],reference)
            self.assertEqual(session.tool_snapshots('compile',[],[],reference),dict(indexes=[],files=0,bytes=0))
            self.assertEqual(len(session.tool_files),1)
            actual=dict(originalPath=row['actualOriginalPath'],bytes=ref['bytes'],sha256=ref['sha256'],mode=0o755)
            self.assertEqual(session.tool_input_pending(dict(files=[actual])),[])
            self.assertEqual(session.tool_input_pending(dict(files=[]))[0]['reason'],'observed-tool-file-missing-from-after-full-shard')
            self.assertEqual(session.tool_input_pending(dict(files=[{**actual,'sha256':'0'*64}]))[0]['reason'],'observed-tool-file-differs-from-after-full-shard')

    def test_new_observed_tool_is_retained_after_only_and_changed_or_deleted_is_pending(self):
        spec=importlib.util.spec_from_file_location('inner_tool_after',ROOT/'qlever/scripts/sdk-inner-materials.py')
        inner=importlib.util.module_from_spec(spec);spec.loader.exec_module(inner)
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);source=out/'new-tool';source.write_bytes(b'newly observed executable');source.chmod(0o755)
            item=source.stat();identity=[item.st_dev,item.st_ino,item.st_mode,item.st_size,item.st_mtime_ns,item.st_ctime_ns]
            actual=inner.file_identity(source);capture=out/'stop.original';capture.write_bytes(source.read_bytes())
            session=module.Session.__new__(module.Session);session.tool_files=[dict(actualOriginalPath=str(source),identity=identity,actualMode=item.st_mode,original=module.commands.ref(capture,out))]
            observed,pending=session.after_tool_inputs(inner.file_identity)
            self.assertEqual(pending,[]);self.assertIn(str(source),observed)
            before={}
            with patch.object(inner,'check_budget'):
                inventory=inner.archive_inputs([source],out/'domains',before,remaining_bytes=lambda:1024**2,observed_after=observed)
            self.assertEqual(before,{})
            self.assertEqual(inventory['pending'],[])
            self.assertEqual(inventory['files'][0]['originalPath'],str(source))
            with tarfile.open(out/inventory['shards'][0]['path']) as archive:
                self.assertEqual(archive.extractfile(str(source).lstrip('/')).read(),capture.read_bytes())
            source.write_bytes(b'changed')
            self.assertEqual(session.after_tool_inputs(inner.file_identity)[0],{})
            self.assertTrue(session.after_tool_inputs(inner.file_identity)[1])
            with patch.object(inner,'check_budget'),self.assertRaisesRegex(ValueError,'full identity changed'):
                inner.archive_inputs([source],out/'changed-domains',{},remaining_bytes=lambda:1024**2,observed_after=observed)
            source.unlink()
            self.assertEqual(session.after_tool_inputs(inner.file_identity)[0],{})
            self.assertTrue(session.after_tool_inputs(inner.file_identity)[1])
            self.assertEqual(capture.read_bytes(),b'newly observed executable')

    def test_tool_indexes_shard_without_payload_copies(self):
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);session=module.Session.__new__(module.Session);session.out=out;session.directory=out/'toolchain-execution';session.directory.mkdir();session.tool_files=[];session.tool_captures=set();rows=[];captures=[]
            for index in range(3):
                payload=session.directory/(str(index)+'.original');payload.write_bytes(bytes([index]));ref=module.commands.ref(payload,out);captures.append(ref)
                rows.append(dict(actualOriginalPath='/usr/bin/tool-'+str(index),identity=[1,index,0o100755,1,3,4],actualMode=0o100755,sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase='configure',rawEventKind='toolchain-original',captureSequence=index+1,original=ref))
            with patch.object(module,'METADATA',1200):result=session.tool_snapshots('configure',rows,captures,lambda row:row)
            self.assertGreater(len(result['indexes']),1)
            self.assertEqual(sum(len(json.loads((out/row['path']).read_text())['rows']) for row in result['indexes']),3)
            self.assertTrue(all(row['bytes']<=1200 for row in result['indexes']))
            self.assertEqual(len(list(session.directory.glob('*.original'))),3)

    def test_tool_index_refuses_insufficient_remaining_before_metadata_write(self):
        parent=ROOT/'.test-data/sdk-toolchain-adapter';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            out=Path(directory);session=module.Session.__new__(module.Session);session.out=out;session.directory=out/'toolchain-execution';session.directory.mkdir();session.tool_files=[];session.tool_captures=set()
            payload=session.directory/'capture.original';payload.write_bytes(b'one');ref=module.commands.ref(payload,out)
            row=dict(actualOriginalPath='/usr/bin/tool',identity=[1,2,0o100755,3,3,4],actualMode=0o100755,sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase='configure',rawEventKind='toolchain-original',captureSequence=1,original=ref)
            with patch.object(module,'remaining_source_bytes',return_value=0),self.assertRaisesRegex(ValueError,'remaining shared budget'):
                session.tool_snapshots('configure',[row],[ref],lambda original:original)
            self.assertEqual(list(session.directory.glob('*-tools-*.json')),[])

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
                return dict(observedToolFiles=[],commandReceipt=dict(exit=0,signal=None,actualWait=True),trackingReceipt=dict(actualTrackedWait=True,trackedProcessesClosed=True),rawTraceShards=[ref(trace)],captureFiles=[captured])
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

"""ZIP protocol fixtures only; no SDK/Git capability or authority is issued."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
scanner=load('generated_source',ROOT/'qlever/scripts/sdk-generated-source-originals.py')
fixture=load('multi_fixture',Path(__file__).with_name('test_sdk_generation_multiprocess_bindings.py'))
def scenario(change=None,tracked=False,bad_wait=False):
    rows,originals=fixture.fixture();prefix='inner/toolchain-execution/';members={prefix+'captures/'+name:bytes for name,bytes in originals.items()}
    def ref(path):return dict(path=path,bytes=len(members[path]),sha256=hashlib.sha256(members[path]).hexdigest())
    def put(path,value):members[path]=json.dumps(value).encode();return ref(path)
    rows[0]['command']=['fixed-fixture-command']
    if change:change(rows,members)
    captures=[ref(name) for name in sorted(members) if name.startswith(prefix+'captures/')]
    index=put(prefix+'capture-index-0000.json',dict(schemaVersion=1,files=captures))
    rawpath=prefix+'compile.trace-0000.jsonl';members[rawpath]=b''.join((json.dumps(row)+'\n').encode() for row in rows)
    required={r['path']:dict(bytes=r['original']['bytes'],sha256=r['original']['sha256']) for r in rows if r['kind']=='fd-capture' and r['role']=='consumer'}
    provider=prefix+'source-provider.mountinfo.raw';members[provider]=b'1 0 0:1 / / ro - overlay overlay rw\n'
    plan=dict(sourceRoot='/opt/qlever-sdk/source',sourceProviderOriginals=dict(mountinfo=ref(provider)),remainingMilliseconds=5000,phases=[dict(name='compile',actualCommand=['fixed-fixture-command'],rawTraceShards=[ref(rawpath)],captures=dict(indexes=[index],files=len(captures),bytes=sum(row['bytes'] for row in captures)))],sourceFiles={},requiredInputs=required)
    if tracked:
        # A separate actual root/wait raw phase precedes compile; all sequence
        # references are shifted with their original records, not approvals.
        reference_keys={'entrySequence','barrierSequence','captureSequence','producerCaptureSequence'}
        for row in rows:
            row['sequence']+=2
            for key in reference_keys:
                if key in row:row[key]+=2
        members[rawpath]=b''.join((json.dumps(row)+'\n').encode() for row in rows)
        configure=[dict(kind='owned-root-binding',phase='configure',sequence=1,pid=9,backend='ptrace-all-stop-process-v1',command=['fixed-fixture-command']),dict(kind='actual-wait-exit',phase='configure',sequence=2,pid=9,returnCode=0)]
        configpath=prefix+'configure.trace-0000.jsonl';members[configpath]=b''.join((json.dumps(row)+'\n').encode() for row in configure)
        plan['phases'][0]['rawTraceShards']=[ref(rawpath)]
        plan['phases'].insert(0,dict(name='configure',actualCommand=['fixed-fixture-command'],rawTraceShards=[ref(configpath)],captures=dict(indexes=[],files=0,bytes=0)))
        for phase,records in zip(plan['phases'],[configure,rows]):
            waits=[{key:row[key] for key in ['pid','sequence','returnCode','phase']} for row in records if row['kind']=='actual-wait-exit']
            phase['trackingReceipt']=dict(schemaVersion=1,kind='sdk-observer-tracked-phase-original',phase=phase['name'],command=phase['actualCommand'],actualTrackedWait=True,trackedProcessesClosed=True,actualRootPid=records[0]['pid'],actualRootReturnCode=0,waitReferences=waits)
        if bad_wait:plan['phases'][1]['trackingReceipt']['waitReferences'][0]['returnCode']=7
    base=ROOT/'.test-data/sdk-generated-source-originals';base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=base) as directory:
        archive=Path(directory)/'sdk.zip'
        with zipfile.ZipFile(archive,'w') as out:
            for path,data in members.items():out.writestr(path,data)
        return scanner.observe(archive,plan)
class Tests(unittest.TestCase):
    def test_streams_zip_capture_and_kernel_byte_relationship(self):
        result=scenario();self.assertTrue(result['selectedGeneratedConsumerByteCustodyVerified']);self.assertTrue(result['generatedInputIoClosureVerified']);self.assertFalse(result['overallSdkSourceVerified'])
    def test_actual_two_phase_waits_are_derived_and_changed_receipt_rejected(self):
        self.assertTrue(scenario(tracked=True)['actualConfigureCompileTrackedWaitVerified'])
        with self.assertRaisesRegex(ValueError,'actual kernel wait references'):scenario(tracked=True,bad_wait=True)
    def test_actual_changed_capture_rehashed_still_rejected(self):
        def change(rows,members):
            row=next(row for row in rows if row['kind']=='fd-capture' and row['role']=='consumer');data=b'change0';members['inner/toolchain-execution/captures/'+row['original']['path']]=data
            row['original'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest());row['identity'][3]=len(data)
        with self.assertRaisesRegex(ValueError,'actual generated bytes changed'):scenario(change)
    def test_uncovered_mmap_never_grants_generated_closure(self):
        def change(rows,members):rows.append(dict(kind='generated-mmap-unverified',phase='compile',sequence=len(rows)+1,path='/build/config.h'))
        result=scenario(change);self.assertTrue(result['selectedGeneratedConsumerByteCustodyVerified']);self.assertFalse(result['generatedInputIoClosureVerified']);self.assertEqual(result['uncoveredOperations'],['generated-input-mmap:/build/config.h'])
    def test_unreferenced_capture_original_rejected(self):
        def change(rows,members):members['inner/toolchain-execution/captures/capture-9999.original']=b'not-observed'
        with self.assertRaisesRegex(ValueError,'no corresponding actual FD'):scenario(change)
if __name__=='__main__':unittest.main()

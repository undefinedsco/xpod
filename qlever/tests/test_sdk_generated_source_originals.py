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
    source_files={}
    def ref(path):return dict(path=path,bytes=len(members[path]),sha256=hashlib.sha256(members[path]).hexdigest())
    def put(path,value):members[path]=json.dumps(value).encode();return ref(path)
    rows[0]['command']=['fixed-fixture-command']
    def source_read(path,data,mode=0o644):
        tail=rows[-2:];del rows[-2:]
        def emit(kind,**fields):
            row=dict(kind=kind,phase='compile',sequence=len(rows)+1,**fields);rows.append(row);return row
        entry=emit('kernel-syscall',pid=11,arch=fixture.ARCH,op='entry',nr=63,args=[3,0,len(data)])
        barrier=emit('all-stop-barrier',pids=[10,11],osStates=['t','t']);name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data
        capture=emit('fd-capture',pid=11,fd=3,entrySequence=entry['sequence'],role='source-read',path=path,identity=[1,len(originals)+100,0o100000|mode,len(data),5,6],barrierSequence=barrier['sequence'],writers=[],original=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
        emit('exclusive-captured-syscall-resume',pid=11,entrySequence=entry['sequence'],captureSequence=capture['sequence'])
        emit('kernel-syscall',pid=11,arch=fixture.ARCH,op='exit',entrySequence=entry['sequence'],result=len(data),isError=False)
        emit('exclusive-captured-syscall-exit',pid=11,entrySequence=entry['sequence'],result=len(data),isError=False)
        for row in tail:row['sequence']=len(rows)+1;rows.append(row)
        members[prefix+'captures/'+name]=data;source_files.setdefault(path,dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),mode=mode));return capture
    if change:change(rows,members,source_files,source_read) if change.__code__.co_argcount==4 else change(rows,members)
    captures=[ref(name) for name in sorted(members) if name.startswith(prefix+'captures/')]
    index=put(prefix+'capture-index-0000.json',dict(schemaVersion=1,files=captures))
    rawpath=prefix+'compile.trace-0000.jsonl';members[rawpath]=b''.join((json.dumps(row)+'\n').encode() for row in rows)
    required={r['path']:dict(bytes=r['original']['bytes'],sha256=r['original']['sha256']) for r in rows if r['kind']=='fd-capture' and r['role']=='consumer'}
    provider=prefix+'source-provider.mountinfo.raw';members[provider]=b'1 0 0:1 / / ro - overlay overlay rw\n'
    plan=dict(sourceRoot='/opt/qlever-sdk/source',sourceProviderOriginals=dict(mountinfo=ref(provider)),remainingMilliseconds=5000,phases=[dict(name='compile',actualCommand=['fixed-fixture-command'],rawTraceShards=[ref(rawpath)],captures=dict(indexes=[index],files=len(captures),bytes=sum(row['bytes'] for row in captures)))],sourceFiles=source_files,requiredInputs=required)
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
    def test_real_source_rows_are_complete_capture_inventory(self):
        def change(rows,members,source_files,source_read):
            self.source_rows=[source_read('/opt/qlever-sdk/source/src/a.c',b'alpha'),source_read('/opt/qlever-sdk/source/src/b.c',b'beta',0o755)]
        result=scenario(change)
        self.assertEqual(result['postpatchSourceReadSnapshotsMatched'],2)
        self.assertEqual(result['postpatchSourceReadCaptures'],[dict(path='/opt/qlever-sdk/source/src/a.c',bytes=5,sha256=hashlib.sha256(b'alpha').hexdigest(),mode=0o644,captures=1),dict(path='/opt/qlever-sdk/source/src/b.c',bytes=4,sha256=hashlib.sha256(b'beta').hexdigest(),mode=0o755,captures=1)])
        self.assertEqual(result['unresolvedSourceReadPaths'],[])
    def test_mismatched_expected_and_changed_mode_rejected(self):
        def expected(rows,members,source_files,source_read):source_read('/opt/qlever-sdk/source/src/a.c',b'alpha');source_files['/opt/qlever-sdk/source/src/a.c']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'actual source read snapshot differs'):scenario(expected)
        def mode(rows,members,source_files,source_read):source_read('/opt/qlever-sdk/source/src/a.c',b'alpha');source_files['/opt/qlever-sdk/source/src/a.c']['mode']=0o755
        with self.assertRaisesRegex(ValueError,'actual source read snapshot differs'):scenario(mode)
    def test_duplicate_same_path_counted_and_conflict_rejected(self):
        def duplicate(rows,members,source_files,source_read):
            source_read('/opt/qlever-sdk/source/src/a.c',b'alpha');source_read('/opt/qlever-sdk/source/src/a.c',b'alpha')
        result=scenario(duplicate);self.assertEqual(result['postpatchSourceReadCaptures'][0]['captures'],2)
    def test_unresolved_source_is_not_added(self):
        def change(rows,members,source_files,source_read):source_read('/opt/qlever-sdk/source/src/missing.c',b'gap');source_files.clear()
        result=scenario(change)
        self.assertEqual(result['postpatchSourceReadSnapshotsMatched'],0);self.assertEqual(result['postpatchSourceReadCaptures'],[]);self.assertEqual(result['unresolvedSourceReadPaths'],['/opt/qlever-sdk/source/src/missing.c'])
    def test_projection_helper_is_pure_and_enforces_capture_invariants(self):
        row=dict(path='/source/a.c',identity=[1,2,0o100644,3,4,5]);paths={};digest=(3,'a'*64)
        first=scanner.retain_postpatch_source_read_capture(row,digest,paths);self.assertEqual(first,dict(path='/source/a.c',bytes=3,sha256='a'*64,mode=0o644,captures=1))
        second=scanner.retain_postpatch_source_read_capture(row,digest,paths);self.assertIs(second,first);self.assertEqual(second['captures'],2)
        with self.assertRaisesRegex(ValueError,'bytes/sha256/mode changed'):scanner.retain_postpatch_source_read_capture(dict(row,identity=[1,2,0o100600,3,4,5]),digest,paths)
if __name__=='__main__':unittest.main()

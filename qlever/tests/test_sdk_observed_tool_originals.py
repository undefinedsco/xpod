"""Pure retained-original joins; synthetic records do not prove ptrace execution."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('observed_tools',ROOT/'qlever/scripts/sdk-observed-tool-originals.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ToolOriginalTests(unittest.TestCase):
    def fixture(self,change=None):
        originals={}
        def ref(name,data):
            if not isinstance(data,bytes):data=(json.dumps(data)+'\n').encode()
            originals[name]=data;return dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
        payload=ref('inner/toolchain-execution/captures/capture-0001.original',b'actual executable')
        identity=[1,2,0o100755,payload['bytes'],1760000000000000001,1760000000000000003]
        raw=dict(kind='toolchain-original',captureKind='file',observedPath='/usr/bin/tool',identity=identity,original=dict(payload,path='capture-0001.original'),sequence=3,phase='configure')
        descriptor=dict(actualOriginalPath='/usr/bin/tool',identity=identity.copy(),actualMode=identity[2],sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase='configure',rawEventKind='toolchain-original',captureSequence=3,original=payload)
        verified=[dict(observedPath=raw['observedPath'],identity=identity,original=raw['original'])]
        if change:change(descriptor,raw,payload,verified)
        tools=ref('inner/toolchain-execution/configure-tools-0000.json',dict(schemaVersion=1,rows=[descriptor]))
        captures=ref('inner/toolchain-execution/configure-captures-0000.json',dict(schemaVersion=1,files=[payload]))
        trace=ref('inner/toolchain-execution/configure.raw',raw)
        end=ref('inner/toolchain-execution/compile.raw',dict(kind='end',sequence=4,phase='compile'))
        after=dict(originalPath='/usr/bin/tool',bytes=payload['bytes'],sha256=payload['sha256'],mode=0o755)
        plan=dict(remainingMilliseconds=10000,verifiedRows=[after],verifiedToolSnapshots=verified,phases=[dict(name='configure',rawTraceShards=[trace],captures=dict(indexes=[captures],files=1,bytes=payload['bytes']),toolFileSnapshots=dict(indexes=[tools],files=1,bytes=payload['bytes'])),dict(name='compile',rawTraceShards=[end],captures=dict(indexes=[],files=0,bytes=0),toolFileSnapshots=dict(indexes=[],files=0,bytes=0))])
        return originals,plan
    def replace_trace(self,originals,phase,parts):
        for ref in phase['rawTraceShards']:originals.pop(ref['path'])
        phase['rawTraceShards']=[]
        for index,data in enumerate(parts):
            name='inner/toolchain-execution/'+phase['name']+'.trace-'+str(index)+'.jsonl'
            originals[name]=data;phase['rawTraceShards'].append(dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
    def indexed_fixture(self,change=None,*,split=False):
        originals,plan=self.fixture(change)
        for phase in plan['phases']:
            encoder=module.raw_records.IndexedRawEncoder();parts=[]
            for ref in phase['rawTraceShards']:
                for line in originals[ref['path']].splitlines():parts.extend(encoder.encode(json.loads(line)))
            self.replace_trace(originals,phase,parts if split else [b''.join(parts)])
        return originals,plan
    def run_fixture(self,originals,plan):
        parent=ROOT/'.test-data/sdk-observed-tool-test';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            archive=Path(directory)/'original.zip'
            with zipfile.ZipFile(archive,'w') as z:
                for name,data in originals.items():z.writestr(name,data)
            return module.observe(archive,plan)
    def test_same_raw_full_payload_after_only_preserves_exact_ns(self):
        files,plan=self.fixture();result=self.run_fixture(files,plan)
        self.assertEqual(result['pending'],[]);self.assertFalse(result['wholeToolchainVerified']);self.assertFalse(result['sourceClosureVerified'])
        self.assertFalse(result['files'][0]['observedBeforeCompile']);self.assertEqual(result['files'][0]['identityDecimal'][-1],'1760000000000000003')
    def test_one_nanosecond_descriptor_change_rejected(self):
        files,plan=self.fixture(lambda d,*_:d['identity'].__setitem__(5,d['identity'][5]+1))
        with self.assertRaisesRegex(ValueError,'stop identity'):self.run_fixture(files,plan)
    def test_wrong_phase_sequence_mode_or_parent_rejected(self):
        changes=[lambda d,*_:d.update(phase='compile'),lambda d,*_:d.update(captureSequence=4),lambda d,*_:d.update(actualMode=0o100644),lambda d,r,p,v:p.update(path='inner/toolchain-execution/captures/unknown')]
        for change in changes:
            with self.subTest(change=change):
                files,plan=self.fixture(change)
                with self.assertRaises(ValueError):self.run_fixture(files,plan)
    def test_private_execution_universe_cannot_omit_or_replace(self):
        files,plan=self.fixture();plan['verifiedToolSnapshots']=[]
        with self.assertRaisesRegex(ValueError,'private execution'):self.run_fixture(files,plan)
    def test_missing_or_different_after_stays_specific_pending(self):
        files,plan=self.fixture();plan['verifiedRows']=[]
        self.assertEqual(self.run_fixture(files,plan)['pending'][0]['reason'],'observed-tool-file-missing-from-after-full-shard')
        files,plan=self.fixture();plan['verifiedRows'][0]['sha256']='0'*64
        self.assertEqual(self.run_fixture(files,plan)['pending'][0]['reason'],'observed-tool-file-differs-from-after-full-shard')
    def test_payload_mutation_is_not_descriptor_authority(self):
        files,plan=self.fixture();files['inner/toolchain-execution/captures/capture-0001.original']=b'changed content!!'
        with self.assertRaises(ValueError):self.run_fixture(files,plan)
    def test_expired_rejected_without_archive(self):
        _,plan=self.fixture();plan['remainingMilliseconds']=0
        with self.assertRaisesRegex(ValueError,'deadline'):module.observe('/must-not-open',plan)
    def test_indexed_full_tool_join_equals_legacy(self):
        originals,plan=self.fixture();expected=self.run_fixture(originals,plan)
        originals,plan=self.indexed_fixture();actual=self.run_fixture(originals,plan)
        self.assertEqual(actual,expected);self.assertEqual(len(actual['files']),1)
        self.assertEqual(actual['files'][0]['identityDecimal'][-1],'1760000000000000003')
    def test_indexed_schema_and_row_cross_shards_and_reset_per_phase(self):
        originals,plan=self.indexed_fixture(split=True)
        self.assertEqual([len(phase['rawTraceShards']) for phase in plan['phases']],[3,3])
        self.assertEqual(len(self.run_fixture(originals,plan)['files']),1)
    def test_indexed_malformed_or_incomplete_streams_rejected(self):
        header=[module.raw_records.RAW_RECORD_MODEL]
        cases=[
            [header],
            [header,['schema',0,['phase']]],
            [header,['row',0,['configure']]],
            [header,['schema',0,['phase']],['row',0,[]]],
            [header,['schema',0,['phase']],['row',1,['configure']]],
            [header,['schema',0,['phase']],['schema',1,['sequence']]],
            [header,{'phase':'configure','sequence':1}],
            [{'phase':'configure','sequence':1},header],
            [header,['schema',0,['phase']],['row',0,['configure']],['schema',1,['phase']]],
        ]
        for values in cases:
            with self.subTest(values=values):
                originals,plan=self.indexed_fixture()
                self.replace_trace(originals,plan['phases'][0],[(json.dumps(value)+'\n').encode() for value in values])
                with self.assertRaises((AssertionError,ValueError,TypeError,KeyError)):self.run_fixture(originals,plan)
    def test_indexed_unfinished_line_and_missing_phase_header_rejected(self):
        for missing_header in [False,True]:
            with self.subTest(missing_header=missing_header):
                originals,plan=self.indexed_fixture(split=True);phase=plan['phases'][1]
                parts=[originals[ref['path']] for ref in phase['rawTraceShards']]
                if missing_header:parts=parts[1:]
                else:parts[-1]=parts[-1][:-1]
                self.replace_trace(originals,phase,parts)
                with self.assertRaises((AssertionError,ValueError)):self.run_fixture(originals,plan)
    def test_indexed_physical_and_decoded_range_bounds_rejected(self):
        for size in [65400,65536]:
            with self.subTest(size=size):
                originals,plan=self.indexed_fixture();values=[[module.raw_records.RAW_RECORD_MODEL],['schema',0,['x'*128]],['row',0,['a'*size]]]
                self.replace_trace(originals,plan['phases'][0],[(json.dumps(value,separators=(',',':'))+'\n').encode() for value in values])
                with self.assertRaises((AssertionError,ValueError)):self.run_fixture(originals,plan)
    def test_indexed_custody_and_order_constraints_still_rejected(self):
        changes=[lambda d,r,*_:d.update(captureSequence=r['sequence']+1),lambda d,r,*_:r.update(phase='compile'),lambda d,r,*_:r.update(sequence=False),lambda d,*_:d['identity'].__setitem__(5,d['identity'][5]+1)]
        for change in changes:
            with self.subTest(change=change):
                originals,plan=self.indexed_fixture(change)
                with self.assertRaises(ValueError):self.run_fixture(originals,plan)
        originals,plan=self.indexed_fixture();plan['verifiedToolSnapshots']=[]
        with self.assertRaisesRegex(ValueError,'private execution'):self.run_fixture(originals,plan)
        originals,plan=self.indexed_fixture();originals['inner/toolchain-execution/captures/capture-0001.original']=b'changed content!!'
        with self.assertRaises(ValueError):self.run_fixture(originals,plan)
    def test_indexed_trailing_metadata_after_valid_event_rejected(self):
        originals,plan=self.indexed_fixture(split=True);phase=plan['phases'][0]
        parts=[originals[ref['path']] for ref in phase['rawTraceShards']]
        parts.append((json.dumps(['schema',1,['pending']])+'\n').encode())
        self.replace_trace(originals,phase,parts)
        with self.assertRaisesRegex(AssertionError,'incomplete indexed'):self.run_fixture(originals,plan)
    def test_indexed_repeated_sequence_across_shards_rejected(self):
        originals,plan=self.indexed_fixture(split=True);phase=plan['phases'][0]
        parts=[originals[ref['path']] for ref in phase['rawTraceShards']]
        parts.append(parts[-1]);self.replace_trace(originals,phase,parts)
        with self.assertRaisesRegex(ValueError,'ordered same-phase'):self.run_fixture(originals,plan)
    def test_indexed_trace_digest_is_still_verified(self):
        originals,plan=self.indexed_fixture(split=True)
        plan['phases'][0]['rawTraceShards'][0]['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'SHA/size'):self.run_fixture(originals,plan)
if __name__=='__main__':unittest.main()

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
if __name__=='__main__':unittest.main()

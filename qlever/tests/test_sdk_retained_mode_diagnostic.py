"""Diagnostics consume retained in-memory identities, never a new file body."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

path=Path(__file__).resolve().parents[1]/'scripts/sdk-ptrace-execution.py'
spec=importlib.util.spec_from_file_location('retained_mode_diagnostic',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Tests(unittest.TestCase):
    def run_diagnostic(self,states=(),path='/build/output',output=None):
        producer=dict(sequence=11,identity=[1,2,33188,9,100,200])
        stream=output if output is not None else io.StringIO()
        with patch.object(module.os,'open',side_effect=AssertionError('no new FD')),patch.object(module.os,'pread',side_effect=AssertionError('no body read')),contextlib.redirect_stderr(stream):
            module.retained_mode_difference_diagnostic(8,6,path,producer,producer['identity'],[1,2,33261,9,300,400],[],list(states))
        return stream

    def test_retained_identity_and_only_same_inode_candidates_are_reported(self):
        states=[(dict(sequence=12,beforeIdentity=[1,2,33188,9,100,200]),dict(sequence=13,afterIdentity=[1,2,33261,9,300,400])),
                (dict(sequence=14,beforeIdentity=[3,4,33188,9,100,200]),dict(sequence=15,afterIdentity=[3,4,33261,9,300,400]))]
        text=self.run_diagnostic(states).getvalue();row=json.loads(text.split(' ',1)[1])
        self.assertEqual(row['producerCaptureSequence'],11);self.assertEqual(row['producerIdentity'][2],33188)
        self.assertEqual(row['actualRetainedIdentity'][2],33261);self.assertEqual(len(row['recentModeCandidates']),1)
        self.assertEqual(row['recentModeCandidates'][0]['transitionSequence'],13)
        self.assertFalse(row['authorityVerified']);self.assertLessEqual(len(text.encode()),4096)

    def test_large_history_and_path_have_explicit_bounded_samples(self):
        states=[(dict(sequence=i,beforeIdentity=[1,2,33188,9,100,200]),dict(sequence=i+1,afterIdentity=[1,2,33261,9,300,400])) for i in range(100)]
        path='/build/'+'x'*10000;text=self.run_diagnostic(states,path).getvalue();row=json.loads(text.split(' ',1)[1])
        self.assertTrue(row['candidateScanTruncated']);self.assertEqual(row['candidateCountInLast64'],64)
        self.assertEqual(len(row['recentModeCandidates']),4);self.assertTrue(row['pathTruncated'])
        self.assertEqual(row['pathSha256'],hashlib.sha256(path.encode()).hexdigest());self.assertLessEqual(len(text.encode()),4096)

    def test_broken_diagnostic_output_cannot_replace_original_guard(self):
        class Closed:
            def write(self,_):raise OSError('closed')
        self.run_diagnostic(output=Closed())

if __name__=='__main__':unittest.main()

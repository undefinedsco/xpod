"""Pure raw protocol tests; actual Linux execution is separately queued."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('empty_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
    def rows(self):
        identity=[44,1234,33152,0,100,100];flags=655362
        rows=[dict(kind='owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1'),dict(kind='kernel-syscall',pid=7,arch=0xc000003e,op='entry',nr=0,args=[4,1000,8,0,0,0]),dict(kind='all-stop-barrier',pids=[7],osStates=['t']),dict(kind='empty-read-window',pid=7,fd=4,path='/build/temporary.o',identity=identity,flags=flags,entrySequence=2,barrierSequence=3,writers=[dict(pid=7,fd=4,flags=flags,accessMode=2)]),dict(kind='exclusive-empty-read-resume',pid=7,entrySequence=2,captureSequence=4),dict(kind='kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=2,result=0,isError=False),dict(kind='empty-read-eof',pid=7,entrySequence=2,windowSequence=4,exitSequence=6,identity=identity,result=0,isError=False),dict(kind='exclusive-captured-syscall-exit',pid=7,entrySequence=2,result=0,isError=False),dict(kind='actual-wait-exit',pid=7,returnCode=0)]
        return [dict(row,sequence=i+1,phase='configure') for i,row in enumerate(rows)]
    def run_rows(self,rows):return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:self.fail('EOF is not a captured input'),{})
    def test_eof_is_not_input_or_producer(self):
        result=self.run_rows(self.rows());self.assertEqual(result['observedEmptyReadEofWindows'],1);self.assertEqual(result['outputs'],[]);self.assertEqual(result['preparedInputConsumers'],[]);self.assertEqual(result['observedSourceReadCaptures'],0);self.assertFalse(result['overallSdkSourceVerified'])
    def test_nonzero_read_nonempty_identity_multiwriter_and_changed_inode_reject(self):
        for mutation in ['result','size','writer','identity','missing-eof']:
            rows=copy.deepcopy(self.rows())
            if mutation=='result':rows[5]['result']=1;rows[6]['result']=1
            elif mutation=='size':rows[3]['identity'][3]=1
            elif mutation=='writer':rows[3]['writers'].append(dict(pid=8,fd=4,flags=2,accessMode=2))
            elif mutation=='identity':rows[6]['identity']=list(rows[6]['identity']);rows[6]['identity'][1]=4321
            else:rows[6]['kind']='ptrace-event'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.run_rows(rows)
if __name__=='__main__':unittest.main()

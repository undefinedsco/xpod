"""Actual namespace/metadata relation protocol; no suffix normalization authority."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('namespace_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
    def fixture(self):
        rows=[];originals={'capture-0000.original':b'abc'};before=[44,123,0o100644,3,1,1];after=[44,123,0o100755,3,1,2];ref=dict(path='capture-0000.original',bytes=3,sha256=hashlib.sha256(b'abc').hexdigest());arch=0xc00000b7
        def emit(kind,**values):rows.append(dict(kind=kind,phase='configure',sequence=len(rows)+1,**values));return len(rows)
        def call(nr,args):return emit('kernel-syscall',pid=7,arch=arch,op='entry',nr=nr,args=args)
        def end(entry,n):return emit('kernel-syscall',pid=7,arch=arch,op='exit',entrySequence=entry,result=n,isError=False)
        def barrier():return emit('all-stop-barrier',pids=[7],osStates=['t'])
        emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1');entry=call(57,[4]);b=barrier();producer=emit('fd-capture',pid=7,fd=4,entrySequence=entry,barrierSequence=b,role='producer-close',path='/build/retained (deleted)',identity=before,writers=[dict(pid=7,fd=4)],original=ref);emit('exclusive-captured-syscall-resume',pid=7,entrySequence=entry,captureSequence=producer);end(entry,0);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=entry,result=0,isError=False)
        entry=call(53,[-100,1000,0o100755]);b=barrier();window=emit('actual-mode-window',pid=7,path='/build/final',entrySequence=entry,barrierSequence=b,beforeIdentity=before,requestedMode=0o100755);emit('exclusive-mode-resume',pid=7,entrySequence=entry,captureSequence=window);exit=end(entry,0);mode=emit('actual-mode-transition',pid=7,entrySequence=entry,windowSequence=window,exitSequence=exit,afterIdentity=after,result=0,isError=False);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=entry,result=0,isError=False)
        entry=call(63,[3,1000,10]);b=barrier();consumer=emit('fd-capture',pid=7,fd=3,entrySequence=entry,barrierSequence=b,role='consumer',path='/build/final',identity=after,writers=[],original=ref);emit('retained-fd-namespace-binding',producerCaptureSequence=producer,consumerCaptureSequence=consumer,path='/build/final',namedIdentity=after,retainedIdentity=after,modeTransitions=[mode]);emit('generated-consumer-binding',captureSequence=consumer,producerCaptureSequence=producer,path='/build/final',identity=after,retainedIdentity=after);emit('exclusive-captured-syscall-resume',pid=7,entrySequence=entry,captureSequence=consumer);end(entry,3);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=entry,result=3,isError=False);emit('actual-wait-exit',pid=7,returnCode=0);return rows,originals
    def inspect(self,rows,originals):return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda name,_:originals[name],{})
    def test_same_retained_named_fd_and_actual_chmod(self):
        rows,originals=self.fixture();result=self.inspect(rows,originals);self.assertEqual(result['observedNamedRetainedFdBindings'],1);self.assertEqual(result['observedActualModeTransitions'],1);self.assertEqual(result['outputs'][0]['path'],'/build/final');self.assertFalse(result['overallSdkSourceVerified'])
    def test_different_inode_unobserved_mode_or_request_reject(self):
        for mutation in ['inode','missing-mode','request','missing-namespace']:
            rows,originals=self.fixture()
            if mutation=='inode':row=next(r for r in rows if r['kind']=='retained-fd-namespace-binding');row['namedIdentity']=list(row['namedIdentity']);row['namedIdentity'][1]=999
            elif mutation=='missing-mode':next(r for r in rows if r['kind']=='retained-fd-namespace-binding')['modeTransitions']=[]
            elif mutation=='request':next(r for r in rows if r['kind']=='actual-mode-window')['requestedMode']=0o100644
            else:next(r for r in rows if r['kind']=='retained-fd-namespace-binding')['kind']='ptrace-event'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows,originals)
if __name__=='__main__':unittest.main()

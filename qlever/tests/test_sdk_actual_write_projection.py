"""Pure byte transformation, not a ptrace, SDK, or compiler authority test."""
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('write_projection',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def chunks(value):return (value[i:i+65536] for i in range(0,len(value),65536))
class Tests(unittest.TestCase):
    def verify(self,before,buffer,after,offset,count):return m.verify_write_bytes(chunks(before),chunks(buffer),chunks(after),len(before),offset,count,1024**2)
    def test_actual_compiler_sparse_shape_and_partial_overwrite(self):
        self.assertEqual(self.verify(b'',b'x'*155,bytes(1144)+b'x'*155,1144,155),1299)
        self.assertEqual(self.verify(b'abcdef',b'XYzz',b'abXYef',2,2),6)
        self.assertEqual(self.verify(b'abcdef',b'XY',b'abcdef',2,0),6)
        value=b'a'*70000;self.assertEqual(self.verify(value,b'b'*70000,value[:65530]+b'b'*70000,65530,70000),135530)
    def test_changed_bytes_unrelated_copy_extra_tail_and_short_buffer_reject(self):
        for before,buffer,after,offset,count in [(b'',b'x',b'y',0,1),(b'a',b'b',b'bz',0,1),(b'abc',b'x',b'axc',1,2),(b'',b'x',b'x',100,1)]:
            with self.subTest(after=after),self.assertRaises(ValueError):self.verify(before,buffer,after,offset,count)

class ProtocolTests(unittest.TestCase):
    def fixture(self):
        import hashlib
        rows=[];originals={};arch=0xc000003e;before=[44,123,33152,0,1,1];after=[44,123,33152,3,2,2];flags=655362
        def emit(kind,**values):
            row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**values);rows.append(row);return row['sequence']
        def original(data):
            name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('write-original',original=ref);return ref
        emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1')
        write=emit('kernel-syscall',pid=7,arch=arch,op='entry',nr=1,args=[4,1000,3,0,0,0]);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);pre=original(b'');buffer=original(b'abc')
        window=emit('actual-write-window',pid=7,fd=4,path='/build/object.o',entrySequence=write,barrierSequence=barrier,beforeIdentity=before,before=pre,buffer=buffer,offset=0,position=0,flags=flags,writers=[dict(pid=7,fd=4)],baseline='empty')
        emit('exclusive-write-resume',pid=7,entrySequence=write,captureSequence=window);exit=emit('kernel-syscall',pid=7,arch=arch,op='exit',entrySequence=write,result=3,isError=False);post=original(b'abc')
        transition=emit('actual-write-transition',pid=7,entrySequence=write,windowSequence=window,exitSequence=exit,afterIdentity=after,after=post,result=3,isError=False);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=write,result=3,isError=False)
        read=emit('kernel-syscall',pid=7,arch=arch,op='entry',nr=0,args=[4,1000,10,0,0,0]);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);capture=emit('fd-capture',pid=7,fd=4,entrySequence=read,barrierSequence=barrier,path='/build/object.o',role='readwrite-consumer',identity=after,original=post,writers=[dict(pid=7,fd=4,flags=flags,accessMode=2)])
        emit('actual-write-consumer-binding',captureSequence=capture,transitionSequence=transition,path='/build/object.o',identity=after,readOffset=0);emit('exclusive-captured-syscall-resume',pid=7,entrySequence=read,captureSequence=capture);exit=emit('kernel-syscall',pid=7,arch=arch,op='exit',entrySequence=read,result=3,isError=False)
        emit('actual-write-consumer-exit',pid=7,entrySequence=read,captureSequence=capture,exitSequence=exit,identity=after,bytes=3,sha256=post['sha256'],readOffset=0,positionAfter=3,result=3,isError=False);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=read,result=3,isError=False);emit('actual-wait-exit',pid=7,returnCode=0)
        return rows,originals
    def inspect(self,rows,originals):
        import json
        return m.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,_:originals[name],{})
    def test_actual_write_then_read_has_distinct_origin_not_close(self):
        rows,originals=self.fixture();result=self.inspect(rows,originals);self.assertEqual(result['observedActualWriteTransitions'],1);self.assertEqual(result['outputs'][0]['origin'],'actual-exclusive-write-transition');self.assertNotIn('producerCaptureSequence',result['outputs'][0]);self.assertFalse(result['overallSdkSourceVerified'])
    def test_self_consistent_payload_tamper_and_other_writer_reject(self):
        import copy,hashlib
        rows,originals=self.fixture();bad=copy.deepcopy(rows);values=dict(originals);ref=next(row for row in bad if row['kind']=='actual-write-window')['buffer'];values[ref['path']]=b'xyz';digest=hashlib.sha256(b'xyz').hexdigest()
        for row in bad:
            if row['kind']=='write-original' and row['original']['path']==ref['path']:row['original']['sha256']=digest
        ref['sha256']=digest
        with self.assertRaisesRegex(ValueError,'post-write bytes'):self.inspect(bad,values)
        bad=copy.deepcopy(rows);next(row for row in bad if row['kind']=='actual-write-window')['writers'].append(dict(pid=8,fd=4))
        with self.assertRaisesRegex(ValueError,'another alias'):self.inspect(bad,originals)

if __name__=='__main__':unittest.main()

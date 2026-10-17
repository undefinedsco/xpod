import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('multi',Path(__file__).resolve().parents[1]/'scripts/sdk-generation-multiprocess-bindings.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ARCH=0xc00000b7

def fixture():
    rows=[];originals={};caps=0
    def emit(kind,**fields):
        row=dict(kind=kind,phase='compile',sequence=len(rows)+1,**fields);rows.append(row);return row
    def entry(nr,args):return emit('kernel-syscall',pid=11,arch=ARCH,op='entry',nr=nr,args=args)
    def exit(call,result):return emit('kernel-syscall',pid=11,arch=ARCH,op='exit',entrySequence=call['sequence'],result=result,isError=False)
    def capture(call,role,path,identity,data):
        nonlocal caps
        barrier=emit('all-stop-barrier',pids=[10,11],osStates=['t','t']);name='capture-'+str(caps).zfill(4)+'.original';caps+=1;originals[name]=data
        cap=emit('fd-capture',pid=11,fd=3,entrySequence=call['sequence'],role=role,path=path,identity=identity,barrierSequence=barrier['sequence'],writers=[dict(pid=11,fd=3)] if role=='producer-close' else [],original=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
        emit('exclusive-captured-syscall-resume',pid=11,entrySequence=call['sequence'],captureSequence=cap['sequence']);return cap
    def close_exclusive(call,result):exit(call,result);emit('exclusive-captured-syscall-exit',pid=11,entrySequence=call['sequence'],result=result,isError=False)
    emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1');emit('actual-child-binding',parentPid=10,childPid=11,event=1)
    for index,name in enumerate(['config.h','generated.h','custom.h']):
        final='/build/'+name;temporary=final+'.tmp' if index<2 else final;data=('header'+str(index)).encode();identity=[1,index+3,0o100600,len(data),5,6];after=[1,index+3,0o100600,len(data),5,8]
        close=entry(57,[3]);producer=capture(close,'producer-close',temporary,identity,data);close_exclusive(close,0)
        if index<2:
            rename=entry(38,[0,0,0,0]);emit('kernel-path-arguments',pid=11,entrySequence=rename['sequence'],renamePaths=[temporary,final]);exit(rename,0);emit('retained-fd-rename-binding',pid=11,producerCaptureSequence=producer['sequence'],entrySequence=rename['sequence'],fromPath=temporary,toPath=final,identity=after,retainedIdentity=after)
        read=entry(63,[3,0,100]);consumer=capture(read,'consumer',final,after,data);close_exclusive(read,len(data));emit('generated-consumer-binding',captureSequence=consumer['sequence'],producerCaptureSequence=producer['sequence'],path=final,identity=after,retainedIdentity=after,actualBytesEqual=False) # This boolean is deliberately ignored.
    emit('actual-wait-exit',pid=11,returnCode=0);emit('actual-wait-exit',pid=10,returnCode=0);return rows,originals

def observe(rows,originals):return module.observe([('compile',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,maximum:originals[name])
class MultiGenerationTests(unittest.TestCase):
    def test_all_three_original_relations_not_serialized_approval(self):
        rows,originals=fixture();result=observe(rows,originals);self.assertTrue(result['selectedGeneratedConsumerByteCustodyVerified']);self.assertEqual(len(result['outputs']),3);self.assertFalse(result['overallSdkSourceVerified'])
    def test_missing_writer_stop_alias_or_exclusive_window_rejects(self):
        mutations=[lambda rows:next(r for r in rows if r['kind']=='all-stop-barrier').__setitem__('pids',[11]),lambda rows:next(r for r in rows if r['kind']=='fd-capture')['writers'].append(dict(pid=10,fd=4)),lambda rows:next(r for r in rows if r['kind']=='kernel-syscall' and r['op']=='exit').__setitem__('pid',10),lambda rows:next(r for r in rows if r['kind']=='retained-fd-rename-binding')['retainedIdentity'].__setitem__(1,99)]
        for mutate in mutations:
            rows,originals=fixture();mutate(rows)
            with self.assertRaises(ValueError):observe(rows,originals)
    def test_prepared_input_uses_original_byte_chain_but_not_generated_approval(self):
        rows,originals=fixture();consumer=next(row for row in rows if row['kind']=='fd-capture' and row['role']=='consumer')
        original=dict(kind='prepared-build-input-original',path=consumer['path'],identity=consumer['identity'],original=dict(consumer['original']),phase='compile',sequence=1)
        digest=hashlib.sha256((json.dumps({key:original[key] for key in ['path','identity','original']},sort_keys=True)+'\n').encode()).hexdigest()
        seal=dict(kind='prepared-build-input-seal',buildRoot='/build',files=1,inventorySha256=digest,phase='compile',sequence=2)
        for row in rows:
            row['sequence']+=2
            for key in ['entrySequence','barrierSequence','captureSequence','producerCaptureSequence']:
                if key in row:row[key]+=2
        binding=next(row for row in rows if row['kind']=='generated-consumer-binding');binding['kind']='prepared-consumer-binding';binding['producerCaptureSequence']=1
        rows[:0]=[original,seal]
        report=observe(rows,originals);self.assertTrue(report['preparedInputConsumerBytesVerified']);self.assertFalse(report['selectedGeneratedConsumerByteCustodyVerified']);self.assertEqual(len(report['outputs']),2)
        changed=next(row for row in rows if row['kind']=='fd-capture' and row['role']=='consumer');name='capture-9999.original';originals[name]=b'change0';changed['original']=dict(path=name,bytes=7,sha256=hashlib.sha256(originals[name]).hexdigest())
        with self.assertRaisesRegex(ValueError,'prepared consumer bytes'):observe(rows,originals)
    def test_actual_changed_bytes_rehashed_still_reject(self):
        rows,originals=fixture();cap=next(r for r in rows if r['kind']=='fd-capture' and r['role']=='consumer');name=cap['original']['path'];originals[name]=b'change0';cap['original'].update(bytes=7,sha256=hashlib.sha256(originals[name]).hexdigest());cap['identity'][3]=7
        with self.assertRaises(ValueError):observe(rows,originals)
if __name__=='__main__':unittest.main()

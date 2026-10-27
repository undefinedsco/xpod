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
    def test_metadata_chain_diagnostic_distinguishes_path_and_identity_without_leaking(self):
        """FAIL-ONLY suffix: fixed schema, bounded, path redacted, prefix preserved."""
        base=[2049,100,33188,10,111,222]
        producer=dict(sequence=10,path='/build/token=SECRET-DO-NOT-LEAK/x.h',identity=base)
        def fail(consumer,states=()):
            with self.assertRaises(ValueError) as caught:
                module.retained_metadata_chain(producer,consumer,list(states))
            message=str(caught.exception)
            self.assertTrue(message.startswith('multi-process generation originals: retained metadata chain final full identity/path differs'))
            self.assertNotIn('SECRET-DO-NOT-LEAK',message)
            payload=json.loads(message.split('metadata-chain-diagnostic=',1)[1])
            return payload
        # path-only: identity equal, path differs
        path_only=fail(dict(sequence=30,path='/build/other.h',identity=base))
        self.assertEqual(path_only['schemaVersion'],1)
        self.assertEqual(path_only['identityMismatchFields'],[])
        self.assertTrue(path_only['composedPathDiffers'])
        self.assertEqual(path_only['producerIdentity'],base)
        self.assertEqual(path_only['composedIdentity'],base)
        self.assertEqual(path_only['consumerIdentity'],base)
        self.assertEqual(path_only['producerSequence'],10)
        self.assertEqual(path_only['consumerSequence'],30)
        self.assertEqual(len(path_only['producerPathSha256']),64)
        self.assertEqual(path_only['producerPathBytes'],len(producer['path'].encode()))
        self.assertEqual(path_only['metadataReferenceCount'],0)
        # identity-only: path equal, exactly one six-field divergence
        changed=list(base);changed[5]=base[5]+1
        identity_only=fail(dict(sequence=30,path=producer['path'],identity=changed))
        self.assertFalse(identity_only['composedPathDiffers'])
        self.assertEqual(identity_only['identityMismatchFields'],[5])
        self.assertEqual(identity_only['consumerIdentity'],changed)
        self.assertEqual(identity_only['composedIdentity'],base)
        # malformed inputs fall back to the fixed token; the prefix and error stay intact
        for bad in [base[:5],['a']*6,[-1,0,0,0,0,0],[1<<70,0,0,0,0,0],[True,0,0,0,0,0]]:
            with self.assertRaises(ValueError) as caught:
                module.retained_metadata_chain(producer,dict(sequence=30,path=producer['path'],identity=bad),[])
            message=str(caught.exception)
            self.assertTrue(message.startswith('multi-process generation originals: retained metadata chain final full identity/path differs'))
            self.assertIn('metadata-chain-diagnostic=unavailable',message)
    def test_metadata_chain_diagnostic_rejects_oversized_work_before_encode_or_join(self):
        """Oversized path/list inputs fall back BEFORE encoding, hashing or joining."""
        base=[2049,100,33188,10,111,222]
        # character bound is checked before encode
        self.assertIsNone(module._path_summary('/build/'+'a'*5000))
        self.assertIsNotNone(module._path_summary('/build/x.h'))
        # The CHARACTER cap is the binding one: 4096 chars of a 4-byte character
        # is exactly 16384 bytes, so no string can pass the char cap and exceed the
        # byte cap. A multi-byte path within the char cap is admitted; a path over
        # it is rejected by the CHAR check (this is NOT a byte-overflow test).
        max_unicode='/build/'+'\U0001F600'*4089
        self.assertEqual(len(max_unicode),4096)
        self.assertEqual(len(max_unicode.encode()),16363)
        self.assertEqual(module._path_summary(max_unicode)[1],16363)
        self.assertIsNone(module._path_summary(max_unicode+'x'))
        # an admitted multi-byte path still summarizes with its encoded byte length
        admitted='/build/'+'\u00e9'*400
        self.assertEqual(module._path_summary(admitted)[1],len(admitted.encode()))
        # reference count bound is checked before any iteration/join
        self.assertIsNone(module._subsequence_summary(list(range(4097))))
        self.assertEqual(module._subsequence_summary([20,21])[0],2)
        # any non-int / out-of-range entry anywhere (not only the tail) is rejected;
        # the full-length lists put the bad value OUTSIDE the trailing 8
        for bad_value in [-1,1<<70,True,1.5,'7']:
            self.assertIsNone(module._subsequence_summary([bad_value]+list(range(20))),bad_value)
            self.assertIsNone(module._subsequence_summary(list(range(20))+[bad_value]),bad_value)
        # a clean 21-entry list still summarizes with a bounded tail
        clean=module._subsequence_summary(list(range(21)))
        self.assertEqual(clean[0],21)
        self.assertEqual(clean[1],list(range(13,21)))
        # wrong container type is rejected
        for bad in [None,(1,2),'12',{1:'a'}]:
            self.assertIsNone(module._subsequence_summary(bad))
        # and the caller-level failure still keeps the original prefix + fixed token
        producer=dict(sequence=10,path='/build/'+'a'*5000,identity=base)
        with self.assertRaises(ValueError) as caught:
            module.retained_metadata_chain(producer,dict(sequence=30,path='/build/other.h',identity=base),[])
        text=str(caught.exception)
        self.assertTrue(text.startswith('multi-process generation originals: retained metadata chain final full identity/path differs'))
        self.assertIn('metadata-chain-diagnostic=unavailable',text)
        self.assertNotIn('aaaa',text)
    def test_metadata_chain_success_references_and_bounds_unchanged(self):
        """Success path returns exactly the matching references; no suffix is added."""
        base=[2049,100,33188,10,111,222];after=[2049,100,33188,10,111,333]
        producer=dict(sequence=10,path='/build/x.h',identity=base)
        window=dict(kind='actual-rename-window',producerCaptureSequence=10,fromPath='/build/x.h',toPath='/build/y.h',beforeIdentity=base)
        self.assertEqual(module.retained_metadata_chain(producer,dict(sequence=30,path='/build/y.h',identity=after),[(window,dict(sequence=20,afterIdentity=after))]),[20])
        # a long but internally consistent chain keeps every reference, while the
        # diagnostic renders at most the last 8 plus the count and a digest
        long_producer=dict(sequence=10,path='/build/x.h',identity=base)
        states=[];current=list(base);sequence=20
        for _ in range(20):
            following=list(current);following[5]=current[5]+1
            states.append((dict(kind='actual-mode-window',path='/build/x.h',beforeIdentity=list(current)),
                           dict(sequence=sequence,afterIdentity=following)))
            current=following;sequence+=1
        with self.assertRaises(ValueError) as caught:
            module.retained_metadata_chain(long_producer,dict(sequence=99,path='/build/x.h',identity=current[:5]+[current[5]+99]),states)
        payload=json.loads(str(caught.exception).split('metadata-chain-diagnostic=',1)[1])
        self.assertEqual(payload['metadataReferenceCount'],20)
        self.assertEqual(len(payload['metadataReferenceLast']),8)
        self.assertEqual(payload['metadataReferenceLast'][-1],39)
        self.assertEqual(len(payload['metadataReferenceDigest']),64)
    def test_actual_changed_bytes_rehashed_still_reject(self):
        rows,originals=fixture();cap=next(r for r in rows if r['kind']=='fd-capture' and r['role']=='consumer');name=cap['original']['path'];originals[name]=b'change0';cap['original'].update(bytes=7,sha256=hashlib.sha256(originals[name]).hexdigest());cap['identity'][3]=7
        with self.assertRaises(ValueError):observe(rows,originals)
if __name__=='__main__':unittest.main()

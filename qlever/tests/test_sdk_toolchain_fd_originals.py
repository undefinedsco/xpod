"""Actual file byte snapshots and raw protocol math, not an SDK capability."""
import copy
import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import struct
import tempfile
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tool_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend);bindings=backend.bindings

def elf():
    interp=b'/lib/ld-test.so.1\0';header=bytearray(64);header[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HHI',header,16,3,62,1);struct.pack_into('<Q',header,32,64);struct.pack_into('<HHH',header,52,64,56,1)
    program=bytearray(56);struct.pack_into('<I',program,0,3);struct.pack_into('<Q',program,8,120);struct.pack_into('<Q',program,32,len(interp))
    return bytes(header+program)+interp

def fixture():
    originals={'capture-0000.original':elf(),'capture-0001.original':b'1000-2000 r-xp 00000000 01:00 2 /usr/bin/compiler\n'}
    def ref(name):return dict(path=name,bytes=len(originals[name]),sha256=hashlib.sha256(originals[name]).hexdigest())
    binary, maps=ref('capture-0000.original'),ref('capture-0001.original');identity=[os.makedev(1,0),2,0o100755,len(elf()),5,6]
    rows=[dict(kind='owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1'),dict(kind='kernel-syscall',pid=10,arch=0xc000003e,op='entry',nr=59,args=[1,2,3,0,0,0]),dict(kind='ptrace-event',pid=10,event=4),dict(kind='all-stop-barrier',pids=[10],osStates=['t']),dict(kind='toolchain-original',captureKind='file',observedPath='/usr/bin/compiler',identity=identity,original=binary),dict(kind='toolchain-original',captureKind='maps',observedPid=10,original=maps),dict(kind='toolchain-exec-image-capture',pid=10,barrierSequence=4,execEntrySequence=2,execEventSequence=3,exe=dict(resolvedPath='/usr/bin/compiler',identity=identity,original=binary),elf=bindings.elf_interpreter(lambda offset,size:elf()[offset:offset+size],len(elf())),mapsOriginal=maps),dict(kind='toolchain-mapping-original',pid=10,barrierSequence=4,parentCaptureSequence=7,mapping=bindings.parse_proc_maps(originals[maps['path']])[0],identity=identity,original=binary,actualFd=None),dict(kind='kernel-syscall',pid=10,arch=0xc000003e,op='exit',entrySequence=2,result=0,isError=False),dict(kind='actual-wait-exit',pid=10,returnCode=0)]
    for sequence,row in enumerate(rows,1):row.update(sequence=sequence,phase='configure')
    return rows,originals

def observe(rows,originals):
    return bindings.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,maximum:originals[name],{})

class Tests(unittest.TestCase):
    def test_elf_and_actual_maps_parser_are_shared_and_bounded(self):
        data=elf();self.assertEqual(bindings.elf_interpreter(lambda offset,size:data[offset:offset+size],len(data)),dict(machine=62,interpreter='/lib/ld-test.so.1'))
        for raw in [b'not maps\n',b'2000-1000 r-xp 00000000 01:00 2 /file\n']:
            with self.assertRaises(ValueError):bindings.parse_proc_maps(raw)
        corrupted=bytearray(data);corrupted[18]=1
        with self.assertRaises(ValueError):bindings.elf_interpreter(lambda offset,size:corrupted[offset:offset+size],len(corrupted))
    def test_actual_file_snapshot_reuses_unchanged_identity_and_rehashes_changed_bytes(self):
        base=ROOT/'.test-data/sdk-toolchain-fd';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();file=root/'executable';file.write_bytes(elf());observer=backend.Observer(out,root,root);observer.deadline=time.monotonic()+5;observer.current_phase='configure';observer.raw=(out/'raw').open('xb')
            fd=os.open(file,os.O_RDONLY)
            try:
                first=observer.tool_original(fd,str(file));self.assertIs(observer.tool_original(fd,str(file)),first)
                file.write_bytes(elf()+b'changed');second=observer.tool_original(fd,str(file));self.assertNotEqual(first['original']['sha256'],second['original']['sha256']);self.assertEqual(len(observer.captures),2)
            finally:os.close(fd);observer.raw.close();observer.close()
    def _reuse_observer(self,root,out,maximum_bytes=32*1024**2):
        observer=backend.Observer(out,root,root);observer.deadline=time.monotonic()+30;observer.current_phase='compile'
        observer.capture_content_entities=True;observer.maximum_file_bytes=8*1024**2;observer.maximum_bytes=maximum_bytes
        observer.raw=(out/'raw').open('xb');self.addCleanup(observer.raw.close);self.addCleanup(observer.close);return observer
    def test_tool_original_same_bytes_different_inode_keeps_two_identities_one_body(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'Q'*(131072+17);a=root/'tool-a';b=root/'tool-b';a.write_bytes(data);b.write_bytes(data)
            observer=self._reuse_observer(root,out);fa=os.open(a,os.O_RDONLY);fb=os.open(b,os.O_RDONLY);self.addCleanup(os.close,fa);self.addCleanup(os.close,fb)
            first=observer.tool_original(fa,str(a),pid=10,fd=3);physical=observer.capture_bytes;body_claim=observer.claim_bytes['capture-body']
            second=observer.tool_original(fb,str(b),pid=10,fd=4)
            self.assertIn('originalReuse',second);self.assertEqual(first['original'],second['original']);self.assertNotEqual(first['identity'],second['identity'])
            self.assertEqual(second['originalReuse']['originCaptureSequence'],first['sequence']);self.assertEqual(second['originalEntityIdentity'],first['originalEntityIdentity'])
            self.assertEqual(observer.capture_bytes,physical);self.assertEqual(observer.claim_bytes['capture-body'],body_claim);self.assertEqual(len(observer.captures),2);self.assertEqual(len(observer.capture_entities),1)
            self.assertEqual(len(observer.phase_capture_files(0)),1)
    def test_tool_original_same_inode_different_path_emits_both_path_rows(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'H'*(131072+9);a=root/'tool-a';b=root/'tool-b';a.write_bytes(data);os.link(a,b);observer=self._reuse_observer(root,out)
            fa=os.open(a,os.O_RDONLY);fb=os.open(b,os.O_RDONLY);self.addCleanup(os.close,fa);self.addCleanup(os.close,fb)
            first=observer.tool_original(fa,str(a),pid=20,fd=3);physical=observer.capture_bytes
            second=observer.tool_original(fb,str(b),pid=20,fd=4)
            self.assertEqual(first['identity'],second['identity']);self.assertNotEqual(first['observedPath'],second['observedPath']);self.assertIn('originalReuse',second);self.assertEqual(first['original'],second['original']);self.assertEqual(first['originalEntityIdentity'],second['originalEntityIdentity'])
            self.assertEqual(observer.capture_bytes,physical);self.assertEqual(len(observer.captures),2);self.assertEqual(len(observer.capture_entities),1);self.assertEqual(len(observer.phase_capture_files(0)),1)
            observed=observer.observed_tool_files(0,'compile');self.assertEqual({row['actualOriginalPath'] for row in observed},{str(a),str(b)});self.assertEqual(len({row['captureSequence'] for row in observed}),2)
    def test_tool_original_unique_over_budget_fails_before_write_with_bounded_context(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'U'*65537;path=root/'tool';path.write_bytes(data);observer=self._reuse_observer(root,out)
            fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd);start=observer.domain_bytes;observer.maximum_bytes=start+len(data)-1;capture=io.StringIO()
            with contextlib.redirect_stderr(capture),self.assertRaises(AssertionError):observer.tool_original(fd,str(path),pid=11,fd=7)
            self.assertEqual(observer.domain_bytes,start);self.assertEqual(observer.capture_bytes,0);self.assertEqual(getattr(observer,'chunk_reserved',0),0);self.assertEqual(observer.captures,[]);self.assertFalse((out/'capture-0000.original').exists())
            line=next(line for line in capture.getvalue().splitlines() if line.startswith('SDK_TOOL_ORIGINAL_BOUND '));payload=json.loads(line.split(' ',1)[1])
            self.assertEqual(payload['kind'],'tool-original-byte-bound');self.assertEqual(payload['pid'],11);self.assertEqual(payload['fd'],7);self.assertEqual(payload['fileSize'],len(data));self.assertEqual(payload['observedPath'],str(path));self.assertEqual(payload['requestedBytes'],len(data))
            self.assertTrue(payload['observedComplete']);self.assertEqual(payload['observedWholeSha256'],hashlib.sha256(data).hexdigest());self.assertFalse(payload['retained']);self.assertEqual(payload['readOffset']+payload['attemptedBytes'],len(data));self.assertGreater(payload['attemptedBytes'],0);self.assertLess(payload['freeBytes'],payload['requestedBytes'])
    def test_tool_original_partial_write_failure_releases_reservation_and_removes_partial(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'P'*(131072+1);path=root/'tool';path.write_bytes(data);observer=self._reuse_observer(root,out)
            fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd);start=observer.domain_bytes;calls=0;pread=os.pread
            def read(reader,size,offset):
                nonlocal calls
                calls+=1
                if calls==4:raise OSError('injected second-pass read failure')
                return pread(reader,size,offset)
            with patch.object(backend.os,'pread',side_effect=read),self.assertRaises(OSError):observer.tool_original(fd,str(path),pid=12,fd=8)
            self.assertEqual(observer.domain_bytes,start);self.assertEqual(observer.capture_bytes,0);self.assertEqual(getattr(observer,'chunk_reserved',0),0);self.assertEqual(observer.captures,[]);self.assertFalse((out/'capture-0000.original').exists())
    def test_tool_original_corrupt_retained_entity_is_rejected(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'C'*131089;a=root/'a';b=root/'b';a.write_bytes(data);b.write_bytes(data);observer=self._reuse_observer(root,out)
            fa=os.open(a,os.O_RDONLY);fb=os.open(b,os.O_RDONLY);self.addCleanup(os.close,fa);self.addCleanup(os.close,fb)
            first=observer.tool_original(fa,str(a),pid=13,fd=9);physical=observer.capture_bytes;(out/first['original']['path']).write_bytes(b'Z'*len(data))
            with self.assertRaises(AssertionError):observer.tool_original(fb,str(b),pid=13,fd=10)
            self.assertEqual(observer.capture_bytes,physical);self.assertEqual(len(observer.captures),1)
    def test_tool_original_changed_named_window_is_rejected_without_partial(self):
        base=ROOT/'.test-data/sdk-tool-original-reuse';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);out=root/'originals';out.mkdir();data=b'A'*(131072+1);path=root/'tool';path.write_bytes(data);observer=self._reuse_observer(root,out)
            fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd);start=observer.domain_bytes;calls=0;pread=os.pread
            def read(reader,size,offset):
                nonlocal calls
                calls+=1
                if calls==4:path.write_bytes(b'B'*len(data))
                return pread(reader,size,offset)
            with patch.object(backend.os,'pread',side_effect=read),self.assertRaises(AssertionError):observer.tool_original(fd,str(path),pid=14,fd=11)
            self.assertEqual(observer.domain_bytes,start);self.assertEqual(observer.capture_bytes,0);self.assertEqual(observer.captures,[]);self.assertFalse((out/'capture-0000.original').exists())
    def test_no_held_preuse_inode_refuses_without_a_mapping_claim(self):
        """NEGATIVE CONTROL: absent held pre-use inode must still fail closed.

        The current Observer resolves a mapping only through the continuously held
        pre-use lease (`tool_mapping` -> `lifetime_by_identity` ->
        `duplicate_reader`). With no held inode the mapping must be refused as
        unresolved and no mapping original/provider may be emitted. This deliberately
        does NOT assert the retired `actual-map-files-FD-unavailable` string: that hook
        no longer exists in the product, so pinning it would pass for the wrong reason.
        """
        base=ROOT/'.test-data/sdk-toolchain-fd';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            out=Path(directory);observer=backend.Observer(out,out,out);observer.deadline=time.monotonic()+5;observer.current_phase='configure';observer.raw=(out/'raw').open('xb')
            try:
                mapping=bindings.parse_proc_maps(b'1000-2000 r-xp 00000000 01:00 2 /file\n')[0]
                row=observer.tool_mapping(10,mapping,3,4)
                self.assertEqual(row['kind'],'toolchain-unresolved')
                self.assertEqual(row['reason'],'actual-VMA-has-no-unique-pre-use-held-inode')
                self.assertNotIn('original',row)
                self.assertNotIn('providerSequence',row)
                self.assertNotIn('mappingBackingModel',row)
            finally:observer.raw.close();observer.close()

    def test_held_lease_duplicate_reader_denial_stays_fail_closed(self):
        """NEGATIVE CONTROL: a refused duplicate_reader must not yield a claim.

        With exactly one held pre-use inode present the mapping can only proceed by
        borrowing that inode via `LifetimeLeases.duplicate_reader`. If the borrow is
        refused the observer must propagate the refusal; it may never fall back to
        opening the path or to an unverified original.
        """
        base=ROOT/'.test-data/sdk-toolchain-fd';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            out=Path(directory);observer=backend.Observer(out,out,out);observer.deadline=time.monotonic()+5;observer.current_phase='configure';observer.raw=(out/'raw').open('xb')
            lease_set=None;handler_before=signal.getsignal(signal.SIGIO)
            try:
                device=os.makedev(1,0)
                # A real LeaseSet is required: tool_mapping borrows through it, and the
                # observer only creates one inside a traced phase. Use the class seam.
                # A production `phase()`/`run_phase()` owns this set and closes it in its
                # own finally; this unit test injects one OUTSIDE a phase, so it must
                # own and close that real set itself. `LeaseSet.close()` releases the
                # held FDs and restores the process-global SIGIO handler it installed;
                # without this the handler leaks into every later LeaseSet in the same
                # process. Ownership stays with the real set: nothing is mocked and no
                # global signal state is edited directly.
                lease_set=observer.lifetime_leases_class()
                observer.lifetime_leases=lease_set
                observer.lifetime_by_identity[(device,2)]=dict(token=dict(identity=[device,2,0o100755,0,5,6]),sequence=1)
                mapping=bindings.parse_proc_maps(b'1000-2000 r-xp 00000000 01:00 2 /file\n')[0]
                lease_error=backend.lifetime_leases.LeaseError
                with patch.object(observer.lifetime_leases,'duplicate_reader',side_effect=lease_error('held reader identity changed')):
                    with self.assertRaises(lease_error):observer.tool_mapping(10,mapping,3,4)
            finally:
                try:
                    if lease_set is not None:lease_set.close()
                finally:
                    observer.lifetime_leases=None;observer.raw.close();observer.close()
            # The process-global SIGIO handler must be back to what it was, so the
            # next real LeaseSet in this process can still take ownership.
            self.assertIs(signal.getsignal(signal.SIGIO),handler_before)
    def test_raw_exec_fd_elf_and_vma_original_relations_do_not_grant_source_closure(self):
        rows,originals=fixture();report=observe(rows,originals);self.assertEqual(report['toolchainActualExecImages'],1);self.assertEqual(report['toolchainActualFileMappings'],1);self.assertFalse(report['toolchainSourceClosureVerified'])
        changed=copy.deepcopy(rows);changed[6]['execEntrySequence']=1
        with self.assertRaisesRegex(ValueError,'exec entry'):observe(changed,originals)
        changed=copy.deepcopy(rows);changed[7]['mapping']['inode']=99;new=dict(originals);new['capture-0001.original']=b'1000-2000 r-xp 00000000 01:00 99 /usr/bin/compiler\n';changed[5]['original'].update(bytes=len(new['capture-0001.original']),sha256=hashlib.sha256(new['capture-0001.original']).hexdigest())
        with self.assertRaisesRegex(ValueError,'VMA inode'):observe(changed,new)

class VmaRangeTests(unittest.TestCase):
    def test_successful_actual_range_permissions_and_split_offsets(self):
        maps=bindings.parse_proc_maps(b'1000-2000 r-xp 00000000 08:01 55 /tool\n2000-3000 r-xp 00001000 08:01 55 /tool\n')
        self.assertEqual(len(bindings.verify_vma_range(maps,0x1800,0x1000,5)),2)
        for begin,length,prot in [(0x800,4096,5),(0x1000,0x3000,5),(0x1000,4096,7),((1<<64)-1,2,1)]:
            with self.assertRaises(ValueError):bindings.verify_vma_range(maps,begin,length,prot)
        self.assertIn(329,bindings.policy(0xc000003e)['protect']);self.assertIn(288,bindings.policy(0xc00000b7)['protect'])
    def fixture(self,flags=2):
        import os
        rows=[];originals={};identity=[os.makedev(8,1),55,0o100444,4096,1,1];mapping=b'1000-2000 r-xp 00000000 08:01 55 /tool\n'
        def emit(kind,**v):rows.append(dict(kind=kind,sequence=len(rows)+1,phase='configure',**v));return len(rows)
        def original(data,kind,**v):
            name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('toolchain-original',captureKind=kind,original=ref,**v);return ref
        emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1');entry=emit('kernel-syscall',pid=7,arch=0xc000003e,op='entry',nr=9,args=[0,4096,5,flags,3,0]);exit=emit('kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=entry,result=0x1000,isError=False);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);file=original(bytes(4096),'file',identity=identity,observedPath='/tool');maps=original(mapping,'maps',observedPid=7);fd=dict(fd=3,identity=identity,original=file)
        core=emit('toolchain-file-mapping-capture',pid=7,barrierSequence=barrier,entrySequence=entry,exitSequence=exit,actualReturnedAddressHex='1000',actualFd=fd,requestedLength=4096,fileOffset=0,flags=flags,protection=5,mapsOriginal=maps)
        emit('toolchain-mapping-original',pid=7,parentCaptureSequence=core,barrierSequence=barrier,mapping=bindings.parse_proc_maps(mapping)[0],actualFd=fd,identity=identity,original=file);emit('actual-wait-exit',pid=7,returnCode=0);return rows,originals
    def inspect(self,rows,originals):return bindings.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda n,_:originals[n],{})
    def test_actual_exit_va_and_anonymous_flags_override_valid_fd(self):
        rows,originals=self.fixture();self.assertEqual(self.inspect(rows,originals)['toolchainActualFileMappings'],1)
        bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='toolchain-file-mapping-capture')['actualReturnedAddressHex']='2000'
        with self.assertRaises(ValueError):self.inspect(bad,originals)
        rows,originals=self.fixture(2|32)
        with self.assertRaisesRegex(ValueError,'MAP_ANONYMOUS'):self.inspect(rows,originals)

class AnonymousProtectionTests(unittest.TestCase):
    def test_actual_anonymous_rw_to_rwx_is_explicit_pending(self):
        rows=[];originals={}
        def emit(kind,**values):rows.append(dict(kind=kind,sequence=len(rows)+1,phase='configure',**values));return len(rows)
        def maps(permissions):
            data=('1000-2000 '+permissions+' 00000000 00:00 0\n').encode();name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('toolchain-original',captureKind='maps',observedPid=7,original=ref);return ref
        emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1');entry=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='entry',nr=226,args=[0x1000,4096,7,0,0,0]);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);before=maps('rw-p');emit('toolchain-executable-protection-before',pid=7,entrySequence=entry,barrierSequence=barrier,mapsOriginal=before);exit=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='exit',entrySequence=entry,result=0,isError=False);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);after=maps('rwxp');emit('toolchain-executable-protection-capture',pid=7,entrySequence=entry,exitSequence=exit,barrierSequence=barrier,actualSyscall=226,requestedStartHex='1000',requestedLength=4096,protection=7,beforeMapsOriginal=before,afterMapsOriginal=after);emit('actual-wait-exit',pid=7,returnCode=0)
        result=bindings.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,_:originals[name],{})
        self.assertIn('anonymous-or-JIT-mapping-source-unresolved',result['toolchainPending']);self.assertEqual(result['toolchainActualFileMappings'],0);self.assertFalse(result['toolchainSourceClosureVerified'])

if __name__=='__main__':unittest.main()

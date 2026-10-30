"""Actual file byte snapshots and raw protocol math, not an SDK capability."""
import copy
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

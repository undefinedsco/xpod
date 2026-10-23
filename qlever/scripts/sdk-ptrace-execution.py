"""Single all-stop Linux execution backend shared by diagnostics and SDK capture.

The caller owns the absolute phase deadline and the outer SDK owner lifecycle.
No strace tracer may be attached concurrently. This library emits observations;
it never issues source/SDK/native authority.
"""
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import math
import re
import select
import os
from pathlib import Path
import signal
import stat
import sys
import time
import threading
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
probe=load('sdk_execution_originals_util',ROOT/'qlever/scripts/sdk-execution-originals-util.py')
bindings=load('multi_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py')
single=load('sdk_ptrace_kernel',ROOT/'qlever/scripts/sdk-ptrace-kernel.py')
owned_wait=load('owned_wait',ROOT/'qlever/scripts/sdk-blocking-owned-wait.py')
tool_providers=load('tool_providers',ROOT/'qlever/scripts/sdk-tool-provider-originals.py')
generated_vma_module=load('generated_vma_originals',ROOT/'qlever/scripts/sdk-generated-vma-originals.py')
chunk_store=load('sdk_chunk_originals',ROOT/'qlever/scripts/sdk-original-chunk-store.py')
lifetime_leases=load('sdk_tool_lifetime_leases',ROOT/'qlever/scripts/sdk-tool-lifetime-leases.py')
raw_wire_codec=load('sdk_raw_wire_codec',ROOT/'qlever/scripts/sdk-raw-wire-codec.py')
memory_policy=load('sdk_executable_memory_policy',ROOT/'qlever/scripts/sdk-executable-memory-policy.py')
LIFETIME_MODEL='kernel-held-read-lease-v1'
LIFETIME_MAXIMUM_DEPTH=8
LIFETIME_OPEN_ERRORS=frozenset([errno.EACCES,errno.EPERM,errno.ENOENT,errno.ENOTDIR,errno.ELOOP,errno.ENAMETOOLONG,errno.ESTALE,errno.ENXIO,errno.ESRCH])

class CaptureReservation:
    """One snapshot reservation in the observer's existing source-byte ledger."""
    def __init__(self,observer):self.observer=observer;self.reserved=0;self.active=False;self.committed_bytes=0
    def reserve(self,count):
        b=self.observer;b.check_budget()
        with b.domain_lock:
            assert not self.active and type(count) is int and count>=0
            generated=getattr(b,'generated_vma',None)
            assert b.domain_bytes+getattr(b,'chunk_reserved',0)+(generated.reserved if generated else 0)+count<=b.maximum_bytes,'shared capture reservation bound'
            b.chunk_reserved=getattr(b,'chunk_reserved',0)+count;self.reserved=count;self.active=True
    def commit(self,count):
        b=self.observer
        with b.domain_lock:
            assert self.active and type(count) is int and 0<=count<=self.reserved
            b.domain_bytes+=count;b.claim_bytes['capture-body']+=count;self.committed_bytes+=count
            b.chunk_reserved-=count;self.reserved-=count
    def release(self):
        b=self.observer
        with b.domain_lock:
            assert self.active
            b.chunk_reserved-=self.reserved;self.reserved=0;self.active=False
SEIZE=0x4206;INTERRUPT=0x4207;GETEVENTMSG=0x4201;SYSCALL=24;WALL=0x40000000
OPTIONS=1|2|4|8|16|32|64|0x00100000
MAX=16*1024**2
def close_child_observer_retained(descriptors):
    """Drop observer-only fork copies before the initial authority barrier.

    These private read leases remain held by the parent. CLOEXEC would close
    them only after exec, which is later than the initial stopped-root census.
    """
    values=tuple(descriptors)
    assert all(type(fd) is int and fd>2 and not os.get_inheritable(fd) for fd in values),'private close-on-exec observer descriptors required'
    for fd in values:os.close(fd)

def retained_mode_difference_diagnostic(pid,fd,path,producer,current,actual,mode_refs,metadata_states):
    """Explain an existing rejection using already captured identities only."""
    try:
        candidates=[]
        for window,change in metadata_states[-64:]:
            before=window['beforeIdentity'];after=change['afterIdentity']
            if before[:2]==actual[:2] or after[:2]==actual[:2]:
                candidates.append(dict(windowSequence=window['sequence'],transitionSequence=change['sequence'],beforeIdentity=before,afterIdentity=after))
        value=dict(kind='retained-producer-mode-difference',pid=pid,fd=fd,
                   path=path[:128],pathTruncated=len(path)>128,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),
                   producerCaptureSequence=producer['sequence'],producerIdentity=producer['identity'],
                   observedChainIdentity=current,actualRetainedIdentity=actual,
                   modeTransitionSequences=mode_refs[-8:],modeTransitionCount=len(mode_refs),
                   recentModeCandidates=candidates[-4:],candidateCountInLast64=len(candidates),
                   candidateScanTruncated=len(metadata_states)>64 or len(candidates)>4,
                   authorityVerified=False,scope='rejection diagnostic only; held producer bytes already checked; no inferred chmod or source authority')
        line='SDK_RETAINED_PRODUCER_MODE_CHANGED '+json.dumps(value,sort_keys=True,separators=(',',':'))+'\n'
        if len(line.encode())<=4096:sys.stderr.write(line)
    except BaseException:
        pass  # Never replace the existing mode-chain rejection.
def retained_rename_path_absent(path):
    try:os.lstat(path)
    except FileNotFoundError:return True
    return False
SELECTED={'config.h','generated.h','custom.h'}
def profile(arch):return bindings.policy(arch)
def fdpath(pid,fd):
    try:return os.readlink('/proc/'+str(pid)+'/fd/'+str(fd))
    except FileNotFoundError:return None

def descriptor_flags(pid,fd):
    text=Path('/proc',str(pid),'fdinfo',str(fd)).read_text();rows=[x.split()[1] for x in text.splitlines() if x.startswith('flags:')];assert len(rows)==1;return int(rows[0],8)
def descriptor_position(pid,fd):
    rows=[line.split()[1] for line in Path('/proc',str(pid),'fdinfo',str(fd)).read_text().splitlines() if line.startswith('pos:')];assert len(rows)==1;return int(rows[0])
def state(pid):
    fields=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split();return fields[0]

def path_argument(pid,dirfd,address):
    value=single.cstring(pid,address)
    if value.startswith('/'):return os.path.normpath(value)
    base=os.readlink('/proc/'+str(pid)+'/cwd') if dirfd in [0xffffffffffffff9c,0xffffff9c,-100] else fdpath(pid,dirfd)
    assert base and base.startswith('/');return os.path.normpath(base+'/'+value)

class ShardedRaw:
    def __init__(self,out,name,maximum):
        self.out=out;self.name_prefix=name;self.maximum=maximum;self.total=0;self.paths=[];self.file=None;self.open_next()
    def open_next(self):
        path=self.out/(self.name_prefix+'.trace-'+str(len(self.paths)).zfill(4)+'.jsonl');self.file=path.open('xb');self.paths.append(path)
    def write(self,data):
        assert len(data)<=65536 and len(data)<=self.maximum,'raw record/shard bound'
        if self.file.tell()+len(data)>self.maximum:self.file.flush();os.fsync(self.file.fileno());self.file.close();self.open_next()
        self.file.write(data);self.total+=len(data)
    def flush(self):self.file.flush()
    def tell(self):return self.total
    def close(self):self.file.flush();os.fsync(self.file.fileno());self.file.close()

class EncodedShardedRaw:
    def __init__(self,observer,name,maximum):
        self.observer=observer;self.name_prefix=name;self.maximum=maximum;self.paths=[];self.references={};self.writer=None;self.current_logical=0;self.total=0;self.finished=False;self.open_next()
    def charge(self,count):
        self.observer.claim(count,category='raw-wire');self.total+=count
    def open_next(self):
        path=self.observer.out/(self.name_prefix+'.trace-'+str(len(self.paths)).zfill(4)+'.jsonl.gz');self.paths.append(path)
        self.writer=raw_wire_codec.RawWriter(path,claim=self.charge,check=self.observer.check,maximum_logical=self.maximum,maximum_encoded=self.maximum)
        self.current_logical=0
    def finish_current(self):
        self.references[str(self.paths[-1])]=self.writer.finish()
    def write(self,data):
        assert not self.finished,'raw stream already closed'
        if self.current_logical+len(data)>self.maximum:self.finish_current();self.open_next()
        self.writer.write_record(data);self.current_logical+=len(data)
    def flush(self):pass  # gzip buffering is bounded; finish owns the trailer/fsync.
    def tell(self):return self.total
    def finish(self):
        if not self.finished:self.finish_current();self.finished=True
    def close(self):
        if not self.finished:self.writer.abort()


def actual_executable(command):
    assert isinstance(command,list) and command,'actual argv required'
    executable='/usr/bin/bash' if command[0]=='bash' else command[0]
    assert os.path.isabs(executable),'fixed absolute executable required'
    return executable

class BoundedPipePump:
    """One owned pipe, bounded before writing any bytes to its original file."""
    def __init__(self,descriptor,path,maximum,claim,errors):
        self.descriptor=descriptor;self.path=Path(path);self.maximum=maximum;self.claim=claim;self.errors=errors
        self.bytes=0;self.sha256=None;self.thread=threading.Thread(target=self.run,daemon=True)
    def run(self):
        digest=hashlib.sha256()
        try:
            with self.path.open('xb') as output:
                while True:
                    block=os.read(self.descriptor,65536)
                    if not block:break
                    assert self.bytes+len(block)<=self.maximum,'actual stdio single-stream byte bound'
                    self.claim(len(block));output.write(block);self.bytes+=len(block);digest.update(block)
                output.flush();os.fsync(output.fileno());self.sha256=digest.hexdigest()
        except BaseException as error:self.errors.append(str(error))
        finally:os.close(self.descriptor)
    def start(self):self.thread.start()
    def finish(self,check):
        while self.thread.is_alive():check();self.thread.join(.05)
        check();assert self.sha256 is not None,'actual stdio pipe did not close'

def completed_capture_storage_census(rows,phase):
    """Bounded failure-only lower bound from existing complete raw references."""
    seen={};buckets={};visited=0;matched=0;truncated=False;invalid=False
    for row in reversed(rows):
        if visited>=8192:truncated=True;break
        visited+=1
        if not isinstance(row,dict) or row.get('phase')!=phase:continue
        matched+=1
        ref=row.get('original',{});name=ref.get('path');size=ref.get('bytes');digest=ref.get('sha256')
        if not isinstance(name,str) or not re.fullmatch(r'capture-[0-9]{4,}\.original',name) or type(size) is not int or size<0 or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):invalid=True;continue
        key=(size,digest)
        if name in seen:
            if seen[name]!=key:invalid=True
            continue
        if len(seen)>=4096:truncated=True;continue
        seen[name]=key;bucket=buckets.setdefault(key,dict(physicalEntities=0,consumerEntities=0));bucket['physicalEntities']+=1
        if row.get('kind')=='fd-capture' and row.get('role')=='consumer':bucket['consumerEntities']+=1
    duplicates=[dict(bytes=size,sha256=digest,**value,potentialDuplicatePhysicalBytes=(value['physicalEntities']-1)*size) for (size,digest),value in buckets.items() if value['physicalEntities']>1]
    duplicates.sort(key=lambda row:(-row['potentialDuplicatePhysicalBytes'],row['sha256']))
    return dict(kind='same-phase-physical-content-census',phase=phase,scanOrder='newest-first',availableObservations=len(rows),matchedPhaseObservations=matched,visitedObservations=visited,distinctPhysicalReferences=len(seen),maximumVisitedObservations=8192,maximumPhysicalReferences=4096,truncated=truncated,invalidReferenceMetadata=invalid,topBuckets=duplicates[:4],duplicateBucketCount=len(duplicates),potentialDuplicatePhysicalBytesLowerBound=sum(row['potentialDuplicatePhysicalBytes'] for row in duplicates),scope='same complete bytes/SHA storage only; no source identity, actual reuse eligibility, or IO saving proven')

class Observer:
    def __init__(self,out,source,build,*,deadline_monotonic=None,check_budget=lambda:None,maximum_bytes=32*1024**2,maximum_file_bytes=1024**2,selected_names=SELECTED,maximum_processes=128,shard_bytes=None,require_success=True,maximum_stdio_bytes=None,shared_tasks=False,capture_toolchain=False,deny_optional_io_uring=False,verified_setresuid_noop=False,verified_identity_noop=False,terminal_exit_evidence=False,generated_vma_output=False,generated_vma_shared_mm=False,generated_vma_private_wake=False,generated_vma_private_wait_mismatch=False,capture_content_entities=False,queued_identity_noop=False,stopped_writer_aliases=False,generated_vma_coordinated_wait=False,generated_vma_parked_wait=False,io_uring_enosys_v2=False,serialize_terminal_syscalls=False,capture_maps_content_entities=False,retained_generated_metadata=False,indexed_raw_records=False,compressed_raw=False,generated_build_root=generated_vma_module.BUILD_ROOT):
        assert type(indexed_raw_records) is bool
        self.indexed_raw_records=indexed_raw_records
        self.prepared_dependency_plan=None;self.dependency_roots={};self.dependency_cache=None
        self.shared_tasks=shared_tasks
        assert type(deny_optional_io_uring) is bool
        self.deny_optional_io_uring=deny_optional_io_uring
        assert type(verified_setresuid_noop) is bool
        assert type(verified_identity_noop) is bool and not (verified_identity_noop and verified_setresuid_noop),'one explicit identity transition model required'
        self.verified_setresuid_noop=verified_setresuid_noop
        self.verified_identity_noop=verified_identity_noop
        assert type(queued_identity_noop) is bool and (not queued_identity_noop or verified_identity_noop and capture_toolchain),'queued identity requires actual identity/authority observation'
        self.queued_identity_noop=queued_identity_noop
        assert type(stopped_writer_aliases) is bool and (not stopped_writer_aliases or shared_tasks and capture_toolchain),'stopped alias writes require tracked authority and FD tables'
        self.stopped_writer_aliases=stopped_writer_aliases
        assert type(generated_vma_coordinated_wait) is bool and (not generated_vma_coordinated_wait or generated_vma_private_wait_mismatch and generated_vma_shared_mm),'coordinated wait requires existing stopped-MM private wait model'
        self.generated_vma_coordinated_wait=generated_vma_coordinated_wait
        assert type(generated_vma_parked_wait) is bool and (not generated_vma_parked_wait or generated_vma_coordinated_wait),'parked wait requires coordinated same-MM wait model'
        self.generated_vma_parked_wait=generated_vma_parked_wait
        assert type(io_uring_enosys_v2) is bool and (not io_uring_enosys_v2 or deny_optional_io_uring),'v2 ENOSYS requires explicit optional syscall denial'
        self.io_uring_enosys_v2=io_uring_enosys_v2
        assert type(terminal_exit_evidence) is bool
        self.terminal_exit_evidence=terminal_exit_evidence
        assert type(serialize_terminal_syscalls)is bool and(not serialize_terminal_syscalls or terminal_exit_evidence and shared_tasks),'serialized terminal syscalls require shared strict exit evidence'
        self.serialize_terminal_syscalls=serialize_terminal_syscalls;self.terminal_focus=None
        assert type(capture_content_entities) is bool,'explicit content storage model flag required'
        self.capture_content_entities=capture_content_entities
        assert type(capture_maps_content_entities)is bool and(not capture_maps_content_entities or capture_content_entities and capture_toolchain),'maps storage reuse requires complete tool/content observation'
        self.capture_maps_content_entities=capture_maps_content_entities
        assert type(retained_generated_metadata)is bool and(not retained_generated_metadata or generated_vma_output and generated_vma_parked_wait),'retained generated metadata requires complete parked-wait observer'
        self.retained_generated_metadata=retained_generated_metadata
        self.capture_toolchain=capture_toolchain;self.process_authority=bool(capture_toolchain);self.authority_handles=tool_providers.ProcessAuthorityHandles();self.tool_original_cache={};self.tool_provider_cache={};self.tool_metadata_bytes=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['metadataBytes']
        self.prepared_inputs={};self.prepared_sealed=False;self.domain_bytes=0;self.claim_bytes=dict.fromkeys(('raw-wire','capture-body','stdio','provider-other'),0);self.domain_lock=threading.Lock();self.pump_errors=[];self.maximum_stdio_bytes=maximum_stdio_bytes if maximum_stdio_bytes is not None else maximum_file_bytes
        self.compressed_raw=compressed_raw;self.logical_raw_bytes=0;self.raw_logical_limit=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['sourceMaterialBytes'];self.require_success=require_success;self.raw_bytes_completed=0;self.maximum_processes=maximum_processes;self.shard_bytes=shard_bytes
        self.deadline_monotonic=deadline_monotonic;self.check_budget=check_budget;self.maximum_bytes=maximum_bytes;self.maximum_file_bytes=maximum_file_bytes;self.selected_names=selected_names
        self.out=Path(out);self.capture_dir=self.out;self.source=str(source);self.build=str(build);self.tasks={};self.seq=0;self.records=[];self.captures=[];self.retained=set();self.producers={};self.write_states={};self.write_projections={};self.append_chains={};self.budget_context={};self.metadata_states=[];self.rename_records=[];self.consumers=[];self.raw=None;self.deadline=0;self.pausing=False;self.root=None;self.root_code=None;self.failures=[];self.current_phase=None;self.unknown_stops={};self.capture_bytes=0;self.capture_entities={};self.content_capture_pool={};self.exclusive=None;self.wait_references=[]
        self.lifetime_leases=None;self.lifetime_phase=None;self.lifetime_acquired={};self.lifetime_by_identity={};self.authority_observed=set()
        assert type(generated_vma_output) is bool and (not generated_vma_output or shared_tasks and capture_toolchain),'generated VMA requires existing actual shared-task/tool observation'
        self.generated_build_root=generated_vma_module.validated_build_root(generated_build_root)
        assert not generated_vma_output or self.build==self.generated_build_root,'caller-owned generated output build root differs'
        assert type(generated_vma_shared_mm) is bool and (not generated_vma_shared_mm or generated_vma_output and shared_tasks and capture_toolchain),'shared-MM VMA requires existing generated/all-task/tool observation'
        assert type(generated_vma_private_wake) is bool and (not generated_vma_private_wake or generated_vma_shared_mm),'private wake requires actual stopped-MM cohort model'
        self.generated_vma_private_wake=generated_vma_private_wake
        assert type(generated_vma_private_wait_mismatch) is bool and (not generated_vma_private_wait_mismatch or generated_vma_private_wake),'wait mismatch requires complete private-wake cohort model'
        self.generated_vma_private_wait_mismatch=generated_vma_private_wait_mismatch
        self.generated_vma_shared_mm=generated_vma_shared_mm
        self.generated_vma_output=generated_vma_output;self.generated_vma=generated_vma_module.create_runtime(self,SimpleNamespace(generated_vma_module=generated_vma_module,single=single,SYSCALL=SYSCALL,INTERRUPT=INTERRUPT,state=state)) if generated_vma_output else None
    def dependency_mountinfo(self):
        with open('/proc/self/mountinfo','rb') as stream:data=stream.read(self.tool_metadata_bytes+1)
        assert len(data)<=self.tool_metadata_bytes,'dependency actual mountinfo byte bound';return data
    def load_prepared_dependencies(self,argument):
        assert not self.tasks and self.prepared_dependency_plan is None,'dependency source binding must precede actual child'
        assert isinstance(argument,dict) and set(argument)=={'collection','mountinfo'},'fixed prepared dependency originals required'
        material_root=self.out.parent.resolve(strict=True)
        def read(path,reference=None,actual_source=False):
            path=Path(path);assert path.is_absolute() and not path.is_symlink() and (path.resolve(strict=True).is_relative_to(material_root) or actual_source and str(path) in [self.source+'/CMakeLists.txt','/opt/qlever-sdk/dependencies/sources.cmake'] and path.resolve(strict=True)==path),'dependency original escapes actual materials'
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                identity=probe.identity(os.fstat(fd));assert stat.S_ISREG(identity[2]) and identity[3]<=self.tool_metadata_bytes,'dependency metadata byte bound'
                data=bytearray()
                while True:
                    self.check();block=os.read(fd,65536)
                    if not block:break
                    data.extend(block);assert len(data)<=self.tool_metadata_bytes,'dependency metadata grew'
                assert identity==probe.identity(os.fstat(fd))==probe.identity(os.stat(path,follow_symlinks=False)),'dependency metadata identity changed'
                ref=dict(path=str(path),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
                if reference is not None:assert ref==reference,'dependency metadata original reference differs'
                return bytes(data),ref
            finally:os.close(fd)
        collection_path=material_root/'fetchcontent/materials.json';assert argument['collection']['path']==str(collection_path),'fixed dependency collection path required'
        data,collection_ref=read(collection_path,argument['collection']);collection=json.loads(data)
        prepared_data,prepared_ref=read(material_root/'source-prepared.json');prepared=json.loads(prepared_data)
        declared=bindings.dependency_collection_contract(prepared,collection)
        assert prepared['dependencyCollection']==dict(path='fetchcontent/materials.json',bytes=collection_ref['bytes'],sha256=collection_ref['sha256']),'same source-prepared collection bytes required'
        mounts,mount_ref=read(argument['mountinfo']['path'],argument['mountinfo']);assert mounts==self.dependency_mountinfo(),'dependency raw mountinfo differs from actual kernel'
        def member(ref):
            name=ref['path'];assert isinstance(name,str) and name.startswith('fetchcontent/') and not name.startswith('/') and all(part not in ['', '.', '..'] for part in name.split('/')) and '\\' not in name,'canonical dependency materials reference required'
            raw,actual=read(material_root/name);assert (actual['bytes'],actual['sha256'])==(ref['bytes'],ref['sha256']),'dependency materials member differs';return raw,actual
        declaration=collection.get('declarationSource',{});assert declaration.get('sourcePath')==self.source+'/CMakeLists.txt','fixed actual CMake declaration source required'
        declaration_data,declaration_ref=member(declaration['file']);actual_declaration,unused=read(Path(self.source)/'CMakeLists.txt',actual_source=True)
        assert actual_declaration==declaration_data,'prepared declaration differs from current source bytes'
        expected_cache=bindings.dependency_declaration_projection(collection,declaration_data)
        cache_data,cache_ref=member(collection['cmakeCache']);assert collection.get('cmakeCachePath')=='/opt/qlever-sdk/dependencies/sources.cmake' and cache_data==expected_cache,'fixed dependency cache projection differs'
        actual_cache=Path(collection['cmakeCachePath']);assert not actual_cache.is_symlink() and read(actual_cache,actual_source=True)[0]==cache_data and stat.S_IMODE(actual_cache.stat().st_mode)==0o644,'actual readonly dependency cache bytes differ';probe.effective_readonly(actual_cache,mounts)
        roots=[]
        for name,row in declared.items():
            assert sum(len(item['files']) for item in roots)<=self.maximum_processes,'dependency aggregate member bound'
            root=Path(row['sourceRoot']);assert not root.is_symlink() and str(root.resolve(strict=True))==str(root),'dependency root alias forbidden'
            provider=probe.effective_readonly(root,mounts);index_data,index_ref=member(row['sourceInventory']);index=json.loads(index_data)
            shard_data=[member(ref) for ref in index['shards']];files=bindings.dependency_inventory_rows(index,[json.loads(raw) for raw,_ in shard_data],json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['sourceMembers'],self.check)
            assert sum(len(item['files']) for item in roots)+len(files)<=self.maximum_processes,'dependency aggregate member bound'
            actual=set()
            def fail_walk(error):raise error
            for directory,dirs,names in os.walk(root,followlinks=False,onerror=fail_walk):
                self.check()
                for child in list(dirs)+names:
                    path=Path(directory)/child;relative=str(path.relative_to(root));item=os.lstat(path)
                    if stat.S_ISDIR(item.st_mode):continue
                    assert len(actual)<250000 and relative not in actual,'dependency actual closed-set member bound';actual.add(relative);expected=files.get(relative);assert expected,'unregistered dependency physical member'
                    assert stat.S_IMODE(item.st_mode)==expected['mode'],'dependency prepared mode differs'
                    if stat.S_ISLNK(item.st_mode):
                        target=os.readlink(path);assert expected['kind']=='symlink' and target==expected['target'] and str(path.resolve(strict=True)).startswith(str(root)+'/'),'dependency symlink target differs or escapes'
                    else:assert stat.S_ISREG(item.st_mode) and expected['kind']=='file' and item.st_size==expected['bytes'],'dependency physical member shape differs'
            assert actual==set(files),'dependency physical closed set differs'
            roots.append(dict(name=name,sourceRoot=str(root),provider=provider,files=files,indexRef=index_ref,indexReference=row['sourceInventory'],shardData=shard_data,shardReferences=index['shards']))
        self.prepared_dependency_plan=dict(preparedRef=prepared_ref,collectionRef=collection_ref,mountRef=mount_ref,mounts=mounts,roots=roots,declarationRef=declaration_ref,declarationReference=declaration['file'],cacheRef=cache_ref,cacheReference=collection['cmakeCache'])
    def seal_prepared_dependency_sources(self):
        plan=self.prepared_dependency_plan
        if plan is None or self.dependency_roots:return
        assert not self.tasks,'dependency source registration must precede first actual root'
        assert plan['mounts']==self.dependency_mountinfo(),'dependency mount provider changed before first actual child'
        originals={}
        def snapshot(ref):
            if ref['path'] in originals:return originals[ref['path']]
            fd=os.open(ref['path'],os.O_RDONLY|os.O_NOFOLLOW)
            try:
                before=probe.identity(os.fstat(fd));actual=self.snapshot_write_original(fd,ref['bytes']);assert before==probe.identity(os.fstat(fd)) and (actual['bytes'],actual['sha256'])==(ref['bytes'],ref['sha256']),'dependency metadata changed before actual source registration';originals[ref['path']]=actual;return actual
            finally:os.close(fd)
        for root in plan['roots']:
            row=self.emit(dict(kind='prepared-dependency-source-root',name=root['name'],sourceRoot=root['sourceRoot'],provider=root['provider'],declarationOriginal=snapshot(plan['declarationRef']),declarationReference=plan['declarationReference'],cmakeCacheOriginal=snapshot(plan['cacheRef']),cmakeCacheReference=plan['cacheReference'],sourcePreparedOriginal=snapshot(plan['preparedRef']),collectionOriginal=snapshot(plan['collectionRef']),mountinfoOriginal=snapshot(plan['mountRef']),inventoryIndexOriginal=snapshot(root['indexRef']),inventoryReference=root['indexReference'],inventoryShardReferences=root['shardReferences'],inventoryShardOriginals=[snapshot(ref) for _,ref in root['shardData']]))
            if self.dependency_cache is None:self.dependency_cache=dict(path='/opt/qlever-sdk/dependencies/sources.cmake',registrationSequence=row['sequence'],original=plan['cacheRef'])
            self.dependency_roots[root['name']]=dict(root,registrationSequence=row['sequence'],mounts=plan['mounts'])
    def dependency_source(self,path):
        if self.dependency_cache and path==self.dependency_cache['path']:
            assert self.prepared_dependency_plan['mounts']==self.dependency_mountinfo(),'dependency cache provider changed';probe.effective_readonly(path,self.prepared_dependency_plan['mounts'])
            ref=self.dependency_cache['original'];return dict(name='@cmake-cache',relativePath='sources.cmake',registrationSequence=self.dependency_cache['registrationSequence']),dict(bytes=ref['bytes'],sha256=ref['sha256'],mode=0o644)
        for name,root in self.dependency_roots.items():
            if path.startswith(root['sourceRoot']+'/'):
                relative=path[len(root['sourceRoot'])+1:];entry=root['files'].get(relative);assert entry and entry['kind']=='file','dependency actual read lacks prepared physical original'
                assert root['mounts']==self.dependency_mountinfo(),'dependency mount provider changed during actual execution'
                probe.effective_readonly(path,root['mounts'])
                return dict(name=name,relativePath=relative,registrationSequence=root['registrationSequence']),entry
        assert not path.startswith('/opt/qlever-sdk/dependencies/'),'unregistered dependency source read'
        return None
    def tighten_remaining(self,remaining_bytes):
        # External source domains supply only their remaining allowance. The
        # existing observer ledger remains private and is clipped under the
        # same lock used by capture and both stdio pumps; never reset charges.
        self.check_budget()
        assert type(remaining_bytes) is int and remaining_bytes>=0,'nonnegative actual remaining source bytes required'
        with self.domain_lock:
            self.maximum_bytes=min(self.maximum_bytes,self.domain_bytes+remaining_bytes)
            return self.maximum_bytes
    def claim(self,count,*,context=None,category='provider-other'):
        self.check_budget()
        with self.domain_lock:
            generated=getattr(self,'generated_vma',None);reserved=generated.reserved if generated else 0;spend=min(count,reserved) if generated and generated.spending_thread==threading.get_ident() else 0
            if count<0 or self.domain_bytes+getattr(self,'chunk_reserved',0)+reserved+count-spend>self.maximum_bytes:
                try:
                    # Failure-only aggregation of already retained metadata. No new
                    # payload/proc reads, authority, reservation or byte-limit change.
                    completed={key:dict(count=0,bytes=0) for key in ('source-read','consumer','readwrite-consumer','producer-close','prepared-build-input-original','write-original','toolchain-original','other')}
                    for row in self.captures:
                        key=row.get('role') if row.get('kind')=='fd-capture' else row.get('kind')
                        key=key if key in completed else 'other'
                        completed[key]['count']+=1
                        completed[key]['bytes']+=row['original']['bytes']
                    diagnostic=dict(kind='execution-byte-bound',chargedBytes=self.domain_bytes,requestedBytes=count,maximumBytes=self.maximum_bytes,projectedBytes=self.domain_bytes+count,generatedReservedBytes=reserved,completedRetainedEntityBytes=self.capture_bytes,completedObservationReferencedBytes=sum(bucket['bytes'] for bucket in completed.values()),completedObservationReferences=completed,**(context or dict(role='other-execution-original')))
                    diagnostic['successfulClaimBytes']=dict(self.claim_bytes)
                    diagnostic['rawBytesCompleted']=getattr(self,'raw_bytes_completed',0)
                    raw=getattr(self,'raw',None)
                    if raw is not None and hasattr(raw,'paths') and hasattr(raw,'total'):diagnostic['currentRawShards']=dict(count=len(raw.paths),bytes=raw.total)
                    diagnostic['completedStorageCensus']=completed_capture_storage_census(self.captures,getattr(self,'current_phase',None))
                    encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=4096,'bounded execution storage diagnostic'
                    print('SDK_EXECUTION_BYTE_BOUND '+encoded,file=sys.stderr,flush=True)
                except BaseException:
                    pass  # Diagnostic failure must never replace the original bound.
                raise AssertionError('shared execution original byte bound')
            self.domain_bytes+=count
            self.claim_bytes[category if category in self.claim_bytes else 'provider-other']+=count
            if generated:generated.reserved-=spend
    def reserve_generated_bytes(self,count):
        self.check_budget()
        with self.domain_lock:
            if not (self.generated_vma and type(count) is int and count>=0 and self.domain_bytes+getattr(self,'chunk_reserved',0)+self.generated_vma.reserved+count<=self.maximum_bytes):
                try:
                    context=getattr(self,'budget_context',{})
                    detail={key:context[key] for key in ('role','pid','fd','identity','writeCount','writeOffset','pathSha256') if key in context}
                    if 'path' in context:detail.update(path=context['path'][:128],pathTruncated=context.get('pathTruncated',False) or len(context['path'])>128)
                    identity=context.get('identity',[])
                    origin=getattr(self.generated_vma,'origins',{}).get(tuple(identity[:2]))
                    if origin is not None:detail['originSequence']=origin['sequence']
                    value=dict(kind='generated-reservation-bound',phase=self.current_phase,requestedBytes=count,chargedBytes=self.domain_bytes,maximumBytes=self.maximum_bytes,generatedReservedBytes=self.generated_vma.reserved if self.generated_vma else 0,successfulClaimBytes=dict(self.claim_bytes),context=detail,authorityVerified=False)
                    encoded=json.dumps(value,sort_keys=True);assert len(encoded.encode())<=4000
                    print('SDK_GENERATED_RESERVATION_BOUND '+encoded,file=sys.stderr,flush=True)
                except BaseException:
                    pass  # Preserve the same rejection even if diagnostics fail.
                raise AssertionError('same remaining execution ledger cannot reserve generated checkpoint')
            self.generated_vma.reserved+=count
    def generated_fd_flags(self,pid,fd):return descriptor_flags(pid,fd)
    def generated_fd_path(self,pid,fd):return fdpath(pid,fd)
    def emit(self,row):
        self.check();self.seq+=1;row=dict(row,sequence=self.seq,phase=self.current_phase,observedUnixNs=str(time.time_ns()),**(dict(observedMonotonicNs=str(time.monotonic_ns())) if getattr(self,'generated_vma_output',False) else {}));data=None
        if row.get('original',{}).get('storage'):
            if row['kind']=='write-original':row['storageIdentity']=self.chunk_identity(row['original'])
            else:assert any(capture['original']==row['original'] for capture in self.captures),'chunk reference lacks earlier write snapshot'
        elif getattr(self,'capture_content_entities',False) and row.get('kind') in ['fd-capture','prepared-build-input-original','write-original','toolchain-original'] and 'original' in row:
            entity=self.register_capture_entity(row['original']);assert row.get('originalEntityIdentity',entity)==entity,'physical storage identity differs';row['originalEntityIdentity']=entity
        parts=self.raw_encoder.encode(row) if getattr(self,'indexed_raw_records',False) else [(json.dumps(row,sort_keys=True)+'\n').encode()]
        size=sum(map(len,parts));assert size<=65536,'actual raw record exceeds fixed range bound'
        assert self.logical_raw_bytes+size<=self.raw_logical_limit,'cumulative logical raw wire bound'
        self.logical_raw_bytes+=size
        if not self.compressed_raw:self.claim(size,category='raw-wire',context=dict(role='raw-record',rawKind=row['kind']))
        for data in parts:self.raw.write(data)
        self.raw.flush()
        if self.generated_vma:self.generated_vma.record(row)
        if getattr(self,'capture_content_entities',False) and row.get('kind') in ['fd-capture','prepared-build-input-original','write-original','toolchain-original'] and 'original' in row and 'originalReuse' not in row and 'storage' not in row['original']:
            ref=row['original'];scope=('maps',)if getattr(self,'capture_maps_content_entities',False)and row.get('captureKind')=='maps'else ()
            self.content_capture_pool.setdefault((self.current_phase,*scope,ref['bytes'],ref['sha256']),row)
        return row
    def wait_one(self):
        return self.waiter.wait_one()
    def check(self):
        self.check_budget()
        if hasattr(self,'waiter') and self.waiter.active:self.waiter.check()
        assert not self.pump_errors,'actual bounded stdio failed: '+str(self.pump_errors);assert time.monotonic()<self.deadline,'all-stop observer deadline'
        if self.lifetime_leases is not None:self.lifetime_leases.check()
    def actual_tgid(self,pid):
        with open('/proc/'+str(pid)+'/status','rb') as source:data=source.read(65537)
        assert len(data)<=65536,'bounded actual task status'
        values={line.split(b':',1)[0]:line.split(b':',1)[1].strip() for line in data.splitlines() if b':' in line}
        assert int(values[b'Pid'])==pid and int(values[b'TracerPid'])==os.getpid(),'task is not actually owned by observer'
        return int(values[b'Tgid'])
    def verify_task_ownership(self,terminal_peers=()):
        excluded=set(terminal_peers);live={pid:row for pid,row in self.tasks.items() if not row['exited']and pid not in excluded};groups={};tables={};ownership=[]
        for pid,row in sorted(live.items()):
            self.check();tgid=self.actual_tgid(pid);assert tgid==row['tgid'],'actual TGID differs from kernel clone binding';groups.setdefault(tgid,[]).append(pid)
            descriptors=[]
            for value in self.bounded_fd_slots(pid):
                self.check();fd=int(value);item=os.stat('/proc/'+str(pid)+'/fd/'+value);descriptors.append([fd,probe.identity(item),descriptor_flags(pid,fd),descriptor_position(pid,fd)])
            table=row['fdTable'];prior=tables.setdefault(table,descriptors);assert prior==descriptors,'CLONE_FILES table differs between stopped owners'
            ownership.append(dict(tid=pid,tgid=tgid,fdTable=table))
        for tgid,tids in groups.items():assert sorted(int(value) for value in os.listdir('/proc/'+str(tgid)+'/task'))==sorted(tids+[pid for pid in excluded if self.tasks[pid]['tgid']==tgid]),'unregistered or missing actual TGID task'
        return ownership
    def bounded_fd_slots(self,pid):
        values=[]
        with os.scandir('/proc/'+str(pid)+'/fd') as entries:
            for entry in entries:
                self.check();assert len(values)<1024,'actual FD table slots unsupported above 1024'
                values.append(entry.name)
        return sorted(values,key=int)
    def writable_aliases(self,identity,target_pid=None,target_fd=None):
        result={}
        for pid,row in sorted(self.tasks.items()):
            if row['exited']:continue
            for value in self.bounded_fd_slots(pid):
                self.check();fd=int(value);item=os.stat('/proc/'+str(pid)+'/fd/'+value)
                if (item.st_dev,item.st_ino)!=tuple(identity[:2]):continue
                flags=descriptor_flags(pid,fd)
                if flags&os.O_ACCMODE==os.O_RDONLY:continue
                table=row['fdTable'] if self.shared_tasks else pid;key=(table,fd)
                assert key in result or len(result)<64,'writable alias keys unsupported above 64'
                actual=dict(pid=pid,fd=fd,flags=flags,accessMode=flags&os.O_ACCMODE)
                if pid==target_pid and fd==target_fd:result[key]=actual
                else:result.setdefault(key,actual)
        return list(result.values())
    def barrier(self):
        self.pausing=True
        try:
            for pid,row in list(self.tasks.items()):
                if not row['stopped'] and not row['exited']:
                    try:single.trace(INTERRUPT,pid)
                    except OSError as error:
                        if error.errno not in [errno.EIO,errno.ESRCH]:raise
            def terminal_peer(pid,row):
                terminal=row.get('terminalAuthority')
                return getattr(self,'serialize_terminal_syscalls',False)and terminal and terminal['closed']and terminal.get('resumed')and state(pid)=='Z'
            while self.unknown_stops or any(not row['stopped']and not row['exited']and not terminal_peer(pid,row)for pid,row in self.tasks.items()):
                pid,status=self.wait_one();self.event(pid,status,False)
            for pid,row in list(self.tasks.items()):
                terminal=row.get('terminalAuthority')
                if not row['exited'] and terminal and state(pid)=='Z':self.reap_terminal_task(pid,allow_pending=getattr(self,'serialize_terminal_syscalls',False))
            known=[];terminal_peers=[]
            for pid,row in self.tasks.items():
                if row['exited']:continue
                if terminal_peer(pid,row):
                    terminal=row['terminalAuthority'];sample=terminal['lease'].terminal_peer_original();sample.update(originalSequence=terminal['original']['sequence'],closeSequence=terminal['closedRow']['sequence'],resumeSequence=terminal['resumed']['sequence']);terminal_peers.append(sample);continue
                assert row['stopped'] and state(pid)=='t','potential writer not in OS tracing-stop'
                if not self.shared_tasks:assert os.listdir('/proc/'+str(pid)+'/task')==[str(pid)],'unknown shared writer thread'
                known.append(pid)
            barrier=self.emit(dict(kind='all-stop-barrier',pids=sorted(known),osStates=['t']*len(known),**({'taskOwnership':self.verify_task_ownership([row['pid']for row in terminal_peers])} if self.shared_tasks else {}),**(dict(terminalPeers=sorted(terminal_peers,key=lambda row:row['pid']))if terminal_peers else {})))
            self.close_terminal_authorities(barrier)
            return barrier
        finally:self.pausing=False
    def sole_writer(self,target_pid,target_fd,identity):
        aliases=self.writable_aliases(identity,target_pid,target_fd)
        assert len(aliases)==1 and aliases[0]['pid']==target_pid and aliases[0]['fd']==target_fd,'another writable FD aliases selected output inode'
        return [dict(pid=target_pid,fd=target_fd)]
    def stopped_write_alias_inventory(self,pid,fd,identity):
        assert self.shared_tasks and self.process_authority and not self.pausing,'stopped write aliases require initialized complete ownership'
        ownership=self.verify_task_ownership()
        assert all(task['stopped'] and state(other)=='t' for other,task in self.tasks.items() if not task['exited']),'write alias owner is not stopped'
        aliases=self.writable_aliases(identity,pid,fd)
        assert aliases and any(value['pid']==pid and value['fd']==fd for value in aliases),'selected writable FD missing from actual alias scan'
        result=[]
        for alias in aliases:
            owner=alias['pid'];slot=alias['fd'];actual=probe.identity(os.stat('/proc/'+str(owner)+'/fd/'+str(slot)))
            assert actual==identity and descriptor_flags(owner,slot)==alias['flags'],'write alias changed during all-stop inventory'
            result.append(dict(**alias,identity=actual,fdTable=self.tasks[owner]['fdTable']))
        tables=[]
        for owner,task in sorted(self.tasks.items()):
            if task['exited']:continue
            descriptors=[]
            for value in self.bounded_fd_slots(owner):
                self.check();slot=int(value);actual=probe.identity(os.stat('/proc/'+str(owner)+'/fd/'+value));flags=descriptor_flags(owner,slot)
                descriptors.append([slot,actual,flags])
            tables.append(dict(pid=owner,fdTable=task['fdTable'],descriptors=descriptors))
        inventory=dict(aliases=result,taskOwnership=ownership,descriptorTables=tables,scope='all live stopped tracked FD tables; only selected syscall resumes')
        assert len(json.dumps(inventory,separators=(',',':')).encode())<=32768,'bounded complete stopped FD inventory exceeds raw-record budget'
        return inventory
    def seal_prepared_build_inputs(self):
        # This runs once, before the first tracee is forked. Existing build
        # inputs have a different origin from a close observed by this tracer.
        assert not self.tasks and not self.prepared_sealed,'prepared input snapshot must precede the first actual root'
        root=Path(self.build);assert not self.out.resolve().is_relative_to(root.resolve()),'observer originals must not be inside the input build root'
        def entries():
            result=[]
            if not root.exists():return result
            for directory,dirs,files in os.walk(root,followlinks=False):
                self.check()
                for name in dirs:
                    assert not Path(directory,name).is_symlink(),'prepared build directory symlink requires separate source binding'
                for name in files:
                    path=Path(directory,name);item=path.lstat()
                    assert stat.S_ISREG(item.st_mode),'prepared build input must be a regular no-follow original: '+str(path)
                    result.append((str(path.absolute()),probe.identity(item)))
                    assert len(result)<=self.maximum_processes,'prepared build original member bound'
            return sorted(result)
        root_identity=probe.identity(root.lstat()) if root.exists() else None
        before=entries();inventory=hashlib.sha256()
        for path,identity in before:
            self.check();reader=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                assert identity==probe.identity(os.fstat(reader)) and identity[3]<=self.maximum_file_bytes,'prepared FD identity/size differs'
                name='capture-'+str(len(self.captures)).zfill(4)+'.original';offset=0;digest=hashlib.sha256()
                with (self.capture_dir/name).open('xb') as output:
                    while True:
                        self.check();block=os.pread(reader,65536,offset)
                        if not block:break
                        offset+=len(block);assert offset<=identity[3] and offset<=self.maximum_file_bytes,'prepared original grew during capture'
                        self.claim(len(block),category='capture-body');output.write(block);digest.update(block)
                    output.flush();os.fsync(output.fileno())
                assert offset==identity[3] and identity==probe.identity(os.fstat(reader))==probe.identity(os.stat(path,follow_symlinks=False)),'prepared original changed during capture'
                original=dict(path=name,bytes=offset,sha256=digest.hexdigest())
                row=self.emit(dict(kind='prepared-build-input-original',path=path,identity=identity,original=original,originalEntityIdentity=self.register_capture_entity(original)))
                inventory.update((json.dumps(dict(path=path,identity=identity,original=original),sort_keys=True)+'\n').encode())
                self.captures.append(row);self.capture_bytes+=offset;self.retained.add(reader);self.prepared_inputs[path]=(row,reader,(offset,digest.hexdigest()));reader=None
            finally:
                if reader is not None:os.close(reader)
        assert before==entries() and root_identity==(probe.identity(root.lstat()) if root.exists() else None),'prepared build input root/closed set or identity changed during snapshot'
        self.emit(dict(kind='prepared-build-input-seal',buildRoot=self.build,files=len(before),inventorySha256=inventory.hexdigest(),scope='actual pre-first-root bytes only; source-prepare causality independent'))
        self.prepared_sealed=True
    def retained_metadata_chain(self,producer,consumer):
        return bindings.retained_metadata_chain(producer,consumer,self.metadata_states)
    def capture_metadata(self,pid):
        barrier=self.barrier();task=self.tasks[pid];path,access,mode=task.pop('metadataPath');held=os.open(access,os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(held));assert stat.S_ISREG(identity[2])
            row=self.emit(dict(kind='actual-mode-window',pid=pid,path=path,entrySequence=task['entry']['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,requestedMode=mode))
            task['metadataWindow']=(row,held,access);self.retained.add(held);held=None;return row
        finally:
            if held is not None:os.close(held)
    def complete_metadata(self,pid,entry,exit):
        row,held,access=self.tasks[pid].pop('metadataWindow')
        try:
            identity=probe.identity(os.fstat(held));assert not exit['isError'] and exit['result']==0 and self.exclusive==(pid,entry['sequence']),'actual chmod did not complete exclusively'
            before=row['beforeIdentity'];assert identity[:2]==before[:2] and identity[3:5]==before[3:5] and stat.S_IFMT(identity[2])==stat.S_IFMT(before[2]) and stat.S_IMODE(identity[2])==row['requestedMode']&0o7777,'actual chmod changed file bytes/identity or wrong mode'
            assert probe.identity(os.stat(access,follow_symlinks=access.startswith('/proc/')))==identity,'actual chmod access path changed'
            change=self.emit(dict(kind='actual-mode-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,result=exit['result'],isError=exit['isError']))
            self.metadata_states.append((row,change))
        finally:os.close(held);self.retained.remove(held)
    def close_rename_leases(self,*descriptors):
        primary=sys.exc_info()[1];failure=None
        for fd in descriptors:
            if fd is None:continue
            try:os.close(fd)
            except BaseException as error:
                if failure is None:failure=error
                continue # Still owned: outer cleanup can retry this descriptor.
            try:self.retained.discard(fd)
            except BaseException as error:
                if failure is None:failure=error
        if primary is None and failure is not None:raise failure
    def capture_rename(self,pid):
        barrier=self.barrier()
        if barrier['sequence']!=self.seq:barrier=self.barrier()
        assert barrier['sequence']==self.seq,'retained rename requires fresh final all-stop barrier'
        task=self.tasks[pid];old,new=task['rename'];entry=task['entry']
        assert old!=new and all(path.startswith(self.build+'/') and str(Path(path).resolve(strict=path==old))==path for path in [old,new]),'rename requires distinct canonical build paths'
        destination_absent=retained_rename_path_absent(new)
        source=probe.identity(os.stat(old,follow_symlinks=False));assert stat.S_ISREG(source[2])
        key=tuple(source[:2]);generated=getattr(self,'generated_vma',None)
        if key in self.producers:
            producer,retained,expected=self.producers[key];producer_reference=dict(producerCaptureSequence=producer['sequence'])
        else:
            assert generated and generated.model==generated_vma_module.PARKED_WAIT_MODEL and generated.active is None and key in generated.checkpoints,'rename lacks a verified producer'
            producer=generated.checkpoints[key];origin=generated.origins[key];retained=origin['held'];expected=(producer['original']['bytes'],producer['original']['sha256']);producer_reference=dict(generatedCheckpointSequence=producer['sequence'])
        held=os.dup(retained);self.retained.add(held)
        destination=None
        try:
            before=probe.identity(os.fstat(held));assert before==source,'rename source differs from retained producer FD'
            bindings.retained_metadata_chain(producer,dict(sequence=self.seq+1,path=old,identity=before),self.metadata_states)
            original=self.snapshot_write_original(held,before[3]);assert (original['bytes'],original['sha256'])==expected,'rename preimage bytes differ from producer'
            destination_row=None
            if not destination_absent:
                named_destination=os.stat(new,follow_symlinks=False)
                assert stat.S_ISREG(named_destination.st_mode) and named_destination.st_nlink==1,'rename replacement requires single-link regular named target'
                destination=os.open(new,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC);self.retained.add(destination)
                destination_stat=os.fstat(destination);destination_identity=probe.identity(destination_stat)
                assert stat.S_ISREG(destination_identity[2]) and destination_stat.st_nlink==1 and destination_identity[:2]!=before[:2],'rename replacement requires distinct single-link regular target'
                assert destination_identity==probe.identity(named_destination)==probe.identity(os.stat(new,follow_symlinks=False)),'rename replacement target changed before capture'
                destination_original=self.snapshot_write_original(destination,destination_identity[3])
                assert destination_identity==probe.identity(os.fstat(destination))==probe.identity(os.stat(new,follow_symlinks=False)) and os.fstat(destination).st_nlink==1,'rename replacement preimage changed during capture'
                destination_row=dict(identity=destination_identity,namedIdentity=destination_identity,links=1,original=destination_original)
            assert before==probe.identity(os.fstat(held))==probe.identity(os.stat(old,follow_symlinks=False)) and (retained_rename_path_absent(new) if destination_absent else destination_row['identity']==probe.identity(os.stat(new,follow_symlinks=False))),'rename preimage changed during all-stop capture'
            row=self.emit(dict(kind='actual-rename-window',pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],**producer_reference,fromPath=old,toPath=new,beforeIdentity=before,namedIdentity=before,beforeOriginal=original,leaseSequence=self.seq+1,**({'destinationAbsenceErrno':errno.ENOENT} if destination_row is None else {'replacementBefore':destination_row})))
            task['renameWindow']=(row,held,expected,destination);held=None;destination=None;return row
        finally:self.close_rename_leases(held,destination)
    def complete_rename(self,pid,entry,exit):
        row,held,expected,destination=self.tasks[pid].pop('renameWindow')
        try:
            assert self.exclusive==(pid,entry['sequence']) and exit['result']==0 and exit['isError'] is False,'retained rename lacks actual exclusive successful exit'
            after=probe.identity(os.fstat(held));assert after[:5]==row['beforeIdentity'][:5] and after==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'retained rename post namespace/identity differs'
            original=self.snapshot_write_original(held,after[3]);assert (original['bytes'],original['sha256'])==expected,'retained rename changed producer bytes'
            assert after==probe.identity(os.fstat(held))==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'retained rename postimage changed during capture'
            replacement_after=None
            if destination is not None:
                displaced=os.fstat(destination);displaced_identity=probe.identity(displaced);prior=row['replacementBefore']
                assert displaced.st_nlink==0 and displaced_identity[:5]==prior['identity'][:5],'rename replacement displaced target identity/link changed'
                displaced_original=self.snapshot_write_original(destination,displaced_identity[3])
                assert (displaced_original['bytes'],displaced_original['sha256'])==(prior['original']['bytes'],prior['original']['sha256']) and displaced_identity==probe.identity(os.fstat(destination)) and os.fstat(destination).st_nlink==0,'rename replacement displaced bytes changed'
                assert after==probe.identity(os.fstat(held))==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'rename replacement namespace changed during displaced capture'
                replacement_after=dict(identity=displaced_identity,links=0,original=displaced_original)
            change=self.emit(dict(kind='actual-rename-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],leaseSequence=row['leaseSequence'],exitSequence=exit['sequence'],afterIdentity=after,namedIdentity=after,afterOriginal=original,oldPathAbsent=True,oldPathAbsenceErrno=errno.ENOENT,result=exit['result'],isError=exit['isError'],**({} if replacement_after is None else {'replacementAfter':replacement_after})))
            self.metadata_states.append((row,change))
        finally:self.close_rename_leases(held,destination)
    def chunk_identity(self,reference):
        storage=reference['storage'];assert storage['model']=='chunk-original-v1'
        ref=storage['manifest'];value=os.stat(self.capture_dir/ref['path'],follow_symlinks=False)
        assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_size==ref['bytes']
        return [*probe.identity(value),value.st_nlink]
    def snapshot_write_original(self,reader,size,*,offset=0):
        assert 0<=size<=self.maximum_file_bytes,'write original byte bound'
        source=os.fstat(reader)
        if getattr(self,'capture_content_entities',False) and offset==0 and stat.S_ISREG(source.st_mode) and source.st_size==size:
            self.check();number=len(self.captures);ledger=CaptureReservation(self)
            manifest=chunk_store.snapshot(self.capture_dir,reader,number,ledger,self.check)
            data=chunk_store.read_manifest(self.capture_dir,manifest,self.check)
            reference=dict(path='capture-'+str(number).zfill(4)+'.original',bytes=data['bytes'],sha256=data['sha256'],storage=dict(model='chunk-original-v1',manifest=manifest))
            physical_bytes=ledger.committed_bytes
            row=self.emit(dict(kind='write-original',original=reference))
            self.captures.append(row);self.capture_bytes+=physical_bytes
            return reference
        name='capture-'+str(len(self.captures)).zfill(4)+'.original';count=0;digest=hashlib.sha256()
        with (self.capture_dir/name).open('xb') as output:
            while count<size:
                self.check();block=os.pread(reader,min(65536,size-count),offset+count);assert block,'short actual write original'
                self.claim(len(block),category='capture-body',context=self.budget_context);output.write(block);count+=len(block);digest.update(block)
            output.flush();os.fsync(output.fileno())
        row=self.emit(dict(kind='write-original',original=dict(path=name,bytes=count,sha256=digest.hexdigest())))
        self.captures.append(row);self.capture_bytes+=count;return row['original']
    def fd_blocks(self,reader,size):
        offset=0
        while offset<size:
            self.check();block=os.pread(reader,min(65536,size-offset),offset);assert block,'short held write image'
            offset+=len(block);yield block
    def original_blocks(self,ref):
        if ref.get('storage'):
            yield from chunk_store.blocks(self.capture_dir,ref['storage']['manifest'],self.check)
            return
        with (self.capture_dir/ref['path']).open('rb') as stream:
            while True:
                self.check();block=stream.read(65536)
                if not block:break
                yield block
    def capture_write(self,pid,fd):
        barrier=self.barrier();entry=self.tasks[pid]['entry'];path=fdpath(pid,fd);reader=os.open('/proc/'+str(pid)+'/fd/'+str(fd),os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(reader));assert stat.S_ISREG(identity[2]) and identity[3]<=self.maximum_file_bytes
            alias_inventory=self.stopped_write_alias_inventory(pid,fd,identity) if getattr(self,'stopped_writer_aliases',False) else None
            writers=[dict(pid=pid,fd=fd)] if alias_inventory else self.sole_writer(pid,fd,identity);flags=descriptor_flags(pid,fd);assert flags&os.O_ACCMODE==os.O_RDWR
            position=descriptor_position(pid,fd);offset=identity[3] if flags&os.O_APPEND else position;count=entry['args'][2]
            assert count<=self.maximum_file_bytes and offset+count<=self.maximum_file_bytes,'bounded actual write range'
            self.budget_context=dict(path=path[:4096],pathTruncated=len(path)>4096,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),role='write-before',pid=pid,fd=fd,identity=identity,writeCount=count,writeOffset=offset)
            generated_origin=self.generated_vma.write_baseline(pid,fd,identity,identity[3],offset) if self.generated_vma else None
            key=tuple(identity[:2]);chain=self.append_chains.get(key)
            append=offset==identity[3] and generated_origin is None
            if chain and not append:self.checkpoint_appends('nonappend-write',entry['sequence']);chain=None
            if chain:
                assert chain['identity']==identity,'append FD preimage identity changed'
                before=dict(bytes=identity[3],sha256=chain['digest'].hexdigest())
            else:
                before=bindings.digest_blocks(self.fd_blocks(reader,identity[3]),self.maximum_file_bytes,self.check);assert identity==probe.identity(os.fstat(reader))
            if generated_origin is not None:assert generated_origin['data']==(before['bytes'],before['sha256']),'generated write entire before bytes differ from retained origin'
            initial=None
            if generated_origin is not None or tuple(identity[:2]) not in self.write_states:
                initial=self.snapshot_write_original(reader,identity[3]);assert identity==probe.identity(os.fstat(reader))
            prior=None if generated_origin is not None else self.write_states.get(tuple(identity[:2]));baseline=generated_origin['sequence'] if generated_origin is not None else 'empty'
            if identity[3] and generated_origin is None:
                if prior:
                    assert prior['afterIdentity']==identity and (prior['after']['bytes'],prior['after']['sha256'])==(before['bytes'],before['sha256']),'write preimage differs from previous actual write'
                    baseline=prior['sequence']
                else:
                    original=self.producers.get(tuple(identity[:2])) or self.prepared_inputs.get(path)
                    assert original,'nonempty writable preimage lacks retained actual original'
                    row,held,data=original;assert probe.identity(os.fstat(held))==identity and data==(before['bytes'],before['sha256']),'write preimage differs from actual retained original';baseline=row['sequence']
            memory=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
            try:
                self.budget_context['role']='actual-write-buffer';buffer=self.snapshot_write_original(memory,count,offset=entry['args'][1])
            finally:os.close(memory)
            row=self.emit(dict(kind='actual-write-window',pid=pid,fd=fd,path=path,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,format='bounded-append-effect-v1' if append else 'bounded-write-delta-v1',initialBefore=initial,before=before,buffer=buffer,offset=offset,position=position,flags=flags,writers=writers,baseline=baseline,**(dict(stoppedAliasInventory=alias_inventory) if alias_inventory else {})))
            self.budget_context={}
            if generated_origin is not None:self.tasks[pid]['generatedWriteOrigin']=generated_origin
            if append and chain is None:
                digest=hashlib.sha256()
                for block in self.fd_blocks(reader,identity[3]):digest.update(block)
                assert digest.hexdigest()==before['sha256'] and identity==probe.identity(os.fstat(reader))
                retained=os.dup(reader);self.retained.add(retained)
                chain=dict(identity=identity,digest=digest,held=retained,dirty=False,transition=None)
                self.append_chains[key]=chain
            self.tasks[pid]['writeWindow']=(row,reader);self.retained.add(reader);reader=None;return row
        finally:
            if reader is not None:os.close(reader)
    def complete_write(self,pid,entry,exit):
        row,held=self.tasks[pid].pop('writeWindow')
        try:
            assert self.exclusive==(pid,entry['sequence']) and not exit['isError'] and 0<=exit['result']<=entry['args'][2],'actual write failed or returned invalid count'
            identity=probe.identity(os.fstat(held));assert identity==probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(row['fd']))) and identity[:3]==row['beforeIdentity'][:3] and descriptor_flags(pid,row['fd'])==row['flags'],'actual writer FD changed'
            alias_after=self.stopped_write_alias_inventory(pid,row['fd'],identity) if 'stoppedAliasInventory' in row else None
            if alias_after:
                expected=row['stoppedAliasInventory'];assert alias_after['taskOwnership']==expected['taskOwnership'],'write alias ownership changed'
                assert [{**alias,'identity':row['beforeIdentity']} for alias in alias_after['aliases']]==expected['aliases'],'write alias descriptor binding changed'
            else:self.sole_writer(pid,row['fd'],identity)
            key=tuple(identity[:2]);segments=self.write_projections.get(key)
            if row['initialBefore'] is not None:segments=[(row['initialBefore'],0,row['beforeIdentity'][3])] if row['beforeIdentity'][3] else []
            assert segments is not None,'write delta baseline projection missing'
            if row['format']=='bounded-append-effect-v1':
                chain=self.append_chains[key];assert chain['identity']==row['beforeIdentity'] and row['offset']==row['beforeIdentity'][3]
                assert identity[3]==row['offset']+exit['result'] if exit['result'] else identity[3]==row['beforeIdentity'][3]
                effect=hashlib.sha256();position=0
                for block in self.original_blocks(row['buffer']):
                    chunk=block[:max(0,min(len(block),exit['result']-position))]
                    if chunk:
                        actual=os.pread(held,len(chunk),row['offset']+position);assert actual==chunk,'actual append range differs from returned syscall buffer'
                        effect.update(actual);chain['digest'].update(actual);position+=len(actual)
                    if position==exit['result']:break
                assert position==exit['result'] and identity==probe.identity(os.fstat(held))
                # O(1) metadata append; the prefix is NOT re-read or certified here.
                if exit['result']:segments.append((row['buffer'],0,exit['result']))
                after=dict(bytes=identity[3],sha256=chain['digest'].hexdigest())
                extra=dict(afterObservation='uncheckpointed-append-projection',actualAppendEffect=dict(bytes=position,sha256=effect.hexdigest()))
                chain.update(identity=identity,dirty=True)
            else:
                segments=bindings.write_segments(segments,row['offset'],exit['result'],row['buffer'],self.maximum_file_bytes)
                after=bindings.digest_blocks(self.fd_blocks(held,identity[3]),self.maximum_file_bytes,self.check)
                expected=bindings.digest_blocks(bindings.segment_blocks(segments,self.original_blocks,self.check),self.maximum_file_bytes,self.check)
                assert after==expected and identity==probe.identity(os.fstat(held)),'actual post-write bytes differ from syscall buffer projection';extra={}
            self.write_projections[key]=segments
            transition=self.emit(dict(kind='actual-write-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,after=after,result=exit['result'],isError=exit['isError'],**(dict(stoppedAliasInventoryAfter=alias_after) if alias_after else {}),**extra))
            if row['format']=='bounded-append-effect-v1':chain['transition']=transition
            self.write_states[tuple(identity[:2])]=transition
            generated_origin=self.tasks[pid].pop('generatedWriteOrigin',None)
            if generated_origin is not None:self.generated_vma.complete_write_bridge(generated_origin,row,transition,held)
        finally:
            primary=sys.exc_info()[1]
            try:os.close(held)
            except BaseException as cleanup:
                if self.generated_vma:self.generated_vma.cleanup_errors.append(cleanup)
                if primary is None:raise
            else:self.retained.remove(held)
    def checkpoint_appends(self,reason,entry_sequence=None):
        # Called only while every registered live task is stopped, or after all
        # actual waits. A held FD survives close/rename; no pathname re-open.
        assert all(row['stopped'] or row['exited'] for row in self.tasks.values()),'append checkpoint requires all-task stop'
        if not self.append_chains:return []
        barrier=self.barrier() if any(not row['exited'] for row in self.tasks.values()) else None
        checked=[]
        for key,chain in list(self.append_chains.items()):
            held=chain['held'];identity=probe.identity(os.fstat(held))
            assert identity==chain['identity'],'append checkpoint FD identity changed'
            if chain['dirty']:
                self.budget_context=dict(role='append-full-checkpoint',identity=identity,reason=reason)
                original=self.snapshot_write_original(held,identity[3])
                assert identity==probe.identity(os.fstat(held)) and (original['bytes'],original['sha256'])==(identity[3],chain['digest'].hexdigest()),'append prefix changed before full checkpoint'
                row=self.emit(dict(kind='append-full-checkpoint',transitionSequence=chain['transition']['sequence'],identity=identity,original=original,reason=reason,entrySequence=entry_sequence,barrierSequence=barrier['sequence'] if barrier else None,closedTrackedWaits=barrier is None))
                checked.append(row['sequence']);chain['dirty']=False
            os.close(held);self.retained.remove(held);del self.append_chains[key]
        self.budget_context={}
        return checked
    def capture_entity_identity(self,reference):
        name=reference['path'];assert re.fullmatch(r'capture-[0-9]{4,}\.original',name),'fixed retained capture entity required'
        value=os.stat(self.capture_dir/name,follow_symlinks=False)
        assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_size==reference['bytes'],'same single-link retained capture entity required'
        return [*probe.identity(value),value.st_nlink]
    def register_capture_entity(self,reference):
        reference=bindings.physical_original_reference(reference)
        identity=self.capture_entity_identity(reference);prior=self.capture_entities.get(reference['path'])
        assert prior is None or prior==(reference,identity),'capture entity path reused with different bytes or identity'
        self.capture_entities[reference['path']]=(dict(reference),identity)
        return identity
    def verify_capture_entity(self,reference):
        reference=bindings.physical_original_reference(reference)
        registered=self.capture_entities.get(reference['path']);assert registered and registered[0]==reference,'same registered capture entity required'
        reader=os.open(self.capture_dir/reference['path'],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK);self.retained.add(reader)
        try:
            value=os.fstat(reader);identity=[*probe.identity(value),value.st_nlink]
            assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and identity==registered[1] and identity==self.capture_entity_identity(reference),'retained capture entity changed before read'
            offset=0;digest=hashlib.sha256()
            while True:
                self.check();block=os.pread(reader,65536,offset)
                if not block:break
                offset+=len(block);assert offset<=reference['bytes'];digest.update(block)
            value=os.fstat(reader)
            assert identity==[*probe.identity(value),value.st_nlink]==self.capture_entity_identity(reference) and (offset,digest.hexdigest())==(reference['bytes'],reference['sha256']),'retained capture entity bytes or identity changed'
            return identity
        finally:
            primary=sys.exc_info()[1]
            try:os.close(reader)
            except BaseException:
                if primary is None:raise
            else:self.retained.remove(reader)
    def read_capture_fd(self,reader,output,*,context=None):
        offset=0;digest=hashlib.sha256()
        while True:
            self.check();block=os.pread(reader,65536,offset)
            if not block:break
            offset+=len(block);assert offset<=self.maximum_file_bytes,'bounded actual capture FD required'
            if output is not None:self.claim(len(block),category='capture-body',context=dict(context or {},captureOffset=offset-len(block),capturePrefixSHA256=digest.copy().hexdigest()));output.write(block)
            digest.update(block)
        return offset,digest.hexdigest()
    def prior_content_entity(self,data,*,scope=()):
        prior=self.content_capture_pool.get((self.current_phase,*scope,*data))
        if prior is None:return None
        assert prior['phase']==self.current_phase and prior['sequence']<=self.seq and prior['original']['path']in self.capture_entities,'actual prior samephase canonical required'
        ref=bindings.physical_original_reference(prior['original']);entity=self.verify_capture_entity(ref)
        assert data==(ref['bytes'],ref['sha256'])and entity==prior['originalEntityIdentity'],'actual body differs from canonical retained entity'
        return prior,ref,entity
    def content_capture_original(self,reader,target,ident,name,context):
        # Lookup follows a fresh complete FD read. The pool is physical storage,
        # never a substitute for this window's FD/source/operation provenance.
        value=os.fstat(reader);before=[*probe.identity(value),value.st_nlink];assert before[:6]==ident,'actual FD changed before content observation'
        def named():
            value=os.stat(target,follow_symlinks=False);return [*probe.identity(value),value.st_nlink]
        try:initial_named=named()
        except (FileNotFoundError,NotADirectoryError,PermissionError):initial_named=None
        eligible=initial_named==before and stat.S_ISREG(before[2])
        data=self.read_capture_fd(reader,None)
        current=os.fstat(reader);assert before==[*probe.identity(current),current.st_nlink],'actual complete content FD changed'
        if eligible:assert named()==before,'actual named content FD changed'
        reused=self.prior_content_entity(data)if eligible else None
        if reused is not None:
            prior,ref,entity=reused
            value=os.fstat(reader);assert before==[*probe.identity(value),value.st_nlink]==named(),'FD/named identity changed during canonical verification'
            return ref,entity,dict(originalReuse=dict(model='same-phase-content-entity-v2',originCaptureSequence=prior['sequence']),captureWindowIdentity=before,captureWindowAfterIdentity=[*probe.identity(value),value.st_nlink],namedWindowIdentity=initial_named,namedWindowAfterIdentity=named()),data
        # Unknown contents incur a second actual held-FD pass, not a refunded
        # speculative body. Charge each output block before writing it.
        with (self.capture_dir/name).open('xb') as output:
            actual=self.read_capture_fd(reader,output,context=context);output.flush();os.fsync(output.fileno())
        value=os.fstat(reader);assert actual==data and before==[*probe.identity(value),value.st_nlink],'fresh physical content pass changed actual FD/body'
        if eligible:assert named()==before,'actual named source changed during physical capture'
        ref=dict(path=name,bytes=data[0],sha256=data[1]);self.capture_bytes+=data[0];entity=self.register_capture_entity(ref)
        return ref,entity,dict(captureWindowIdentity=before,captureWindowAfterIdentity=[*probe.identity(value),value.st_nlink],**(dict(namedWindowIdentity=initial_named,namedWindowAfterIdentity=named()) if eligible else {})),data
    def phase_capture_files(self,capture_start):
        # Raw observations stay one-per-window; each physical body appears once.
        references={}
        for row in self.captures[capture_start:]:
            original=row['original']
            if original.get('storage'):
                manifest=original['storage']['manifest'];data=chunk_store.read_manifest(self.capture_dir,manifest,self.check)
                assert (data['bytes'],data['sha256'])==(original['bytes'],original['sha256'])
                physical=[manifest]+[dict(path='chunks/'+chunk['sha256'],bytes=chunk['bytes'],sha256=chunk['sha256']) for chunk in data['chunks']]
            else:physical=[bindings.physical_original_reference(original)]
            for reference in physical:
                prior=references.get(reference['path'])
                assert prior is None or prior==reference,'conflicting same-phase capture entity reference'
                references[reference['path']]=reference
        return [dict(reference,path=str(self.capture_dir/reference['path'])) for reference in references.values()]
    def capture(self,pid,fd,role):
        barrier=self.barrier();self.check();target=fdpath(pid,fd);path='/proc/'+str(pid)+'/fd/'+str(fd);before=os.stat(path);reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
        try:
            ident=probe.identity(os.fstat(reader));assert ident==probe.identity(before) and stat.S_ISREG(ident[2]) and ident[3]<=self.maximum_file_bytes,'bounded regular capture required'
            if role=='producer-close':
                aliases=self.writable_aliases(ident,pid,fd)
                if len(aliases)!=1 or aliases[0]['pid']!=pid or aliases[0]['fd']!=fd:
                    assert len(aliases)>1 and any(alias['pid']==pid and alias['fd']==fd for alias in aliases),'selected close FD changed before exclusive window'
                    table_owners=sorted(other for other,task in self.tasks.items() if not task['exited'] and (task['fdTable']==self.tasks[pid]['fdTable'] if self.shared_tasks else other==pid))
                    row=self.emit(dict(kind='alias-close-window',pid=pid,fd=fd,path=target,entrySequence=self.tasks[pid]['entry']['sequence'],barrierSequence=barrier['sequence'],identity=ident,aliases=aliases,tableOwners=table_owners,scope='descriptor close only; no producer or input byte authority'))
                    self.tasks[pid]['aliasCloseWindow']=(row,reader);self.retained.add(reader);reader=None;return row
            writers=self.sole_writer(pid,fd,ident) if role=='producer-close' else [];rw_read=False
            # A stopped writer is still a writer: diagnose, never silently accept it.
            if role!='producer-close':
                aliases=[];alias_count=0;alias_digest=hashlib.sha256()
                for alias in self.writable_aliases(ident,pid,fd):
                    alias_count+=1;alias_digest.update((json.dumps(alias,sort_keys=True)+'\n').encode())
                    if len(aliases)<32:aliases.append(alias)
                if alias_count==1 and aliases==[dict(pid=pid,fd=fd,flags=descriptor_flags(pid,fd),accessMode=os.O_RDWR)] and role=='consumer' and ident[3]==0:
                    entry=self.tasks[pid]['entry'];rules=profile(entry['arch'])
                    assert entry['nr']==rules['read'] and entry['args'][0]==fd and entry['args'][2]>0,'empty window requires actual read entry'
                    row=self.emit(dict(kind='empty-read-window',pid=pid,fd=fd,path=target,identity=ident,
                        flags=descriptor_flags(pid,fd),entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],writers=aliases))
                    self.tasks[pid]['emptyReadWindow']=(row,reader);self.retained.add(reader);reader=None
                    return row
                if alias_count==1 and aliases==[dict(pid=pid,fd=fd,flags=descriptor_flags(pid,fd),accessMode=os.O_RDWR)] and role=='consumer' and ident[3]>0:
                    transition=self.write_states.get(tuple(ident[:2]))
                    assert transition and transition['afterIdentity']==ident,'nonempty own-RW read lacks actual write transition'
                    rw_read=True;writers=aliases;alias_count=0
                if alias_count:
                    # No environment, payload, unrelated paths, or complete fdinfo is exported.
                    diagnostic=dict(kind='capture-writable-alias-conflict',path=target[:4096],pathTruncated=len(target)>4096,
                        pathSha256=hashlib.sha256(os.fsencode(target)).hexdigest(),identity=ident,role=role,
                        selectedPid=pid,selectedFd=fd,selectedFlags=descriptor_flags(pid,fd),
                        entrySequence=self.tasks[pid]['entry']['sequence'],barrierSequence=barrier['sequence'],
                        aliasCount=alias_count,aliases=aliases,aliasesTruncated=alias_count>len(aliases),aliasInventorySha256=alias_digest.hexdigest())
                    encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=16384,'bounded conflict diagnostic'
                    row=self.emit(diagnostic)
                    print('SDK_INPUT_CAPTURE_CONFLICT '+encoded,file=sys.stderr,flush=True)
                    raise AssertionError('live writable alias before consumer; diagnostic sequence '+str(row['sequence']))
            reusable=None
            if role=='consumer' and not rw_read:
                candidate=self.producers.get(tuple(ident[:2])) or self.prepared_inputs.get(target)
                if candidate and candidate[0].get('phase')==self.current_phase and candidate[0]['original']['path'] in self.capture_entities:
                    prior,held,expected=candidate
                    if prior.get('originalEntityIdentity')==self.capture_entities[prior['original']['path']][1] and expected==(prior['original']['bytes'],prior['original']['sha256']):reusable=prior
            name='capture-'+str(len(self.captures)).zfill(4)+'.original'
            if self.capture_content_entities:
                context=dict(role='fd-capture',captureRole=role,pid=pid,fd=fd,fileBytes=ident[3],captureIdentity=ident,capturePathPrefix=os.fsencode(target)[:128].decode('utf-8','backslashreplace'),capturePathSHA256=hashlib.sha256(os.fsencode(target)).hexdigest(),captureObservationComplete=False)
                ref,entity_identity,storage,data=self.content_capture_original(reader,target,ident,name,context)
                offset=data[0]
            else:
                name='capture-'+str(len(self.captures)).zfill(4)+'.original';offset=0;digest=hashlib.sha256();output=None
                try:
                    if reusable is None:output=(self.capture_dir/name).open('xb')
                    while True:
                        block=os.pread(reader,65536,offset)
                        if not block:break
                        offset+=len(block);assert offset<=self.maximum_file_bytes
                        if output is not None:self.claim(len(block),category='capture-body',context=dict(role='fd-capture',captureRole=role,pid=pid,fd=fd,fileBytes=ident[3],captureOffset=offset-len(block),captureIdentity=ident,capturePathPrefix=os.fsencode(target)[:128].decode('utf-8','backslashreplace'),capturePathSHA256=hashlib.sha256(os.fsencode(target)).hexdigest(),captureObservationComplete=False,capturePrefixSHA256=digest.copy().hexdigest()));output.write(block)
                        digest.update(block);self.check()
                    if output is not None:output.flush();os.fsync(output.fileno())
                finally:
                    if output is not None:
                        primary=sys.exc_info()[1]
                        try:output.close()
                        except BaseException:
                            if primary is None:raise
                assert ident==probe.identity(os.fstat(reader))==probe.identity(os.stat(path))
                data=(offset,digest.hexdigest())
                if reusable is None:
                    self.capture_bytes+=offset;ref=dict(path=name,bytes=offset,sha256=data[1]);entity_identity=self.register_capture_entity(ref);storage={}
                else:
                    ref=dict(reusable['original']);assert data==(ref['bytes'],ref['sha256']),'actual consumer bytes differ from retained original entity'
                    entity_identity=self.verify_capture_entity(ref);storage=dict(originalReuse=dict(model='same-phase-producer-original-v1',originCaptureSequence=reusable['sequence']))
            dependency=self.dependency_source(target) if role=='source-read' and target.startswith('/opt/qlever-sdk/dependencies/') else None
            if dependency:
                binding,expected=dependency;assert expected['mode']==stat.S_IMODE(ident[2]) and (expected['bytes'],expected['sha256'])==data,'dependency actual held FD bytes differ from prepared snapshot'
            row=self.emit(dict(**({'dependency':dependency[0]} if dependency else {}),**storage,originalEntityIdentity=entity_identity,kind='fd-capture',role='readwrite-consumer' if rw_read else role,pid=pid,fd=fd,entrySequence=self.tasks[pid]['entry']['sequence'],path=target,identity=ident,original=ref,barrierSequence=barrier['sequence'],writers=writers))
            self.captures.append(row);capture_fd=reader;self.retained.add(reader);reader=None
            if role!='producer-close':self.tasks[pid]['releaseCaptureFd']=capture_fd
            if role=='producer-close':
                previous=self.producers.get(tuple(ident[:2]))
                if previous:os.close(previous[1]);self.retained.remove(previous[1])
                self.producers[tuple(ident[:2])]=(row,capture_fd,data)
            if rw_read:
                assert (ref['bytes'],ref['sha256'])==(transition['after']['bytes'],transition['after']['sha256']),'own-RW read bytes differ from actual write transition'
                self.tasks[pid]['rwReadWindow']=(row,capture_fd,data,descriptor_position(pid,fd))
                self.emit(dict(kind='actual-write-consumer-binding',captureSequence=row['sequence'],transitionSequence=transition['sequence'],path=target,identity=ident,readOffset=descriptor_position(pid,fd)))
            if role=='consumer' and not rw_read:
                if self.generated_vma and self.generated_vma.consumer(row,data,ident):return row
                original=self.producers.get(tuple(ident[:2]));prepared=False
                if original is None:
                    original=self.prepared_inputs.get(target);prepared=original is not None
                assert original,'build consumer lacks actual producer or sealed prepared FD: '+str(dict(path=target,dev=ident[0],ino=ident[1]))
                old,held,expected=original;now=probe.identity(os.fstat(held));held_hash=hashlib.sha256();held_bytes=0
                while True:
                    block=os.pread(held,65536,held_bytes)
                    if not block:break
                    held_bytes+=len(block);assert held_bytes<=self.maximum_file_bytes;held_hash.update(block);self.check()
                held_data=(held_bytes,held_hash.hexdigest())
                assert now==probe.identity(os.fstat(held))
                assert data==expected==held_data and now==ident,'actual prepared/generated bytes changed before consumer: '+str(dict(path=target,dev=ident[0],ino=ident[1]))
                if target!=old['path'] or any(window['kind']=='actual-rename-window' and window.get('producerCaptureSequence')==old['sequence'] for window,change in self.metadata_states):
                    named_identity=probe.identity(os.stat(target,follow_symlinks=False));assert named_identity==ident==probe.identity(os.fstat(held)),'actual named path does not refer to retained producer FD'
                    mode_refs=bindings.retained_metadata_chain(old,row,self.metadata_states)
                    self.emit(dict(kind='retained-fd-namespace-binding',producerCaptureSequence=old['sequence'],consumerCaptureSequence=row['sequence'],path=target,namedIdentity=named_identity,retainedIdentity=now,modeTransitions=mode_refs,metadataChainModel='actual-rename-mode-chain-v1'))
                self.consumers.append(self.emit(dict(kind='prepared-consumer-binding' if prepared else 'generated-consumer-binding',captureSequence=row['sequence'],producerCaptureSequence=old['sequence'],path=target,identity=ident,retainedIdentity=now,actualBytesEqual=True)))
            return row
        finally:
            if reader is not None:os.close(reader)
    def enforce_executable_memory(self,pid,record):
        reason=memory_policy.decision(record['arch'],record['nr'],record['args'])
        # Existing controlled ENOSYS substitution prevents setup from executing;
        # enter/register and all unmediated asynchronous submissions stay refused.
        if record['nr']==425 and self.deny_optional_io_uring:reason=None
        descriptor=memory_policy.write_descriptor(record['arch'],record['nr'],record['args'])
        if descriptor is not None:
            target=fdpath(pid,descriptor)
            if memory_policy.memory_fd(target):reason='proc-memory-write-descriptor'
            self.emit(dict(kind='executable-memory-write-fd',model=memory_policy.MODEL,pid=pid,entrySequence=record['sequence'],fd=descriptor,target=target))
        if reason:
            self.emit(dict(kind='executable-memory-refused',model=memory_policy.MODEL,pid=pid,entrySequence=record['sequence'],reason=reason))
            raise ValueError('executable memory policy refused before resume: '+reason)

    def lifetime_open(self,pid,path):
        """Open the actual lexical target through the tracee's own root.

        Existing process authority must already have sampled this pid. Binding
        the opened root re-validates its six-field identity, so a root swap
        between the authority barrier and this open refuses the lease.
        """
        assert isinstance(path,str) and path.startswith('/') and '\x00' not in path,'absolute actual lexical target required'
        assert pid in self.authority_observed,'lifetime target requires an existing actual process authority sample'
        root=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        try:
            # The held root must still be the identity captured by process
            # authority; bind() rechecks the full six-field stat of this FD.
            self.authority_handles.bind('root',root)
            # Linux openat2 RESOLVE_IN_ROOT also confines absolute symlink
            # targets. A relative openat alone would still escape via symlinks.
            assert os.uname().machine in ['x86_64','aarch64'],'supported openat2 ABI required'
            how=(ctypes.c_uint64*3)(os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK,0,0x10|0x02)
            libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long
            descriptor=libc.syscall(ctypes.c_long(437),ctypes.c_int(root),ctypes.c_char_p(os.fsencode(path)),ctypes.byref(how),ctypes.c_size_t(ctypes.sizeof(how)))
            if descriptor<0:raise OSError(ctypes.get_errno(),'root-contained lifetime open failed',path)
            return descriptor
        finally:os.close(root)
    def execveat_descriptor_is_image(self,pid,descriptor):
        """Reject an empty-path execveat target that cannot be a regular image."""
        try:
            value=os.stat('/proc/'+str(pid)+'/fd/'+str(descriptor))
            return stat.S_ISREG(value.st_mode) and not descriptor_flags(pid,descriptor)&os.O_PATH
        except (FileNotFoundError,ProcessLookupError):return False
    def lifetime_acquisition(self,pid,lexical,role,entry_sequence,barrier_sequence,*,descriptor=None,depth=0,source='lexical',collected=None):
        """Acquire one actual kernel read lease before the syscall is resumed.

        Every local descriptor is closed in this function; LeaseSet holds its own
        CLOEXEC duplicate, so a tracee FD may later close without ending evidence.
        """
        assert self.lifetime_leases is not None and depth<=LIFETIME_MAXIMUM_DEPTH,'bounded lifetime lease recursion required'
        assert role in ['executable','interpreter','mmap'],'typed lifetime lease role required'
        local=None
        try:
            try:
                local=os.open('/proc/'+str(pid)+'/fd/'+str(descriptor),os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK) if descriptor is not None else self.lifetime_open(pid,lexical)
            except OSError as error:
                if error.errno not in LIFETIME_OPEN_ERRORS:raise
                self.tool_unresolved(pid,'toolchain-lease-open-unavailable',role=role,actualPath=lexical[:4096],errorCode=error.errno,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            value=os.fstat(local);ident=probe.identity(value)
            if not stat.S_ISREG(value.st_mode):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role=role,actualPath=lexical[:4096],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            if not fcntl.fcntl(local,fcntl.F_GETFL)&os.O_NONBLOCK:
                self.tool_unresolved(pid,'toolchain-lease-descriptor-flags-differ',role=role,actualPath=lexical[:4096],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            return self.lifetime_ensure(pid,local,ident,lexical,role,entry_sequence,barrier_sequence,source=source,depth=depth,collected=collected)
        finally:
            if local is not None:os.close(local)
    def lifetime_ensure(self,pid,reader,ident,lexical,role,entry_sequence,barrier_sequence,*,source,depth,collected=None):
        key=tuple(ident[:2]);present=self.lifetime_acquired.get(key)
        if present is not None:
            assert present['identity']==ident,'same leased inode changed identity before reuse'
            self.lifetime_leases.check(present['token'])
            if collected is not None:collected.append(list(ident))
            if role in ['executable','interpreter']:
                interpreter=self.lifetime_classify(reader,ident)
                if interpreter is not None:self.lifetime_interpreter(pid,interpreter,depth+1,entry_sequence,barrier_sequence,collected)
            return self.emit(dict(kind='toolchain-lease-reused',pid=pid,leaseId=present['token']['leaseId'],acquisitionSequence=present['sequence'],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,role=role,source=source,scope='same kernel-held read lease token reused; no second acquisition'))
        # Classify before acquiring. An unsupported executable format stays an
        # explicit pending observation and must never receive lease evidence.
        interpreter=None
        if role in ['executable','interpreter']:
            try:interpreter=self.lifetime_classify(reader,ident)
            except ValueError as error:
                self.tool_unresolved(pid,'toolchain-lease-format-unclassified',role=role,actualPath=lexical[:4096],detail=str(error)[:256],entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return None
        token=self.lifetime_leases.acquire(reader)
        assert token['identity']==ident and fcntl.fcntl(reader,fcntl.F_GETLEASE)==fcntl.F_RDLCK,'actual held kernel read lease required before resume'
        captured=self.emit(dict(kind='toolchain-lease-acquired',model=LIFETIME_MODEL,pid=pid,role=role,source=source,identity=ident,actualPath=lexical[:4096],actualPathTruncated=len(lexical)>4096,actualPathSha256=hashlib.sha256(os.fsencode(lexical)).hexdigest(),leaseId=token['leaseId'],entrySequence=entry_sequence,barrierSequence=barrier_sequence,depth=depth,**({'interpreter':interpreter} if interpreter else {})))
        self.lifetime_acquired[key]=dict(token=dict(token),sequence=captured['sequence'],identity=list(ident))
        self.lifetime_by_identity[tuple(ident)]=dict(token=dict(token),sequence=captured['sequence'])
        if collected is not None:collected.append(list(ident))
        if interpreter is not None:self.lifetime_interpreter(pid,interpreter,depth+1,entry_sequence,barrier_sequence,collected)
        return captured
    def lifetime_classify(self,reader,ident):
        """Return the single actual interpreter named by supported image bytes."""
        header=os.pread(reader,4096,0)
        if header.startswith(b'#!'):
            words=header[2:].split(b'\n',1)[0].split()
            interpreter=words[0].decode('utf-8','strict') if words else ''
        elif header.startswith(b'\x7fELF'):
            interpreter=bindings.elf_interpreter(lambda offset,size:os.pread(reader,size,offset),ident[3]).get('interpreter') or ''
        else:raise ValueError('actual image is neither supported ELF64 nor an absolute shebang')
        if interpreter and (not interpreter.startswith('/') or '\x00' in interpreter or len(interpreter.encode())>4096):raise ValueError('absolute bounded interpreter path required')
        return interpreter or None
    def lifetime_interpreter(self,pid,interpreter,depth,entry_sequence,barrier_sequence,collected=None):
        if depth>LIFETIME_MAXIMUM_DEPTH:
            self.tool_unresolved(pid,'toolchain-lease-interpreter-depth-exceeded',role='interpreter',actualPath=interpreter[:4096],entrySequence=entry_sequence,barrierSequence=barrier_sequence);return
        local=None
        try:
            try:local=self.lifetime_open(pid,interpreter)
            except OSError as error:
                if error.errno not in LIFETIME_OPEN_ERRORS:raise
                self.tool_unresolved(pid,'toolchain-lease-interpreter-open-unavailable',role='interpreter',actualPath=interpreter[:4096],errorCode=error.errno,entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return
            value=os.fstat(local);next_identity=probe.identity(value)
            if not stat.S_ISREG(value.st_mode):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role='interpreter',actualPath=interpreter[:4096],identity=next_identity,entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return
            self.lifetime_ensure(pid,local,next_identity,interpreter,'interpreter',entry_sequence,barrier_sequence,source='interpreter',depth=depth,collected=collected)
        finally:
            if local is not None:os.close(local)
    def tool_unresolved(self,pid,reason,**fields):
        return self.emit(dict(kind='toolchain-unresolved',pid=pid,reason=reason,**fields))
    def tool_original(self,reader,observed_path):
        before=probe.identity(os.fstat(reader));assert stat.S_ISREG(before[2]) and before[3]<=self.maximum_file_bytes,'bounded regular tool FD required'
        cached=self.tool_original_cache.get(tuple(before))
        if cached:return cached
        name='capture-'+str(len(self.captures)).zfill(4)+'.original';offset=0;digest=hashlib.sha256()
        with (self.capture_dir/name).open('xb') as output:
            while True:
                self.check();block=os.pread(reader,65536,offset)
                if not block:break
                offset+=len(block);assert offset<=before[3] and offset<=self.maximum_file_bytes,'tool FD grew during bounded capture'
                self.claim(len(block),category='capture-body');output.write(block);digest.update(block)
            output.flush();os.fsync(output.fileno())
        assert offset==before[3] and before==probe.identity(os.fstat(reader)),'tool FD changed during capture'
        original=dict(path=name,bytes=offset,sha256=digest.hexdigest())
        row=self.emit(dict(kind='toolchain-original',captureKind='file',observedPath=observed_path,identity=before,original=original))
        self.captures.append(row);self.capture_bytes+=offset;self.tool_original_cache[tuple(before)]=row
        return row
    def tool_mountinfo_original(self,pid,namespace_identity,data):
        digest=hashlib.sha256(data).hexdigest();key=(tuple(namespace_identity),digest)
        reference=self.tool_provider_cache.get(key)
        if reference is None:
            assert len(self.tool_provider_cache)<self.maximum_processes,'actual tool provider original count bound'
            name='capture-'+str(len(self.captures)).zfill(4)+'.original'
            with (self.capture_dir/name).open('xb') as output:
                for at in range(0,len(data),65536):self.check();block=data[at:at+65536];self.claim(len(block),category='capture-body');output.write(block)
                output.flush();os.fsync(output.fileno())
            reference=dict(path=name,bytes=len(data),sha256=digest)
            capture=self.emit(dict(kind='toolchain-original',captureKind='mountinfo',observedPid=pid,original=reference));self.captures.append(capture);self.capture_bytes+=len(data);self.tool_provider_cache[key]=reference
        return reference
    def capture_process_authority(self,pid,role,event_sequence=None):
        barrier=self.barrier()
        try:mounts,observation=tool_providers.capture_process_authority(pid,self.check,self.tool_metadata_bytes,self.authority_handles)
        except BaseException as error:
            # Parent-visible context only; the sole provider owns actual status
            # originals. Preserve its original failure and never resume here.
            context=dict(kind='process-authority-capture-rejected',pid=pid,role=role,eventSequence=event_sequence,barrierSequence=barrier['sequence'],phase=self.current_phase,exceptionClass=type(error).__name__,authorityVerified=False)
            encoded=json.dumps(context,sort_keys=True);assert len(encoded.encode())<=2048,'authority failure context bound'
            print('SDK_PROCESS_AUTHORITY_REJECTED '+encoded,file=sys.stderr,flush=True)
            raise
        observation['mountinfoOriginal']=self.tool_mountinfo_original(pid,observation['namespaces']['mnt']['identity'],mounts)
        self.authority_observed.add(pid)
        self.emit(dict(kind='toolchain-process-authority',pid=pid,role=role,eventSequence=event_sequence,barrierSequence=barrier['sequence'],observation=observation))
    def capture_exit_authority_at_stop(self,pid,status,event):
        lease=tool_providers.ExitStopAuthorityLease(pid,status,event['exitStatus'],self.check,self.tool_metadata_bytes,self.authority_handles)
        try:
            observation=lease.observation
            observation['authority']['mountinfoOriginal']=self.tool_mountinfo_original(pid,observation['authority']['namespaces']['mnt']['identity'],lease.mounts)
            original=self.emit(dict(kind='toolchain-terminal-authority',pid=pid,eventSequence=event['sequence'],observation=observation))
            self.tasks[pid]['terminalAuthority']=dict(lease=lease,event=event,original=original,closed=False)
        except BaseException:lease.close();raise
    def reap_terminal_task(self,pid,*,allow_pending=False):
        task=self.tasks[pid];terminal=task.get('terminalAuthority')
        assert terminal and terminal['lease'].assert_task_before_wait()=='Z','actual held EXIT task required before terminal wait'
        self.check();assert self.waiter.active,'existing owned wait deadline must be armed';self.waiter.check()
        observed,status=os.waitpid(pid,WALL|os.WNOHANG);self.waiter.check();self.check()
        if allow_pending and observed==0:return False
        assert observed==pid and (os.WIFEXITED(status) or os.WIFSIGNALED(status)) and status==terminal['event']['exitStatus'],'EXIT message lacks matching actual terminal wait'
        self.event(pid,status,False);return True
    def tool_provider(self,pid,reader,actual_path,identity,original,barrier):
        try:data,observation=tool_providers.capture_provider(pid,reader,actual_path,identity,self.check,self.tool_metadata_bytes)
        except tool_providers.ProviderUnavailable as error:
            self.tool_unresolved(pid,'toolchain-effective-readonly-provider-unverified',actualPath=actual_path,barrierSequence=barrier,detail=str(error)[:512]);return None
        reference=self.tool_mountinfo_original(pid,observation['mountNamespaceIdentity'],data)
        observation['mountinfoOriginal']=reference
        return self.emit(dict(kind='toolchain-provider-original',pid=pid,barrierSequence=barrier,fileOriginal=original,observation=observation))['sequence']
    def generated_wait_word(self,pid,address):
        assert sys.byteorder=='little' and single.ctypes.sizeof(single.ctypes.c_long)==8,'reviewed 64-bit little-endian ptrace word required'
        assert type(address) is int and address>0 and address%4==0,'aligned uint32 word required'
        value=single.trace(single.PEEKDATA,pid,address&~7);raw=int(value).to_bytes(8,'little',signed=True);return raw[address%8:address%8+4]
    def content_tool_maps(self,pid):
        path='/proc/'+str(pid)+'/maps';name='capture-'+str(len(self.captures)).zfill(4)+'.original';data=bytearray();digest=hashlib.sha256()
        def identity(value):return [*probe.identity(value),value.st_nlink]
        with open(path,'rb')as source:
            before=identity(os.fstat(source.fileno()));named=identity(os.stat(path,follow_symlinks=False))
            assert stat.S_ISREG(before[2])and before[3]==0 and before[6]==1 and before==named,'actual proc maps descriptor/named identity differs'
            while True:
                self.check();block=source.read(65536)
                if not block:break
                assert len(data)+len(block)<=self.tool_metadata_bytes,'bounded actual maps required'
                data.extend(block);digest.update(block)
            observed=(len(data),digest.hexdigest());after=identity(os.fstat(source.fileno()));assert before==after==identity(os.stat(path,follow_symlinks=False)),'actual complete maps FD changed'
            reused=self.prior_content_entity(observed,scope=('maps',));extra={}
            if reused is None:
                with(self.capture_dir/name).open('xb')as output:
                    for at in range(0,len(data),65536):
                        self.check();block=data[at:at+65536];self.claim(len(block),category='capture-body',context=dict(role='toolchain-original',captureKind='maps',observedPid=pid));output.write(block)
                    output.flush();os.fsync(output.fileno())
                ref=dict(path=name,bytes=observed[0],sha256=observed[1]);self.capture_bytes+=observed[0]
            else:
                prior,ref,_=reused;extra['originalReuse']=dict(model='same-phase-maps-content-entity-v1',originCaptureSequence=prior['sequence'])
            assert before==identity(os.fstat(source.fileno()))==identity(os.stat(path,follow_symlinks=False)),'maps FD/named identity changed during physical original verification'
            ref=dict(ref,observationSequence=self.seq+1)
            row=self.emit(dict(kind='toolchain-original',captureKind='maps',observedPid=pid,original=ref,mapsWindowIdentity=before,mapsWindowAfterIdentity=after,mapsNamedWindowIdentity=named,mapsNamedWindowAfterIdentity=identity(os.stat(path,follow_symlinks=False)),**extra));self.captures.append(row)
        mappings=bindings.parse_proc_maps(bytes(data));memory_policy.validate_mappings(mappings)
        return row,mappings
    def tool_maps(self,pid):
        if getattr(self,'capture_maps_content_entities',False):return self.content_tool_maps(pid)
        # Read only while all registered potential writers are at OS stops.
        name='capture-'+str(len(self.captures)).zfill(4)+'.original';data=bytearray();digest=hashlib.sha256()
        with open('/proc/'+str(pid)+'/maps','rb') as source,(self.capture_dir/name).open('xb') as output:
            while True:
                self.check();block=source.read(65536)
                if not block:break
                assert len(data)+len(block)<=self.tool_metadata_bytes,'bounded actual maps required'
                self.claim(len(block),category='capture-body');output.write(block);data.extend(block);digest.update(block)
            output.flush();os.fsync(output.fileno())
        original=dict(path=name,bytes=len(data),sha256=digest.hexdigest())
        row=self.emit(dict(kind='toolchain-original',captureKind='maps',observedPid=pid,original=original));self.captures.append(row);self.capture_bytes+=len(data)
        mappings=bindings.parse_proc_maps(bytes(data));memory_policy.validate_mappings(mappings)
        return row,mappings
    def tool_mapping(self,pid,mapping,parent,barrier,actual_fd=None,*,required=False,permitted=None):
        common=dict(pid=pid,parentCaptureSequence=parent,barrierSequence=barrier,mapping=mapping,actualFd=actual_fd)
        if mapping['inode']==0 and mapping['path'] in ['[vdso]','[vsyscall]'] and 'x' in mapping['permissions'] and 'w' not in mapping['permissions']:
            return self.emit(dict(kind='toolchain-kernel-executable-mapping',model=memory_policy.MODEL,**common,scope='kernel-provided immutable execution mapping; kernel is controller TCB, not a userspace source archive'))
        if mapping['inode']==0 or not mapping['path'].startswith('/'):
            return self.tool_unresolved(pid,'anonymous-or-kernel-mapping-original-unavailable',**{key:value for key,value in common.items() if key!='pid'})
        path='/proc/'+str(pid)+'/map_files/'+mapping['startHex']+'-'+mapping['endHex']
        held_candidates=[value for identity,value in self.lifetime_by_identity.items() if (os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode'])]
        if len(held_candidates)!=1:
            return self.tool_unresolved(pid,'actual-VMA-has-no-unique-pre-use-held-inode',**{key:value for key,value in common.items() if key!='pid'})
        backing=held_candidates[0]
        reader=self.lifetime_leases.duplicate_reader(backing['token'])
        common['mappingBackingModel']='held-pre-use-lease-v1'
        try:
            identity=probe.identity(os.fstat(reader));assert (os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode']),'actual map_files FD differs from VMA'
            original=self.tool_original(reader,mapping['path'])
            if actual_fd is not None:
                if actual_fd['identity']!=identity:return self.tool_unresolved(pid,'entry-FD-to-actual-mapped-file-identity-differs',**{key:value for key,value in common.items() if key!='pid'})
            assert identity==probe.identity(os.fstat(reader))==backing['token']['identity'],'actual held mapping inode identity changed'
            self.lifetime_leases.check(backing['token'])
            held=self.lifetime_by_identity.get(tuple(identity))
            if held is not None and (permitted is None or tuple(identity) in permitted):self.lifetime_leases.check(held['token'])
            else:
                held=None
                if required:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='mapping',parentCaptureSequence=parent,actualPath=mapping['path'][:4096],identity=identity,scope='initial exec image backing VMA has no earlier matching pre-use read lease')
            provider=self.tool_provider(pid,reader,mapping['path'],identity,original['original'],barrier)
            return self.emit(dict(kind='toolchain-mapping-original',**common,identity=identity,original=original['original'],providerSequence=provider,**({'lifetimeLeaseSequence':held['sequence']} if held is not None else {})))
        finally:os.close(reader)
    def observe_tool_stop(self,pid,job):
        barrier=self.barrier();self.check();kind,entry,event=job
        if kind=='exec-before':
            self.tasks[pid].pop('toolExecPath',None)
            rules=profile(entry['arch']);args=entry['args'];at=1 if entry['nr']==rules['execveat'] else 0
            lexical=None;raw_path=''
            try:
                raw_path=single.cstring(pid,args[at]) if args[at] else ''
                cwd=os.readlink('/proc/'+str(pid)+'/cwd');base=cwd if at==0 or args[0] in [0xffffffffffffff9c,0xffffff9c,-100] else fdpath(pid,args[0])
                lexical=os.path.normpath(raw_path if raw_path.startswith('/') else base+'/'+raw_path) if raw_path and base else None
                captured=self.emit(dict(kind='toolchain-exec-path-entry',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],syscall=entry['nr'],entryPath=raw_path,lexicalPath=lexical,scope='actual entry-stop string only; actual executable FD is independently captured'))
                self.tasks[pid]['toolExecPath']=captured
            except OSError as error:
                if error.errno not in [errno.EIO,errno.EFAULT,errno.EPERM,errno.EACCES,errno.ENOENT]:raise
                self.tool_unresolved(pid,'exec-entry-path-original-unavailable',entrySequence=entry['sequence'],errorCode=error.errno)
            except UnicodeError:self.tool_unresolved(pid,'exec-entry-path-non-UTF8',entrySequence=entry['sequence'])
            except ValueError as error:
                if str(error)!='tracee path bound':raise
                self.tool_unresolved(pid,'exec-entry-path-bound',entrySequence=entry['sequence'])
            descriptor=args[0] if entry['nr']==rules['execveat'] and not raw_path and args[0] not in [0xffffffffffffff9c,0xffffff9c,-100] else None
            if descriptor is not None and not self.execveat_descriptor_is_image(pid,descriptor):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role='executable',actualPath='/proc/'+str(pid)+'/fd/'+str(descriptor),entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],source='execveat-fd');descriptor=None;lexical=None
            collected=[]
            if lexical is not None or descriptor is not None:
                # Actual entry-stop target through the tracee root (or its own
                # execveat FD) is leased before this syscall may resume.
                # Authority/lease invariant ValueError and LeaseError both
                # abort; only an ordinary open failure stays explicit pending.
                try:
                    lease=self.lifetime_acquisition(pid,lexical or '/proc/'+str(pid)+'/fd/'+str(descriptor),'executable',entry['sequence'],barrier['sequence'],descriptor=descriptor,source='execveat-fd' if descriptor is not None else 'lexical',collected=collected)
                    if lease is not None:self.tasks[pid]['toolExecLease']=dict(sequence=lease['sequence'],identities=[list(value) for value in collected],entrySequence=entry['sequence'])
                except OSError as error:
                    self.tool_unresolved(pid,'toolchain-lease-acquisition-failed',role='executable',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],errorClass=type(error).__name__)
            else:self.tool_unresolved(pid,'toolchain-lease-target-unresolved',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],hasRawPath=bool(raw_path))
        elif kind=='exec':
            expected=profile(entry['arch'])['exec'] if entry is not None else []
            if entry is None or entry['nr'] not in expected:
                self.tool_unresolved(pid,'exec-stop-actual-syscall-entry-unavailable',execEventSequence=event['sequence']);return
            path='/proc/'+str(pid)+'/exe'
            try:reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
            except OSError as error:
                if error.errno not in [errno.EPERM,errno.EACCES,errno.ENOENT,errno.ESRCH]:raise
                self.tool_unresolved(pid,'exec-stop-executable-FD-unavailable',execEntrySequence=entry['sequence'],execEventSequence=event['sequence'],errorCode=error.errno);return
            try:
                identity=probe.identity(os.fstat(reader));resolved=os.readlink(path);original=self.tool_original(reader,resolved)
                try:elf=bindings.elf_interpreter(lambda offset,size:os.pread(reader,size,offset),identity[3])
                except ValueError as error:elf=dict(unresolved='actual-ELF-interpreter-unclassified:'+str(error)[:256])
                assert identity==probe.identity(os.fstat(reader))==probe.identity(os.stat(path)),'actual exe FD changed'
                lease=self.tasks[pid].pop('toolExecLease',None)
                permitted={tuple(value) for value in lease['identities']} if lease is not None and lease['entrySequence']==entry['sequence'] else set()
                if tuple(identity) not in permitted:self.tool_unresolved(pid,'toolchain-lifetime-lease-mismatch',role='executable',execEntrySequence=entry['sequence'],actualPath=resolved[:4096],identity=identity,permittedIdentities=[list(value) for value in sorted(permitted)],scope='actual exec image differs from its own pre-resume acquisition chain')
                held=self.lifetime_by_identity.get(tuple(identity))
                if held is not None:self.lifetime_leases.check(held['token'])
                provider=self.tool_provider(pid,reader,resolved,identity,original['original'],barrier['sequence'])
                maps,mappings=self.tool_maps(pid)
                with open('/proc/'+str(pid)+'/personality','rb') as personality_file:personality=personality_file.read(33)
                assert re.fullmatch(rb'[0-9a-f]{8}\n',personality) and not int(personality,16)&0x400000,'READ_IMPLIES_EXEC personality refused before executable resume'
                captured=self.emit(dict(kind='toolchain-exec-image-capture',executionPersonalityRaw=personality.decode('ascii'),pid=pid,barrierSequence=barrier['sequence'],execEntrySequence=entry['sequence'],execEventSequence=event['sequence'],execPathEntrySequence=self.tasks[pid].get('toolExecPath',{}).get('sequence'),exe=dict(lexicalPath=self.tasks[pid].get('toolExecPath',{}).get('lexicalPath'),resolvedPath=resolved,identity=identity,original=original['original'],providerSequence=provider),elf=elf,mapsOriginal=maps['original'],**(dict(lifetimeLeaseSequence=held['sequence'],lifetimeLeaseVerified=tuple(identity) in permitted) if held is not None else {})))
                for mapping in mappings:
                    if mapping['inode'] or 'x' in mapping['permissions']:
                        # Every initial executable/interpreter backing VMA must
                        # match this exec's own pre-resume acquisition chain.
                        self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'],required=True,permitted=permitted)
            finally:os.close(reader)
        elif kind=='protect-before':
            maps,_=self.tool_maps(pid);self.tasks[pid]['toolProtectBefore']=maps['original']
            self.emit(dict(kind='toolchain-executable-protection-before',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],mapsOriginal=maps['original']))
        elif kind=='mmap-before':
            self.tasks[pid].pop('toolMmapLease',None)
            descriptor=entry['args'][4]
            # Only queued for a nonanonymous regular FD; this job must acquire
            # through the tracee's own /proc/PID/fd/N before the kernel maps it.
            lease=self.lifetime_acquisition(pid,fdpath(pid,descriptor) or '/proc/'+str(pid)+'/fd/'+str(descriptor),'mmap',entry['sequence'],barrier['sequence'],descriptor=descriptor,source='descriptor')
            if lease is not None:self.tasks[pid]['toolMmapLease']=dict(sequence=lease['sequence'],identity=lease['identity'],entrySequence=entry['sequence'])
        else:
            maps,mappings=self.tool_maps(pid);args=entry['args']
            if kind=='mmap':
                begin=event['result'];end=begin+args[1];assert 0<=begin<end<=1<<64,'actual mmap returned range overflow';anonymous=bool(args[3]&0x20);fd=self.tasks[pid].pop('toolMmapFd',None)
                if fd is not None:
                    try:
                        reader=os.open('/proc/'+str(pid)+'/fd/'+str(fd['fd']),os.O_RDONLY|os.O_CLOEXEC)
                        try:
                            current=probe.identity(os.fstat(reader))
                            if current==fd['identity'] and stat.S_ISREG(current[2]):fd['original']=self.tool_original(reader,fdpath(pid,fd['fd']))['original']
                            else:self.tool_unresolved(pid,'actual-mmap-FD-changed-or-nonregular',entrySequence=entry['sequence'])
                        finally:os.close(reader)
                    except OSError as error:
                        if error.errno not in [errno.EPERM,errno.EACCES,errno.ENOENT,errno.ESRCH]:raise
                        self.tool_unresolved(pid,'actual-mmap-FD-original-unavailable',entrySequence=entry['sequence'],errorCode=error.errno)
                lease=self.tasks[pid].pop('toolMmapLease',None)
                if lease is not None and not(anonymous or fd is None or lease['identity']!=fd['identity'] or lease['entrySequence']!=entry['sequence']):
                    self.lifetime_leases.check(self.lifetime_by_identity[tuple(lease['identity'])]['token'])
                else:
                    lease=None
                    if not anonymous and fd is not None:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='mmap',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],identity=fd.get('identity'),actualPath=fdpath(pid,args[4]),scope='file-backed mmap has no earlier matching pre-use read lease')
                captured=self.emit(dict(kind='toolchain-file-mapping-capture',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],exitSequence=event['sequence'],actualReturnedAddressHex=format(begin,'x'),actualFd=fd,requestedLength=args[1],fileOffset=args[5],flags=args[3],protection=args[2],mapsOriginal=maps['original'],**(dict(lifetimeLeaseSequence=lease['sequence'],lifetimeLeaseIdentity=lease['identity']) if lease is not None else {})))
                selected=[row for row in mappings if int(row['startHex'],16)<end and int(row['endHex'],16)>begin]
                bindings.verify_vma_range(mappings,begin,args[1],args[2])
                if anonymous:self.tool_unresolved(pid,'anonymous-or-JIT-mapping-source-unresolved',parentCaptureSequence=captured['sequence'])
                elif fd is None:self.tool_unresolved(pid,'actual-mapping-entry-FD-unavailable',parentCaptureSequence=captured['sequence'])
                else:
                    assert selected,'successful mmap has no actual VMA'
                    for mapping in selected:
                        if mapping['fileOffset']+max(begin-int(mapping['startHex'],16),0)!=args[5]+max(int(mapping['startHex'],16)-begin,0):
                            self.tool_unresolved(pid,'actual-mmap-VMA-offset-differs',parentCaptureSequence=captured['sequence']);continue
                        self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'],fd)
            else:
                begin,end=args[0],args[0]+args[1];before=self.tasks[pid].pop('toolProtectBefore',None)
                captured=self.emit(dict(kind='toolchain-executable-protection-capture',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],exitSequence=event['sequence'],actualSyscall=entry['nr'],requestedStartHex=format(begin,'x'),requestedLength=args[1],protection=args[2],beforeMapsOriginal=before,afterMapsOriginal=maps['original']))
                if entry['nr'] in [329,288]:self.tool_unresolved(pid,'toolchain-protection-key-access-state-unverified',parentCaptureSequence=captured['sequence'])
                if before is None:self.tool_unresolved(pid,'executable-protection-before-VMA-unavailable',parentCaptureSequence=captured['sequence'])
                actual_mappings=bindings.verify_vma_range(mappings,begin,args[1],args[2])
                if any(mapping['inode']==0 or not mapping['path'].startswith('/') for mapping in actual_mappings):self.tool_unresolved(pid,'anonymous-or-JIT-mapping-source-unresolved',parentCaptureSequence=captured['sequence'])
                def protected(mapping):
                    try:return self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'])
                    except BaseException:
                        # A mapping-original rejection must not hide its own
                        # explicit lifetime fault before this syscall resumes.
                        self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='protected-mapping',parentCaptureSequence=captured['sequence'],actualPath=mapping['path'][:4096],mapping=mapping,scope='executable protection original could not be bound to any earlier pre-use lease')
                        raise
                # mprotect never acquires. Each executable file-backed mapping
                # must carry an earlier full-identity lease, else explicit pending.
                for mapping in actual_mappings:
                    if 'x' not in mapping['permissions'] or mapping['inode']==0 or not mapping['path'].startswith('/'):continue
                    row=protected(mapping)
                    if 'lifetimeLeaseSequence' not in row:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='protected-mapping',parentCaptureSequence=captured['sequence'],actualPath=mapping['path'][:4096],mapping=mapping,scope='executable protection has no earlier matching pre-use read lease')
                for mapping in mappings:
                    if int(mapping['startHex'],16)<end and int(mapping['endHex'],16)>begin and mapping not in actual_mappings:protected(mapping)
    def resume(self):
        if self.generated_vma and getattr(self.generated_vma,'round',None) is not None:return self.generated_vma.drive()
        focus=getattr(self,'terminal_focus',None)
        if focus is not None and self.tasks[focus].get('terminalAuthority',{}).get('closed')and state(focus)=='Z':self.terminal_focus=None
        if getattr(self,'serialize_terminal_syscalls',False)and self.terminal_focus is None and self.exclusive is None:
            def candidates():
                return [(pid,task)for pid,task in self.tasks.items()if not task['exited']and not task.get('terminalAuthority')and task.get('entry')and task['entry']['nr']in bindings.policy(task['entry']['arch'])['exits']]
            if candidates():
                self.barrier()
                pending=candidates();assert pending,'selected exit entry escaped all-stop'
                # Linux thread exit is 93/60; group exit is 94/231. Finish the
                # already stopped individual exits before a sibling can kill
                # their still pending EXIT-event authority boundaries.
                pid,task=min(pending,key=lambda pair:(pair[1]['entry']['nr']in [94,231],pair[0]))
                assert task['stopped']and state(pid)=='t'and not task.get('authorityPending'),'selected terminal task lacks initialized stop'
                self.terminal_focus=pid
        for pid,row in list(self.tasks.items()):
            if getattr(self,'terminal_focus',None)is not None and pid!=self.terminal_focus and not row.get('terminalAuthority',{}).get('closed'):continue
            if self.generated_vma and self.generated_vma.owner is not None and pid!=self.generated_vma.owner:continue
            if self.exclusive and pid!=self.exclusive[0]:continue
            if row.get('vforkHeldChild') is not None:continue
            if row.get('identityNoopPending'):continue
            if row['stopped'] and not row['exited']:
                terminal=row.get('terminalAuthority')
                if terminal:
                    assert terminal['closed'],'EXIT task resumed before terminal/peer closure'
                    if state(pid)=='Z':self.reap_terminal_task(pid,allow_pending=getattr(self,'serialize_terminal_syscalls',False));continue
                    signal_value=row.pop('signal',0);assert signal_value==0,'EXIT resume may not inject a signal'
                    single.trace(SYSCALL,pid,0,0);row['stopped']=False
                    terminal['resumed']=self.emit(dict(kind='actual-terminal-exit-resume',pid=pid,originalSequence=terminal['original']['sequence'],closeSequence=terminal['closedRow']['sequence'],request='PTRACE_SYSCALL',signal=0))
                else:
                    single.trace(SYSCALL,pid,0,row.pop('signal',0));row['stopped']=False
    def close_terminal_authorities(self,barrier):
        if not getattr(self,'terminal_exit_evidence',False):return
        for pid,task in list(self.tasks.items()):
            terminal=task.get('terminalAuthority')
            if terminal and not terminal['closed']:
                terminal['closedRow']=self.emit(dict(kind='toolchain-terminal-authority-closed',pid=pid,eventSequence=terminal['event']['sequence'],originalSequence=terminal['original']['sequence'],barrierSequence=barrier['sequence'],actualWaitSequence=task.get('actualWaitSequence')))
                terminal['closed']=True
                if task['exited']:terminal['lease'].close()
    def capture_identity_noop_entry(self,pid,record,status):
        task=self.tasks[pid]
        assert self.exclusive is None and not self.pausing and not task.get('authorityPending'),'identity requires initialized exclusive authority boundary'
        assert task['stopped'] and not task['exited'] and task['entry'] is record,'identity entry changed before its boundary'
        identity_axis=tool_providers.identity_noop_axis(record['arch'],record['nr'])
        barrier=self.barrier()
        transition_type=tool_providers.StoppedIdentityNoopTransition if getattr(self,'verified_identity_noop',False) else tool_providers.StoppedSetresuidTransition
        transition=transition_type(pid,record['arch'],record['nr'],record['args'],self.check,entry_sequence=record['sequence'],barrier_sequence=barrier['sequence'],stopped_wait_status=status)
        task['setresuidTransition']=transition
        try:
            self.emit(dict(kind='identity-noop-entry-original' if getattr(self,'verified_identity_noop',False) else 'setresuid-noop-entry-original',**(dict(identityAxis=identity_axis) if getattr(self,'verified_identity_noop',False) else {}),pid=pid,entrySequence=record['sequence'],barrierSequence=barrier['sequence'],observation=transition.observation))
            self.exclusive=(pid,record['sequence'])
        except BaseException:transition.close();task.pop('setresuidTransition',None);raise
    def capture_queued_identity(self):
        if not getattr(self,'queued_identity_noop',False):return False
        assert self.exclusive is None and not self.pausing,'queued identity requires a quiescent dispatcher'
        for pid,task in self.tasks.items():
            pending=task.get('identityNoopPending')
            if pending and not task['exited'] and not task.get('authorityPending'):
                entry_sequence,status=pending;record=task['entry']
                assert record is not None and record['sequence']==entry_sequence and task['stopped'],'queued identity lost its actual stopped entry'
                self.capture_identity_noop_entry(pid,record,status)
                del task['identityNoopPending']
                return True
        return False
    def checkpoint_append_boundaries(self):
        if not any(task.get('appendBoundary') for task in self.tasks.values()):return
        self.barrier()
        for task in self.tasks.values():
            # A peer may reach its exit while the all-stop barrier is assembled.
            # Preserve the actual causal entry rather than borrowing its later
            # mutable entry slot, which can already be closed at this point.
            boundary=task.pop('appendBoundary',None)
            if boundary is not None:self.checkpoint_appends('syscall-boundary',boundary)
    def pending_captures(self):
        if self.generated_vma and getattr(self.generated_vma,'round',None) is not None:return
        if self.exclusive:return
        if getattr(self,'terminal_focus',None)is not None:
            if any(t.get('terminalAuthority')and not t['terminalAuthority']['closed']for t in self.tasks.values()):self.close_terminal_authorities(self.barrier())
            return
        if self.generated_vma and self.generated_vma.owner is not None:
            pid=self.generated_vma.owner;task=self.tasks[pid]
            if task.get('capture'):
                assert task.pop('capture')==(None,'generated-vma-before'),'unsupported capture while generated mapping dirty'
                capture=self.generated_vma.capture(pid);task['entry']['captureSequence']=capture['sequence'];self.exclusive=(pid,task['entry']['sequence']);self.emit(dict(kind='exclusive-generated-vma-resume',pid=pid,entrySequence=task['entry']['sequence'],captureSequence=capture['sequence']))
            return
        if self.capture_queued_identity():return
        if getattr(self,'terminal_exit_evidence',False) and any(t.get('terminalAuthority') and not t['terminalAuthority']['closed'] for t in self.tasks.values()):
            self.close_terminal_authorities(self.barrier())
        while self.process_authority:
            selected=next(((pid,row) for pid,row in self.tasks.items() if row.get('authorityPending') and not row['exited']),None)
            if selected is None:break
            pid,task=selected;role,event_sequence=task['authorityPending'].pop(0);self.capture_process_authority(pid,role,event_sequence)
        if self.capture_queued_identity():return
        self.checkpoint_append_boundaries()
        while self.capture_toolchain:
            selected=next(((pid,row) for pid,row in self.tasks.items() if row.get('toolPending') and not row['exited']),None)
            if selected is None:break
            pid,task=selected
            self.barrier();self.checkpoint_appends('toolchain-access',task['entry']['sequence'] if task.get('entry') else None)
            self.observe_tool_stop(pid,task['toolPending'].pop(0))
        # All candidate entries encountered while stopping peers are preserved;
        # process each before resuming any potential writer.
        while True:
            candidate=next(((pid,r) for pid,r in self.tasks.items() if r.get('capture') and not r['exited']),None)
            if not candidate:break
            pid,task=candidate;fd,role=task.pop('capture');
            if role!='writer-before':
                self.barrier();self.checkpoint_appends('captured-access',task['entry']['sequence'])
            capture=self.generated_vma.capture(pid) if role=='generated-vma-before' else self.capture_rename(pid) if role=='rename-before' else self.capture_metadata(pid) if role=='metadata-before' else (self.capture_write(pid,fd) if role=='writer-before' else self.capture(pid,fd,role));task['entry']['captureSequence']=capture['sequence'];self.exclusive=(pid,task['entry']['sequence']);self.emit(dict(kind={'generated-vma-operation-window':'exclusive-generated-vma-resume','actual-write-window':'exclusive-write-resume','actual-mode-window':'exclusive-mode-resume','actual-rename-window':'exclusive-rename-resume','empty-read-window':'exclusive-empty-read-resume','alias-close-window':'exclusive-alias-close-resume'}.get(capture['kind'],'exclusive-captured-syscall-resume'),pid=pid,entrySequence=task['entry']['sequence'],captureSequence=capture['sequence']));break
        if self.exclusive is None:self.capture_queued_identity()
    def release_vfork_parent(self,child,event,reason):
        task=self.tasks[child];parent_pid=task.pop('vforkParent',None)
        if parent_pid is None:return
        parent=self.tasks[parent_pid]
        assert parent.get('vforkHeldChild')==child and parent['stopped'] and not parent['exited'] and state(parent_pid)=='t','actual vfork parent ptrace-stop lost'
        hold=parent.pop('vforkHoldSequence');del parent['vforkHeldChild']
        self.emit(dict(kind='vfork-parent-release',parentPid=parent_pid,childPid=child,holdSequence=hold,releaseSequence=event['sequence'],releaseKind=reason,actualParentState='t'))
    def reject_shared_clone(self,pid,entry,flags):
        # Failure diagnostics only. No FD-table/TGID ownership or closure is
        # inferred from flags, a pathname, or this bounded /proc snapshot.
        with open('/proc/'+str(pid)+'/status','rb') as source:status=source.read(65537)
        assert len(status)<=65536,'bounded clone status original required'
        fields={}
        for line in status.splitlines():
            if b':' in line:
                key,value=line.split(b':',1)
                if key in [b'Pid',b'Tgid',b'PPid',b'TracerPid',b'Threads']:fields[key.decode('ascii')]=int(value.strip())
        assert fields.get('Pid')==pid,'actual clone PID status differs'
        tids=sorted(int(value) for value in os.listdir('/proc/'+str(pid)+'/task'));tracked=sorted(key for key,row in self.tasks.items() if not row['exited'])
        executable=os.readlink('/proc/'+str(pid)+'/exe');identity=probe.identity(os.stat('/proc/'+str(pid)+'/exe'))
        def summary(values):
            digest=hashlib.sha256()
            for value in values:self.check();digest.update((str(value)+'\n').encode())
            return dict(count=len(values),sample=values[:32],truncated=len(values)>32,sha256=digest.hexdigest())
        diagnostic=dict(kind='unsupported-shared-clone-before-resume',pid=pid,entrySequence=entry['sequence'],arch=entry['arch'],syscall=entry['nr'],actualFlags=flags,
            selectedTaskOsState=state(pid),status=fields,taskTids=summary(tids),registeredLivePids=summary(tracked),observerPid=os.getpid(),registeredRootPid=self.root,
            actualProcessGroup=os.getpgid(pid),executablePath=executable[:4096],executablePathTruncated=len(executable)>4096,executablePathSha256=hashlib.sha256(os.fsencode(executable)).hexdigest(),executableIdentity=identity,
            sharedMemory=bool(flags&0x100),sharedFdTable=bool(flags&0x400),sameThreadGroup=bool(flags&0x10000),scope='unsupported clone rejected before syscall resume; diagnostics only, no shared ownership or source authority')
        encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=16384,'bounded shared clone diagnostic'
        row=self.emit(diagnostic);print('SDK_UNSUPPORTED_SHARED_CLONE '+encoded,file=sys.stderr,flush=True)
        raise AssertionError('shared thread/FD-table clone refused before resume; diagnostic sequence '+str(row['sequence']))
    def stopped_executable_diagnostic(self,pid,status,*,descriptor=None):
        # A held executable FD and process starttime bind this selected stopped
        # task independently of its inherited historical exec-event cache.
        assert os.WIFSTOPPED(status) and self.tasks[pid]['stopped'] and not self.tasks[pid]['exited'],'actual stopped selected task required'
        assert descriptor is None or type(descriptor) is int and 0<=descriptor<(1<<31),'bounded selected descriptor required'
        selected='exe' if descriptor is None else 'fd/'+str(descriptor)
        self.check();directory=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        executable=None
        try:
            def starttime():
                self.check();fd=os.open('stat',os.O_RDONLY|os.O_CLOEXEC,dir_fd=directory)
                try:
                    raw=os.read(fd,4097);assert len(raw)<=4096,'bounded process stat'
                    assert os.read(fd,1)==b'','complete process stat'
                finally:os.close(fd)
                tail=raw[raw.rfind(b')')+2:].split();assert len(tail)>=20 and tail[0] in [b't',b'T'],'selected task no longer stopped'
                return int(tail[19])
            def fdinfo():
                self.check();fd=os.open('fdinfo/'+str(descriptor),os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=directory)
                try:
                    raw=os.read(fd,4097);assert len(raw)<=4096 and os.read(fd,1)==b'','bounded complete selected fdinfo'
                finally:os.close(fd)
                fields={}
                for name,base in [('flags',8),('pos',10),('mnt_id',10),('ino',10)]:
                    values=[line.split(b':',1)[1].strip() for line in raw.splitlines() if line.startswith(name.encode()+b':')]
                    assert len(values)==1 and values[0] and all(c in (b'01234567' if base==8 else b'0123456789') for c in values[0]),'unique numeric selected fdinfo required'
                    fields[name]=int(values[0],base)
                return raw,fields
            before=starttime();path=os.readlink(selected,dir_fd=directory)
            info,fields=fdinfo() if descriptor is not None else (None,None)
            executable=os.open(selected,(os.O_RDONLY if descriptor is None else os.O_PATH)|os.O_CLOEXEC,dir_fd=directory)
            identity=probe.identity(os.fstat(executable));assert stat.S_ISREG(identity[2]),'selected executable regular file required'
            self.check();assert identity==probe.identity(os.stat(selected,dir_fd=directory))==probe.identity(os.fstat(executable)),'held executable identity changed'
            assert path==os.readlink(selected,dir_fd=directory) and before==starttime(),'selected task executable/starttime changed'
            assert probe.identity(os.fstat(directory))==probe.identity(os.stat('/proc/'+str(pid))),'selected process directory replaced'
            result=dict(path=path[:512],pathTruncated=len(path)>512,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),identity=identity,processStarttime=before,scope='same stopped task held executable FD identity; diagnostic only, no source authority')
            if descriptor is not None:
                assert (info,fields)==fdinfo(),'selected fdinfo changed during held sample'
                assert fields['ino']==identity[1],'selected fdinfo inode differs'
                assert identity==probe.identity(os.fstat(executable))==probe.identity(os.stat(selected,dir_fd=directory)) and path==os.readlink(selected,dir_fd=directory) and before==starttime(),'selected descriptor or process identity changed after fdinfo'
                result.update(fd=descriptor,flags=fields['flags'],position=fields['pos'],mountId=fields['mnt_id'],fdinfoRaw=info.decode('ascii'),fdinfoSHA256=hashlib.sha256(info).hexdigest(),scope='same selected ptrace-stop held descriptor numeric metadata only; no body read or output/source authority')
                producer=self.producers.get(tuple(identity[:2]))
                if producer and probe.identity(os.fstat(producer[1]))==identity and producer[0].get('identity')==identity:
                    result['trackedProducerAssociation']=dict(captureSequence=producer[0]['sequence'],identity=identity,scope='existing retained producer FD identity match only; not mapping allowance')
                else:result['trackedProducerAssociationPending']='no-exact-current-retained-producer-identity'
                if path.startswith(self.build+'/') and not path.endswith(' (deleted)'):result['buildRelativePath']=os.path.relpath(path,self.build)
            return result
        finally:
            if executable is not None:os.close(executable)
            os.close(directory)
    def syscall_rejection_diagnostic(self,pid,status,entry,*,authority=False,shared_mapping=False):
        # Numeric kernel-entry arguments only: never dereference user pointers,
        # collect argv/environment, or resume a forbidden operation for diagnosis.
        args=entry['args'];assert isinstance(args,list) and len(args)==6 and all(type(value) is int and 0<=value<(1<<64) for value in args),'bounded actual syscall argument words required'
        assert type(shared_mapping) is bool and not(authority and shared_mapping),'one fixed syscall rejection category required'
        kind,pending,prefix=('process-authority-syscall-before-resume','process-authority-syscall-refused','SDK_PROCESS_AUTHORITY_SYSCALL_REJECTED ') if authority else ('shared-writable-mapping-before-resume','shared-writable-mapping-refused','SDK_SHARED_WRITABLE_MAPPING_REJECTED ') if shared_mapping else ('unsupported-asynchronous-external-writer-before-resume','unsupported-asynchronous-external-writer-syscall','SDK_UNSUPPORTED_WRITER_SYSCALL ')
        task=self.tasks[pid]
        diagnostic=dict(kind=kind,pid=pid,tid=pid,tgid=task.get('tgid'),arch=entry['arch'],syscall=entry['nr'],args=args,entrySequence=entry['sequence'],phase=self.current_phase,waitStatus=status,stopSignal=os.WSTOPSIG(status),ptraceEvent=status>>16,registeredStopped=task['stopped'],registeredExited=task['exited'],registeredRootPid=self.root,observerPid=os.getpid(),authorityVerified=False,pending=pending,scope='actual kernel syscall-entry numeric words only; refused before resume; no source or process authority')
        if task.get('diagnosticExec'):
            actual=dict(task['diagnosticExec']);path=actual['path'];actual.update(path=path[:512],pathTruncated=actual.get('pathTruncated',False) or len(path)>512)
            diagnostic['actualExecImage']=actual
        else:diagnostic['actualExecImagePending']='selected-exec-stop-original-unavailable'
        try:diagnostic['selectedStoppedExecutable']=self.stopped_executable_diagnostic(pid,status)
        except BaseException as error:diagnostic['selectedStoppedExecutablePending']=type(error).__name__[:128]
        if shared_mapping:
            if args[3]&0x20:diagnostic['selectedMappingFdPending']='actual-MAP_ANONYMOUS-flag-no-file-descriptor-sample'
            elif args[4]>=(1<<31):diagnostic['selectedMappingFdPending']='actual-fd-word-outside-nonnegative-int-range'
            else:
                try:diagnostic['selectedMappingFd']=self.stopped_executable_diagnostic(pid,status,descriptor=args[4])
                except BaseException as error:diagnostic['selectedMappingFdPending']=type(error).__name__[:128]
        encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=(12288 if shared_mapping else 4096),'bounded forbidden syscall diagnostic'
        print(prefix+encoded,file=sys.stderr,flush=True)
        return self.emit(diagnostic)
    def reject_forbidden_syscall(self,pid,status,entry):
        row=self.syscall_rejection_diagnostic(pid,status,entry)
        raise AssertionError('unsupported asynchronous/external writer syscall; diagnostic sequence '+str(row['sequence']))
    def event(self,pid,status,allow_capture=True):
        if pid not in self.tasks:
            assert os.WIFSTOPPED(status) and status>>16==128,'unregistered non-child tracee event'
            tracer=[line.split()[1] for line in Path('/proc',str(pid),'status').read_text().splitlines() if line.startswith('TracerPid:')]
            assert tracer==[str(os.getpid())] and pid not in self.unknown_stops,'unknown observer-owned stop identity'
            self.unknown_stops[pid]=status;return
        task=self.tasks[pid]
        if task.get('setresuidTransition'):
            assert os.WIFSTOPPED(status) and status>>16==0 and os.WSTOPSIG(status)==(signal.SIGTRAP|0x80),'setresuid transition lost its actual syscall exit stop'
        if task.get('deniedIoUring'):
            assert os.WIFSTOPPED(status) and status>>16==0 and os.WSTOPSIG(status)==(signal.SIGTRAP|0x80),'explicitly denied syscall lost its actual exit stop'
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            if getattr(self,'terminal_focus',None)==pid:self.terminal_focus=None
            task.update(exited=True,stopped=False);code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
            wait=self.emit(dict(kind='actual-wait-exit',pid=pid,returnCode=code,**(dict(waitStatus=status) if getattr(self,'terminal_exit_evidence',False) else {}),**({'actualExecImage':task['diagnosticExec']} if 'diagnosticExec' in task else {})));self.wait_references.append(dict(pid=pid,sequence=wait['sequence'],returnCode=code,phase=self.current_phase))
            task['actualWaitSequence']=wait['sequence']
            terminal=task.get('terminalAuthority')
            if terminal and terminal['closed']:terminal['lease'].close()
            self.release_vfork_parent(pid,wait,'actual-terminal-wait')
            if pid==self.root:self.root_code=code
            return
        assert os.WIFSTOPPED(status);task['stopped']=True;event=status>>16;sig=os.WSTOPSIG(status)
        if event:
            extra={}
            if self.process_authority and event==6 and getattr(self,'terminal_exit_evidence',False):
                message=ctypes.c_ulong();single.trace(GETEVENTMSG,pid,0,ctypes.byref(message));extra=dict(waitStatus=status,exitStatus=int(message.value))
            observed_event=self.emit(dict(kind='ptrace-event',pid=pid,event=event,**extra))
            if extra:self.capture_exit_authority_at_stop(pid,status,observed_event)
            if self.process_authority and event in [4,6] and not extra:task.setdefault('authorityPending',[]).append(('exec-stop' if event==4 else 'exit-stop',observed_event['sequence']))
            if event==4:
                actual_exe=os.readlink('/proc/'+str(pid)+'/exe');actual_identity=probe.identity(os.stat('/proc/'+str(pid)+'/exe'))
                task['diagnosticExec']=dict(path=actual_exe[:4096],pathTruncated=len(actual_exe)>4096,pathSha256=hashlib.sha256(os.fsencode(actual_exe)).hexdigest(),identity=actual_identity,eventSequence=observed_event['sequence'],entrySequence=task.get('entry',{}).get('sequence'),scope='actual exec-stop image only; argv/environment not collected')
            if event==4 and self.shared_tasks:
                prior=task['fdTable'];task['fdTable']=-observed_event['sequence'];self.emit(dict(kind='actual-exec-fd-table-unshare',pid=pid,eventSequence=observed_event['sequence'],priorFdTable=prior,fdTable=task['fdTable'],tgid=task['tgid']))
            if event==4:self.release_vfork_parent(pid,observed_event,'actual-exec')
            if event==4 and self.capture_toolchain:task.setdefault('toolPending',[]).append(('exec',task.get('entry'),observed_event))
            if event in [1,2,3]:
                child=ctypes.c_ulong();single.trace(GETEVENTMSG,pid,0,ctypes.byref(child));new=int(child.value);assert new not in self.tasks and len(self.tasks)<self.maximum_processes,'actual child/PID bound'
                fields={}
                if self.shared_tasks:
                    entry=task['entry'];assert entry is not None,'actual child lacks syscall entry'
                    if entry['nr'] in [profile(entry['arch'])['clone'],profile(entry['arch'])['clone3']]:flags=task['cloneFlags']
                    else:
                        assert entry['arch']==0xc000003e and entry['nr'] in [57,58],'unknown actual fork operation';flags=17|(0x4100 if entry['nr']==58 else 0)
                    ownership=bindings.inspect_shared_clone_flags(flags);tgid=task['tgid'] if ownership['sameThreadGroup'] else new;table=task['fdTable'] if ownership['sharedFdTable'] else new
                    assert self.actual_tgid(new)==tgid,'kernel child TGID differs from clone flags';fields=dict(tgid=tgid,fdTable=table)
                self.tasks[new]=dict(stopped=False,exited=False,entry=None,initial=True,**(dict(authorityPending=[('initial-child',None)]) if self.process_authority else {}),**fields);self.emit(dict(kind='actual-child-binding',parentPid=pid,childPid=new,event=event,**(dict(cloneEntrySequence=task['entry']['sequence'],cloneFlags=flags,**fields) if self.shared_tasks else {})))
                # The kernel child event establishes inherited executable memory;
                # it is not a new exec-stop or a current named-file observation.
                # Keep only the immediate inheritance edge, so clone depth cannot
                # enlarge a bounded failure diagnostic indefinitely.
                if task.get('diagnosticExec'):
                    inherited=dict(task['diagnosticExec'])
                    inherited.update(inheritedFromPid=pid,inheritanceEventSequence=observed_event['sequence'],inheritanceEvent=event,scope='kernel child-event inherited prior exec-stop image; not current executable-file verification; argv/environment not collected')
                    self.tasks[new]['diagnosticExec']=inherited
                if event==2:
                    if not self.shared_tasks:
                        entry=task['entry'];flags=task['observedCloneFlags'] if entry['nr'] in [profile(entry['arch'])['clone'],profile(entry['arch'])['clone3']] else 0x4111
                    assert flags&0x4000 and task.get('vforkHeldChild') is None and task['stopped'] and state(pid)=='t','actual VFORK event/parent stop required'
                    hold=self.emit(dict(kind='vfork-parent-held',parentPid=pid,childPid=new,eventSequence=observed_event['sequence'],entrySequence=task['entry']['sequence'],actualParentState='t'))
                    task.update(vforkHeldChild=new,vforkHoldSequence=hold['sequence']);self.tasks[new]['vforkParent']=pid
                if new in self.unknown_stops:self.event(new,self.unknown_stops.pop(new),False)
            elif event not in [4,5,6,128]:raise ValueError('unsupported ptrace event')
            return
        if sig!=(signal.SIGTRAP|0x80):
            # SIGCHLD delivery is recorded then suppressed; actual wait syscalls
            # still report every child. Other signals are fail-closed.
            assert sig==signal.SIGCHLD,'unexpected tracee signal';task['signal']=sig;self.emit(dict(kind='signal-delivery',pid=pid,signal=sig));return
        kernel,_=single.syscall(pid);policy=profile(kernel['arch'])
        if kernel['op']=='exit' and task['entry'] is not None:kernel['entrySequence']=task['entry']['sequence']
        record=self.emit(dict(kind='kernel-syscall',pid=pid,**kernel,**(dict(waitStatus=status) if getattr(self,'verified_setresuid_noop',False) or getattr(self,'verified_identity_noop',False) else {})))
        if record['op']=='entry':
            if self.capture_toolchain:self.enforce_executable_memory(pid,record)
            assert task['entry'] is None,'syscall entry missing prior exit';task['initial']=False;task['entry']=record;nr=record['nr'];args=record['args']
            identity_axis=tool_providers.identity_noop_axis(kernel['arch'],nr)
            if self.process_authority and ((getattr(self,'verified_identity_noop',False) and identity_axis is not None) or (getattr(self,'verified_setresuid_noop',False) and identity_axis=='Uid')):
                assert self.exclusive is None,'identity entry crossed an active exclusive operation'
                if getattr(self,'queued_identity_noop',False) and (self.pausing or task.get('authorityPending')):
                    assert task['stopped'] and not task.get('identityNoopPending'),'duplicate or nonstopped queued identity entry'
                    task['identityNoopPending']=(record['sequence'],status)
                    return
                self.capture_identity_noop_entry(pid,record,status)
                return
            if nr==425 and getattr(self,'deny_optional_io_uring',False):
                executable=self.stopped_executable_diagnostic(pid,status)
                registers=single.deny_io_uring_setup(pid,kernel['arch'],nr,model='explicit-kernel-enosys-denial-v2') if getattr(self,'io_uring_enosys_v2',False) else single.deny_io_uring_setup(pid,kernel['arch'],nr)
                denied=self.emit(dict(kind='explicit-io-uring-setup-denied',pid=pid,entrySequence=record['sequence'],arch=kernel['arch'],args=args,waitStatus=status,executable=executable,**registers))
                task['deniedIoUring']=denied
                return
            if nr in policy['forbidden']:self.reject_forbidden_syscall(pid,status,record)
            if self.process_authority:
                try:tool_providers.verify_authority_syscall(kernel['arch'],nr,args)
                except BaseException:
                    try:self.syscall_rejection_diagnostic(pid,status,record,authority=True)
                    except BaseException as diagnostic_error:
                        # Preserve the original policy rejection even if the
                        # existing raw ledger/deadline refuses a diagnostic row.
                        try:print('SDK_PROCESS_AUTHORITY_SYSCALL_DIAGNOSTIC_UNAVAILABLE '+type(diagnostic_error).__name__[:128],file=sys.stderr,flush=True)
                        except BaseException:pass
                    raise
            if self.generated_vma and self.generated_vma.classify(pid,record,lambda dirfd,address:path_argument(pid,dirfd,address)):return
            if nr in [policy['clone'],policy['clone3']]:
                flags=args[0] if nr==policy['clone'] else single.trace(2,pid,args[0])&((1<<64)-1)
                if self.capture_toolchain:assert not flags&0x400 and (not flags&0x100 or flags&0x4000),'executable memory policy requires independent FD tables and kernel-held vfork for shared VM before clone resume'
                task['observedCloneFlags']=flags
                if self.shared_tasks:bindings.inspect_shared_clone_flags(flags);task['cloneFlags']=flags
                elif flags&(0x10000|0x400):self.reject_shared_clone(pid,record,flags)
                if not self.shared_tasks:assert flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown clone flags refused'
                self.emit(dict(kind='kernel-clone-flags',pid=pid,entrySequence=record['sequence'],flags=flags))
            if self.shared_tasks:
                assert not(nr==436 and args[2]&2),'close_range UNSHARE FD ownership unsupported'
                execs=[59,322] if kernel['arch']==0xc000003e else [221,281]
                if nr in execs:assert pid==task['tgid'],'nonleader exec TID replacement unsupported before resume'
            if self.append_chains and bindings.append_boundary_syscall(kernel['arch'],nr,args):task['appendBoundary']=record['sequence']
            if nr==policy['read']:
                try:read_identity=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(args[0])))
                except FileNotFoundError:read_identity=None
                if read_identity and tuple(read_identity[:2]) in self.append_chains:task['appendBoundary']=record['sequence']
            if nr==policy['mmap'] and args[2]&2 and args[3]&1:
                try:self.syscall_rejection_diagnostic(pid,status,record,shared_mapping=True)
                except BaseException:pass
                raise AssertionError('shared writable mapping refused before resume')
            if self.capture_toolchain and nr in policy['exec']:task.pop('toolExecLease',None);task.setdefault('toolPending',[]).append(('exec-before',record,None))
            if self.capture_toolchain and nr in policy['protect'] and args[2]&4:task.setdefault('toolPending',[]).append(('protect-before',record,None))
            if self.capture_toolchain and nr==policy['mmap']:task.pop('toolMmapFd',None);task.pop('toolMmapLease',None)
            if self.capture_toolchain and nr==policy['mmap'] and not(args[3]&0x20) and args[4]<(1<<31):
                try:task['toolMmapFd']=dict(fd=args[4],identity=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(args[4]))))
                except FileNotFoundError:task['toolMmapFd']=None
                if task['toolMmapFd'] and stat.S_ISREG(task['toolMmapFd']['identity'][2]):task.setdefault('toolPending',[]).append(('mmap-before',record,None))
            selected=None;fd=None
            if nr in [policy['read'],policy['write'],policy['close']]:fd=args[0];selected=fdpath(pid,fd)
            if nr==policy['mmap'] and args[4]<(1<<31):fd=args[4];selected=fdpath(pid,fd)
            if selected:
                try:item=os.stat('/proc/'+str(pid)+'/fd/'+str(fd))
                except FileNotFoundError:item=None
                if item and stat.S_ISREG(item.st_mode):
                    if nr==policy['write'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE==os.O_RDWR:task['capture']=(fd,'writer-before')
                    elif nr==policy['close'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE in [os.O_WRONLY,os.O_RDWR]:task['capture']=(fd,'producer-close')
                    elif nr==policy['read'] and selected.startswith(self.build+'/') and (self.selected_names is None or Path(selected).name in self.selected_names):task['capture']=(fd,'consumer')
                    elif nr==policy['mmap'] and selected.startswith(self.build+'/') and (self.selected_names is None or Path(selected).name in self.selected_names):self.emit(dict(kind='generated-mmap-unverified',pid=pid,path=selected,entrySequence=record['sequence']))
                    elif nr==policy['read'] and (selected.startswith(self.source+'/') or selected.startswith('/opt/qlever-sdk/dependencies/')):task['capture']=(fd,'source-read')
            mode_ops={0xc000003e:{90:'path',91:'fd',268:'at'},0xc00000b7:{52:'fd',53:'at'}}[kernel['arch']]
            if nr in mode_ops:
                form=mode_ops[nr]
                if form=='fd':target=fdpath(pid,args[0]);access='/proc/'+str(pid)+'/fd/'+str(args[0]);mode=args[1]
                elif form=='path':target=path_argument(pid,-100,args[0]);access=target;mode=args[1]
                else:target=path_argument(pid,args[0],args[1]);access=target;mode=args[2]
                if target and target.startswith(self.build+'/'):
                    try:item=os.stat(access,follow_symlinks=access.startswith('/proc/'))
                    except FileNotFoundError:item=None
                    if item and stat.S_ISREG(item.st_mode):task['metadataPath']=(target,access,mode);task['capture']=(None,'metadata-before')
            if nr in [policy.get('rename'),policy.get('renameat'),policy.get('renameat2')]:
                if nr==policy.get('rename'):old=path_argument(pid,-100,args[0]);new=path_argument(pid,-100,args[1])
                else:old=path_argument(pid,args[0],args[1]);new=path_argument(pid,args[2],args[3])
                task['rename']=(old,new);self.emit(dict(kind='kernel-path-arguments',pid=pid,entrySequence=record['sequence'],renamePaths=[old,new]))
                if old and new and old.startswith(self.build+'/') and new.startswith(self.build+'/'):
                    try:rename_source=os.stat(old,follow_symlinks=False)
                    except FileNotFoundError:rename_source=None
                    if rename_source and ((rename_source.st_dev,rename_source.st_ino) in self.producers or self.generated_vma and self.generated_vma.model==generated_vma_module.PARKED_WAIT_MODEL and (rename_source.st_dev,rename_source.st_ino) in self.generated_vma.checkpoints):
                        assert nr!=policy.get('renameat2') or args[4]==0,'retained renameat2 flags unsupported'
                        task['capture']=(None,'rename-before')
        else:
            old=task['entry']
            if old is None:assert task['initial'],'orphan syscall exit';task['initial']=False;return
            record['entrySequence']=old['sequence'];task['entry']=None
            if self.generated_vma and pid in self.generated_vma.pending:
                self.generated_vma.finish(pid,old,record);self.emit(dict(kind='exclusive-captured-syscall-exit',pid=pid,entrySequence=old['sequence'],result=record['result'],isError=record['isError']));self.exclusive=None;return
            transition=task.pop('setresuidTransition',None)
            if transition is not None:
                try:
                    assert self.exclusive==(pid,old['sequence']) and record['isError'] is False and type(record['result']) is int and record['result']==0,'setresuid requires actual exclusive successful syscall exit'
                    barrier=self.barrier()
                    observation=transition.finish(exit_sequence=record['sequence'],barrier_sequence=barrier['sequence'],stopped_wait_status=status,result=record['result'])
                    self.emit(dict(kind='identity-noop-exit-original' if getattr(self,'verified_identity_noop',False) else 'setresuid-noop-exit-original',**(dict(identityAxis=transition.axis) if getattr(self,'verified_identity_noop',False) else {}),pid=pid,entrySequence=old['sequence'],exitSequence=record['sequence'],barrierSequence=barrier['sequence'],observation=observation))
                    self.exclusive=None
                finally:transition.close()
                return
            denied=task.pop('deniedIoUring',None)
            if denied is not None:
                assert old['nr']==425 and record['arch']==old['arch'] and record['isError'] is True and record['result']==-bindings.DENIED_IO_URING_ERRNO,'explicit denial lacks actual kernel ENOSYS exit'
                current=self.stopped_executable_diagnostic(pid,status)
                assert current==denied['executable'],'explicit denial task/executable changed'
                self.emit(dict(kind='explicit-io-uring-setup-denied-exit',pid=pid,entrySequence=old['sequence'],denialSequence=denied['sequence'],exitSequence=record['sequence'],result=record['result'],isError=record['isError'],executable=current))
                return
            alias_close=task.pop('aliasCloseWindow',None)
            if alias_close is not None:
                window,held=alias_close
                try:
                    assert self.exclusive==(pid,old['sequence']) and not record['isError'] and record['result']==0,'alias close did not actually complete'
                    identity=probe.identity(os.fstat(held));assert identity[:2]==window['identity'][:2],'alias close retained a different inode'
                    absent=[]
                    for owner in window['tableOwners']:
                        try:os.stat('/proc/'+str(owner)+'/fd/'+str(window['fd']))
                        except FileNotFoundError:absent.append(dict(tid=owner,fd=window['fd'],errorCode=errno.ENOENT))
                        else:raise AssertionError('closed descriptor slot still exists in shared table')
                    self.emit(dict(kind='alias-close-exit',pid=pid,entrySequence=old['sequence'],windowSequence=window['sequence'],exitSequence=record['sequence'],retainedIdentity=identity,slotAbsences=absent,result=record['result'],isError=record['isError']))
                finally:os.close(held);self.retained.remove(held)
            if task.get('metadataWindow'):self.complete_metadata(pid,old,record)
            if task.get('writeWindow'):self.complete_write(pid,old,record)
            rw_read=task.pop('rwReadWindow',None)
            if rw_read is not None:
                window,held,data,read_offset=rw_read;assert self.exclusive==(pid,old['sequence']) and not record['isError'] and 0<=record['result']<=old['args'][2],'own-RW read exit differs'
                assert probe.identity(os.fstat(held))==window['identity']==probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(window['fd']))),'own-RW read identity changed'
                digest=hashlib.sha256();count=0
                while True:
                    self.check();block=os.pread(held,65536,count)
                    if not block:break
                    count+=len(block);assert count<=self.maximum_file_bytes;digest.update(block)
                assert data==(count,digest.hexdigest()) and probe.identity(os.fstat(held))==window['identity'] and descriptor_flags(pid,window['fd'])==window['writers'][0]['flags'] and descriptor_position(pid,window['fd'])==read_offset+record['result'],'own-RW read actual bytes/FD changed during exclusive window'
                self.emit(dict(kind='actual-write-consumer-exit',pid=pid,entrySequence=old['sequence'],captureSequence=window['sequence'],exitSequence=record['sequence'],identity=window['identity'],bytes=count,sha256=digest.hexdigest(),readOffset=read_offset,positionAfter=descriptor_position(pid,window['fd']),result=record['result'],isError=record['isError']))
            empty=task.pop('emptyReadWindow',None)
            if empty is not None:
                window,held=empty
                try:
                    assert self.exclusive==(pid,old['sequence']) and not record['isError'] and record['result']==0,'empty read did not return actual EOF'
                    current=probe.identity(os.fstat(held));selected=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(window['fd'])))
                    assert current==selected==window['identity'] and current[3]==0 and descriptor_flags(pid,window['fd'])==window['flags'],'empty read FD identity/flags changed'
                    self.emit(dict(kind='empty-read-eof',pid=pid,entrySequence=old['sequence'],windowSequence=window['sequence'],exitSequence=record['sequence'],identity=current,result=record['result'],isError=record['isError']))
                finally:os.close(held);self.retained.remove(held)
            if self.capture_toolchain:
                rules=profile(old['arch'])
                if record['isError']:
                    if old['nr']==rules['mmap']:task.pop('toolMmapFd',None);task.pop('toolMmapLease',None)
                    if old['nr'] in rules['protect']:task.pop('toolProtectBefore',None)
                    if old['nr'] in rules['exec']:task.pop('toolExecPath',None);task.pop('toolExecLease',None)
                if not record['isError'] and record['result']>=0 and old['nr']==rules['mmap'] and (not(old['args'][3]&0x20) or old['args'][2]&4):task.setdefault('toolPending',[]).append(('mmap',old,record))
                if not record['isError'] and record['result']==0 and old['nr'] in rules['protect'] and old['args'][2]&4:task.setdefault('toolPending',[]).append(('protect-after',old,record))
            if task.get('renameWindow') is not None:self.complete_rename(pid,old,record)
            if self.exclusive==(pid,old['sequence']):self.emit(dict(kind='exclusive-captured-syscall-exit',pid=pid,entrySequence=old['sequence'],result=record['result'],isError=record['isError']));self.exclusive=None
            release_fd=task.pop('releaseCaptureFd',None)
            if release_fd is not None:os.close(release_fd);self.retained.remove(release_fd)
            if task.get('rename'):
                old_path,new_path=task.pop('rename')
                if record['result']==0:
                    try:item=os.stat(new_path,follow_symlinks=False)
                    except FileNotFoundError:item=None
                    if item and (item.st_dev,item.st_ino) in self.producers:
                        produced,held,data=self.producers[(item.st_dev,item.st_ino)];self.rename_records.append(self.emit(dict(kind='retained-fd-rename-binding',pid=pid,fromPath=old_path,toPath=new_path,producerCaptureSequence=produced['sequence'],entrySequence=old['sequence'],identity=probe.identity(item),retainedIdentity=probe.identity(os.fstat(held)))))
        if allow_capture and task.get('capture'):self.pending_captures()
    def phase(self,name,command,deadline_monotonic=None,*,cwd=None,env=None,stdoutPath=None,stderrPath=None):
        self.deadline=deadline_monotonic if deadline_monotonic is not None else self.deadline_monotonic
        if self.deadline is None:self.deadline=time.monotonic()+90
        self.check()
        with owned_wait.BlockingOwnedWait(self.deadline,WALL) as waiter:
            self.waiter=waiter
            return self.phase_armed(name,command,cwd,env,stdoutPath,stderrPath)
    def phase_armed(self,name,command,cwd,env,stdoutPath,stderrPath):
        capture_start=len(self.captures);started_ns=time.time_ns();stdout_path=Path(stdoutPath) if stdoutPath is not None else self.out/(name+'.stdout.raw');stderr_path=Path(stderrPath) if stderrPath is not None else self.out/(name+'.stderr.raw')
        self.wait_references=[];self.tasks={};self.unknown_stops={};self.root_code=None;self.current_phase=name;self.raw=EncodedShardedRaw(self,name,self.shard_bytes or self.maximum_file_bytes) if self.compressed_raw else ShardedRaw(self.out,name,self.shard_bytes) if self.shard_bytes else open(self.out/(name+'.syscalls.original.jsonl'),'xb')
        self.raw_encoder=probe.IndexedRawEncoderV2() if self.indexed_raw_records else None
        if not self.prepared_sealed:
            try:
                self.seal_prepared_dependency_sources()
                self.seal_prepared_build_inputs()
            except BaseException:
                self.raw_bytes_completed+=self.raw.tell();self.raw.close();self.close();raise
        ready_read,ready_write=os.pipe() if self.process_authority else (None,None)
        read_fd,write_fd=os.pipe();stdout_read,stdout_write=os.pipe();stderr_read,stderr_write=os.pipe();child=os.fork()
        if child==0:
            try:
                os.close(write_fd);os.close(stdout_read);os.close(stderr_read)
                close_child_observer_retained(self.retained)
                if self.process_authority:
                    os.close(ready_read);tool_providers.restrict_child_authority();os.write(ready_write,b'R');os.close(ready_write)
                assert os.read(read_fd,1)==b'x';os.close(read_fd)
                os.dup2(stdout_write,1);os.dup2(stderr_write,2);os.close(stdout_write);os.close(stderr_write)
                os.chdir(cwd if cwd is not None else self.source);os.execve(actual_executable(command),command,env if env is not None else {'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':str(self.out),'TMPDIR':str(self.out)})
            except BaseException:os._exit(70)
        os.close(stdout_write);os.close(stderr_write);self.pump_errors=[]
        pumps=[BoundedPipePump(stdout_read,stdout_path,self.maximum_stdio_bytes,lambda count:self.claim(count,category='stdio'),self.pump_errors),BoundedPipePump(stderr_read,stderr_path,self.maximum_stdio_bytes,lambda count:self.claim(count,category='stdio'),self.pump_errors)]
        root_pgid=os.getpgid(child);self.root=child;self.tasks[child]=dict(stopped=False,exited=False,entry=None,initial=True,**(dict(authorityPending=[('initial-root',None)]) if self.process_authority else {}),**(dict(tgid=child,fdTable=child) if self.shared_tasks else {}))
        try:
            # Created only here, in the parent after fork: the child must never
            # inherit a lease FD or SIGIO ownership.
            if self.capture_toolchain:self.lifetime_leases=lifetime_leases.LeaseSet()
            self.lifetime_phase=name;self.lifetime_acquired={};self.lifetime_by_identity={};self.authority_observed=set()
            os.close(read_fd)
            for pump in pumps:pump.start()
            if self.process_authority:
                os.close(ready_write);ready_write=None;self.check();remaining=max(0,self.deadline-time.monotonic());readable,_,_=select.select([ready_read],[],[],remaining);self.check();assert readable and os.read(ready_read,1)==b'R','child authority setup did not complete before release';os.close(ready_read);ready_read=None
            self.emit(dict(kind='owned-root-binding',pid=child,command=command,**(dict(toolchainLifetimeModel=LIFETIME_MODEL,executableMemoryPolicy=memory_policy.MODEL) if self.capture_toolchain else {}),**(dict(rawRecordModel=probe.RAW_RECORD_MODEL_V2)if self.indexed_raw_records else {}),backend='ptrace-all-stop-process-v1',**(dict(chunkOriginalStorageModel='chunk-original-v1') if self.capture_content_entities else {}),captureOriginalEntityModel='same-phase-content-entity-v2' if self.capture_content_entities else 'same-phase-producer-original-v1',**(dict(mapsOriginalEntityModel='same-phase-maps-content-entity-v1')if getattr(self,'capture_maps_content_entities',False)else {}),**(dict(generatedVmaModel=self.generated_vma.model,**(dict(generatedVmaMetadataModel=generated_vma_module.RETAINED_METADATA_MODEL)if getattr(self,'retained_generated_metadata',False)else {}),generatedVmaBuildRoot=self.build,generatedVmaParentDeadlineMonotonicNs=str(int(self.waiter.parent_deadline*1e9))) if self.generated_vma else {}),**(dict(stoppedWriterAliasModel='all-stop-exclusive-write-aliases-v1') if getattr(self,'stopped_writer_aliases',False) else {}),**(dict(optionalIoUringModel='explicit-kernel-enosys-denial-v2' if getattr(self,'io_uring_enosys_v2',False) else 'explicit-kernel-enosys-denial-v1') if self.deny_optional_io_uring else {}),**(dict(setresuidNoopModel='actual-stopped-setresuid-noop-v1') if self.verified_setresuid_noop else {}),**(dict(setresIdentityNoopModel='actual-stopped-setres-identity-noop-queued-v2' if getattr(self,'queued_identity_noop',False) else 'actual-stopped-setres-identity-noop-v1') if getattr(self,'verified_identity_noop',False) else {}),**(dict(processAuthorityModel=tool_providers.AUTHORITY_MODEL) if self.process_authority else {}),**(dict(exitAuthorityModel='actual-selected-exit-stop-held-terminal-peers-v2'if getattr(self,'serialize_terminal_syscalls',False)else 'actual-selected-exit-stop-before-peer-barrier-v1') if getattr(self,'terminal_exit_evidence',False) else {}),**(dict(taskOwnershipModel='all-tracked-tids-shared-fd-v1',tgid=child,fdTable=child) if self.shared_tasks else {})));single.trace(SEIZE,child,0,OPTIONS);single.trace(INTERRUPT,child);pid,status=self.wait_one();self.event(pid,status,False);self.pending_captures();os.write(write_fd,b'x');os.close(write_fd);write_fd=None;self.resume()
            while any(not r['exited'] for r in self.tasks.values()):
                pid,status=self.wait_one();self.event(pid,status);self.pending_captures();self.resume()
            assert getattr(self,'terminal_focus',None)is None,'serialized terminal wait did not close'
            assert not any(task.get('vforkHeldChild') is not None for task in self.tasks.values()),'vfork child release/wait closure missing'
            if self.generated_vma:self.generated_vma.complete_phase()
            self.checkpoint_appends('phase-final')
            # Exact boundary: every tracked wait is closed; closures follow.
            self.complete_lifetime_leases()
            for pump in pumps:pump.finish(self.check)
            if self.require_success:assert self.root_code==0,'actual observed root did not exit successfully'
            completed_ns=time.time_ns()
            summary=dict(schemaVersion=1,kind='owned-multiprocess-all-stop-CMake-diagnostic',command=command,actualRootPid=child,actualRootReturnCode=self.root_code,actualTrackedPids=sorted(self.tasks),allTrackedWaitsClosed=all(r['exited'] for r in self.tasks.values()),backend='ptrace-all-stop-process-v1',scope='tracked process wait/FD-byte observations only; shared threads/FD tables/async writers unsupported')
            probe.jsonfile(self.out/(name+'.receipt.json'),summary)
            self.raw.flush()
            if isinstance(self.raw,EncodedShardedRaw):self.raw.finish()
            def original(path):
                digest=hashlib.sha256();size=0;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                try:
                    identity=probe.identity(os.fstat(fd));maximum=self.maximum_stdio_bytes if path in [stdout_path,stderr_path] else self.maximum_bytes
                    assert identity[3]<=maximum,'bounded original size required'
                    while True:
                        block=os.read(fd,65536)
                        if not block:break
                        size+=len(block);assert size<=maximum,'original grew beyond bounded size';digest.update(block);self.check()
                    assert identity==probe.identity(os.fstat(fd))==probe.identity(os.stat(path,follow_symlinks=False))
                    actual_hash=digest.hexdigest()
                    for pump in pumps:
                        if pump.path==path:assert (size,actual_hash)==(pump.bytes,pump.sha256),'actual stdio original differs from owned pipe'
                    return dict(path=str(path),bytes=size,sha256=actual_hash)
                finally:os.close(fd)
            return dict(commandReceipt=dict(schemaVersion=1,command=command,actualExecutable=actual_executable(command),pid=child,pgid=root_pgid,actualWait=True,exit=self.root_code if self.root_code>=0 else None,signal=-self.root_code if self.root_code<0 else None,startedUnixNs=str(started_ns),completedUnixNs=str(completed_ns),rawClosedBeforeHash=True,stdout=dict(original(stdout_path),path=stdout_path.name),stderr=dict(original(stderr_path),path=stderr_path.name)),
                trackingReceipt=dict(schemaVersion=1,kind='sdk-observer-tracked-phase-original',phase=name,observerPid=os.getpid(),command=command,actualRootPid=child,actualRootReturnCode=self.root_code,actualTrackedWait=True,trackedProcessesClosed=all(row['exited'] for row in self.tasks.values()),deadlineMonotonic=self.deadline,startedUnixNs=str(started_ns),completedUnixNs=str(completed_ns),waitReferences=self.wait_references),
                rawTraceShards=[dict(original(path),wire=self.raw.references[str(path)]) for path in self.raw.paths] if isinstance(self.raw,EncodedShardedRaw) else [original(path) for path in self.raw.paths] if isinstance(self.raw,ShardedRaw) else [original(Path(self.raw.name))],
                captureFiles=self.phase_capture_files(capture_start),
                observedToolFiles=self.observed_tool_files(capture_start,name))
        finally:
            primary=sys.exc_info()[1]
            for control_fd in [ready_read,ready_write]:
                if control_fd is not None:os.close(control_fd)
            if write_fd is not None:os.close(write_fd)
            for pid,row in self.tasks.items():
                if not row['exited']:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
            leases=self.lifetime_leases
            if leases is not None:
                try:leases.close()
                except BaseException:
                    if primary is None:raise
                finally:self.lifetime_leases=None
            self.raw_bytes_completed+=self.raw.tell();self.raw.close()
    def complete_lifetime_leases(self):
        """Require and emit only real closed lease tokens after all waits."""
        leases=self.lifetime_leases
        if leases is None:return None
        assert all(row['exited'] for row in self.tasks.values()),'lifetime lease closure before allTrackedWaitsClosed'
        closed_pids=sorted(pid for pid,row in self.tasks.items() if row['exited'])
        tokens=leases.complete()
        acquired={row['token']['leaseId']:row['sequence'] for row in self.lifetime_acquired.values()}
        assert set(acquired)=={token['leaseId'] for token in tokens} and sorted(acquired)==[token['leaseId'] for token in tokens],'lease tokens/acquisitions differ'
        # Each token and closed PID remains explicit, in bounded rows; never
        # expand the existing 64 KiB raw-record limit for a large phase.
        digest=hashlib.sha256()
        for token in tokens:
            value=dict(leaseId=token['leaseId'],identity=token['identity'],acquisitionSequence=acquired[token['leaseId']])
            digest.update(json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n')
            self.emit(dict(kind='toolchain-lease-closed-token',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,**value))
        for offset in range(0,len(closed_pids),256):
            self.emit(dict(kind='toolchain-lease-closed-pids',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,offset=offset,actualClosedPids=closed_pids[offset:offset+256]))
        row=self.emit(dict(kind='toolchain-leases-closed',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,tokenCount=len(tokens),tokensSha256=digest.hexdigest(),actualClosedPidCount=len(closed_pids),allTrackedWaitsClosed=True,scope='actual kernel-held read leases closed after all tracked waits; no source authority'))
        return row
    def observed_tool_files(self,capture_start,name):
        rows=[dict(actualOriginalPath=row['observedPath'],identity=row['identity'],actualMode=row['identity'][2],sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase=row['phase'],rawEventKind='toolchain-original',captureSequence=row['sequence'],original=dict(row['original'],path=str(self.capture_dir/row['original']['path']))) for row in self.captures[capture_start:] if row.get('kind')=='toolchain-original' and row.get('captureKind')=='file']
        assert all(row['phase']==name for row in rows),'tool original belongs to another phase'
        return rows
    def close(self):
        if getattr(self,'generated_vma',None):self.generated_vma.close()
        for task in getattr(self,'tasks',{}).values():
            transition=task.pop('setresuidTransition',None)
            if transition is not None:transition.close()
            terminal=task.get('terminalAuthority')
            if terminal:terminal['lease'].close()
        if hasattr(self,'authority_handles'):self.authority_handles.close()
        for fd in list(self.retained):os.close(fd);self.retained.remove(fd)
    def abort(self):
        # Never claim whole-kernel ownership from this traced PID registry. The
        # producer must propagate failure to its existing PID1 owner, whose
        # actual wait/ECHILD cleanup closes descendants outside this registry.
        for pid,row in self.tasks.items():
            if not row['exited']:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
        self.close()


class SdkExecutionObserver(Observer):
    """Production API: one instance per actual inner build owner.

    The caller supplies the existing ExecutionBudget.end and remaining *shared*
    source-domain bytes. Per-phase deadlines may shorten it, never extend it.
    .phase returns real command/tracked receipts; it does not claim a closed
    process group while this long-lived observer still retains descriptors.
    """
    def __init__(self,out,source,build,*,deadline_monotonic,check_budget,maximum_bytes,maximum_stdio_bytes,prepared_dependencies=None):
        limits=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())
        assert isinstance(maximum_bytes,int) and 0<maximum_bytes<=limits['sourceMaterialBytes'],'canonical shared execution byte bound required'
        assert isinstance(maximum_stdio_bytes,int) and 0<maximum_stdio_bytes<=min(maximum_bytes,limits['shardBytes']),'existing bounded command raw limit required'
        assert Path(source)==Path('/opt/qlever-sdk/source') and Path(build)==Path('/opt/qlever-sdk/build'),'fixed SDK source/build roots required'
        assert isinstance(deadline_monotonic,(float,int)) and math.isfinite(deadline_monotonic) and time.monotonic()<deadline_monotonic,'existing live SDK deadline required'
        super().__init__(out,source,build,deadline_monotonic=deadline_monotonic,check_budget=check_budget,maximum_bytes=maximum_bytes,
            maximum_file_bytes=limits['shardBytes'],selected_names=None,maximum_processes=limits['sourceMembers'],shard_bytes=limits['shardBytes'],require_success=False,maximum_stdio_bytes=maximum_stdio_bytes,shared_tasks=True,capture_toolchain=True,deny_optional_io_uring=True,verified_identity_noop=True,terminal_exit_evidence=True,generated_vma_output=True,generated_vma_shared_mm=True,generated_vma_private_wake=True,generated_vma_private_wait_mismatch=True,capture_content_entities=True,queued_identity_noop=True,stopped_writer_aliases=True,generated_vma_coordinated_wait=True,generated_vma_parked_wait=True,io_uring_enosys_v2=True,serialize_terminal_syscalls=True,capture_maps_content_entities=True,retained_generated_metadata=True,indexed_raw_records=True,compressed_raw=True)
        self.capture_dir=self.out/'captures';self.capture_dir.mkdir(exist_ok=False);self.sdk_phase_index=0;self.sdk_failed=False
        mounts=Path('/proc/self/mountinfo').read_bytes();assert len(mounts)<=limits['metadataBytes'],'source provider metadata bound'
        self.source_provider=probe.effective_readonly(source,mounts);self.source_provider_originals=dict(mountinfo=probe.put(self.out/'source-provider.mountinfo.raw',mounts));self.claim(len(mounts))
        if prepared_dependencies is not None:
            self.deadline=self.deadline_monotonic
            self.load_prepared_dependencies(prepared_dependencies)
    def phase(self,name,command,deadline_monotonic,*,cwd,env,stdoutPath,stderrPath):
        assert not self.sdk_failed and self.sdk_phase_index<2 and name==['configure','compile'][self.sdk_phase_index] and deadline_monotonic<=self.deadline_monotonic,'fixed phase within existing SDK deadline required'
        expected=['bash','/components/qlever/scripts/build-qlever-runtime-sdk.sh','configure-prepared' if name=='configure' else 'build-prepared']
        assert command==expected,'fixed actual SDK phase argv required'
        result=super().phase(name,command,deadline_monotonic,cwd=cwd,env=env,stdoutPath=stdoutPath,stderrPath=stderrPath)
        self.sdk_failed=result['trackingReceipt']['actualRootReturnCode']!=0;self.sdk_phase_index+=1;return result

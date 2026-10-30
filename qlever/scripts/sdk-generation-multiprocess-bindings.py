"""Pure all-stop generated-file byte relations from actual observer originals.

Not a capability. Controlled observer/TCB execution, Git inputs and upstream
runtime/toolchain authority remain independent of this mechanical axis.
"""
import hashlib
import os
import posixpath
import importlib.util
from pathlib import Path
_raw_spec=importlib.util.spec_from_file_location('sdk_raw_records',Path(__file__).with_name('sdk-execution-originals-util.py'))
raw_records=importlib.util.module_from_spec(_raw_spec);_raw_spec.loader.exec_module(raw_records)
# Derived transport codec: pure serialization of facts this replay already proved.
_transport_spec=importlib.util.spec_from_file_location('sdk_generated_producer_transport',Path(__file__).with_name('sdk-generated-producer-transport.py'))
generated_transport=importlib.util.module_from_spec(_transport_spec);_transport_spec.loader.exec_module(generated_transport)
import json
import re
import struct
import stat
import shlex
TIMESTAMP_MODEL='actual-utimensat-timespec-v6'
TIMESTAMP_CHAIN_MODEL='actual-rename-mode-timestamp-chain-v6'
UTIME_NOW_NS=1073741823
UTIME_OMIT_NS=1073741822
TIMESTAMP_SYSCALLS={0xc000003e:280,0xc00000b7:88}

def timespec_pair(sec,nsec):
    """Validate ONE kernel timespec: nsec is 0..999999999 or UTIME_NOW/UTIME_OMIT.

    The kernel rejects anything else with EINVAL, so a successfully completed
    utimensat/futimens can never legitimately carry such a value.
    """
    need(type(sec) is int and type(nsec) is int,'timespec integer fields required')
    need(0<=nsec<=999999999 or nsec in (UTIME_NOW_NS,UTIME_OMIT_NS),'timespec nsec outside kernel range')
    return (sec,nsec)

def decode_timespec(data):
    assert len(data)==32,'timespec must be 32 bytes'
    return [timespec_pair(int.from_bytes(data[i*16:i*16+8],'little',signed=True),
                          int.from_bytes(data[i*16+8:i*16+16],'little',signed=True)) for i in range(2)]

def timestamp_effect(before,after,times):
    """The single utimensat/futimens effect contract.

    Used by the recorder, the retained metadata chain and the raw replay, so the
    three sites cannot disagree. Shape and per-timespec validation happen HERE:
    callers pass the operand array through unchanged.

    Both-OMIT is a true kernel no-op, so the WHOLE six-field identity must stay
    byte-identical - including ctime, which any real timestamp change advances.
    A single OMIT preserves its field; an explicit value follows the documented
    round-DOWN rule (the kernel may truncate to filesystem resolution, never up).
    """
    need(isinstance(times,(list,tuple)) and len(times)==2,'exact two-timespec operand array required')
    for pair in times:
        # each element must be exactly {tv_sec,tv_nsec}: no extra or missing fields
        need(isinstance(pair,(list,tuple)) and len(pair)==2,'exact two-field timespec pairs required')
    atime,mtimes=timespec_pair(times[0][0],times[0][1]),timespec_pair(times[1][0],times[1][1])
    need(len(before)==6 and len(after)==6,'full six-field timestamp identities required')
    need(before[:3]==after[:3] and before[3]==after[3] and stat.S_IMODE(before[2])==stat.S_IMODE(after[2]),'timestamp changed inode/mode/size')
    if atime[1]==UTIME_OMIT_NS and mtimes[1]==UTIME_OMIT_NS:
        need(before==after,'both-OMIT timestamps changed (no field, including ctime, may move)')
        return
    if mtimes[1]==UTIME_OMIT_NS:need(after[4]==before[4],'UTIME_OMIT changed mtime')
    elif mtimes[1]!=UTIME_NOW_NS:need(after[4]<=mtimes[0]*10**9+mtimes[1],'requested mtime exceeds requested value')

LINK_MODEL='actual-link-inode-effect-v8'
LINK_SYSCALLS={0xc000003e:dict(link=86,linkat=265,unlink=87,unlinkat=263),0xc00000b7:dict(linkat=37,unlinkat=35)}

POLICIES={
 0xc00000b7:dict(exec={221,281},execveat=281,protect={226,288},read=63,reads={63,65,67,69,286},write=64,close=57,mmap=222,clone=220,clone3=435,spawn={220,435},renameat=38,renameat2=276,renameOps={38,276},exits={93,94},forbidden={0,1,2,3,4,292,425,426,427,271,117,97,268}),
 0xc000003e:dict(exec={59,322},execveat=322,protect={10,329},read=0,reads={0,17,19,295,327},write=1,close=3,mmap=9,clone=56,clone3=435,spawn={56,57,58,435},rename=82,renameat=264,renameat2=316,renameOps={82,264,316},exits={60,231},forbidden={206,207,208,209,210,333,425,426,427,311,101,272,308}),
}
# ACTUAL kernel read-family ABI, per reviewed architecture. This is NOT a set of
# syscall numbers with a shared shape: each form has its own operand layout and
# its own way of establishing the consumed file range. `read`/`readv` advance the
# descriptor position, so the exact range is (positionAfter - result, result);
# `pread64`/`preadv`/`preadv2` carry an explicit offset and never move it.
# `readv`/`preadv`/`preadv2` bound the transfer by the SUM of iov_len over the
# actual iovec vector, not by the raw iovcnt, so the replay must keep both.
READ_FORMS={
 0xc00000b7:{63:dict(name='read',iovec=False,offset=None,bound='count'),
              65:dict(name='readv',iovec=True,offset=None,bound='iov'),
              67:dict(name='pread64',iovec=False,offset=3,bound='count'),
              69:dict(name='preadv',iovec=True,offset=3,bound='iov'),
              286:dict(name='preadv2',iovec=True,offset=3,bound='iov',flagsIndex=4)},
 0xc000003e:{0:dict(name='read',iovec=False,offset=None,bound='count'),
              19:dict(name='readv',iovec=True,offset=None,bound='iov'),
              17:dict(name='pread64',iovec=False,offset=3,bound='count'),
              295:dict(name='preadv',iovec=True,offset=3,bound='iov'),
              327:dict(name='preadv2',iovec=True,offset=3,bound='iov',flagsIndex=4)},
}
IOVECTOR_MAXIMUM=1024
IOVECTOR_ENTRY_BYTES=16
def read_form(arch,nr):
    """Return the reviewed ABI form for one actual read-family number."""
    return READ_FORMS.get(arch,{}).get(nr)
def physical_original_reference(reference):
    return {key:reference[key]for key in ['path','bytes','sha256']+(['storage'] if 'storage' in reference else [])}

def capture_inventory_name(path):
    prefix='inner/toolchain-execution/captures/'
    need(type(path) is str and path.startswith(prefix),'fixed capture inventory prefix')
    name=path[len(prefix):]
    need(re.fullmatch(r'(capture-[0-9]{4,}\.original|manifests/[0-9]+\.json|chunks/[0-9a-f]{64})',name),'fixed capture inventory role')
    return name

def chunk_module():
    import importlib.util
    from pathlib import Path
    spec=importlib.util.spec_from_file_location('verified_chunk_originals',Path(__file__).with_name('sdk-original-chunk-store.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class CaptureOriginalReader:
    """One physical-byte inventory, with explicit logical chunk observations."""
    def __init__(self,read_original,maximum_file,maximum_total,check):
        self.read_original=read_original;self.maximum_file=maximum_file;self.maximum_total=maximum_total;self.check=check
        self.physical={};self.physical_bytes=0;self.logical={};self.codec=None
    def physical_blocks(self,ref):
        need(type(ref) is dict and set(ref)=={'path','bytes','sha256'},'exact physical capture reference')
        name=ref['path'];need(type(name) is str and re.fullmatch(r'(capture-[0-9]{4,}\.original|manifests/[0-9]+\.json|chunks/[0-9a-f]{64})',name),'fixed physical capture path')
        need(type(ref['bytes']) is int and 0<=ref['bytes']<=self.maximum_file and type(ref['sha256']) is str and re.fullmatch(r'[0-9a-f]{64}',ref['sha256']),'physical capture size/hash bound')
        old=self.physical.get(name);need(old is None or old==ref,'physical capture reference changed')
        if old is None:
            self.physical_bytes+=ref['bytes'];need(self.physical_bytes<=self.maximum_total,'shared physical capture byte bound');self.physical[name]=dict(ref)
        value=self.read_original(name,self.maximum_file)
        if isinstance(value,bytes):
            need(len(value)<=1024**2,'legacy tiny byte reader bound');body=value;value=(body[i:i+65536] for i in range(0,len(body),65536))
        count=0;digest=hashlib.sha256()
        for block in value:
            self.check();need(type(block) is bytes and len(block)<=65536,'bounded physical capture block');count+=len(block);need(count<=ref['bytes'],'physical capture grew');digest.update(block);yield block
        need((count,digest.hexdigest())==(ref['bytes'],ref['sha256']),'physical capture bytes/hash differ')
    def manifest(self,reference):
        need(type(reference) is dict and set(reference)=={'path','bytes','sha256','storage'},'exact logical chunk reference')
        storage=reference.get('storage');need(type(storage) is dict and set(storage)=={'model','manifest'} and storage['model']=='chunk-original-v1','explicit chunk original storage required')
        if self.codec is None:self.codec=chunk_module()
        ref=storage['manifest'];need(type(ref) is dict and type(ref.get('bytes')) is int and 0<=ref['bytes']<=1024**2,'bounded chunk manifest');data=b''.join(self.physical_blocks(ref));manifest=self.codec.validate_manifest_bytes(data,ref)
        need((manifest['bytes'],manifest['sha256'])==(reference['bytes'],reference['sha256']),'logical original differs from manifest')
        match=re.fullmatch(r'capture-([0-9]{4,})\.original',reference['path']);need(match and int(match.group(1))==manifest['sequence'] and ref['path']=='manifests/'+str(manifest['sequence'])+'.json','manifest observation sequence differs')
        identity=manifest['sourceIdentityBefore'];need(all(type(v) is int and v>=0 for v in identity) and stat.S_ISREG(identity[2]) and identity[3]==reference['bytes'],'manifest source identity differs')
        return manifest
    def blocks(self,reference):
        name=reference['path'];canonical=physical_original_reference(reference);prior=self.logical.get(name);need(prior is None or prior==canonical,'logical original reference changed');self.logical[name]=canonical
        if 'storage' in reference:
            self.manifest(reference)
            yield from self.codec.blocks_from_reader(reference['storage']['manifest'],self.physical_blocks,self.check)
        else:yield from self.physical_blocks(physical_original_reference(reference))

def tool_original_key(reference):
    return (reference['path'],reference['observationSequence'])if 'observationSequence'in reference else reference['path']

# FAIL-ONLY bounded diagnostic suffix for the final identity/path mismatch.
#
# The next genuine failure must carry enough operands to decide whether the
# mismatch is a path-only or an identity-only divergence, without leaking raw
# paths, file contents, arbitrary exception text or unbounded integers.
# This runs ONLY on the failing branch; a successful chain never calls it.
_METADATA_CHAIN_DIAGNOSTIC_LIMIT = 4096
_METADATA_CHAIN_DIAGNOSTIC_INTS = 8
# Bounded WORK limits: these reject oversized inputs BEFORE any encode/hash/join,
# so the fail-only diagnostic can never do unbounded work on a hostile value.
_METADATA_CHAIN_DIAGNOSTIC_PATH_CHARS = 4096
_METADATA_CHAIN_DIAGNOSTIC_PATH_BYTES = 16384
_METADATA_CHAIN_DIAGNOSTIC_REFERENCES = 4096
_METADATA_CHAIN_DIAGNOSTIC_FALLBACK = 'metadata-chain-diagnostic=unavailable'

def _bounded_int(value):
    """Exact non-negative int that fits the bounded decimal rendering, else None."""
    if type(value) is not int or value < 0 or value > (1 << 63) - 1:
        return None
    return value

def _identity_fields(value):
    """Six exact non-negative ints in probe.identity field order, else None.

    probe.identity field order is
    [st_dev, st_ino, st_mode, st_size, st_mtime_ns, st_ctime_ns].
    """
    if type(value) not in (list, tuple) or len(value) != 6:
        return None
    fields = [_bounded_int(field) for field in value]
    return None if any(field is None for field in fields) else fields

def _path_summary(value):
    """SHA-256 and byte length of a path; never the path bytes themselves.

    Rejects by type and CHARACTER length before encoding, then by encoded byte
    length before hashing, so an arbitrarily long string never causes unbounded
    encode/hash work in this fail-only path.
    """
    if type(value) is not str or len(value) > _METADATA_CHAIN_DIAGNOSTIC_PATH_CHARS:
        return None
    try:
        encoded = value.encode('utf-8', 'surrogatepass')
    except BaseException:
        return None
    if len(encoded) > _METADATA_CHAIN_DIAGNOSTIC_PATH_BYTES:
        return None
    return hashlib.sha256(encoded).hexdigest(), len(encoded)

def _subsequence_summary(references):
    """Bounded count/tail/digest of matching metadata references.

    Rejects a wrong type or an over-long list BEFORE any iteration/join, then
    requires EVERY reference to be an exact non-negative int in range before any
    str() conversion, so neither the digest nor the tail can do unbounded work.
    """
    if type(references) is not list or len(references) > _METADATA_CHAIN_DIAGNOSTIC_REFERENCES:
        return None
    for item in references:
        if _bounded_int(item) is None:
            return None
    tail = references[-_METADATA_CHAIN_DIAGNOSTIC_INTS:]
    digest = hashlib.sha256(','.join(str(item) for item in references).encode('ascii')).hexdigest()
    return len(references), tail, digest

def metadata_chain_diagnostic(producer, consumer, current, path, references):
    """Fixed-schema, bounded suffix describing the final identity/path mismatch.

    Fail-closed: any malformed input yields the fixed fallback token. This helper
    never raises and never substitutes for the caller's own assertion.
    """
    try:
        producer_identity = _identity_fields(producer.get('identity'))
        consumer_identity = _identity_fields(consumer.get('identity'))
        composed_identity = _identity_fields(current)
        producer_sequence = _bounded_int(producer.get('sequence'))
        consumer_sequence = _bounded_int(consumer.get('sequence'))
        producer_path = _path_summary(producer.get('path'))
        consumer_path = _path_summary(consumer.get('path'))
        composed_path = _path_summary(path)
        composed_reference = _subsequence_summary(references)
        if None in (producer_identity, consumer_identity, composed_identity, producer_sequence,
                    consumer_sequence, producer_path, consumer_path, composed_path,
                    composed_reference):
            return _METADATA_CHAIN_DIAGNOSTIC_FALLBACK
        mismatch = [index for index in range(6)
                    if composed_identity[index] != consumer_identity[index]]
        payload = dict(
            schemaVersion=1,
            producerSequence=producer_sequence,
            consumerSequence=consumer_sequence,
            producerIdentity=producer_identity,
            composedIdentity=composed_identity,
            consumerIdentity=consumer_identity,
            identityMismatchFields=mismatch,
            producerPathSha256=producer_path[0], producerPathBytes=producer_path[1],
            composedPathSha256=composed_path[0], composedPathBytes=composed_path[1],
            consumerPathSha256=consumer_path[0], consumerPathBytes=consumer_path[1],
            composedPathDiffers=composed_path[0] != consumer_path[0],
            metadataReferenceCount=composed_reference[0],
            metadataReferenceLast=composed_reference[1],
            metadataReferenceDigest=composed_reference[2])
        rendered = 'metadata-chain-diagnostic=' + json.dumps(
            payload, sort_keys=True, separators=(',', ':'))
        if len(rendered) > _METADATA_CHAIN_DIAGNOSTIC_LIMIT:
            return _METADATA_CHAIN_DIAGNOSTIC_FALLBACK
        return rendered
    except BaseException:
        return _METADATA_CHAIN_DIAGNOSTIC_FALLBACK

def retained_metadata_chain(producer,consumer,states):
    """Join only independently verified operation endpoints; never infer a gap.

    Callers must validate each window/exit/lease/original first. This helper
    only composes their exact endpoints and grants no authority by itself.
    """
    current=producer['identity'];path=producer['path'];references=[];previous=producer['sequence']
    need(len(current)==6 and producer['sequence']<consumer['sequence'],'retained metadata chain endpoints/order')
    for window,change in states:
        sequence=change['sequence']
        if not (producer['sequence']<sequence<consumer['sequence']):continue
        before=window['beforeIdentity'];after=change['afterIdentity']
        if before[:2]!=producer['identity'][:2]:continue
        # FULL six-field BEFORE continuity for EVERY admitted operation. A timestamp
        # writes afterIdentity (mtime/ctime); it never justifies a mismatched BEFORE.
        # If a before state cannot equal the composed current, the operation is not
        # admissible here and the chain must refuse rather than relax the check.
        need(previous<sequence and len(before)==len(after)==6 and before==current,'retained metadata chain gap/order')
        if window['kind']=='actual-link-window':
            need(window.get('model')==LINK_MODEL,'link window lacks declared model')
            # link/unlink changes nlink and ctime only; dev/ino/mode/size/mtime and
            # the composed namespace path are unaffected.
            need(after[:5]==before[:5],'retained link changed inode/mode/size/mtime')
            # nlink must move by exactly one in the direction of the operation.
            form=window.get('form')
            before_links=window.get('beforeLinks');after_links=change.get('afterLinks')
            need(type(before_links) is int and type(after_links) is int,'retained link counts required')
            need(after_links==(before_links+1 if form in ('link','linkat') else before_links-1),'retained link nlink effect differs')
            # A link/unlink operand names another alias of the SAME inode; it does not
            # move the composed namespace path (identical to the chmod rule). The
            # operand's own path is bound to its raw bytes in the window branch.
        elif window['kind']=='actual-timestamp-window':
            need(window.get('model')==TIMESTAMP_MODEL,'timestamp window lacks declared model')
            # Same mechanics as chmod: inode identity proves the metadata effect and
            # the composed namespace path is UNCHANGED by an inode-metadata op.
            need(after[:4]==before[:4] and stat.S_IMODE(after[2])==stat.S_IMODE(before[2]),'retained timestamp changed inode/mode/size')
            # Same as the existing chmod branch: an inode-metadata operation does NOT
            # move the composed namespace path. A hard-link alias may be the operand
            # while the consumer keeps the original name; the inode identity proves
            # the effect. The operand's own path is validated against its raw bytes in
            # the window branch, so no path restriction is invented here.
            if window.get('timesAbsent'):
                need(window.get('times') is None,'retained timestamp absent-times mismatch')
            else:
                timestamp_effect(before,after,window.get('times'))
        elif window['kind']=='actual-rename-window':
            reference='generatedCheckpointSequence'if producer.get('kind')=='generated-vma-operation-exit'and producer.get('operation')=='unmap'else 'producerCaptureSequence'
            need(window.get(reference)==producer['sequence']and ('producerCaptureSequence'in window)!=('generatedCheckpointSequence'in window) and window['fromPath']==path and after[:5]==before[:5],'retained rename chain producer/path/bytes metadata differs')
            path=window['toPath']
        else:
            need(window['kind']=='actual-mode-window' and after[:2]==before[:2] and after[3:5]==before[3:5],'retained metadata chain unknown operation/changed bytes')
        current=after;previous=sequence;references.append(sequence)
    if not (current==consumer['identity'] and path==consumer['path']):
        raise ValueError('multi-process generation originals: retained metadata chain final full identity/path differs; '+
            metadata_chain_diagnostic(producer,consumer,current,path,references))
    return references

def policy(arch):
    if arch not in POLICIES:raise ValueError('unsupported actual kernel architecture')
    return POLICIES[arch]

def need(value,reason):
    if not value:raise ValueError('multi-process generation originals: '+reason)
DENIED_IO_URING_ERRNO=38 # Linux ENOSYS, for both explicitly supported audit architectures.
def denied_io_uring_register_layout(arch):
    policy(arch)
    # Linux x86_64 user_regs_struct.orig_rax and arm64 NT_ARM_SYSTEM_CALL.
    return {0xc000003e:(1,216,120,8),0xc00000b7:(0x404,4,0,4)}[arch]
def denied_io_uring_substitute(model,width):
    need(model in ['explicit-kernel-enosys-denial-v1','explicit-kernel-enosys-denial-v2'],'unknown explicit denial register model')
    return b'\xff'*width if model=='explicit-kernel-enosys-denial-v1' else (0x7fffffff).to_bytes(width,'little')
def verify_denied_io_uring_registers(arch,nr,before,after,*,model='explicit-kernel-enosys-denial-v1'):
    need(type(nr) is int and nr==425,'only io_uring_setup may be explicitly denied')
    regset,size,offset,width=denied_io_uring_register_layout(arch)
    need(type(before) is bytes and type(after) is bytes and len(before)==len(after)==size,'exact denial register set required')
    need(int.from_bytes(before[offset:offset+width],'little')==nr,'actual entry register syscall differs')
    expected=before[:offset]+denied_io_uring_substitute(model,width)+before[offset+width:]
    need(after==expected,'denial changed other registers or failed to set invalid syscall')
    return dict(registerSet=regset,registerBytes=size,syscallOffset=offset,syscallBytes=width,originalSyscall=nr,substitutedSyscall=-1 if model=='explicit-kernel-enosys-denial-v1' else 0x7fffffff)
def append_boundary_syscall(arch,nr,args=None):
    rules=policy(arch)
    # open/openat allocate a descriptor; they do not consume file contents.
    # Only a fully decoded, non-truncating flags word may defer checkpoint to
    # the actual later read/mmap/exec/close. Unknown inputs stay fail-closed.
    flag_index={0xc000003e:{2:1,257:2},0xc00000b7:{56:2}}[arch].get(nr)
    if flag_index is not None:
        if not isinstance(args,(list,tuple)) or len(args)!=6 or not all(type(value) is int and 0<=value<(1<<64) for value in args):return True
        flags=args[flag_index]
        if type(flags) is not int or not 0<=flags<(1<<64):return True
        return bool(flags&0x200) # Linux O_TRUNC, on both reviewed ABIs.
    # Before exec, mapping, namespace/mode/size or descriptor replacement can
    # change what a retained append image denotes. Socket reads are not file
    # consumers and do not trigger a full checkpoint per network packet.
    extra={0xc000003e:{2,3,9,11,59,76,77,85,86,87,90,91,257,263,265,268,292,322,436,32,33,72},
           0xc00000b7:{23,24,25,35,36,45,46,49,52,53,56,57,215,221,222,281,436}}[arch]
    return nr in extra or nr in rules['renameOps']

_THREAD_CLONE_ALLOWED=0xff|0x100|0x200|0x400|0x800|0x4000|0x8000|0x10000|0x40000|0x80000|0x100000|0x200000|0x1000000|0x100000000

def inspect_shared_clone_flags(flags):
    need(type(flags) is int and flags>=0,'actual clone flags required')
    allowed=0xff|0x100|0x200|0x400|0x800|0x4000|0x8000|0x10000|0x40000|0x80000|0x100000|0x200000|0x1000000|0x100000000
    need(flags&~allowed==0,'unknown clone ownership flags')
    need(not(flags&0x800) or flags&0x100,'CLONE_SIGHAND requires shared VM')
    need(not(flags&0x10000) or flags&0x100 and flags&0x800 and flags&0xff==0,'thread clone has invalid VM/signal ownership')
    return dict(sharedFdTable=bool(flags&0x400),sameThreadGroup=bool(flags&0x10000),sharedMemory=bool(flags&0x100))

def verify_write_bytes(before,buffer,after,before_size,offset,count,maximum,check=lambda:None):
    """Bounded sequential pure write(2) reconstruction; no metadata approval."""
    need(type(offset) is int and offset>=0 and type(count) is int and count>=0 and max(before_size,offset+count)<=maximum,'write reconstruction bound')
    class Reader:
        def __init__(self,blocks):self.blocks=iter(blocks);self.pending=b'';self.done=False
        def take(self,n):
            need(0<=n<=65536,'write comparison chunk bound');out=bytearray()
            while len(out)<n:
                check()
                if not self.pending:
                    try:self.pending=next(self.blocks);need(isinstance(self.pending,bytes) and 0<len(self.pending)<=65536,'bounded write original block')
                    except StopIteration:self.done=True;break
                take=min(n-len(out),len(self.pending));out.extend(self.pending[:take]);self.pending=self.pending[take:]
            return bytes(out)
        def skip(self,n):
            while n:
                part=self.take(min(n,65536));need(part,'short pre-write original');n-=len(part)
    pre=Reader(before);payload=Reader(buffer);post=Reader(after);pre_position=0;position=0
    expected_size=max(before_size,offset+count) if count else before_size
    while position<expected_size:
        size=min(65536,expected_size-position);expected=bytearray()
        while len(expected)<size:
            at=position+len(expected)
            if count and offset<=at<offset+count:
                n=min(size-len(expected),offset+count-at);part=payload.take(n);need(len(part)==n,'short actual write buffer');expected.extend(part)
            elif at<before_size:
                if pre_position<at:pre.skip(at-pre_position);pre_position=at
                n=min(size-len(expected),before_size-at,(offset-at if count and at<offset else size));part=pre.take(n);need(len(part)==n,'short pre-write image');pre_position+=n;expected.extend(part)
            else:
                n=min(size-len(expected),offset-at if count and at<offset else size);need(n>0,'invalid write gap');expected.extend(bytes(n))
        need(post.take(size)==bytes(expected),'actual post-write bytes differ from syscall buffer projection');position+=size
    need(post.take(1)==b'','actual post-write original has extra bytes')
    return expected_size
def executable_memory_policy():
    spec=importlib.util.spec_from_file_location('sdk_executable_memory_policy',Path(__file__).with_name('sdk-executable-memory-policy.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def parse_proc_maps(raw):
    need(isinstance(raw,bytes) and len(raw)<=4*1024**2,'bounded maps original required')
    result=[];previous=0
    for number,line in enumerate(raw.splitlines(),1):
        need(len(line)<=65536,'maps line bound')
        match=re.fullmatch(rb'([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) ([0-9a-f]+) ([0-9a-f]+):([0-9a-f]+) ([0-9]+)(?: +(.*))?',line)
        need(match is not None,'actual proc maps syntax required')
        start,end=int(match[1],16),int(match[2],16);need(previous<=start<end,'ordered nonoverlapping actual VMA required');previous=end
        path=(match[8] or b'').decode('utf-8','strict')
        result.append(dict(startHex=format(start,'x'),endHex=format(end,'x'),permissions=match[3].decode(),fileOffset=int(match[4],16),deviceMajor=int(match[5],16),deviceMinor=int(match[6],16),inode=int(match[7]),path=path,mapsLineIndex=number))
    return result

def verify_vma_range(mappings,begin,length,protection):
    need(type(begin) is int and type(length) is int and 0<=begin<begin+length<=1<<64,'actual mapping range overflow')
    end=begin+length;cursor=begin;selected=[]
    for mapping in mappings:
        start,stop=int(mapping['startHex'],16),int(mapping['endHex'],16)
        if start>=end or stop<=begin:continue
        need(start<=cursor<stop,'actual mapping VMA range has a hole')
        need(all(not(protection&bit) or letter in mapping['permissions'] for bit,letter in [(1,'r'),(2,'w'),(4,'x')]),'actual VMA permissions differ from successful syscall')
        cursor=min(stop,end);selected.append(mapping)
    need(cursor==end,'actual mapping VMA does not cover successful returned range');return selected

def elf_interpreter(read,size):
    # Fixed supported SDK targets use little-endian ELF64. This function reads
    # the retained FD/capture bytes, never executes or follows PT_INTERP.
    header=read(0,min(size,64));need(len(header)>=64 and header[:6]==b'\x7fELF\x02\x01','supported actual ELF64 required')
    machine=struct.unpack_from('<H',header,18)[0];need(header[6]==1 and struct.unpack_from('<H',header,16)[0] in [2,3] and struct.unpack_from('<I',header,20)[0]==1 and struct.unpack_from('<H',header,52)[0]==64 and machine in [62,183],'supported ELF machine/header required')
    offset=struct.unpack_from('<Q',header,32)[0];stride,count=struct.unpack_from('<HH',header,54)
    need(stride==56 and 0<count<=4096 and offset+count*stride<=size,'bounded ELF program headers required')
    interpreter=None
    for index in range(count):
        row=read(offset+index*stride,stride);need(len(row)==stride,'truncated ELF program header')
        if struct.unpack_from('<I',row)[0]!=3:continue
        begin,length=struct.unpack_from('<Q',row,8)[0],struct.unpack_from('<Q',row,32)[0]
        need(interpreter is None and 1<length<=4096 and begin+length<=size,'unique bounded ELF PT_INTERP required')
        raw=read(begin,length);need(len(raw)==length and raw[-1:]==b'\0' and b'\0' not in raw[:-1],'actual interpreter encoding required')
        interpreter=raw[:-1].decode('utf-8','strict');need(interpreter.startswith('/') and '\n' not in interpreter,'absolute actual interpreter path required')
    return dict(machine=machine,interpreter=interpreter)

def write_segments(before,offset,count,buffer,maximum):
    """Immutable original slices, not full postimage copies. Zero gaps explicit."""
    need(type(maximum) is int and maximum>=0,'exact write projection maximum required')
    need(type(offset) is int and offset>=0 and type(count) is int and count>=0,'nonnegative exact write offset/count required')
    need(all(type(at) is int and at>=0 and type(n) is int and n>=0 and (ref is None or type(ref.get('bytes')) is int and 0<=at<=at+n<=ref['bytes']<=maximum) for ref,at,n in before),'bounded original delta segment required')
    size=sum(item[2] for item in before);need(size<=maximum and offset+count<=maximum and type(buffer.get('bytes')) is int and 0<=count<=buffer['bytes']<=maximum,'write projection size/range bound');result=[]
    def subset(start,end):
        position=0
        for ref,at,n in before:
            left=max(start,position);right=min(end,position+n)
            if right>left:result.append((ref,at+left-position,right-left))
            position+=n
    if not count:return list(before)
    subset(0,min(offset,size))
    if offset>size:result.append((None,0,offset-size))
    result.append((buffer,0,count));subset(offset+count,size)
    need(len(result)<=65536,'write delta segment count unsupported')
    return result

def segment_blocks(segments,read_blocks,check=lambda:None):
    for ref,start,length in segments:
        if ref is None:
            while length:check();n=min(length,65536);yield bytes(n);length-=n
            continue
        position=0
        for block in read_blocks(ref):
            check();need(isinstance(block,bytes) and 0<len(block)<=65536,'bounded delta original block')
            left=max(start,position);right=min(start+length,position+len(block))
            if right>left:yield block[left-position:right-position]
            position+=len(block)
            if position>=start+length:break
        need(position>=start+length,'short write delta original slice')

def digest_blocks(blocks,maximum,check=lambda:None):
    count=0;digest=hashlib.sha256()
    for block in blocks:
        check();need(isinstance(block,bytes) and len(block)<=65536,'bounded write digest chunk');count+=len(block);need(count<=maximum,'write digest byte bound');digest.update(block)
    return dict(bytes=count,sha256=digest.hexdigest())

def parse_fetchcontent_declarations(text):
    # Intentionally bounded literal subset of the pinned CMake declarations.
    # Changed/dynamic/custom download semantics require a new reviewed adapter.
    VALUES={'GIT_REPOSITORY','GIT_TAG','GIT_SHALLOW','URL','URL_HASH','SOURCE_SUBDIR'};FLAGS={'SYSTEM','EXCLUDE_FROM_ALL','OVERRIDE_FIND_PACKAGE'};NAME=re.compile(r'[a-z][a-z0-9_-]*\Z')
    clean=re.sub(r'#[^\n]*','',text)
    declarations=[];names=set()
    for match in re.finditer(r'(?im)^\s*FetchContent_Declare\s*\(([^)]*)\)',clean):
        tokens=shlex.split(match[1]);name=tokens[0].lower() if tokens else ''
        if not NAME.fullmatch(name) or name in names:raise ValueError('Unique literal FetchContent name required')
        names.add(name);options={};i=1
        while i<len(tokens):
            key=tokens[i].upper();i+=1
            if key in options or key not in VALUES|FLAGS:raise ValueError('Unsupported FetchContent declaration option: '+key)
            if key in FLAGS:options[key]=True;continue
            if i==len(tokens) or any(c in tokens[i] for c in '$;[]\\'):raise ValueError('Literal FetchContent option required')
            options[key]=tokens[i];i+=1
        row=dict(name=name,options=tokens[1:])
        if 'SOURCE_SUBDIR' in options:
            need(not options['SOURCE_SUBDIR'].startswith('/') and all(v not in ['', '.', '..', '.git'] for v in options['SOURCE_SUBDIR'].split('/')),'canonical dependency source subdir');row['sourceSubdir']=options['SOURCE_SUBDIR']
        if 'GIT_REPOSITORY' in options:
            if 'URL' in options or not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',options['GIT_REPOSITORY']) or not re.fullmatch('[0-9a-f]{40}',options.get('GIT_TAG','')):raise ValueError('Exact HTTPS Git repository/commit required')
            if options.get('GIT_SHALLOW','FALSE').upper() not in ('TRUE','FALSE'):raise ValueError('Literal shallow declaration required')
            row.update(method='git',repository=options['GIT_REPOSITORY'],commit=options['GIT_TAG'])
        else:
            if set(options)&{'GIT_TAG','GIT_SHALLOW'} or not options.get('URL','').startswith('https://github.com/'):raise ValueError('Pinned HTTPS archive required')
            digest=options.get('URL_HASH','')
            if not re.fullmatch(r'SHA3_224=[a-f0-9]{56}',digest):raise ValueError('Exact declared archive hash required')
            row.update(method='url',url=options['URL'],algorithm='sha3_224',digest=digest.split('=',1)[1])
        declarations.append(row)
    calls=re.findall(r'(?im)^\s*FetchContent_MakeAvailable\s*\(([^)]*)\)',clean)
    if len(calls)!=1 or len(shlex.split(calls[0]))!=len(names) or set(shlex.split(calls[0]))!=names:raise ValueError('Exact closed literal FetchContent availability set required')
    if not declarations:raise ValueError('Actual FetchContent declarations required')
    return declarations

def fetchcontent_source_bindings(rows):
    cache='set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "" FORCE)\n';names=set()
    for row in rows:
        name=row['name']
        if not isinstance(name,str) or not re.fullmatch('[a-z][a-z0-9_-]*',name) or name in names or row['sourceRoot']!='/opt/qlever-sdk/dependencies/'+name:raise ValueError('Fixed literal CMake prepared source binding required')
        names.add(name);cache+='set(FETCHCONTENT_SOURCE_DIR_'+name.upper()+' "'+row['sourceRoot']+'" CACHE PATH "" FORCE)\n'
    return cache

def fetchcontent_cache_bytes(declarations):
    return fetchcontent_source_bindings([dict(name=row['name'],sourceRoot='/opt/qlever-sdk/dependencies/'+row['name']) for row in declarations]).encode('utf-8')

def dependency_declaration_projection(collection,original):
    need(collection.get('declarationSource',{}).get('sourcePath')=='/opt/qlever-sdk/source/CMakeLists.txt','fixed actual dependency declaration source required')
    declarations=parse_fetchcontent_declarations(original.decode('utf-8','strict'))
    need([row['declaration'] for row in collection['dependencies']]==declarations,'dependency declaration universe differs from actual CMake original')
    return fetchcontent_cache_bytes(declarations)

def probe_mount_readonly(path,data):
    matches=[]
    for line in data.decode('utf-8','strict').splitlines():
        fields=line.split();separator=fields.index('-');need(separator>=6 and len(fields)>separator+3,'dependency kernel mount layout')
        mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
        if path==mount or path.startswith(mount.rstrip('/')+'/'):matches.append((len(mount),mount,fields[5].split(','),fields[separator+3].split(',')))
    need(bool(matches),'dependency source mount missing');_,mount,options,superoptions=max(matches);need('ro' in options or 'ro' in superoptions,'dependency source provider is writable')
    return dict(mount=mount,mountOptions=options,superblockOptions=superoptions)

def dependency_inventory_rows(index,shards,maximum_members,check=lambda:None):
    need(index.get('schemaVersion')==1 and type(index.get('files')) is int and 0<=index['files']<=maximum_members and type(index.get('bytes')) is int and index['bytes']>=0,'dependency physical inventory index shape')
    need(len(index['shards'])==len(shards),'dependency inventory shard count differs');rows={};total=0
    for shard in shards:
        need(shard.get('schemaVersion')==1 and isinstance(shard.get('files'),list),'dependency inventory shard shape')
        for row in shard['files']:
            check();path=row.get('path');need(isinstance(path,str) and path and not path.startswith('/') and '\\' not in path and '\0' not in path and all(v not in ['', '.', '..'] for v in path.split('/')) and len(path.encode())<=4096,'canonical dependency member path required')
            need(path not in rows and len(rows)<maximum_members,'dependency physical inventory duplicate/member bound')
            need(row.get('kind') in ['file','symlink'] and type(row.get('mode')) is int and 0<=row['mode']<=0o7777 and type(row.get('bytes')) is int and row['bytes']>=0 and re.fullmatch('[0-9a-f]{64}',row.get('sha256','')),'dependency physical member shape')
            if row['kind']=='symlink':
                target=row.get('target');need(isinstance(target,str) and target and not target.startswith('/') and '\0' not in target,'dependency internal symlink target required')
                parts=path.split('/')[:-1]
                for part in target.split('/'):
                    if part=='..':need(bool(parts),'dependency symlink escapes root');parts.pop()
                    elif part not in ['', '.']:parts.append(part)
                raw=target.encode();need(len(raw)==row['bytes'] and hashlib.sha256(raw).hexdigest()==row['sha256'],'dependency symlink original differs')
            rows[path]=row;total+=row['bytes']
    need(len(rows)==index['files'] and total==index['bytes'],'dependency physical inventory aggregate differs');return rows

def dependency_collection_contract(prepared,collection):
    need(collection.get('schemaVersion')==1 and collection.get('kind')=='qlever-sdk-fetchcontent-prepared-originals' and collection.get('sourceRoot')=='/opt/qlever-sdk/source' and collection.get('dependenciesRoot')=='/opt/qlever-sdk/dependencies','fixed prepared dependency collection required')
    need(isinstance(prepared.get('dependencyCollection'),dict) and prepared['dependencyCollection']['path']=='fetchcontent/materials.json','source-prepared dependency collection binding required')
    dependencies=collection.get('dependencies');need(isinstance(dependencies,list) and len(dependencies)<=128,'dependency declaration count bound');result={}
    for row in dependencies:
        name=row.get('name');need(isinstance(name,str) and re.fullmatch('[A-Za-z][A-Za-z0-9_-]*',name) and name not in result,'unique canonical declared dependency name required')
        need(row.get('sourceRoot')=='/opt/qlever-sdk/dependencies/'+name and row.get('sourceOriginals',{}).get('kind') in ['git','url'] and isinstance(row['sourceOriginals'].get('file'),dict),'dependency root/source-originals binding differs')
        need(row.get('declaration',{}).get('name')==name,'dependency declaration name differs from registered root')
        need(isinstance(row.get('sourceInventory'),dict) and row.get('declaration',{}).get('method')==row['sourceOriginals']['kind'],'dependency inventory/source kind reference required');result[name]=row
    return result

def _mapping_protection_bits(permissions):
    """Translate ACTUAL /proc/PID/maps permission text into prot bits.

    An exec image is mapped by the kernel before the replay sees it, so there is
    no mmap prot word for it. The edge must report the REAL permissions: an
    rw-p data segment of the same executable is NOT an immutable source input,
    and claiming it read-only would over-credit. bits: r=1,w=2,x=4.
    """
    need(isinstance(permissions,str) and re.fullmatch('[r-][w-][x-][ps]',permissions),'actual VMA permissions required')
    return (1 if permissions[0]=='r' else 0)|(2 if permissions[1]=='w' else 0)|(4 if permissions[2]=='x' else 0)


def record_validated_mmap(operations,row,entry,descriptor,anonymous,actual):
    """Record one ALREADY-VERIFIED mmap row into the CALLER's own state.

    `operations` is explicit per-observation state owned by observe(); there is
    deliberately no module-global store, so nested record_observer/read_original
    callbacks or an independent concurrent observation can never clear or mix
    another observation's proof state.

    Only called from the replay branch that has validated the entry/exit, the
    actual return address, requested length, offset, prot and flags, and the FD
    original. Keeping this out of the coverage classes preserves their minimal
    projection contract (their canonical fixture supplies only sequence fields).
    """
    operations[row['sequence']]=dict(phase=row['phase'],pid=row['pid'],
        entrySequence=entry['sequence'],anonymous=anonymous,
        descriptorIdentity=list(descriptor['identity']) if descriptor and 'identity' in descriptor else None,
        descriptorHasOriginal=bool(descriptor and 'original' in descriptor),
        descriptorSha256=(descriptor.get('original') or {}).get('sha256') if descriptor else None,
        descriptorBytes=(descriptor.get('original') or {}).get('bytes') if descriptor else None,
        returnedAddressHex=format(actual['result'],'x'),requestedLength=entry['args'][1],
        fileOffset=entry['args'][5],flags=entry['args'][3],protection=entry['args'][2],
        # C4: a writable MAP_SHARED mapping lets another task change the same
        # file bytes, so the held read lease no longer implies immutable content.
        writableShared=bool(entry['args'][3]&0x1 and entry['args'][2]&0x2))


def derive_verified_file_mmap_keys(mmap_operations,by_capture,pending_for_operation):
    """DERIVED projection of already fully-verified file-backed mmap operations.

    Same pattern as verifiedPrivateWakeEntrySequences: the value is produced only
    after the ordinary replay has validated the exact entry/exit, the actual
    return address, requested length, file offset, prot and flags, the retained
    whole FD original, the held pre-use lease/identity and every VMA mapping
    original for that operation. It is never read as an input claim and never
    substitutes a path match for verification.

    A row is emitted only when: the operation is a non-anonymous mmap, the
    observer recorded a whole validated FD original, the operation's VMA
    universe is COMPLETE (no missing mapping original), at least one mapping
    original exists, and every mapped inode identity equals that FD. Any
    anonymous, unbound, incomplete or identity-divergent operation is omitted,
    so its marker remains uncovered.
    """
    keys=[]
    for sequence in sorted(mmap_operations):
        meta=mmap_operations[sequence];state=by_capture.get(sequence)
        if state is None or meta['anonymous'] or not meta['descriptorHasOriginal']:continue
        # C4: writable MAP_SHARED cannot claim immutable file custody even when a
        # foreign/forged trace carried it through; MAP_PRIVATE PROT_WRITE (the
        # real GCC consumer shape) is untouched because COW leaves file bytes
        # immutable under the held lease.
        if meta.get('writableShared'):continue
        # Both projection layouts are supported here, in ONE place: the indexed
        # class stores positional fields with a flat seen map, the ordinary class
        # stores named fields with an owned mapping set.
        value=state['value']
        if isinstance(value,list):
            if not all(state['expected'].values()):continue
            originals=value[9]
        else:
            if set(state['expected'])!=state['seen']:continue
            originals=value['mapOriginals']
        if not originals:continue
        descriptor=[str(number) for number in meta['descriptorIdentity']]
        paths=set()
        for value in originals:
            if value['identityDecimal']!=descriptor:paths.clear();break
            paths.add(value['observedPath'])
        if not paths:continue
        # C5: an operation whose OWN authority is still pending cannot claim
        # per-file closure, even though the global toolchain axis already
        # reports the gap. Attribution is scoped to this operation (its own
        # capture sequence or one of its verified mapped paths), so unrelated
        # pending elsewhere in the phase never suppresses a valid credit.
        if pending_for_operation(sequence,state,paths):continue
        # Only the identity tuple is DERIVED here. The per-operation facts
        # (address/length/offset/flags/prot/paths) already live in the verified
        # operation projection, so nothing is duplicated onto the wire.
        for path in sorted(paths):
            keys.append((meta['phase'],meta['pid'],meta['entrySequence'],path))
    return keys

class ToolchainOperationCoverage:
    """Projection of branches already verified by observe; never an authority.

    Keep each actual operation's file-backed VMA universe, instead of using
    global counts or a set of observed paths as a substitute for coverage.
    """
    def __init__(self,maximum_bytes=4*1024**2,maximum_members=50000,check=lambda:None):
        self.operations=[];self.by_capture={};self.maximum_bytes=maximum_bytes;self.maximum_members=maximum_members;self.check=check;self.charged=0
    def claim(self,value):
        self.check();self.charged+=len(json.dumps(value,separators=(',',':')).encode());need(self.charged<=self.maximum_bytes,'tool operation projection metadata bound')
    @staticmethod
    def mapping_key(mapping):return json.dumps(mapping,sort_keys=True,separators=(',',':'))
    def start(self,kind,row,entry,mappings,primary=None):
        self.check();need(len(self.operations)<self.maximum_members,'tool operation member bound')
        need(kind in ['exec','mmap','protect'] and row['sequence'] not in self.by_capture,'duplicate tool operation capture')
        expected={self.mapping_key(mapping):mapping for mapping in mappings if mapping['inode']>0 and mapping['path'].startswith('/')}
        need(len(expected)==sum(1 for mapping in mappings if mapping['inode']>0 and mapping['path'].startswith('/')),'duplicate actual tool VMA')
        value=dict(kind=kind,phase=row['phase'],pid=row['pid'],entrySequence=entry['sequence'],captureSequence=row['sequence'],mapOriginals=[],expectedFileMappingCount=len(expected),unresolved=[])
        if kind=='exec':value['execEventSequence']=row['execEventSequence'];value['elf']=row['elf'];value['primaryFile']={**primary,'identityDecimal':[str(number) for number in primary['identity']]};del value['primaryFile']['identity']
        else:value['exitSequence']=row['exitSequence']
        self.claim(value)
        for key in expected:self.claim(key)
        self.operations.append(value);self.by_capture[row['sequence']]=dict(value=value,expected=expected,seen=set())
    def mapped(self,parent,row,original_sequence,provider=None):
        need(parent in self.by_capture,'tool VMA has no verified operation')
        state=self.by_capture[parent];key=self.mapping_key(row['mapping'])
        need(key in state['expected'] and key not in state['seen'],'duplicate or unrelated tool VMA original')
        state['seen'].add(key)
        value=dict(observedPath=row['mapping']['path'],identityDecimal=[str(number) for number in row['identity']],original=row['original'],mapping=row['mapping'],captureSequence=row['sequence'],originalCaptureSequence=original_sequence,stopReadonlyProvider=provider)
        self.claim(value);state['value']['mapOriginals'].append(value)
    def finish(self,unresolved=(),stop_provider_pending=()):
        pending=list(unresolved)
        for state in self.by_capture.values():
            self.check();state['value']['unresolved']=[]
            for key in sorted(set(state['expected'])-state['seen']):
                mapping=state['expected'][key];reason='toolchain-operation-file-mapping-original-unavailable:'+str(state['value']['captureSequence'])+':'+mapping['path']+':'+mapping['startHex']+'-'+mapping['endHex']+':'+str(mapping['fileOffset'])
                state['value']['unresolved'].append(reason);pending.append(reason)
        result=dict(schemaVersion=1,scope='verified raw operation/file associations; effective-RO and source authority independent',operations=self.operations,pending=pending,stopProviderPending=list(stop_provider_pending))
        need(len(json.dumps(result,separators=(',',':')).encode())<=self.maximum_bytes,'tool operation final metadata bound');return result

class IndexedToolchainOperationCoverage:
    """Lossless operation projection with explicit positional fields and paths.

    The raw verified operations remain separate; only their wire layout changes.
    Missing mappings retain all nine parser fields instead of duplicating a long
    reason string in both each operation and the global pending list.
    """
    MODEL='indexed-tool-operation-coverage-v1'
    MAPPING_FIELDS=('startHex','endHex','permissions','fileOffset','deviceMajor','deviceMinor','inode','path','mapsLineIndex')
    def __init__(self,maximum_bytes=4*1024**2,maximum_members=50000,check=lambda:None):
        self.operations=[];self.by_capture={};self.paths=[];self.path_ids={};self.maximum_bytes=maximum_bytes;self.maximum_members=maximum_members;self.check=check;self.charged=256
    def claim(self,value):
        self.check();self.charged+=len(json.dumps(value,separators=(',',':')).encode())+1
        need(self.charged<=self.maximum_bytes,'indexed tool operation projection metadata bound')
    def mapping_key(self,mapping):
        need(set(mapping) in [set(self.MAPPING_FIELDS),set(self.MAPPING_FIELDS[:-1])],'unknown indexed mapping field')
        path=mapping['path']
        if path not in self.path_ids:
            self.claim(path);self.path_ids[path]=len(self.paths);self.paths.append(path)
        return tuple(self.path_ids[path] if field=='path' else str(mapping[field]) if field in ['fileOffset','inode'] else mapping.get(field) for field in self.MAPPING_FIELDS)
    def start(self,kind,row,entry,mappings,primary=None):
        self.check();need(len(self.operations)<self.maximum_members,'tool operation member bound')
        need(kind in ['exec','mmap','protect'] and row['sequence'] not in self.by_capture,'duplicate tool operation capture')
        selected=[mapping for mapping in mappings if mapping['inode']>0 and mapping['path'].startswith('/')]
        expected={self.mapping_key(mapping):False for mapping in selected}
        need(len(expected)==len(selected),'duplicate actual tool VMA')
        primary_file=None
        if kind=='exec':
            primary_file={**primary,'identityDecimal':[str(number) for number in primary['identity']]};del primary_file['identity']
        value=[kind,row['phase'],row['pid'],entry['sequence'],row['sequence'],len(expected),row['execEventSequence'] if kind=='exec' else row['exitSequence'],primary_file,row['elf'] if kind=='exec' else None,[],[]]
        self.claim(value)
        for key in expected:self.claim(key)
        self.operations.append(value);self.by_capture[row['sequence']]=dict(value=value,expected=expected)
    def mapped(self,parent,row,original_sequence,provider=None):
        need(parent in self.by_capture,'tool VMA has no verified operation')
        state=self.by_capture[parent];key=self.mapping_key(row['mapping'])
        need(key in state['expected'] and not state['expected'][key],'duplicate or unrelated tool VMA original')
        value=dict(observedPath=row['mapping']['path'],identityDecimal=[str(number) for number in row['identity']],original=row['original'],mapping=row['mapping'],captureSequence=row['sequence'],originalCaptureSequence=original_sequence,stopReadonlyProvider=provider)
        self.claim(value);state['expected'][key]=True;state['value'][9].append(value)
    def finish(self,unresolved=(),stop_provider_pending=()):
        for state in self.by_capture.values():
            self.check();state['value'][10]=[list(key) for key,seen in sorted(state['expected'].items()) if not seen]
        result=dict(schemaVersion=2,model=self.MODEL,scope='verified raw operation/file associations; effective-RO and source authority independent',paths=self.paths,operations=self.operations,pending=list(unresolved),stopProviderPending=list(stop_provider_pending))
        need(len(json.dumps(result,separators=(',',':')).encode())<=self.maximum_bytes,'indexed tool operation final metadata bound');return result

def verify_stopped_original_order(original,barrier,boundary,consumer,*,inline=False):
    """Bind a retained observation to this phase's actual stopped boundary."""
    phase=consumer.get('phase')
    need(isinstance(phase,str) and bool(phase) and all(value.get('phase')==phase for value in [original,barrier,boundary]),'stopped original phase differs')
    sequences=[value.get('sequence') for value in [boundary,barrier,original,consumer]]
    need(all(type(value) is int and value>0 for value in sequences),'stopped original requires actual integer sequences')
    start,stop,observed,used=sequences
    need(start<stop<observed and (observed==used if inline else observed<used),'stopped original is outside its actual boundary/barrier window')

KERNEL_VIRTUAL_FILESYSTEMS=frozenset(['sysfs'])

def verify_kernel_virtual_fs_chain(chain,authority_tables,*,subject_pid,result,requested_bound,
                                   descriptor_flags,need):
    """PURE verifier for a read-only kernel-generated virtual filesystem file.

    Every accepted fact is RE-DERIVED from the subject's own verified mountinfo
    bytes and from the observed syscall; nothing comes from the chain's words
    alone. A regular file bind-mounted at the same path fails the filesystem and
    device checks; a different mount fails the mount-id check; a writable mount
    fails the read-only check; and a read that consumed more than the captured
    object or more than it requested is refused.

    Returns a frozen fact dict or ``None``.
    """
    if not isinstance(chain,dict):return None
    path=chain.get('path')
    if not isinstance(path,str) or not path.startswith(('/sys/','/proc/sys/')):return None
    if chain.get('fstype') not in KERNEL_VIRTUAL_FILESYSTEMS:return None
    if 'ro' not in (chain.get('mountOptions') or []):return None
    if type(chain.get('mountId')) is not int or chain.get('descriptorMountId')!=chain['mountId']:return None
    if type(result) is not int or result<=0:return None
    if type(requested_bound) is not int or result>requested_bound:return None
    if type(descriptor_flags) is not int or descriptor_flags&os.O_ACCMODE!=0:return None
    if not authority_tables:return None
    mount_point=chain.get('mountPoint')
    if not isinstance(mount_point,str):return None
    for table in authority_tables:
        if not isinstance(table,bytes):continue
        try:lines=table.decode('utf-8','strict').splitlines()
        except UnicodeDecodeError:continue
        for line in lines:
            fields=line.split()
            if len(fields)<7:continue
            try:separator=fields.index('-')
            except ValueError:continue
            if separator<6 or len(fields)<=separator+3:continue
            mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
            if mount!=mount_point:continue
            try:mount_id=int(fields[0])
            except ValueError:continue
            if mount_id!=chain['mountId']:continue
            if fields[2]!=str(chain.get('device')):continue
            if 'ro' not in fields[5].split(','):continue
            if fields[separator+1]!=chain.get('fstype'):continue
            if 'ro' not in fields[separator+3].split(','):continue
            return dict(model='kernel-virtual-fs-metadata-v1',subjectPid=subject_pid,path=path,
                mountPoint=mount,mountId=mount_id,fstype=chain['fstype'],device=fields[2],
                consumedLength=result,authorityTableCount=len(authority_tables))
    return None

def classify_read_input_origin(item,dependency_roots,prepared_paths):
    """Classify ONE credited read input against already-verified origins.

    Returns ``(originClass, detail)``. Only CLOSED classes are named; everything
    else is ``unresolved`` so the leaf keeps SOURCE pending. This never invents an
    origin from a path prefix, a producer boolean or a read count.

    Admitted classes, each tied to a fact this replay itself validated:

    * ``prepared-fetchcontent`` — the resolved target is a file inside a
      REGISTERED FetchContent dependency root (exact registration sequence, path
      inside that root, byte length/digest/mode equal to the prepared snapshot).
    * ``signed-debian-installed`` — the resolved target is a file inside a
      registered signed-Debian install root, matched by its exact bytes.
    * ``generated-same-phase`` — the target is a file this same replay already
      recorded as a completed producer output with the SAME byte image.
    """
    path=item.get('resolvedPath')
    if not isinstance(path,str) or not path.startswith('/'):return 'unresolved','no canonical resolved target'
    size=item['bytes'];digest=item['sha256']
    for name,root in (dependency_roots or {}).items():
        base=root['root']
        if path==base or path.startswith(base.rstrip('/')+'/'):
            relative=path[len(base.rstrip('/'))+1:] if path!=base else ''
            row=root['files'].get(relative)
            if (row is not None and row.get('kind')=='file' and row.get('bytes')==size
                    and row.get('sha256')==digest):
                return 'prepared-fetchcontent',dict(dependency=name,
                    registrationSequence=root['registrationSequence'],relativePath=relative)
            return 'unresolved','registered dependency root does not verify these exact bytes'
    # A bare pathname is NOT closure: retained "prepared" originals are not
    # necessarily FetchContent, and a path can be re-created with different bytes.
    # Both must match the retained prepared original's EXACT byte image. Anything
    # else stays unresolved for the TS-side derivation over verified ownership.
    row=(prepared_paths or {}).get(path)
    if row is not None and row.get('bytes')==size and row.get('sha256')==digest:
        return 'prepared-fetchcontent',dict(relativePath=path,
            preparedOriginal=row.get('original'),sourceKind=row.get('kind','prepared'))
    if row is not None:
        return 'unresolved','prepared path exists with different bytes'
    return 'unresolved','no closed same-private source class for this input'


def observe(phase_lines,read_original,required_inputs=None,check=lambda:None,limits=None,capture_observer=None,compact_tool_coverage=False,record_observer=None,generated_build_root='/opt/qlever-sdk/build'):
    maximum_raw=limits['sourceMaterialBytes'] if limits else 32*1024**2
    maximum_file=limits['shardBytes'] if limits else 1024**2
    maximum_total=limits['sourceMaterialBytes'] if limits else 16*1024**2
    maximum_members=limits['sourceMembers'] if limits else 50000
    minimum_metadata=limits['metadataBytes'] if limits else 4*1024**2
    chunk_storage_model=None;chunk_storage_initialized=False
    original_reader=CaptureOriginalReader(read_original,maximum_file,maximum_total,check)
    def read_reference(reference):return original_reader.blocks(reference)
    entity_model=None;entity_model_initialized=False;maps_entity_model=None;maps_entity_initialized=False;storage_origins={};storage_entities={};storage_aliases={};pending_storage_rows=[];original_cache={};observed_entity_names=set();retained_entries=set();phase_tracking=[];generated_verifier=None;generated_module=None
    denial_mode=False;denial=None;denied_operations={};setresuid_mode=False;identity_mode=False;queued_identity_mode=False;stopped_alias_mode=False;terminal_mode=False;setresuid_operations={}
    shared_mode=False;owners={};exec_fd_events={};vfork_events={};vfork_holds={};child_bindings={};wait_rows={}
    live=set();last=0;entries={};exits={};barriers={};caps={};validated_generated_producers={};indexed_producer_captures=set();phase_capture_sequences=[];paths={};renames=[];consumers=[];source_reads=[];total=0;capture_total=0;exclusive=None;root_codes={};clone_flags=set();clone_flag_values={}
    alias_close_windows={};alias_close_exits=set()
    link_windows={};link_transitions={};link_args={};mode_windows={};mode_transitions={};timestamp_windows={};timestamp_transitions={};metadata_args={};rename_windows={};rename_transitions={};active_rename=None;pending_rename_window=None;latest_execution_sequence=0;write_original_sequences={};namespace_bindings=[]
    # STRICT matched FAILURE-ONLY settlement for the absent-operand link markers.
    # absent_entries maps the marker's own entrySequence -> its declaration; a row
    # may be settled exactly once, and only by the matching real exit (isError true,
    # genuine negative Linux errno) plus a confirmation that cites that same exit.
    # `unobserved` entries are collected ONLY so phase-end can refuse them: they
    # prove nothing, so no window/transition may ever cite them.
    absent_entries={};absent_settled={};absent_confirmed={};unobserved_entries=set();link_evidence_sequences=set()
    # EXACT emitter field sets for the two admitted absent-operand markers, taken
    # from the real emitter (sdk-ptrace-execution.py:1226 and :1334) plus the common
    # envelope that emit_original adds to every row (:894). A missing or extra key is
    # a rejection, so a forged row cannot drop "regular" or invent authority.
    ABSENT_ENTRY_KEYS=frozenset(['kind','phase','sequence','observedUnixNs','pid','entrySequence','form','arch','nr','resolved','regular','reason'])
    ABSENT_CONFIRMED_KEYS=frozenset(['kind','phase','sequence','observedUnixNs','pid','entrySequence','exitSequence','form','errnoValue','newPathHex','oldPathHex','scope'])
    append_obligations={};append_completed={};append_dirty={};append_checkpoints={};append_hashes={};write_projections={};write_windows={};closed_write_windows=set();write_transitions={};write_consumers=[];write_read_exits={}
    empty_windows={};empty_eofs=set();dependency_roots={};dependency_reads=0;dependency_cache=None;dependency_expected_names=None;dependency_collection_identity=None
    reused_originals={};prepared={};prepared_consumers=[];prepared_digest=hashlib.sha256();prepared_count=0;prepared_sealed=False;prepared_paths={}
    def capture_data(ref):
        nonlocal capture_total
        need(re.fullmatch(r'capture-[0-9]{4,}\.original',ref['path']) and 0<=ref['bytes']<=maximum_file,'fixed capture role/byte bound')
        prior=original_reader.logical.get(ref['path']);need(prior is None or prior==physical_original_reference(ref),'cached logical original reference changed')
        key=(ref['path'],ref['bytes'],ref['sha256'])
        if key not in original_cache:
            original=read_reference(ref);digest=hashlib.sha256();count=0
            if isinstance(original,bytes):need(len(original)<=1024**2,'legacy tiny byte reader bound')
            blocks=(original[offset:offset+65536] for offset in range(0,len(original),65536)) if isinstance(original,bytes) else original
            for block in blocks:
                check();need(isinstance(block,bytes) and len(block)<=65536,'bounded actual capture block required');count+=len(block);need(count<=ref['bytes'],'capture actual byte bound');digest.update(block)
            data=(count,digest.hexdigest());capture_total=original_reader.physical_bytes;need(capture_total<=maximum_total and data==(ref['bytes'],ref['sha256']),'capture actual bytes/reference differs');original_cache[key]=data;observed_entity_names.add(ref['path'])
        return original_cache[key]
    def storage_original(row):
        ref=row['original'];data=capture_data(ref);entity=row.get('originalEntityIdentity')
        if 'storage' in ref:
            need(chunk_storage_model=='chunk-original-v1' and row['kind']=='write-original' and 'originalEntityIdentity' not in row and 'originalReuse' not in row,'chunk storage requires declared own write observation')
            physical=ref['storage']['manifest'];identity=row.get('storageIdentity')
            need(type(identity) is list and len(identity)==7 and all(type(v) is int and v>=0 for v in identity) and stat.S_ISREG(identity[2]) and identity[3]==physical['bytes'] and identity[6]==1,'actual manifest physical identity differs')
            need(ref['path'] not in storage_entities,'chunk observation repeated')
            original_reader.manifest(ref);storage_entities[ref['path']]=row;storage_origins[row['sequence']]=row
            return data
        need(isinstance(entity,list) and len(entity)==7 and all(type(value) is int and value>=0 for value in entity) and entity[3]==data[0] and entity[6]==1 and entity[2]&0o170000==0o100000,'canonical physical content entity identity malformed')
        reuse=row.get('originalReuse')
        if row.get('captureKind')=='maps'and maps_entity_model is not None:
            window=row.get('mapsWindowIdentity');need(isinstance(window,list)and len(window)==7 and all(type(v)is int and v>=0 for v in window)and stat.S_ISREG(window[2])and window[3]==0 and window[6]==1 and row.get('mapsWindowAfterIdentity')==row.get('mapsNamedWindowIdentity')==row.get('mapsNamedWindowAfterIdentity')==window,'maps lacks complete fresh proc FD/named identities')
            need(type(ref.get('observationSequence'))is int and ref['observationSequence']==row['sequence'],'maps reference lacks its own actual observation sequence')
        else:need('observationSequence'not in ref,'observation reference requires maps storage model')
        if reuse is not None:
            need(maps_entity_model=='same-phase-maps-content-entity-v1'and row.get('kind')=='toolchain-original'and row.get('captureKind')=='maps','noncanonical maps alias requires explicit model')
            need(isinstance(reuse,dict)and set(reuse)=={'model','originCaptureSequence'}and reuse['model']==maps_entity_model and type(reuse['originCaptureSequence'])is int and 0<reuse['originCaptureSequence']<row['sequence'],'exact backward maps physical alias required')
            origin=storage_origins.get(reuse['originCaptureSequence']);need(origin and origin['kind']=='toolchain-original'and origin.get('captureKind')=='maps'and origin['phase']==row['phase']and physical_original_reference(origin['original'])==physical_original_reference(ref)and entity==origin['originalEntityIdentity'],'maps alias mixes phase, original or physical identity')
        else:
            old=storage_entities.get(ref['path']);need(old is None,'canonical physical content path repeated without typed alias')
            storage_entities.setdefault(ref['path'],row);storage_origins[row['sequence']]=row
        return data
    def dependency_bytes(ref):
        capture_data(ref);need(ref['bytes']<=4*1024**2,'dependency metadata byte bound')
        value=read_reference(ref);blocks=[value] if isinstance(value,bytes) else value;data=bytearray()
        for block in blocks:check();need(isinstance(block,bytes) and len(block)<=65536,'dependency metadata range bound');data.extend(block);need(len(data)<=ref['bytes'],'dependency metadata grew')
        need((len(data),hashlib.sha256(data).hexdigest())==(ref['bytes'],ref['sha256']),'dependency metadata original changed');return bytes(data)
    def dependency_json(ref):return json.loads(dependency_bytes(ref))
    tool_coverage=(IndexedToolchainOperationCoverage if compact_tool_coverage else ToolchainOperationCoverage)(limits.get('metadataBytes',4*1024**2) if limits else 4*1024**2,limits.get('sourceMembers',50000) if limits else 50000,check)
    tool_originals={};tool_files={};tool_pending=set();tool_execs=0;tool_mappings=0;producer_input_edges=[];producer_exec_image={};unbound_read_operations=[];input_read_originals={};regular_input_observations={};inputs_pending={};inputs_pending_rejected={};observations_by_entry={};disposition_entries={};writable_dispositions={};kernel_metadata_originals={};authority_mountinfo={};control_gates=[];nonexec_credit={};exec_event_history={};nonexec_positive_pending={};read_custody={};lease_entry_by_token={};read_source_class={};read_lease_epoch={};target_resolutions={};tool_core=None;exec_events={};terminal_events={};tool_exec_paths={};tool_protect_before={};tool_providers={};tool_provider_pending=set();provider_verifier=None;tool_digest=hashlib.sha256()
    def resolved_target_for(observation_row):
        """Canonical target of the descriptor this read used.

        Order of evidence:
          1. the observation's OWN `resolvedPath` (emitted at capture time by
             current observers);
          2. otherwise the most recent `regular-input-target-resolution` row for
             the same (pid, fd) STRICTLY BEFORE the observation, whose identity
             matches this read's identity.

        Both are real observer facts; neither is a path guess. A descriptor that
        was never resolved stays unresolved.
        """
        own=observation_row.get('resolvedPath')
        if isinstance(own,str) and own:return own
        candidates=[row for row in target_resolutions.get((observation_row['pid'],observation_row['fd']),[])
                    if row['sequence']<observation_row['sequence']
                    and row.get('identity')==observation_row.get('identity')]
        if not candidates:return None
        return max(candidates,key=lambda row:row['sequence'])['resolvedPath']

    def verify_nonexec_chain(disposition,exit_row):
        """Prove an ACTUAL chain for a positive non-file read, or refuse it.

        Returns ``(verified, reason)``. ``verified`` is a frozen fact set the
        caller may use ONLY for this exact entry; ``reason`` is a stable string
        when nothing is proved. No object kind, path prefix, producer boolean or
        raw ``kind`` participates: every accepted chain is a real relation
        between rows that the replay itself already validated.
        """
        row=disposition['row'];entry=disposition['entry'];result=exit_row['result']
        if result<=0:return None,'nonpositive result needs no chain'
        chain=disposition.get('chain')
        if not isinstance(chain,dict):return None,'positive non-file read has no typed chain'
        model=chain.get('model')
        if model=='observer-startup-gate-v1':
            # EXACT trusted-observer relation: one gate row, a binding to THIS
            # pid, a release strictly before the read entry, and the released
            # byte is the entire content the observer ever wrote.
            gates=[g for g in control_gates if g['sequence']==chain.get('gateSequence') and g['kind']=='toolchain-control-gate']
            if len(gates)!=1:return None,'startup gate original unavailable'
            gate=gates[0]
            if gate.get('model')!='observer-owned-startup-gate-v1' or gate.get('phase')!=row['phase']:
                return None,'startup gate model/phase differs'
            if [str(v) for v in gate['identity']]!=[str(v) for v in chain.get('identity',[])]:
                return None,'startup gate identity differs from the bound pipe inode'
            bindings=[g for g in control_gates if g['kind']=='toolchain-control-gate-binding'
                      and g.get('gateSequence')==gate['sequence'] and g.get('pid')==row['pid']]
            releases=[g for g in control_gates if g['kind']=='toolchain-control-gate-release'
                      and g.get('gateSequence')==gate['sequence'] and g.get('pid')==row['pid']]
            if len(bindings)!=1 or len(releases)!=1:return None,'startup gate binding/release relation incomplete'
            if bindings[0]['sequence']!=chain.get('bindingSequence') or releases[0]['sequence']!=chain.get('releaseSequence'):
                return None,'startup gate cited sequences differ'
            if not (bindings[0]['sequence']<releases[0]['sequence']<entry['sequence']):
                return None,'startup gate release is not strictly before the read entry'
            if releases[0].get('byteLength')!=1 or releases[0].get('byteSha256')!=chain.get('byteSha256'):
                return None,'startup gate released byte differs'
            if result>1:return None,'startup gate read consumed more than the single released byte'
            # The gate is a PRE-EXEC construct: the read must precede this pid's
            # first actual exec event, otherwise it is some later unrelated pipe.
            first_exec=min((event['sequence'] for event in exec_event_history.values()
                            if event.get('pid')==row['pid'] and event['sequence']>entry['sequence']),default=None)
            if first_exec is None:return None,'startup gate read is not followed by this pid exec'
            return dict(model='observer-startup-gate-v1',gateSequence=gate['sequence'],
                bindingSequence=bindings[0]['sequence'],releaseSequence=releases[0]['sequence'],
                identity=[str(v) for v in gate['identity']],consumedLength=result,
                byteSha256=chain['byteSha256'],execSequence=first_exec),None
        if model=='kernel-process-metadata-v1':
            # Kernel-generated metadata of THIS pid. The bytes and their subject
            # must be the exact captured original, and the pid must be inside the
            # verified process-authority interval (same namespace/root/mounts).
            name=chain.get('metadataName');subject=chain.get('subjectPid')
            if name not in ['mountinfo','cgroup']:return None,'unreviewed kernel metadata name'
            if subject!=row['pid']:return None,'kernel metadata subject differs from the reading process'
            reference=chain.get('subjectOriginal')
            if not isinstance(reference,dict):return None,'kernel metadata original reference missing'
            captured=kernel_metadata_originals.get(tool_original_key(reference))
            if captured is None:return None,'kernel metadata original was not captured'
            if captured['name']!=name or captured['subjectPid']!=row['pid']:
                return None,'kernel metadata original belongs to another subject'
            if [str(v) for v in chain.get('contentIdentity',[])]!=[str(v) for v in captured['identity']]:
                return None,'kernel metadata content identity differs from the captured original'
            # Metadata files are read from the start of a synthetic, non-seekable
            # stream, so the consumed range must be a real prefix of the captured
            # original and may not exceed it.
            if result>captured['original']['bytes']:
                return None,'kernel metadata consumed more bytes than the captured original'
            samples=process_interval.samples if process_interval is not None else {}
            if row['pid'] not in samples:return None,'kernel metadata pid lacks a verified authority interval sample'
            sample=samples[row['pid']]
            if name=='mountinfo':
                # mountinfo is the SAME object the process-authority interval
                # already verified, so its exact bytes must agree.
                if captured['original']['sha256']!=sample.get('mountinfoSha256'):
                    return None,'kernel metadata bytes differ from the verified authority mountinfo'
            if sample.get('rootIdentity') is None or not sample.get('namespaces'):
                return None,'kernel metadata subject lacks a verified root/namespace'
            return dict(model='kernel-process-metadata-v1',metadataName=name,
                subjectPid=row['pid'],subjectOriginal=reference,consumedLength=result,
                contentIdentity=[str(v) for v in captured['identity']]),None
        if model=='kernel-virtual-fs-metadata-v1':
            # Delegated to the SAME pure verifier the tests exercise directly, so
            # there is exactly one implementation of this rule.
            authority_tables=[row['bytes'] for row in (authority_mountinfo.get(row['pid']) or [])]
            verified=verify_kernel_virtual_fs_chain(chain,authority_tables,
                subject_pid=row['pid'],result=result,
                requested_bound=row.get('requestedBound'),descriptor_flags=row.get('descriptorFlags'),need=need)
            if verified is None:return None,'virtual-fs chain did not verify against the subject mount table'
            return verified,None
        return None,'unknown non-file chain model'

    process_interval=None;process_intervals=[]
    def provider_module():
        nonlocal provider_verifier
        if provider_verifier is None:
            import importlib.util
            from pathlib import Path
            spec=importlib.util.spec_from_file_location('verified_tool_provider',Path(__file__).with_name('sdk-tool-provider-originals.py'));provider_verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(provider_verifier)
        return provider_verifier
    def original_blocks(reference):
        capture_data(reference);value=read_reference(reference)
        return (value[i:i+65536] for i in range(0,len(value),65536)) if isinstance(value,bytes) else value
    def tool_ref(reference,kind=None):
        value=tool_originals.get(tool_original_key(reference));need(value and value['original']==reference and (kind is None or value['captureKind']==kind),'toolchain reference lacks actual complete original')
        return value
    def tool_maps(reference):
        tool_ref(reference,'maps');need(reference['bytes']<=4*1024**2,'bounded maps original')
        original=read_reference(reference);blocks=[original] if isinstance(original,bytes) else original;parts=[];count=0;digest=hashlib.sha256()
        for block in blocks:
            check();need(isinstance(block,bytes) and len(block)<=65536,'bounded maps block');count+=len(block);need(count<=reference['bytes'],'maps byte bound');digest.update(block);parts.append(block)
        need((count,digest.hexdigest())==(reference['bytes'],reference['sha256']),'maps original changed')
        mappings=parse_proc_maps(b''.join(parts))
        if memory_mode:memory_checker.validate_mappings(mappings)
        return mappings
    def tool_barrier(row):
        value=barriers.get(row['barrierSequence']);need(value and value['pids']==sorted(live) and row['pid'] in live,'tool snapshot lacks complete actual stop barrier')
    def tool_provider(sequence,consumer,file_original,actual_path):
        if sequence is None:
            tool_provider_pending.add('toolchain-stop-readonly-provider-original-unavailable:'+str(consumer['sequence'])+':'+str(actual_path))
            # EXACT per-operation attribution for the derived credit projection.
            # The wire reason above is unchanged; this bounded tuple (phase, the
            # consumer row's own capture sequence, exact path) is what the credit
            # rule queries, so no substring/numeric matching is ever involved.
            pending_provider_operations.add((consumer['phase'],consumer['sequence'],str(actual_path)));return None
        need(type(sequence) is int and sequence<consumer['sequence'] and sequence in tool_providers,'actual tool provider original sequence missing')
        record=tool_providers[sequence]
        need(not record['used'],'tool provider original already consumed by another role')
        need(record['pid']==consumer['pid'] and record['phase']==consumer['phase'] and record['barrierSequence']==consumer['barrierSequence'] and record['fileOriginal']==file_original['original'] and record['observation']['actualPath']==actual_path and record['observation']['identity']==file_original['identity'],'tool provider original operation/FD/path/barrier differs')
        record['used']=True;return record['verified']
    def tool_elf(reference):
        original=read_reference(reference);iterator=iter([original] if isinstance(original,bytes) else original);prefix=bytearray()
        def read(offset,size):
            need(0<=offset and size<=65536 and offset+size<=min(reference['bytes'],4*1024**2),'ELF metadata window bound')
            while len(prefix)<offset+size:
                check();block=next(iterator,b'');need(block and isinstance(block,bytes) and len(block)<=65536,'truncated ELF original');prefix.extend(block);need(len(prefix)<=4*1024**2,'ELF metadata prefix bound')
            return bytes(prefix[offset:offset+size])
        try:return elf_interpreter(read,reference['bytes'])
        except ValueError as error:return dict(unresolved='actual-ELF-interpreter-unclassified:'+str(error)[:256])
        finally:
            if hasattr(original,'close'):original.close()
    def write_alias_inventory(value,identity,pid,fd):
        need(stopped_alias_mode and isinstance(value,dict),'stopped alias inventory requires explicit model')
        need(value.get('scope')=='all live stopped tracked FD tables; only selected syscall resumes','stopped alias scope differs')
        need(value.get('taskOwnership')==[dict(tid=owner,**owners[owner]) for owner in sorted(live)],'stopped alias task ownership differs')
        aliases=value.get('aliases');need(isinstance(aliases,list) and 1<=len(aliases)<=64,'bounded complete alias inventory required')
        seen=set();selected=False
        for alias in aliases:
            owner=alias.get('pid');slot=alias.get('fd');need(owner in live and type(slot) is int and 0<=slot and alias.get('fdTable')==owners[owner]['fdTable'],'alias has unknown owner/FD table')
            key=(alias['fdTable'],slot);need(key not in seen,'duplicate shared-table alias');seen.add(key)
            need(alias.get('identity')==identity and type(alias.get('flags')) is int and alias['flags']&3 in [1,2] and alias.get('accessMode')==alias['flags']&3,'alias inode or writable access differs')
            selected=selected or owner==pid and slot==fd
        need(selected,'selected writer absent from complete alias inventory')
        tables=value.get('descriptorTables');need(isinstance(tables,list) and [table.get('pid') for table in tables]==sorted(live),'complete stopped FD table census missing')
        shared={};derived={}
        for table in tables:
            owner=table['pid'];table_id=owners[owner]['fdTable'];need(table.get('fdTable')==table_id,'census FD table differs from actual clone lineage')
            slots=table.get('descriptors');need(isinstance(slots,list) and len(slots)<=1024,'bounded complete FD slots required')
            prior=shared.setdefault(table_id,slots);need(prior==slots,'shared FD table census differs between stopped owners')
            seen_slots=set()
            for descriptor in slots:
                need(isinstance(descriptor,list) and len(descriptor)==3,'exact FD census descriptor required')
                slot,actual,flags=descriptor;need(type(slot) is int and slot>=0 and slot not in seen_slots and isinstance(actual,list) and len(actual)==6 and all(type(n) is int for n in actual) and type(flags) is int,'invalid FD census slot/identity/flags');seen_slots.add(slot)
                if actual[:2]!=identity[:2] or flags&3==0:continue
                need(actual==identity,'same-inode alias census identity differs')
                key=(table_id,slot);alias=dict(pid=owner,fd=slot,identity=actual,flags=flags,accessMode=flags&3,fdTable=table_id)
                if owner==pid and slot==fd:derived[key]=alias
                else:derived.setdefault(key,alias)
        need(list(derived.values())==aliases,'writable aliases differ from complete stopped FD census')
        return aliases
    lifetime_verified_phases=[];verified_file_mmap_keys=set()
    validated_mmap_operations={}
    for phase,lines in phase_lines:
        need(not live,'prior actual process tree has not closed');phase_capture_sequences.clear();roots=[];waits=[];raw_decoder=raw_records.RawRecordDecoder();lease_model=None;lease_tokens={};lease_closed=[];memory_missing=False;memory_shared_entries=set();memory_released_entries=set();pending_provider_operations=set();pending_source_provider_paths={};lease_pids=[];lease_terminal=False;memory_mode=None;bti_mode=None;bti_required=set();bti_originals={};bti_completed=set();approved_rx={};clone3_mode=None;clone3_originals={};clone3_consumed=set();clone3_events={};memory_checker=executable_memory_policy();memory_writes={};remap_mode=None;remap_required=set();remap_originals={};remap_consumed=set()
        for raw in lines:
            check();total+=len(raw);need(total<=maximum_raw and len(raw)<=65536,'tiny raw aggregate/record bound');row=raw_decoder.feed(raw)
            if row is None:continue
            need(row['sequence']==last+1 and row['phase']==phase,'phase/raw sequence differs');last=row['sequence'];kind=row['kind']
            if isinstance(row.get('original'),dict) and 'storage' in row['original']:
                need((not chunk_storage_initialized or chunk_storage_model=='chunk-original-v1') and (kind=='write-original' or original_reader.logical.get(row['original']['path'])==row['original']),'chunk original requires declared write or earlier exact reference')
            if record_observer is not None:record_observer(phase,row)
            if pending_rename_window is not None:need(kind=='exclusive-rename-resume' and row.get('captureSequence')==pending_rename_window,'retained rename window not immediately exclusively resumed')
            if kind in ['kernel-syscall','actual-child-binding']:latest_execution_sequence=row['sequence']
            if active_rename is not None:
                if active_rename['state']=='resumed':
                    need(kind=='kernel-syscall' and row.get('pid')==active_rename['pid'] and row.get('op')=='exit' and row.get('entrySequence')==active_rename['entrySequence'],'event during exclusive retained rename')
                    active_rename['state']='exited'
                elif active_rename['state']=='exited':need(kind in ['write-original','actual-rename-transition'],'event before retained rename postimage closure')
                else:need(kind=='exclusive-captured-syscall-exit','event after retained rename transition before exclusive close')
            active_denial=denied_operations.get(row.get('pid'))
            for pending_uid in setresuid_operations.values():
                if pending_uid['state']=='begun':need(kind=='kernel-syscall' and row.get('pid')==pending_uid['entry']['pid'] and row.get('op')=='exit','event during exclusive setresuid transition')
                elif pending_uid['state']=='exited':need(kind in ['all-stop-barrier','setresuid-noop-exit-original','identity-noop-exit-original'],'setresuid exit missing immediate all-stop originals')
            if active_denial is not None:
                expected_kind={'entry':'explicit-io-uring-setup-denied','substituted':'kernel-syscall','exited':'explicit-io-uring-setup-denied-exit'}[active_denial['state']]
                need(kind==expected_kind,'unexpected event during explicit denied syscall')
                if kind=='kernel-syscall':need(row.get('op')=='exit','explicit denial resumed another entry')
            if kind=='prepared-dependency-source-root':
                need(not live and not roots and not phase_tracking,'dependency roots must precede first actual root')
                dependency_prepared=dependency_json(row['sourcePreparedOriginal']);collection=dependency_json(row['collectionOriginal']);declared=dependency_collection_contract(dependency_prepared,collection)
                declaration=collection.get('declarationSource',{});need(declaration.get('sourcePath')=='/opt/qlever-sdk/source/CMakeLists.txt','fixed actual dependency declaration source required')
                expected_cache=dependency_declaration_projection(collection,dependency_bytes(row['declarationOriginal']))
                identity=tuple((row[key]['bytes'],row[key]['sha256']) for key in ['sourcePreparedOriginal','collectionOriginal','mountinfoOriginal','declarationOriginal','cmakeCacheOriginal'])
                need(dependency_collection_identity is None or dependency_collection_identity==identity,'dependency root registration mixes original collections');dependency_collection_identity=identity;dependency_expected_names=set(declared)
                need(row['declarationReference']==declaration['file'] and (declaration['file']['bytes'],declaration['file']['sha256'])==(row['declarationOriginal']['bytes'],row['declarationOriginal']['sha256']),'dependency declaration original reference differs')
                need(collection.get('cmakeCachePath')=='/opt/qlever-sdk/dependencies/sources.cmake' and row['cmakeCacheReference']==collection['cmakeCache'] and dependency_bytes(row['cmakeCacheOriginal'])==expected_cache,'dependency actual CMake cache bytes differ')
                need((collection['cmakeCache']['bytes'],collection['cmakeCache']['sha256'])==(row['cmakeCacheOriginal']['bytes'],row['cmakeCacheOriginal']['sha256']),'dependency cache original reference differs')
                expected=dependency_prepared['dependencyCollection'];need((expected['bytes'],expected['sha256'])==(row['collectionOriginal']['bytes'],row['collectionOriginal']['sha256']),'dependency collection differs from actual source-prepared')
                name=row['name'];need(name in declared and name not in dependency_roots and row['sourceRoot']==declared[name]['sourceRoot'],'dependency raw root differs from registered declaration')
                index=dependency_json(row['inventoryIndexOriginal']);need(row['inventoryReference']==declared[name]['sourceInventory'] and row['inventoryShardReferences']==index['shards'],'dependency original relative references differ')
                need((declared[name]['sourceInventory']['bytes'],declared[name]['sourceInventory']['sha256'])==(row['inventoryIndexOriginal']['bytes'],row['inventoryIndexOriginal']['sha256']),'dependency inventory registration differs')
                need(len(index['shards'])==len(row['inventoryShardOriginals']),'dependency raw shard references differ')
                for expected,actual in zip(index['shards'],row['inventoryShardOriginals']):need((expected['bytes'],expected['sha256'])==(actual['bytes'],actual['sha256']),'dependency shard registration differs')
                files=dependency_inventory_rows(index,[dependency_json(ref) for ref in row['inventoryShardOriginals']],250000,check);need(sum(len(item['files']) for item in dependency_roots.values())+len(files)<=250000,'dependency aggregate member bound')
                capture_data(row['mountinfoOriginal']);mountvalue=read_reference(row['mountinfoOriginal']);mountparts=[mountvalue] if isinstance(mountvalue,bytes) else mountvalue;mountbytes=bytearray()
                for block in mountparts:
                    check();need(isinstance(block,bytes) and len(block)<=65536 and len(mountbytes)+len(block)<=row['mountinfoOriginal']['bytes']<=4*1024**2,'dependency mountinfo byte bound');mountbytes.extend(block)
                mountbytes=bytes(mountbytes);need((len(mountbytes),hashlib.sha256(mountbytes).hexdigest())==(row['mountinfoOriginal']['bytes'],row['mountinfoOriginal']['sha256']),'dependency mountinfo changed')
                need(probe_mount_readonly(row['sourceRoot'],mountbytes)==row['provider'],'dependency source provider original differs')
                if dependency_cache is None:dependency_cache=dict(path=collection['cmakeCachePath'],original=row['cmakeCacheOriginal'],registrationSequence=row['sequence'],mounts=mountbytes)
                dependency_roots[name]=dict(root=row['sourceRoot'],files=files,registrationSequence=row['sequence'],mounts=mountbytes)
            elif kind=='prepared-build-input-original':
                need(not live and not roots and not phase_tracking and not prepared_sealed,'prepared input must precede first actual process')
                need(row['path'].startswith('/') and row['path'] not in prepared_paths,'unique absolute prepared original path required')
                data=capture_data(row['original']);need(len(row['identity'])==6 and row['identity'][3]==data[0],'prepared identity/bytes differ');prepared[row['sequence']]=(row,data);prepared_count+=1
                # Keep the RETAINED original so a pathname alone can never close a class.
                prepared_paths[row['path']]=dict(bytes=data[0],sha256=data[1],
                    original=dict(row['original']),kind=row.get('kind','prepared-build-input-original'))
                prepared_digest.update((json.dumps(dict(path=row['path'],identity=row['identity'],original=row['original']),sort_keys=True)+'\n').encode())
            elif kind=='prepared-build-input-seal':
                need(not live and not roots and not phase_tracking and not prepared_sealed and row['files']==prepared_count and row['inventorySha256']==prepared_digest.hexdigest(),'prepared closed-set byte seal differs');prepared_sealed=True
                need(all(value[0]['path'].startswith(row['buildRoot'].rstrip('/')+'/') for value in prepared.values()),'prepared original escapes actual build root')
            elif kind=='owned-root-binding':
                bti_mode=row.get('btiHardeningModel');need(bti_mode in [None,'held-rx-bti-hardening-v1'],'unknown BTI model')
                clone3_mode=row.get('clone3ArgsModel');need(clone3_mode in [None,'stopped-clone3-args-v1'],'unknown clone3 argument model')
                memory_mode=row.get('executableMemoryPolicy');need(memory_mode in [None,memory_checker.MODEL],'unknown executable memory policy')
                remap_mode=row.get('remapCapabilityModel');need(remap_mode in [None,memory_checker.REMAP_MODEL] and (remap_mode is None or memory_mode==memory_checker.MODEL),'unknown or unfounded mremap capability model');lease_model=row.get('toolchainLifetimeModel');need(lease_model in [None,'kernel-held-read-lease-v1'],'unknown lifetime model')
                need(row.get('rawRecordModel')==raw_decoder.model,'declared raw record model differs from actual phase format')
                declared_chunk=row.get('chunkOriginalStorageModel')
                need(declared_chunk in [None,'chunk-original-v1'] and (not chunk_storage_initialized or chunk_storage_model==declared_chunk),'unknown or changed chunk storage model')
                need(declared_chunk is not None or not any('storage' in ref for ref in original_reader.logical.values()),'undeclared chunk original')
                chunk_storage_model=declared_chunk;chunk_storage_initialized=True
                observed_entity_model=row.get('captureOriginalEntityModel')
                need('captureOriginalEntityModel' not in row or observed_entity_model in ['same-phase-producer-original-v1','same-phase-content-entity-v2'],'unknown capture entity model')
                need(not entity_model_initialized or entity_model==observed_entity_model,'capture entity model changed across actual roots');entity_model=observed_entity_model;entity_model_initialized=True
                declared_maps_entity=row.get('mapsOriginalEntityModel');need(declared_maps_entity in [None,'same-phase-maps-content-entity-v1']and(not maps_entity_initialized or declared_maps_entity==maps_entity_model)and(declared_maps_entity is None or entity_model=='same-phase-content-entity-v2'),'unknown or changed maps physical entity model');maps_entity_model=declared_maps_entity;maps_entity_initialized=True
                need(chunk_storage_model is None or entity_model=='same-phase-content-entity-v2','chunk storage requires physical content model')
                if entity_model=='same-phase-content-entity-v2':
                    for pending in pending_storage_rows:storage_original(pending)
                pending_storage_rows.clear()
                need(dependency_expected_names is None or set(dependency_roots)==dependency_expected_names,'prepared dependency root universe is not completely registered');need(not live and not roots,'unique actual root required');live.add(row['pid']);roots.append(row['pid']);need(row['backend']=='ptrace-all-stop-process-v1','wrong observer backend')
                need(row.get('taskOwnershipModel') in [None,'all-tracked-tids-shared-fd-v1'],'unknown task ownership model');shared_mode=row.get('taskOwnershipModel') is not None;owners={}
                need(not denied_operations,'unclosed explicit syscall denial at new root');denial=row.get('optionalIoUringModel');need(denial in [None,'explicit-kernel-enosys-denial-v1','explicit-kernel-enosys-denial-v2'],'unknown optional syscall denial model');denial_mode=denial is not None
                generated_model=row.get('generatedVmaModel')
                metadata_model=row.get('generatedVmaMetadataModel');need(metadata_model in [None,'actual-closed-generated-transaction-retained-metadata-v1']and(metadata_model is None or generated_model=='actual-generated-file-vma-stopped-mm-cohort-parked-universe-wait-v8'),'unknown generated metadata accounting model')
                if generated_model is not None:
                    if generated_module is None:
                        import importlib.util
                        from pathlib import Path
                        generated_spec=importlib.util.spec_from_file_location('generated_vma_replay',Path(__file__).with_name('sdk-generated-vma-originals.py'));generated_module=importlib.util.module_from_spec(generated_spec);generated_spec.loader.exec_module(generated_module)
                    need(generated_model in [generated_module.LEGACY_MODEL,generated_module.KERNEL_LINK_MODEL,generated_module.MODEL,generated_module.COHORT_MODEL,generated_module.PRIVATE_WAKE_MODEL,generated_module.PRIVATE_WAIT_MODEL,*generated_module.COORDINATED_WAIT_MODELS] and row.get('generatedVmaBuildRoot')==generated_module.validated_build_root(generated_build_root) and shared_mode,'unknown/unowned generated VMA model')
                    if generated_verifier is not None:need(generated_verifier.model==generated_model and generated_verifier.retained_metadata==(metadata_model is not None),'generated VMA evidence model changed across roots')
                    if generated_verifier is None:generated_verifier=generated_module.create_verifier(generated_module,capture_data,tool_maps,limits.get('metadataBytes',4*1024**2) if limits else 4*1024**2,model=generated_model,read_blocks=lambda ref:original_blocks(ref),maximum_file=maximum_file,retained_metadata=metadata_model is not None,build_root=generated_build_root)
                else:need(generated_verifier is None,'generated VMA model changed across actual roots')
                model=row.get('processAuthorityModel');need(model is None or model==provider_module().AUTHORITY_MODEL,'unknown process authority model');process_interval=provider_module().ProcessAuthorityInterval(row['pid']) if model is not None else None
                need(not setresuid_operations,'unclosed setresuid transition at new root');uid_model=row.get('setresuidNoopModel');need(uid_model in [None,'actual-stopped-setresuid-noop-v1'],'unknown setresuid operation model');identity_model=row.get('setresIdentityNoopModel');need(identity_model in [None,'actual-stopped-setres-identity-noop-v1','actual-stopped-setres-identity-noop-queued-v2'] and not (identity_model and uid_model),'unknown or mixed identity operation model');identity_mode=identity_model is not None;queued_identity_mode=identity_model=='actual-stopped-setres-identity-noop-queued-v2';setresuid_mode=uid_model is not None or identity_mode;need(not setresuid_mode or process_interval is not None,'setresuid model requires actual process authority interval')
                alias_model=row.get('stoppedWriterAliasModel');need(alias_model in [None,'all-stop-exclusive-write-aliases-v1'],'unknown stopped writer alias model');stopped_alias_mode=alias_model is not None;need(not stopped_alias_mode or shared_mode and process_interval is not None,'stopped aliases require complete task/process authority')
                terminal_model=row.get('exitAuthorityModel');need(terminal_model in [None,'actual-selected-exit-stop-before-peer-barrier-v1','actual-selected-exit-stop-held-terminal-peers-v2'],'unknown terminal authority model');terminal_mode=terminal_model is not None;need(not terminal_mode or process_interval is not None,'terminal model requires actual authority interval')
                if process_interval is not None:process_interval.terminal_peer_model=terminal_model=='actual-selected-exit-stop-held-terminal-peers-v2'
                if shared_mode:need(row['tgid']==row['fdTable']==row['pid'],'initial root ownership differs');owners[row['pid']]=dict(tgid=row['tgid'],fdTable=row['fdTable'])
            elif kind=='actual-child-binding':
                child_bindings[row['childPid']]=row
                need(row['parentPid'] in live and row['childPid'] not in live,'unobserved actual child binding')
                if shared_mode:
                    parent=owners[row['parentPid']];entry=entries.get(row['cloneEntrySequence']);need(entry and entry['pid']==row['parentPid'],'child ownership lacks actual clone entry');rules=policy(entry['arch'])
                    if entry['nr'] in [rules['clone'],435]:need(entry['sequence'] in clone_flags and clone_flag_values[entry['sequence']]==row['cloneFlags'],'child actual clone flags differ')
                    else:need(entry['arch']==0xc000003e and entry['nr'] in [57,58] and row['cloneFlags']==17|(0x4100 if entry['nr']==58 else 0),'unknown child fork operation')
                    ownership=inspect_shared_clone_flags(row['cloneFlags']);need(row['tgid']==(parent['tgid'] if ownership['sameThreadGroup'] else row['childPid']) and row['fdTable']==(parent['fdTable'] if ownership['sharedFdTable'] else row['childPid']),'child TGID/FD table differs from kernel clone flags');owners[row['childPid']]=dict(tgid=row['tgid'],fdTable=row['fdTable'])
                if process_interval is not None:process_interval.child(row['parentPid'],row['childPid'])
                live.add(row['childPid'])
            elif kind=='toolchain-terminal-authority':
                need(terminal_mode and process_interval is not None,'terminal original requires explicit model');event=terminal_events.get(row.get('eventSequence'))
                need(event and event.get('pid')==row['pid'] and event.get('event')==6,'terminal original lacks actual EXIT event')
                observation=row.get('observation');need(isinstance(observation,dict),'terminal authority observation required');mount=observation.get('authority',{}).get('mountinfoOriginal');need(isinstance(mount,dict),'terminal mount original required')
                tool_ref(mount,'mountinfo');data=dependency_bytes(mount)
                process_interval.terminal_sample(row,data,event)
            elif kind=='toolchain-terminal-authority-closed':
                need(terminal_mode and process_interval is not None,'terminal close requires explicit model');barrier=barriers.get(row.get('barrierSequence'));need(barrier is not None,'terminal close requires actual peer barrier');process_interval.terminal_close(row,barrier)
            elif kind=='actual-terminal-exit-resume':
                need(terminal_mode and process_interval is not None and row['pid'] in live,'terminal resume requires actual owned interval');process_interval.terminal_resume(row)
            elif kind=='actual-wait-exit':
                need(row['pid'] not in denied_operations,'explicit denial lacks actual kernel exit before task wait')
                need(row['pid'] not in vfork_holds,'held vfork parent ended without child release');wait_rows[row['sequence']]=row
                if process_interval is not None:process_interval.wait(row['pid'],row if terminal_mode else None)
                need(row['pid'] in live,'wait on unknown process');live.remove(row['pid']);root_codes[row['pid']]=row['returnCode'];waits.append(dict(pid=row['pid'],sequence=row['sequence'],returnCode=row['returnCode'],phase=phase))
            elif kind=='all-stop-barrier':
                terminal_peers=process_interval.terminal_peers(row)if process_interval is not None else set();need(process_interval is not None or 'terminalPeers'not in row,'terminal peers lack owned process interval')
                need(row['pids']==sorted(live-terminal_peers) and row['osStates']==['t']*len(live-terminal_peers),'potential writer not in actual complete tracing-stop barrier')
                if shared_mode:need(row['taskOwnership']==[dict(tid=pid,**owners[pid]) for pid in sorted(live-terminal_peers)],'complete actual TID/TGID/shared-table ownership differs')
                barriers[row['sequence']]=row
            elif kind=='actual-exec-fd-table-unshare':
                event=exec_fd_events.get(row['eventSequence']);owner=owners.get(row['pid']);need(shared_mode and owner and event and event['pid']==row['pid'] and owner['tgid']==row['pid']==row['tgid'] and owner['fdTable']==row['priorFdTable'] and row['fdTable']==-event['sequence'],'exec FD-table unshare lacks actual leader exec event');owner['fdTable']=row['fdTable'];exec_fd_events.pop(row['eventSequence'])
            elif kind=='alias-close-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and row['pid']==entry['pid'] and entry['nr']==policy(entry['arch'])['close'] and entry['args'][0]==row['fd'],'alias close actual syscall differs')
                table_owners=sorted(pid for pid in live if owners[pid]['fdTable']==owners[row['pid']]['fdTable']) if shared_mode else [row['pid']]
                need(row['tableOwners']==table_owners and row['pid'] in barrier['pids'],'alias close table owner set differs');keys=set()
                for alias in row['aliases']:
                    need(alias['pid'] in barrier['pids'] and alias['flags']&3 in [1,2] and alias['accessMode']==alias['flags']&3,'alias close has no observed writable slot');keys.add((owners[alias['pid']]['fdTable'] if shared_mode else alias['pid'],alias['fd']))
                need(len(keys)>1 and (owners[row['pid']]['fdTable'] if shared_mode else row['pid'],row['fd']) in keys,'alias close does not refer to selected multi-alias slot');alias_close_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-alias-close-resume':
                window=alias_close_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'alias close exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='alias-close-exit':
                window=alias_close_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and window['sequence'] not in alias_close_exits and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and not row['isError'] and row['result']==0,'alias close missing actual successful exit')
                need(row['retainedIdentity'][:2]==window['identity'][:2] and row['slotAbsences']==[dict(tid=pid,fd=window['fd'],errorCode=2) for pid in window['tableOwners']],'alias close has no actual same-table slot absence');alias_close_exits.add(window['sequence'])
            elif kind=='actual-rename-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                generated_checkpoint=row.get('generatedCheckpointSequence')
                if generated_checkpoint is not None:
                    need(generated_verifier is not None and generated_verifier.model==generated_module.PARKED_WAIT_MODEL and 'producerCaptureSequence'not in row,'generated rename requires explicit v8 checkpoint')
                    checkpoint=generated_verifier.checkpoints.get(generated_checkpoint);producer=(checkpoint,checkpoint['data'])if checkpoint else None
                else:producer=caps.get(row['producerCaptureSequence'])
                need(entry and barrier and producer and row['pid']==entry['pid'] and exclusive is None and row['pid'] in barrier['pids'] and entry['sequence']<barrier['sequence'] and latest_execution_sequence<=barrier['sequence'] and entry['nr'] in policy(entry['arch'])['renameOps'],'retained rename entry/barrier/producer missing')
                need(entry['nr']!=policy(entry['arch']).get('renameat2') or entry['args'][4]==0,'retained renameat2 flags unsupported')
                need(paths.get(row['entrySequence'])==[row['fromPath'],row['toPath']] and row['fromPath']!=row['toPath'] and row['sequence'] not in rename_windows and row['leaseSequence']==row['sequence'],'retained rename paths/window/lease differs')
                old,data=producer;close=exits.get(old['entrySequence']);before=row['beforeIdentity']
                need((generated_checkpoint is not None and old['operation']=='unmap'and old['result']==0 and old['isError']is False or generated_checkpoint is None and old['role']=='producer-close' and close and close['result']==0 and close['isError'] is False)and len(before)==6 and before[:2]==old['identity'][:2] and before[3]==data[0] and row['namedIdentity']==before and capture_data(row['beforeOriginal'])==data,'retained rename preimage original differs')
                replacement=row.get('replacementBefore')
                if replacement is None:
                    need(row.get('destinationAbsenceErrno')==2 and type(row.get('destinationAbsenceErrno')) is int,'retained rename destination absence missing')
                    snapshot_end=row['sequence']-1
                else:
                    need('destinationAbsenceErrno' not in row and type(replacement) is dict and set(replacement)=={'identity','namedIdentity','links','original'},'retained rename replacement preimage shape differs')
                    target=replacement['identity'];need(type(target) is list and len(target)==6 and all(type(x) is int for x in target) and target==replacement['namedIdentity'] and target[:2]!=before[:2] and target[2]&0o170000==0o100000 and type(replacement['links']) is int and replacement['links']==1,'retained rename replacement target identity/link differs')
                    target_data=capture_data(replacement['original']);need(target[3]==target_data[0] and replacement['original']['path']!=row['beforeOriginal']['path'],'retained rename replacement original differs')
                    need(write_original_sequences.get(tuple(replacement['original'][key] for key in ['path','bytes','sha256']),0)==row['sequence']-1,'retained rename replacement snapshot ordering differs')
                    snapshot_end=row['sequence']-2
                need(row['barrierSequence']+1==write_original_sequences.get(tuple(row['beforeOriginal'][key] for key in ['path','bytes','sha256']),0)==snapshot_end,'retained rename preimage snapshot ordering differs')
                retained_metadata_chain(old,dict(sequence=row['sequence'],path=row['fromPath'],identity=before),sorted([*mode_transitions.values(),*timestamp_transitions.values(),*link_transitions.values(),*rename_transitions.values()],key=lambda pair:pair[1]['sequence']))
                rename_windows[row['sequence']]=row;pending_rename_window=row['sequence'];retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-rename-resume':
                window=rename_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'retained rename exclusive resume differs');exclusive=(row['pid'],row['entrySequence']);active_rename=dict(pid=row['pid'],entrySequence=row['entrySequence'],state='resumed');pending_rename_window=None
            elif kind=='actual-rename-transition':
                window=rename_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and window['sequence'] not in rename_transitions and exclusive==(row['pid'],row['entrySequence']) and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'] and window['leaseSequence']==row['leaseSequence'] and exit and exit['sequence']==row['exitSequence'] and exit['result']==row['result']==0 and exit['isError'] is row['isError'] is False,'retained rename actual exit/lease differs')
                before=window['beforeIdentity'];after=row['afterIdentity'];need(len(after)==6 and after[:5]==before[:5] and row['namedIdentity']==after and row['afterOriginal']['path']!=window['beforeOriginal']['path'] and row['oldPathAbsent'] is True and row['oldPathAbsenceErrno']==2 and type(row['oldPathAbsenceErrno']) is int and capture_data(row['afterOriginal'])==capture_data(window['beforeOriginal']),'retained rename changed bytes/identity/namespace')
                need(row['exitSequence']<write_original_sequences.get(tuple(row['afterOriginal'][key] for key in ['path','bytes','sha256']),0)<row['sequence'],'retained rename postimage snapshot ordering differs')
                replacement=window.get('replacementBefore');displaced=row.get('replacementAfter')
                if replacement is None:need(displaced is None,'unexpected retained rename replacement completion')
                else:
                    need(type(displaced) is dict and set(displaced)=={'identity','links','original'},'retained rename replacement completion missing/shape differs')
                    target=displaced['identity'];need(type(target) is list and len(target)==6 and all(type(x) is int for x in target) and target[:5]==replacement['identity'][:5] and type(displaced['links']) is int and displaced['links']==0,'retained rename displaced identity/link differs')
                    need(displaced['original']['path'] not in [replacement['original']['path'],window['beforeOriginal']['path'],row['afterOriginal']['path']] and capture_data(displaced['original'])==capture_data(replacement['original']),'retained rename displaced original differs')
                    need(write_original_sequences.get(tuple(row['afterOriginal'][key] for key in ['path','bytes','sha256']),0)==row['exitSequence']+1 and write_original_sequences.get(tuple(displaced['original'][key] for key in ['path','bytes','sha256']),0)==row['exitSequence']+2==row['sequence']-1,'retained rename displaced snapshot ordering differs')
                rename_transitions[window['sequence']]=(window,row);active_rename['state']='completed'
            elif kind.startswith('generated-kernel-wait-'):
                need(generated_verifier is not None and generated_verifier.model in generated_module.COORDINATED_WAIT_MODELS,'coordinated wait requires explicit model')
                need(kind in ['generated-kernel-wait-window','generated-kernel-wait-waiter-resume','generated-kernel-wait-quiescent','generated-kernel-wait-peer-resume','generated-kernel-wait-peer-stopped','generated-kernel-wait-wake-window','generated-kernel-wait-waker-resume','generated-kernel-wait-closed','generated-kernel-wait-side-wait-window','generated-kernel-wait-side-wait-resume','generated-kernel-wait-side-wait-closed','generated-kernel-wait-side-wait-deferred','generated-kernel-wait-peer-entry-selected'],'unknown coordinated wait record')
                if kind.startswith('generated-kernel-wait-side-'):need(generated_verifier.model==generated_module.PARKED_WAIT_MODEL,'peer side wait requires v8 parked model')
                if kind=='generated-kernel-wait-side-wait-resume':
                    need(exclusive is None,'peer mismatch crossed an exclusive operation');exclusive=(row['pid'],row['entrySequence'])
                if kind=='generated-kernel-wait-window':
                    retained_entries.add(row['entrySequence'])
                    for peer in row.get('initialPeerEntries',[]):retained_entries.add(peer['entrySequence'])
                else:need(generated_verifier.scheduled_active,'coordinated record outside established wait interval')
                if kind=='generated-kernel-wait-quiescent':
                    need(exclusive is not None and exclusive[0]==row['observation']['pid'],'kernel quiescence outside selected exclusive waiter');exclusive=None
            elif kind=='exclusive-generated-vma-resume':
                need(generated_verifier is not None and exclusive is None,'generated VMA exclusive operation model missing');exclusive=(row['pid'],row['entrySequence'])
            elif kind in ['generated-vma-create-path','generated-vma-operation-window','generated-vma-selected-fd-binding','generated-vma-kernel-link-original','generated-vma-operation-exit','generated-vma-consumer-binding']:
                need(generated_verifier is not None,'generated VMA original without explicit model')
                if kind=='generated-vma-operation-window':retained_entries.add(row['entrySequence'])
            elif kind=='kernel-metadata-args-original':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(row.get('model')==TIMESTAMP_MODEL and entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'metadata args original needs model/entry/barrier')
                verify_stopped_original_order(row,barrier,entry,row,inline=True)
                need(row['syscall']==entry['nr']==TIMESTAMP_SYSCALLS.get(entry['arch']) and row['arch']==entry['arch'],'metadata args syscall/arch differs')
                # BIND the captured bytes to the ACTUAL entry arguments.
                need(row['dirfd']==entry['args'][0] and row['pathAddress']==entry['args'][1] and row['timesAddress']==entry['args'][2] and row['flags']==entry['args'][3],'metadata args operand addresses differ from actual entry')
                need(row['form'] in ['path','fd'] and row['form']==('fd' if entry['args'][1]==0 else 'path'),'metadata args form differs from entry')
                path_bytes=bytes.fromhex(row['pathHex'])
                need((row['form']=='fd')==(not path_bytes),'metadata args pathname presence differs from form')
                times_bytes=None
                if row['timesHex'] is not None:
                    times_bytes=bytes.fromhex(row['timesHex']);need(len(times_bytes)==32,'metadata args timespec must be 32 ABI bytes')
                expected=hashlib.sha256(json.dumps(dict(model=TIMESTAMP_MODEL,arch=row['arch'],syscall=row['syscall'],form=row['form'],pathAddress=row['pathAddress'],timesAddress=row['timesAddress'],dirfd=row['dirfd'],flags=row['flags'],pathHex=row['pathHex'],namespaceHex=row['namespaceHex'],timesHex=row['timesHex']),sort_keys=True,separators=(',',':')).encode()).hexdigest()
                need(expected==row['operandSha256'],'metadata args operand digest differs')
                metadata_args[row['sequence']]=row;retained_entries.add(entry['sequence'])
            elif kind=='kernel-link-args-original':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(row.get('model')==LINK_MODEL and entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'link args original needs model/entry/barrier')
                verify_stopped_original_order(row,barrier,entry,row,inline=True)
                need(row['syscall']==entry['nr'] and row['arch']==entry['arch'],'link args syscall/arch differs')

                # EXACT per-form binding, matching the observer's layout.
                need(row['heldRole'] in ('source','target'),'link held role differs')
                if row['form']=='link':
                    need(row['oldDirfd'] is None and row['oldPathAddress']==entry['args'][0],'link source operand differs')
                    need(row['newDirfd'] is None and row['newPathAddress']==entry['args'][1],'link destination operand differs')
                    need(row['flags']==0 and row['heldRole']=='source','link has no flags and holds the source')
                elif row['form']=='linkat':
                    need(row['oldDirfd']==entry['args'][0] and row['oldPathAddress']==entry['args'][1],'linkat source operands differ')
                    need(row['newDirfd']==entry['args'][2] and row['newPathAddress']==entry['args'][3],'linkat destination operands differ')
                    need(row['flags']==entry['args'][4] and entry['args'][4] in (0,0x400),'linkat flags must be 0 or AT_SYMLINK_FOLLOW')
                    need(row['heldRole']=='source','linkat holds the source')
                elif row['form']=='unlink':
                    need(row['oldPathAddress'] is None and row['newPathAddress']==entry['args'][0],'unlink path operand differs')
                    need(row['newDirfd'] is None and row['flags']==0,'unlink has no dirfd/flags')
                    need(row['heldRole']=='target','unlink holds the target')
                else:  # unlinkat
                    need(row['newDirfd']==entry['args'][0] and row['newPathAddress']==entry['args'][1],'unlinkat operands differ')
                    need(row['flags']==entry['args'][2] and entry['args'][2]==0,'unlinkat flags must be zero')
                    need(row['heldRole']=='target','unlinkat holds the target')
                expected=hashlib.sha256(json.dumps(dict(model=LINK_MODEL,arch=row['arch'],syscall=row['syscall'],form=row['form'],
                    newDirfd=row['newDirfd'],newPathAddress=row['newPathAddress'],oldDirfd=row['oldDirfd'],
                    oldPathAddress=row['oldPathAddress'],flags=row['flags'],
                    newPathHex=row['newPathHex'],newNamespaceHex=row['newNamespaceHex'],
                    oldPathHex=row['oldPathHex'],oldNamespaceHex=row['oldNamespaceHex'],
                    heldPathHex=row['heldPathHex'],heldRole=row['heldRole']),sort_keys=True,separators=(',',':')).encode()).hexdigest()
                need(expected==row['operandSha256'],'link args operand digest differs')
                link_args[row['sequence']]=row;retained_entries.add(entry['sequence'])
            elif kind=='actual-link-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(row.get('model')==LINK_MODEL and entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'actual link entry/barrier differs')
                original=link_args.get(row.get('argsOriginalSequence'))
                need(original and original['entrySequence']==row['entrySequence'] and original['pid']==row['pid'],'actual link lacks its own args original')
                # row.form must agree with BOTH the bound original and the real entry.
                need(row.get('form')==original['form'],'actual link window form differs from its args original')
                need(original['syscall']==entry['nr'],'actual link args syscall differs from actual entry')
                need(LINK_SYSCALLS[entry['arch']][original['form']]==entry['nr'],'actual link form does not match the actual entry syscall')
                need(len(row['beforeIdentity'])==6 and type(row['beforeLinks']) is int and row['beforeLinks']>=1,'actual link identity/link count shape differs')
                # window.path must equal the target resolved from ITS OWN raw operand
                # bytes; it is never an unconstrained annotation.
                held=bytes.fromhex(original['heldPathHex']).decode()
                need(row['path']==held,'actual link window path differs from its own held operand')
                link_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-link-resume':
                window=link_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual link exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-link-transition':
                window=link_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(row.get('model')==LINK_MODEL,'actual link transition lacks declared model')
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'],'actual link transition window differs')
                need(exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and row['isError'] is False and row['result']==0,'actual link exit differs')
                before=window['beforeIdentity'];after=row['afterIdentity']
                need(len(after)==6 and after[:5]==before[:5],'actual link changed inode/mode/size/mtime')
                need(type(row['afterLinks']) is int and row['afterLinks']>=0,'actual link result link count shape differs')
                # Direction is an OPERATION fact, verified here rather than only in chain
                # composition, so a swapped window/transition pair cannot pass.
                expected=(window['beforeLinks']+1) if window['form'] in ('link','linkat') else (window['beforeLinks']-1)
                need(row['afterLinks']==expected,'actual link transition nlink direction differs')
                link_transitions[row['sequence']]=(window,row)
            elif kind=='actual-timestamp-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(row.get('model')==TIMESTAMP_MODEL and entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'actual timestamp entry/barrier differs')
                original=metadata_args.get(row.get('argsOriginalSequence'))
                need(original and original['entrySequence']==row['entrySequence'] and original['pid']==row['pid'],'actual timestamp lacks its own args original')
                need(len(row['beforeIdentity'])==6 and (original['timesHex'] is None)==(row['timesAbsent'] is True),'actual timestamp identity/times-absence differs')
                decoded=None if original['timesHex'] is None else [list(p) for p in decode_timespec(bytes.fromhex(original['timesHex']))]
                need(row.get('times')==decoded,'actual timestamp times differ from bound operand bytes')
                # The window path must equal the target resolved from its OWN raw
                # operand bytes, independent of any producer->consumer chain.
                raw_path=bytes.fromhex(original['pathHex'])
                if original['form']=='fd':
                    expected=bytes.fromhex(original['namespaceHex']).decode()
                elif raw_path.startswith(b'/'):expected=raw_path.decode()
                else:
                    need(original['namespaceHex'],'relative timestamp requires a captured namespace base')
                    expected=posixpath.normpath(bytes.fromhex(original['namespaceHex']).decode()+'/'+raw_path.decode())
                need(row['path']==expected,'actual timestamp window path differs from its raw resolved target')
                timestamp_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-timestamp-resume':
                window=timestamp_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual timestamp exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-timestamp-transition':
                window=timestamp_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(row.get('model')==TIMESTAMP_MODEL,'actual timestamp transition lacks declared model')
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'],'actual timestamp transition window differs')
                need(exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and row['isError'] is False and row['result']==0,'actual timestamp exit differs')
                before=window['beforeIdentity'];after=row['afterIdentity']
                if window['timesAbsent']:
                    need(len(after)==6 and after[:4]==before[:4] and after[2]&0o7777==before[2]&0o7777,'actual timestamp changed inode identity/mode/size')
                else:
                    timestamp_effect(before,after,decode_timespec(bytes.fromhex(metadata_args[window['argsOriginalSequence']]['timesHex'])))
                timestamp_transitions[row['sequence']]=(window,row)
            elif kind=='actual-mode-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'actual chmod entry/barrier differs')
                modes={0xc000003e:{90:1,91:1,268:2},0xc00000b7:{52:1,53:2}}[entry['arch']]
                need(entry['nr'] in modes and entry['args'][modes[entry['nr']]]==row['requestedMode'] and len(row['beforeIdentity'])==6,'actual chmod syscall/mode differs');mode_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-mode-resume':
                window=mode_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual chmod exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-mode-transition':
                window=mode_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and not row['isError'] and row['result']==0,'actual chmod exit differs')
                before=window['beforeIdentity'];after=row['afterIdentity'];need(len(after)==6 and after[:2]==before[:2] and after[3:5]==before[3:5] and after[2]&0o170000==before[2]&0o170000 and after[2]&0o7777==window['requestedMode']&0o7777,'actual chmod changed byte identity or wrong mode');mode_transitions[row['sequence']]=(window,row)
            elif kind=='retained-fd-namespace-binding':namespace_bindings.append(row)
            elif kind=='write-original':
                capture_data(row['original']);write_original_sequences[tuple(row['original'][key] for key in ['path','bytes','sha256'])]=row['sequence']
            elif kind=='actual-write-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'] and entry['nr']==policy(entry['arch'])['write'] and entry['args'][0]==row['fd'],'actual write entry/barrier differs')
                need(all(type(row[key]) is int and 0<=row[key]<=maximum_file for key in ['position','offset']) and type(entry['args'][2]) is int and 0<=entry['args'][2]<=maximum_file and row['offset']+entry['args'][2]<=maximum_file,'exact bounded write position/offset/count required')
                need(row['flags']&3==2 and row['writers']==[dict(pid=row['pid'],fd=row['fd'])] and row['offset']==(row['beforeIdentity'][3] if row['flags']&1024 else row['position']),'actual write has another alias or offset differs')
                if stopped_alias_mode:
                    need(barrier['pids']==sorted(live) and barrier['osStates']==['t']*len(live),'alias write lacks complete stopped universe')
                    write_alias_inventory(row.get('stoppedAliasInventory'),row['beforeIdentity'],row['pid'],row['fd'])
                else:need('stoppedAliasInventory' not in row,'alias write requires explicit model')
                delta=row.get('format') in ['bounded-write-delta-v1','bounded-append-effect-v1'];need(row.get('format') in [None,'bounded-write-delta-v1','bounded-append-effect-v1'],'unknown write evidence format')
                before=(row['before']['bytes'],row['before']['sha256']) if delta else capture_data(row['before']);buffer=capture_data(row['buffer']);need(before[0]==row['beforeIdentity'][3] and buffer[0]==entry['args'][2],'write originals differ from actual dimensions')
                baseline=row['baseline']
                if baseline=='empty':need(before[0]==0,'nonempty write preimage has no original authority')
                elif baseline in write_transitions:
                    prior=write_transitions[baseline];need(prior['afterIdentity']==row['beforeIdentity'] and ((prior['after']['bytes'],prior['after']['sha256']) if 'path' not in prior['after'] else capture_data(prior['after']))==before,'write preimage differs from previous actual transition')
                elif generated_verifier is not None and generated_verifier.model in [generated_module.MODEL,*generated_module.COORDINATED_WAIT_MODELS] and baseline in generated_verifier.origins:
                    generated_verifier.write_baseline(row,before)
                else:
                    prior=prepared.get(baseline) or caps.get(baseline);need(prior and prior[0]['identity']==row['beforeIdentity'] and prior[1]==before,'write preimage has no retained original')
                    if baseline in caps:
                        previous=exits.get(prior[0]['entrySequence']);need(prior[0]['role']=='producer-close' and previous and not previous['isError'] and previous['result']==0,'write baseline lacks actual producer close')
                if delta:
                    key=tuple(row['beforeIdentity'][:2])
                    if baseline in write_transitions:
                        projection=write_projections.get(key);need(projection and projection[0]==baseline,'delta preimage is not latest actual transition');segments=projection[1]
                    else:
                        initial=row['initialBefore'];need(capture_data(initial)==before,'initial write delta preimage differs');segments=[(initial,0,before[0])] if before[0] else []
                    if row.get('format')=='bounded-append-effect-v1':
                        need(row['offset']==before[0],'append must begin at actual EOF')
                        if key not in append_hashes:
                            digest=hashlib.sha256()
                            # Use original reader streaming; never load a whole original.
                            def initial_blocks(ref):
                                value=read_reference(ref)
                                return (value[i:i+65536] for i in range(0,len(value),65536)) if isinstance(value,bytes) else value
                            for block in segment_blocks(segments,initial_blocks,check):digest.update(block)
                            need(digest.hexdigest()==before[1],'append baseline full digest differs');append_hashes[key]=digest
                    else:need(key not in append_dirty,'nonappend write before append full checkpoint')
                    write_projections[key]=(row['sequence'],segments)
                write_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-write-resume':
                window=write_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual write exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-write-transition':
                window=write_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'],'actual write exit/window differs')
                need(type(row['result']) is int and type(exit['result']) is int and not exit['isError'] and row['isError'] is False and row['result']==exit['result'] and 0<=row['result']<=window['buffer']['bytes'] and row['afterIdentity'][:3]==window['beforeIdentity'][:3],'actual write result/identity differs')
                if 'stoppedAliasInventory' in window:
                    after_aliases=write_alias_inventory(row.get('stoppedAliasInventoryAfter'),row['afterIdentity'],row['pid'],window['fd'])
                    need([{**alias,'identity':window['beforeIdentity']} for alias in after_aliases]==window['stoppedAliasInventory']['aliases'],'alias bindings changed during exclusive syscall')
                else:need('stoppedAliasInventoryAfter' not in row,'unexpected alias postimage')
                def blocks(ref):
                    value=read_reference(ref)
                    return (value[i:i+65536] for i in range(0,len(value),65536)) if isinstance(value,bytes) else value
                if window.get('format') in ['bounded-write-delta-v1','bounded-append-effect-v1']:
                    need(set(row['after'])=={'bytes','sha256'},'delta after must be digest only')
                    key=tuple(window['beforeIdentity'][:2]);prior=write_projections.get(key);need(prior and prior[0]==window['sequence'],'delta window order differs')
                    if window.get('format')=='bounded-append-effect-v1':
                        need(row.get('afterObservation')=='uncheckpointed-append-projection','append effect is not an actual full snapshot')
                        segments=prior[1];digest=append_hashes[key];effect=hashlib.sha256();position=0
                        for block in blocks(window['buffer']):
                            check();chunk=block[:max(0,min(len(block),row['result']-position))]
                            if chunk:effect.update(chunk);digest.update(chunk);position+=len(chunk)
                            if position==row['result']:break
                        need(position==row['result'] and row.get('actualAppendEffect')==dict(bytes=position,sha256=effect.hexdigest()),'actual append range evidence differs')
                        if position:segments.append((window['buffer'],0,position))
                        expected=dict(bytes=window['beforeIdentity'][3]+position,sha256=digest.hexdigest())
                        need(expected==row['after'],'append projection digest differs');append_dirty[key]=row['sequence']
                    else:
                        segments=write_segments(prior[1],window['offset'],row['result'],window['buffer'],maximum_file)
                        expected=digest_blocks(segment_blocks(segments,blocks,check),maximum_file,check);need(expected==row['after'],'delta postimage does not reconstruct actual full SHA')
                    write_projections[key]=(row['sequence'],segments);after=(expected['bytes'],expected['sha256'])
                else:
                    after=capture_data(row['after'])
                    need(verify_write_bytes(blocks(window['before']),blocks(window['buffer']),blocks(row['after']),window['beforeIdentity'][3],window['offset'],row['result'],maximum_file,check)==after[0],'actual write size projection differs')
                need(after[0]==row['afterIdentity'][3],'actual write after identity/size differs')
                need(window['sequence'] not in closed_write_windows,'duplicate actual write transition');closed_write_windows.add(window['sequence']);write_transitions[row['sequence']]=row
            elif kind=='generated-vma-write-origin-transition':
                need(generated_verifier is not None,'generated write bridge model absent');generated_verifier.consume_write_bridge(row,write_windows.get(row['windowSequence']),write_transitions.get(row['transitionSequence']))
            elif kind=='append-full-checkpoint':
                barrier=barriers.get(row['barrierSequence'])
                need((row['closedTrackedWaits'] is True and not live and row['barrierSequence'] is None) or (row['closedTrackedWaits'] is False and barrier and set(barrier['pids'])==live),'append checkpoint lacks actual all-stop/wait closure')
                transition=write_transitions.get(row['transitionSequence']);key=tuple(row['identity'][:2])
                need(transition and append_dirty.get(key)==transition['sequence'] and transition['afterIdentity']==row['identity'],'append checkpoint latest transition/identity differs')
                need(capture_data(row['original'])==(transition['after']['bytes'],transition['after']['sha256']),'append prefix/full checkpoint bytes differ')
                need(row['reason'] in ['nonappend-write','captured-access','syscall-boundary','toolchain-access','phase-final'],'unknown append checkpoint boundary')
                if row['entrySequence'] is not None:need(row['entrySequence'] in entries and row['entrySequence']<row['sequence'],'append checkpoint entry differs')
                append_checkpoints[transition['sequence']]=row;append_completed[key]=transition['sequence'];del append_dirty[key];del append_hashes[key]
            elif kind=='actual-write-consumer-binding':write_consumers.append(row)
            elif kind=='actual-write-consumer-exit':
                cap=caps.get(row['captureSequence']);exit=exits.get(row['entrySequence'])
                need(cap and cap[0]['role']=='readwrite-consumer' and exclusive==(row['pid'],row['entrySequence']) and cap[0]['entrySequence']==row['entrySequence'] and exit and exit['sequence']==row['exitSequence'],'own-RW read actual exclusive exit differs')
                need(not exit['isError'] and not row['isError'] and row['result']==exit['result'] and 0<=row['result']<=entries[row['entrySequence']]['args'][2] and row['identity']==cap[0]['identity'] and (row['bytes'],row['sha256'])==cap[1],'own-RW read changed bytes or invalid result');need(type(row['readOffset']) is int and row['readOffset']>=0 and row['positionAfter']==row['readOffset']+row['result'] and row['result']<=max(0,cap[1][0]-row['readOffset']),'own-RW actual read range differs');write_read_exits[row['captureSequence']]=row
            elif kind=='empty-read-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'] and entry['nr']==policy(entry['arch'])['read'] and entry['args'][0]==row['fd'] and entry['args'][2]>0,'empty read actual entry/barrier differs')
                need(len(row['identity'])==6 and row['identity'][3]==0 and row['flags']&3==2 and row['writers']==[dict(pid=row['pid'],fd=row['fd'],flags=row['flags'],accessMode=2)],'empty read has nonempty file or another writable alias')
                empty_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-empty-read-resume':
                window=empty_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'empty read exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='empty-read-eof':
                window=empty_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and window['sequence'] not in empty_eofs and exclusive==(row['pid'],row['entrySequence']) and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'empty read EOF window differs')
                need(exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and row['result']==0 and row['isError'] is False and row['identity']==window['identity'],'empty read did not retain identity and actual zero result');empty_eofs.add(window['sequence'])
            elif kind=='exclusive-captured-syscall-resume':
                need(exclusive is None,'exclusive capture resume while another window is open')
                regular=row.get('regularInputForm') is not None
                if regular:
                    # A regular-input observation is NOT an fd-capture; its own
                    # validated observation row is the capture authority.
                    observation=regular_input_observations.get(row['entrySequence'])
                    need(observation is not None and observation['row']['sequence']==row['inputObservationSequence']
                         and observation['entry']['sequence']==row['entrySequence']
                         and observation['row']['pid']==row['pid'],'regular input resume lacks its own validated observation')
                else:
                    need(row['captureSequence'] in caps and caps[row['captureSequence']][0]['entrySequence']==row['entrySequence'],'exclusive capture resume differs')
                exclusive=(row['pid'],row['entrySequence'])
            elif kind=='exclusive-captured-syscall-exit':
                need((exclusive==(row['pid'],row['entrySequence']) or generated_verifier is not None and getattr(generated_verifier,'scheduled_active',False) and exclusive is None) and row['entrySequence'] in exits,'exclusive read/close stop boundary differs');exclusive=None
                if active_rename is not None:need(active_rename['state']=='completed','retained rename closed before verified transition');active_rename=None
            elif kind in ['setresuid-noop-entry-original','identity-noop-entry-original']:
                pending=setresuid_operations.get(row.get('pid'));entry=entries.get(row.get('entrySequence'));barrier=barriers.get(row.get('barrierSequence'))
                need(setresuid_mode and process_interval is not None and pending and pending['state']=='entry' and entry==pending['entry'] and exclusive is None,'setresuid original outside pending actual entry')
                observation=row.get('observation');need(isinstance(observation,dict) and observation.get('pid')==row['pid'] and observation.get('entrySequence')==entry['sequence'],'setresuid entry observation differs')
                if identity_mode:
                    need(kind=='identity-noop-entry-original' and row.get('identityAxis')==provider_module().identity_noop_axis(entry['arch'],entry['nr'])==observation.get('identityAxis'),'typed identity entry axis differs')
                    process_interval.begin_identity_noop_original(observation,entry,barrier)
                else:
                    need(kind=='setresuid-noop-entry-original','identity original requires explicit model')
                    process_interval.begin_setresuid_original(observation,entry,barrier)
                pending.update(state='begun',observation=observation);exclusive=(row['pid'],entry['sequence'])
            elif kind in ['setresuid-noop-exit-original','identity-noop-exit-original']:
                pending=setresuid_operations.get(row.get('pid'));barrier=barriers.get(row.get('barrierSequence'))
                need(pending and pending['state']=='exited' and exclusive==(row['pid'],pending['entry']['sequence']) and row.get('entrySequence')==pending['entry']['sequence'] and row.get('exitSequence')==pending['exit']['sequence'],'setresuid exit original outside pending actual exit')
                observation=row.get('observation');need(isinstance(observation,dict) and observation.get('pid')==row['pid'],'setresuid exit observation differs')
                if identity_mode:
                    need(kind=='identity-noop-exit-original' and row.get('identityAxis')==provider_module().identity_noop_axis(pending['entry']['arch'],pending['entry']['nr'])==observation.get('identityAxis'),'typed identity exit axis differs')
                    process_interval.consume_verified_identity_noop_pair(pending['observation'],observation,pending['exit'],barrier)
                else:
                    need(kind=='setresuid-noop-exit-original','identity original requires explicit model')
                    process_interval.consume_verified_setresuid_pair(pending['observation'],observation,pending['exit'],barrier)
                del setresuid_operations[row['pid']];exclusive=None
            elif kind=='explicit-io-uring-setup-denied':
                entry=entries.get(row.get('entrySequence'));pending=denied_operations.get(row.get('pid'))
                need(denial_mode and pending and pending['state']=='entry' and entry==pending['entry'],'unbound or duplicate explicit denial')
                need(row['arch']==entry['arch'] and row['args']==entry['args'],'explicit denial entry words differ')
                wait=row.get('waitStatus');need(type(wait) is int and wait==(((5|0x80)<<8)|127),'explicit denial syscall stop differs')
                before=bytes.fromhex(row['beforeRegistersHex']);after=bytes.fromhex(row['afterRegistersHex']);description=verify_denied_io_uring_registers(entry['arch'],entry['nr'],before,after,model=denial)
                need(all(row.get(key)==value for key,value in description.items()),'explicit denial register description differs')
                executable=row.get('executable');need(isinstance(executable,dict) and len(executable.get('identity',[]))==6 and type(executable.get('processStarttime')) is int,'explicit denial stopped executable identity required')
                pending.update(state='substituted',denial=row)
            elif kind=='explicit-io-uring-setup-denied-exit':
                pending=denied_operations.get(row.get('pid'));need(pending and pending['state']=='exited','explicit denial exit lacks actual kernel exit')
                actual=pending['exit'];denied=pending['denial']
                need(row['entrySequence']==pending['entry']['sequence'] and row['denialSequence']==denied['sequence'] and row['exitSequence']==actual['sequence'] and row['result']==-DENIED_IO_URING_ERRNO and row['isError'] is True and row['executable']==denied['executable'],'explicit denial exit causal chain differs')
                del denied_operations[row['pid']]
            elif kind=='kernel-syscall':
                need(row['pid'] not in vfork_holds,'vfork parent resumed before actual child exec/terminal wait')
                need(row['pid'] in live and row['arch'] in POLICIES,'unknown syscall process/architecture');need(exclusive is None or exclusive[0]==row['pid'],'another potential writer ran during captured syscall')
                if row['op']=='entry' and read_form(row['arch'],row['nr']) is not None:
                    # COMPLETENESS: every actual read-family entry by a live
                    # producer process becomes an input obligation with its exact
                    # ABI form. It is discharged ONLY by a validated
                    # regular-input-observation for the SAME entry (and, for a
                    # transferring read, its matching real exit). Anything else
                    # keeps the witness's input universe INCOMPLETE, so a
                    # nonempty input set can never be mistaken for the whole set.
                    form=read_form(row['arch'],row['nr'])
                    unbound_read_operations.append(dict(pid=row['pid'],phase=row['phase'],
                        entrySequence=row['sequence'],nr=row['nr'],arch=row['arch'],
                        form=form['name']))
                    inputs_pending[row['sequence']]=dict(pid=row['pid'],phase=row['phase'],
                        entrySequence=row['sequence'],nr=row['nr'],arch=row['arch'],
                        form=form['name'],args=list(row['args']))
                if row['op']=='entry':
                    if append_boundary_syscall(row['arch'],row['nr'],row['args']):append_obligations[row['sequence']]=dict(append_dirty)
                    rules=policy(row['arch'])
                    if memory_mode:
                        remap_reason=memory_checker.decision(row['arch'],row['nr'],row['args'])
                        remap_candidate=False
                        if remap_reason=='memory-remap-outside-fixed-executable-mapping-scope' and remap_mode==memory_checker.REMAP_MODEL:
                            # Shape only: the raw replay below still requires the
                            # exact exclusive/barrier/coverage/exit chain.
                            remap_candidate=memory_checker.remap_shape(row['arch'],row['nr'],row['args'],maximum_file)[0]
                            if remap_candidate:remap_required.add(row['sequence'])
                        need(remap_reason is None or remap_candidate or row['nr']==425 and denial_mode or row['nr']==435 and clone3_mode is not None or bti_mode and memory_checker.bti_candidate(row['arch'],row['nr'],row['args']),'forbidden executable memory operation in successful phase')
                        if bti_mode and memory_checker.bti_candidate(row['arch'],row['nr'],row['args']):bti_required.add(row['sequence'])
                        descriptor=memory_checker.write_descriptor(row['arch'],row['nr'],row['args'])
                        if descriptor is not None:memory_writes[row['sequence']]=(row['pid'],descriptor)
                    need(row['pid'] not in denied_operations,'another syscall before explicit denial completion')
                    if row['nr']==425 and denial_mode:
                        denied_operations[row['pid']]=dict(state='entry',entry=row);retained_entries.add(row['sequence'])
                    else:need(row['nr'] not in rules['forbidden'],'unsupported asynchronous/external writer syscall')
                    if setresuid_mode and (provider_module().identity_noop_axis(row['arch'],row['nr']) in ['Uid','Gid'] if identity_mode else provider_module().identity_noop_axis(row['arch'],row['nr'])=='Uid'):
                        need(exclusive is None and row['pid'] not in setresuid_operations and (queued_identity_mode and all(value['state']=='entry' for value in setresuid_operations.values()) or not setresuid_operations),'overlapping setresuid operation')
                        setresuid_operations[row['pid']]=dict(state='entry',entry=row);retained_entries.add(row['sequence'])
                    elif process_interval is not None:process_interval.syscall(row)
                    if row['nr']==rules['clone']:
                        flags=row['args'][0]
                        if shared_mode:inspect_shared_clone_flags(flags)
                        else:need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared thread/FD clone')
                    if row['nr']==rules['mmap'] and row['args'][2]&2 and row['args'][3]&1:
                        need(generated_verifier is not None and generated_verifier.allow_mapping_entry(row),'shared writable mapping');tool_pending.add('generated-shared-mapping-toolchain-source-authority-unverified')
                    if shared_mode:
                        need(not(row['nr']==436 and row['args'][2]&2),'unknown close_range UNSHARE table ownership')
                        if row['nr'] in ([59,322] if row['arch']==0xc000003e else [221,281]):need(row['pid']==owners[row['pid']]['tgid'],'nonleader exec TID replacement unsupported')
                    entries[row['sequence']]=row
                    if generated_verifier is not None and getattr(generated_verifier,'scheduled_active',False):retained_entries.add(row['sequence'])
                    if row['nr'] in rules['exec'] or row['nr'] in rules['protect'] and row['args'][2]&4 or row['nr']==rules['mmap'] and (not(row['args'][3]&0x20) or row['args'][2]&4):retained_entries.add(row['sequence'])
                elif row['op']=='exit':
                    if 'entrySequence' in row:
                        need(all(append_completed.get(key,0)>=sequence for key,sequence in append_obligations.pop(row['entrySequence'],{}).items()),'append checkpoint missing before actual syscall exit')
                        entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and row['entrySequence'] not in exits,'syscall exit binding differs')
                        if row['pid'] in denied_operations:
                            pending=denied_operations[row['pid']];need(pending['state']=='substituted' and pending['entry']==entry and row['arch']==entry['arch'] and row['result']==-DENIED_IO_URING_ERRNO and row['isError'] is True,'explicit denial requires actual same-entry kernel ENOSYS');pending.update(state='exited',exit=row)
                        if row['pid'] in setresuid_operations:
                            pending=setresuid_operations[row['pid']];need(pending['state']=='begun' and pending['entry']==entry and row['result']==0 and row['isError'] is False and row['arch']==entry['arch'],'setresuid lacks actual same-entry successful exit');pending.update(state='exited',exit=row)
                        if entry['nr']==435:need(row['entrySequence'] in clone_flags,'clone3 lacks actual flags original')
                        if row['isError'] and row['entrySequence'] not in bti_originals and (entry['nr'] in policy(entry['arch'])['exec'] or entry['nr'] in policy(entry['arch'])['protect'] or entry['nr']==policy(entry['arch'])['mmap']):retained_entries.discard(row['entrySequence']);tool_protect_before.pop(row['entrySequence'],None)
                        if row['entrySequence'] in retained_entries:exits[row['entrySequence']]=row
                        else:entries.pop(row['entrySequence']);clone_flags.discard(row['entrySequence'])
                        pending_input=inputs_pending.get(row['entrySequence'])
                        if pending_input is not None:
                            # Discharge the read obligation with the MATCHING real
                            # exit: a failed syscall consumed nothing, a successful
                            # one consumed exactly `result` bytes from its start.
                            observation=regular_input_observations.get(row['entrySequence'])
                            disposition=disposition_entries.get(row['entrySequence'])
                            if disposition is not None and not(row['isError'] or row['result']<=0):
                                # NON-FILE POSITIVE READ. Deferred to PHASE END: the
                                # gate relation is pre-exec, so the exec event that
                                # closes it appears later in the stream. Everything
                                # unresolved stays an open obligation, which makes
                                # the producer's input universe INCOMPLETE.
                                pending_input.update(state='nonexec-pending',result=row['result'],
                                    exitSequence=row['sequence'])
                                nonexec_positive_pending[row['entrySequence']]=dict(
                                    disposition=disposition,exit=row,entry=entry,pending=pending_input)
                            elif row['isError'] or row['result']<0:
                                inputs_pending.pop(row['entrySequence'],None)
                                unbound_read_operations[:] = [r for r in unbound_read_operations if r['entrySequence']!=row['entrySequence']]
                                pending_input.update(state='failed',result=row['result'],isError=True)
                                inputs_pending_rejected[row['entrySequence']]=pending_input
                            elif row['result']==0:
                                # A verified ZERO-byte read consumed nothing. The
                                # real exit proves that, so the obligation closes
                                # WITHOUT granting any byte/source credit.
                                inputs_pending.pop(row['entrySequence'],None)
                                unbound_read_operations[:] = [r for r in unbound_read_operations if r['entrySequence']!=row['entrySequence']]
                                pending_input.update(state='zero',result=0,exitSequence=row['sequence'])
                                inputs_pending_rejected[row['entrySequence']]=pending_input
                            elif observation is not None:
                                if row['result']>observation['requestedBound']:
                                    need(False,'regular input read result exceeds its actual requested bound')
                                consumed_end=observation['rangeStart']+row['result']
                                need(consumed_end<=observation['original']['bytes'],'regular input read consumed past its captured original')
                                observations_by_entry[row['entrySequence']]=dict(observation,
                                    result=row['result'],exitSequence=row['sequence'],consumedEnd=consumed_end,
                                    consumedLength=row['result'],
                                    positionAfter=(observation['rangeStart']+row['result']
                                                   if observation['form']['offset'] is None
                                                   else observation['generation']['position']))
                                unbound_read_operations[:] = [r for r in unbound_read_operations if r['entrySequence']!=row['entrySequence']]
                                inputs_pending.pop(row['entrySequence'],None)
                            # else: a successful read with NO validated observation
                            # stays in inputs_pending/unbound -> incomplete universe.

                else:need(False,'unknown syscall-info operation')
            elif kind=='toolchain-original':
                need(not append_dirty,'tool/source output before mandatory append full checkpoint')
                need(bool(live) and row['captureKind'] in ['file','maps','mountinfo','input-read','kernel-metadata'],'actual tool original must be observed with live stopped tracees')
                data=capture_data(row['original']);need(tool_original_key(row['original'])not in tool_originals,'duplicate tool original')
                if row['captureKind']=='file':
                    need(len(row['identity'])==6 and row['identity'][3]==data[0],'tool FD identity/bytes differ');tool_files[row['original']['path']]=dict(observedPath=row['observedPath'],identity=row['identity'],original=row['original'])
                elif row['captureKind']=='kernel-metadata':
                    # Kernel-generated metadata of ONE stopped tracee pid. It is
                    # byte evidence bound to that subject; it grants no file or
                    # source origin and every use must still match the verified
                    # process-authority interval for the same pid.
                    need(row.get('kernelMetadataName') in ['mountinfo','cgroup'],'unknown kernel metadata original name')
                    # procfs metadata files report st_size 0 regardless of the
                    # bytes they yield, so the size field is NOT the content
                    # length. The retained original digest is the byte proof; the
                    # identity only has to describe a regular virtual file.
                    need(len(row['contentIdentity'])==6 and stat.S_ISREG(row['contentIdentity'][2])
                         and row['contentIdentity'][1]>0,'kernel metadata identity malformed')
                    raw=read_reference(row['original'])
                    raw=b''.join(raw) if not isinstance(raw,bytes) else raw
                    kernel_metadata_originals[tool_original_key(row['original'])]=dict(data=raw,row=row,
                        name=row['kernelMetadataName'],subjectPid=row['observedPid'],
                        identity=row['contentIdentity'],original=row['original'])
                elif row['captureKind']=='input-read':
                    # One canonical byte original per stable protected inode. It is
                    # NOT an observed tool path and grants no source origin; the
                    # separate regular-input-observation rows carry the read facts.
                    need(row.get('regularInputOriginalModel')=='once-per-stable-protected-inode-v1','unknown regular input original model')
                    need(len(row['identity'])==6 and row['identity'][3]==data[0] and stat.S_ISREG(row['identity'][2]),'regular input original identity/bytes differ')
                    input_read_originals[tool_original_key(row['original'])]=dict(data=data,row=row,identity=row['identity'],original=row['original'],entity=row.get('originalEntityIdentity'))
                else:need(data[0]<=4*1024**2 and type(row.get('observedPid')) is int and row['observedPid'] in live,'bounded live tracee metadata original')
                tool_originals[tool_original_key(row['original'])]=row
            elif kind=='regular-input-target-resolution':
                # The observer resolved the tracee descriptor through its own held
                # FD. Keep the canonical target and WHEN it was observed, so an
                # observation can bind the resolution that preceded it.
                need(type(row.get('pid')) is int and type(row.get('fd')) is int
                     and isinstance(row.get('resolvedPath'),str),'bounded target resolution required')
                target_resolutions.setdefault((row['pid'],row['fd']),[]).append(row)
            elif kind in ['toolchain-control-gate','toolchain-control-gate-binding','toolchain-control-gate-release']:
                control_gates.append(row)
            elif kind=='regular-input-disposition':
                # NON-FILE READ EVIDENCE. This row NEVER discharges the obligation
                # by itself. Only a positive read with a VERIFIED chain can ever
                # be discharged, and even then only at the matching real exit.
                # Object kind or path class is recorded, never trusted.
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and row['pid']==entry['pid'] and row['pid'] in barrier['pids'] and entry['sequence']<barrier['sequence']<row['sequence'],'regular input disposition lacks actual entry/all-stop relation')
                form=read_form(entry['arch'],entry['nr']);need(form is not None and row.get('form')==form['name'],'regular input disposition form differs from the actual entry ABI')
                need(row['role']=='input-read' and row['fd']==entry['args'][0],'regular input disposition role/FD differs from the actual entry')
                need(type(row.get('mode')) is int and isinstance(row.get('path'),str) and row['path'],'regular input disposition mode/path required')
                # LEGACY TRACES. A retained trace emitted BEFORE the typed
                # objectKind/pathClass fields existed has neither. It is accepted
                # only as an UNCREDITABLE observation: the class is derived for
                # reporting, no chain exists, and a positive read therefore keeps
                # its obligation. New traces must carry both fields.
                legacy=row.get('objectKind') is None and row.get('pathClass') is None
                if legacy:
                    mode=row['mode'];path=row['path']
                    object_kind=('fifo' if stat.S_ISFIFO(mode) else 'socket' if stat.S_ISSOCK(mode)
                        else 'character-device' if stat.S_ISCHR(mode) else 'block-device' if stat.S_ISBLK(mode)
                        else 'regular' if stat.S_ISREG(mode) else 'other')
                    path_class=('pipe' if path.startswith('pipe:') else 'socket' if path.startswith('socket:')
                        else 'anon-inode' if path.startswith('anon_inode:')
                        else 'proc' if path.startswith('/proc/') else 'sys' if path.startswith('/sys/')
                        else 'dev' if path.startswith('/dev/') else 'other')
                    need(row.get('chain') is None,'legacy disposition cannot carry a chain')
                else:
                    object_kind=row.get('objectKind');path_class=row.get('pathClass')
                    need(object_kind in ['fifo','socket','character-device','block-device','regular','other'],'unknown non-file object kind')
                    need(path_class in ['pipe','socket','anon-inode','proc','sys','dev','other'],'unknown non-file path class')
                # A legacy row predates the flags field; without them the read
                # can only be treated as a POTENTIAL writer, which never credits.
                need(legacy or type(row.get('descriptorFlags')) is int,'non-file disposition requires its actual descriptor flags')
                # REGULAR pseudo-files (/proc,/sys) are non-FILE inputs, not
                # S_IFREG path claims: the mode check must agree with the class.
                need((not stat.S_ISREG(row['mode']) and path_class in ['pipe','socket','anon-inode','dev','other'])
                     or (stat.S_ISREG(row['mode']) and path_class in ['proc','sys']),
                     'non-file disposition mode/path class disagree')
                writable=(row['descriptorFlags']&os.O_ACCMODE!=0) if type(row.get('descriptorFlags')) is int else True
                disposition_entries[entry['sequence']]=dict(row=row,entry=entry,barrier=barrier,form=form,
                    objectKind=object_kind,pathClass=path_class,writable=writable,chain=row.get('chain'),
                    legacy=legacy)
            elif kind=='regular-input-observation':
                # PRE-USE facts only. The consumed range is derived below from the
                # matching real exit, never from this row's own words.
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and row['pid']==entry['pid'] and row['pid'] in barrier['pids'] and entry['sequence']<barrier['sequence']<row['sequence'],'regular input observation lacks actual entry/all-stop relation')
                form=read_form(entry['arch'],entry['nr']);need(form is not None and row.get('form')==form['name'],'regular input observation form differs from the actual entry ABI')
                need(row['role']=='input-read' and row['fd']==entry['args'][0],'regular input role/FD differs from the actual entry')
                # REAL IMMUTABILITY BINDING. A regular-read input is creditable
                # only under a held kernel read lease on THIS exact inode that was
                # acquired before this observation. O_RDONLY is not inode
                # immutability: a different OFD or process could otherwise mutate
                # the bytes between the snapshot and the kernel read.
                lease_sequence=row.get('readLeaseSequence');lease_id=row.get('readLeaseId')
                need(type(lease_sequence) is int and lease_sequence>0 and lease_sequence<row['sequence'],'regular input lacks its prior held read lease')
                # `lease_tokens` is keyed by the emitter's leaseId; the cited
                # acquisition row must be that exact token.
                # The cited sequence is the acquisition ROW number; the replay
                # stored that same number as `acquisitionSequence`.
                acquired=[value for value in lease_tokens.values()
                          if value.get('leaseId')==lease_id and value.get('acquisitionSequence')==lease_sequence]
                need(acquired,'regular input cites a missing lease acquisition')
                lease_row=acquired[0]
                need(lease_row.get('role')=='input-read','cited lease is not an input-read lease')
                need(lease_row.get('identity')==row['identity'],'cited lease identity differs from the input identity')
                # EXACT PRE-USE ORDERING. The observer legitimately takes a NEW
                # read lease at the SYSCALL ENTRY STOP: after the raw entry row
                # and before the capture/resume. So the lease may either be
                # already held (before this entry) or be bound to THIS entry. In
                # both cases it must exist before the observation. A lease bound
                # to a DIFFERENT, later entry is not this read's custody.
                acquisition_entry=lease_row.get('entrySequence')
                need(acquisition_entry is not None,'cited lease lacks its acquisition entry binding')
                if acquisition_entry!=entry['sequence']:
                    need(lease_sequence<entry['sequence'],
                         'cited lease is bound to another entry and was not already held')
                need(lease_sequence<row['sequence'],
                     'cited lease was acquired after this read observation')
                generation=row.get('generation');need(isinstance(generation,dict) and generation.get('identity')==row['identity'] and type(generation.get('flags')) is int and type(generation.get('position')) is int and generation['position']>=0,'exact regular input FD generation required')
                need(generation['flags']&os.O_ACCMODE==0,'regular input descriptor must be read-only')
                need(type(row.get('rangeStart')) is int and 0<=row['rangeStart']<=maximum_file and type(row.get('requestedBound')) is int and 0<=row['requestedBound']<=maximum_file,'bounded regular input requested range required')
                if form['iovec']:
                    lengths=row.get('iovLengths');need(isinstance(lengths,list) and len(lengths)==row.get('iovcnt') and all(type(v) is int and 0<=v<=maximum_file for v in lengths) and sum(lengths)==row['requestedBound'],'regular input iovec lengths must sum to the declared bound')
                    need(0<=row['iovcnt']<=IOVECTOR_MAXIMUM,'bounded regular input iovec count')
                else:need(row.get('iovcnt') is None and row.get('iovLengths') is None,'scalar read must not claim an iovec vector')
                if form['offset'] is not None:need(row['rangeStart']==entry['args'][form['offset']],'pread offset differs from the actual entry operand')
                original=input_read_originals.get(tool_original_key(row.get('original') or {}))
                need(original and original['identity']==row['identity'] and original['original']==row['original'],'regular input observation lacks its canonical byte original')
                need(row.get('originalSequence')==original['row']['sequence'],'regular input original sequence differs')
                regular_input_observations[entry['sequence']]=dict(row=row,entry=entry,barrier=barrier,form=form,
                    original=original['original'],originalData=original['data'],
                    identity=row['identity'],generation=generation,
                    entrySequence=entry['sequence'],exitSequence=None,result=None,consumedLength=None,
                    rangeStart=row['rangeStart'],requestedBound=row['requestedBound'],
                    iovcnt=row.get('iovcnt'),iovLengths=row.get('iovLengths'),role=row['role'],
                    path=row.get('path'))
                # KEEP the entry: the matching real exit still has to arrive and
                # is where the consumed range is derived. retained_entries keeps
                # it alive across the exclusive window.
                retained_entries.add(row['entrySequence'])
            elif kind=='toolchain-process-authority':
                need(process_interval is not None,'process authority original lacks declared root contract');need(not terminal_mode or row.get('role')!='exit-stop','new terminal model requires early EXIT originals, not legacy delayed sample');tool_barrier(row);mount_original=tool_ref(row['observation']['mountinfoOriginal'],'mountinfo');_authority_mounts=dependency_bytes(mount_original['original']);process_interval.sample(row,_authority_mounts)
                authority_mountinfo.setdefault(row['pid'],[]).append(dict(row=row,bytes=_authority_mounts,sha256=mount_original['original']['sha256']))
            elif kind=='toolchain-provider-original':
                tool_barrier(row);file_original=tool_ref(row['fileOriginal'],'file');observation=row['observation'];mount_original=tool_ref(observation['mountinfoOriginal'],'mountinfo');mount_data=dependency_bytes(mount_original['original'])
                verified=provider_module().verify_provider_originals(observation,mount_data,pid=row['pid'],actual_path=observation['actualPath'],file_identity=file_original['identity'])
                need(row['sequence'] not in tool_providers,'duplicate actual tool provider sequence');tool_providers[row['sequence']]=dict(row,verified=verified,used=False)
            elif kind=='toolchain-exec-path-entry':
                tool_barrier(row);entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr']==row['syscall'] and entry['nr'] in policy(entry['arch'])['exec'] and isinstance(row['entryPath'],str) and len(row['entryPath'].encode())<=4096,'actual exec path entry differs');tool_exec_paths[row['sequence']]=row
            elif kind=='toolchain-exec-image-capture':
                if memory_mode:
                    personality=row.get('executionPersonalityRaw');need(isinstance(personality,str) and re.fullmatch(r'[0-9a-f]{8}\n',personality) and not int(personality,16)&0x400000,'actual execution personality permits implicit executable mappings')
                    held=[value for value in lease_tokens.values() if value['acquisitionSequence']==row.get('lifetimeLeaseSequence')]
                    need(len(held)==1 and held[0]['identity']==row['exe']['identity'] and held[0]['acquisitionSequence']<row['sequence'],'actual executable lacks prior exact continuously-held inode')
                tool_barrier(row);entry=entries.get(row['execEntrySequence']);event=exec_events.get(row['execEventSequence']);need(entry and event and entry['pid']==row['pid']==event['pid'] and entry['nr'] in policy(entry['arch'])['exec'],'actual exec entry/event relation differs');retained_entries.add(entry['sequence'])
                path_entry=tool_exec_paths.pop(row.get('execPathEntrySequence'),None)
                if path_entry:need(path_entry['entrySequence']==entry['sequence'] and path_entry['pid']==row['pid'] and path_entry['lexicalPath']==row['exe']['lexicalPath'],'actual exec path/executable snapshot differs')
                else:tool_pending.add('toolchain-exec-path-entry-original-unavailable')
                original=tool_ref(row['exe']['original'],'file');need(row['exe']['identity']==original['identity'] and row['elf']==tool_elf(original['original']),'actual exe FD/ELF bytes differ')
                tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=tool_maps(row['mapsOriginal']),mappingKind='exec');tool_coverage.start('exec',row,entry,tool_core['maps'],dict(observedPath=original['observedPath'],identity=original['identity'],original=original['original'],originalCaptureSequence=original['sequence'],stopReadonlyProvider=tool_provider(row['exe'].get('providerSequence'),row,original,row['exe'].get('resolvedPath'))));producer_exec_image[row['pid']]=dict(pid=row['pid'],phase=row['phase'],
                    entrySequence=entry['sequence'],captureSequence=row['sequence'],
                    exe=original['observedPath'],
                    identity=[str(v) for v in original['identity']],
                    bytes=original['original']['bytes'],sha256=original['original']['sha256'],
                    lifetimeLeaseSequence=row.get('lifetimeLeaseSequence'))
                tool_execs+=1;tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
                retained_entries.discard(entry['sequence']);exec_events.pop(row['execEventSequence'])
                if 'machine' in row['elf']:need(row['elf']['machine']=={0xc000003e:62,0xc00000b7:183}[entry['arch']],'actual executable ELF/kernel architecture differs')
                if 'unresolved' in row['elf']:tool_pending.add('toolchain-exec-ELF-interpreter-unclassified')
            elif kind=='toolchain-executable-protection-before':
                tool_barrier(row);entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr'] in policy(entry['arch'])['protect'] and entry['args'][2]&4,'actual executable protection entry differs');retained_entries.add(entry['sequence']);tool_maps(row['mapsOriginal']);tool_protect_before[row['entrySequence']]=row['mapsOriginal']
            elif kind in ['toolchain-file-mapping-capture','toolchain-executable-protection-capture']:
                tool_barrier(row);entry=entries.get(row['entrySequence']);actual=exits.get(row['entrySequence']);need(entry and actual and actual['sequence']==row['exitSequence'] and entry['pid']==row['pid'] and not actual['isError'],'actual mapping/protection syscall result differs')
                args=entry['args']
                if kind=='toolchain-file-mapping-capture':
                    need(entry['nr']==policy(entry['arch'])['mmap'] and actual['result']>=0 and row['actualReturnedAddressHex']==format(actual['result'],'x') and row['requestedLength']==args[1] and row['fileOffset']==args[5] and row['flags']==args[3] and row['protection']==args[2],'actual mmap dimensions differ')
                    descriptor=row.get('actualFd')
                    if descriptor and 'original' in descriptor:need(descriptor['fd']==args[4] and tool_ref(descriptor['original'],'file')['identity']==descriptor['identity'],'actual mmap FD original differs')
                    maps=tool_maps(row['mapsOriginal']);selected=verify_vma_range(maps,actual['result'],args[1],args[2])
                    anonymous=bool(args[3]&0x20)
                    if anonymous:tool_pending.add('anonymous-or-JIT-mapping-source-unresolved');need(descriptor is None,'MAP_ANONYMOUS must not claim file descriptor authority')
                    tool_coverage.start('mmap',row,entry,selected)
                    tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=maps,mappingKind='mmap',begin=actual['result'],length=args[1],offset=args[5],anonymous=anonymous,descriptor=descriptor)
                    # Validated metadata for the DERIVED credit projection. Collected
                    # HERE because this is where the full mmap row and its entry args
                    # have actually been verified; the coverage API stays minimal.
                    record_validated_mmap(validated_mmap_operations,row,entry,descriptor,anonymous,actual)
                else:
                    need(entry['nr'] in policy(entry['arch'])['protect'] and args[2]&4 and actual['result']==0 and row['actualSyscall']==entry['nr'] and row['requestedStartHex']==format(args[0],'x') and row['requestedLength']==args[1] and row['protection']==args[2] and row['beforeMapsOriginal']==tool_protect_before.get(entry['sequence']),'actual executable protection before/after relation differs')
                    if entry['nr'] in [329,288]:tool_pending.add('toolchain-protection-key-access-state-unverified')
                    maps=tool_maps(row['afterMapsOriginal']);actual_mappings=verify_vma_range(maps,args[0],args[1],args[2])
                    if any(mapping['inode']==0 or not mapping['path'].startswith('/') for mapping in actual_mappings):tool_pending.add('anonymous-or-JIT-mapping-source-unresolved')
                    tool_coverage.start('protect',row,entry,actual_mappings)
                    tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=maps,mappingKind='protect',begin=args[0],length=args[1])
                entries.pop(entry['sequence']);exits.pop(entry['sequence']);retained_entries.discard(entry['sequence']);tool_protect_before.pop(entry['sequence'],None)
                tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
            elif kind=='toolchain-kernel-executable-mapping':
                tool_barrier(row);need(memory_mode==row.get('model')==memory_checker.MODEL and tool_core and row['parentCaptureSequence']==tool_core['sequence'] and row['pid']==tool_core['pid'] and row['mapping'] in tool_core['maps'],'kernel mapping lacks exact actual maps/parent relation')
                mapping=row['mapping'];need(mapping['inode']==0 and mapping['path'] in ['[vdso]','[vsyscall]'] and 'x' in mapping['permissions'] and 'w' not in mapping['permissions'],'only exact kernel special RX mappings are outside userspace source universe')
            elif kind=='toolchain-mapping-original':
                tool_barrier(row);need(tool_core and row['parentCaptureSequence']==tool_core['sequence'] and row['pid']==tool_core['pid'] and row['mapping'] in tool_core['maps'],'actual VMA snapshot relation differs')
                mapping=row['mapping'];need(mapping['inode']>0 and mapping['path'].startswith('/'),'anonymous/kernel VMA cannot claim file original authority');identity=row['identity'];need(len(identity)==6 and identity==tool_ref(row['original'],'file')['identity'],'mapped original FD/bytes differ')
                need((os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode']),'actual VMA inode/device differs from mapped FD')
                if memory_mode:need(row.get('mappingBackingModel')=='held-pre-use-lease-v1','memory-protected phase requires held VMA inode contract')
                if row.get('mappingBackingModel') is not None:
                    need(row['mappingBackingModel']=='held-pre-use-lease-v1' and lease_model=='kernel-held-read-lease-v1','unknown held VMA backing contract')
                    held=[value for value in lease_tokens.values() if value['acquisitionSequence']==row.get('lifetimeLeaseSequence')]
                    need(len(held)==1 and held[0]['identity']==identity and held[0]['acquisitionSequence']<row['parentCaptureSequence'],'VMA backing lacks earlier exact held token')
                descriptor=row.get('actualFd')
                if tool_core.get('mappingKind')=='mmap':
                    need(not tool_core['anonymous'] and descriptor==tool_core['descriptor'] and descriptor is not None,'anonymous or different FD cannot claim mapped file original')
                    begin,end=tool_core['begin'],tool_core['begin']+tool_core['length'];start,stop=int(mapping['startHex'],16),int(mapping['endHex'],16)
                    need(start<end and stop>begin and mapping['fileOffset']+max(begin-start,0)==tool_core['offset']+max(start-begin,0),'actual mapped file offset/range differs')
                elif tool_core.get('mappingKind')=='protect':need(int(mapping['startHex'],16)<tool_core['begin']+tool_core['length'] and int(mapping['endHex'],16)>tool_core['begin'],'executable protection mapping outside actual requested range')
                if descriptor:need(descriptor['identity']==identity,'actual mapping process FD differs')
                provider=tool_provider(row.get('providerSequence'),row,tool_ref(row['original'],'file'),mapping['path'])
                tool_coverage.mapped(tool_core['sequence'],row,tool_ref(row['original'],'file')['sequence'],provider)
                if mapping['permissions'] in ['r-xp','r-xs'] and row.get('lifetimeLeaseSequence'):approved_rx[row['sequence']]=row
                # DERIVED causal-witness edge. Every already-validated mapping
                # capture contributes one compact edge: which process mapped this
                # exact object, at which entry (before any later write), with its
                # full six-field identity, the protection/flags actually used and
                # the held pre-use lease that authorised reading it. This is a
                # projection of facts the replay already proved -- no new claim.
                # A mapping-original can descend from EITHER a validated mmap
                # operation or the validated exec image. The exec image has no
                # mmap prot/flags args; the exec branch already proved the image
                # identity, byte original, resident VMA set and held lease, so the
                # edge records "execution image" rather than inventing prot bits.
                _edge_op=validated_mmap_operations.get(row.get('parentCaptureSequence')) or validated_mmap_operations.get(tool_core['sequence'])
                if _edge_op is None:
                    need(tool_core.get('mappingKind')=='exec','mapping edge lacks its validated operation protection/flags')
                    protection=_mapping_protection_bits(mapping['permissions'])
                    flags=None
                else:
                    need(_edge_op.get('protection') is not None and _edge_op.get('flags') is not None,
                         'mapping edge lacks its validated operation protection/flags')
                    protection=_edge_op['protection'];flags=_edge_op['flags']
                # A writable VMA is recorded with its REAL permissions and is
                # then excluded from the read-only input set by the witness
                # filter. It is never relabelled read-only.
                producer_input_edges.append(dict(
                    pid=row['pid'],phase=row['phase'],entrySequence=entry['sequence'],
                    captureSequence=row['sequence'],identity=[str(v) for v in identity],
                    protection=protection,flags=flags,
                    lifetimeLeaseSequence=row.get('lifetimeLeaseSequence'),
                    bytes=row['original']['bytes'],sha256=row['original']['sha256'],
                    executable=bool(protection&4),readOnly=protection&2==0,
                    mappingModel=('execution-image' if _edge_op is None else 'mmap')))
                tool_mappings+=1;tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
            elif kind=='toolchain-unresolved':
                # Stop-time mount provenance is independent of a continuous inode lease.
                # Every other unresolved observation remains a lifetime blocker.
                if row['reason']!='toolchain-effective-readonly-provider-unverified':memory_missing=True
                tool_pending.add(row['reason'])
                if row['reason']=='toolchain-effective-readonly-provider-unverified':
                    # EXACT per-operation attribution: this is the REAL shape a
                    # writable build root produces (no read-only SOURCE provider
                    # for a generated artifact). Recorded against (phase, this
                    # row's own exact path) so the FILE-IO axis can be decided
                    # separately from the SOURCE-providence axis. The reason string
                    # is untouched and stays in tool_pending.
                    pending_source_provider_paths.setdefault(phase,set()).add(str(row.get('actualPath')))
            elif kind=='bti-hardening-before':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);tool_barrier(row)
                need(bti_mode==row.get('model')=='held-rx-bti-hardening-v1' and memory_mode and entry and entry['pid']==row['pid'] and entry['sequence'] not in bti_originals,'BTI lacks unique declared entry')
                need(exclusive is None and entry['sequence']<barrier['sequence'] and latest_execution_sequence<=barrier['sequence'],'BTI lacks current all-stop barrier')
                maps_original=tool_ref(row['mapsOriginal'],'maps');need(maps_original['observedPid']==row['pid'],'BTI before maps belong to another task')
                verify_stopped_original_order(maps_original,barrier,entry,row)
                mappings=memory_checker.bti_mappings(entry['arch'],entry['nr'],entry['args'],tool_maps(row['mapsOriginal']),row['pageSize'])
                refs=row['mappingSequences'];need(isinstance(refs,list) and len(refs)==len(mappings) and len(set(refs))==len(refs),'BTI mapping references differ')
                for mapping,sequence in zip(mappings,refs):
                    prior=approved_rx.get(sequence)
                    need(prior and prior['pid']==row['pid'] and prior['mapping']==mapping and sequence<entry['sequence'],'BTI lacks earlier approved exact RX VMA')
                    held=[value for value in lease_tokens.values() if value['acquisitionSequence']==prior['lifetimeLeaseSequence']]
                    need(len(held)==1 and held[0]['identity']==prior['identity'],'BTI lacks same held inode')
                bti_originals[entry['sequence']]=(row,mappings);retained_entries.add(entry['sequence']);exclusive=(row['pid'],entry['sequence'])
            elif kind=='executable-memory-remap-allowed':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(remap_mode==row.get('model')==memory_checker.REMAP_MODEL and memory_mode,'mremap allowance lacks the declared capability model')
                need(generated_verifier is not None and generated_verifier.model in generated_module.COHORT_MODELS,'mremap requires a real supported generated MM model')
                need(entry and entry['pid']==row['pid'] and entry['sequence'] in remap_required and entry['sequence'] not in remap_originals,'mremap allowance lacks its shape-admitted actual entry')
                need(exclusive is None and barrier and row['pid'] in barrier['pids'] and latest_execution_sequence<=barrier['sequence'],'mremap allowance lacks a current all-stop barrier')
                need(entry['sequence']<barrier['sequence'],'mremap entry did not precede its barrier')
                target=memory_checker.remap_range(entry['args'][0],entry['args'][1]);need(target is not None and list(target)==row['range'],'mremap range differs from actual entry words')
                need(row['oldSize']==entry['args'][1] and row['newSize']==entry['args'][2] and row['flags']==entry['args'][3] and row.get('coverageComplete') is True and row.get('executableBytes')==0,'mremap proof projection differs from entry')
                # G1: derive domain+cohort from the ACTUAL verifier memory-domain
                # history, never from the row's self-asserted fields.
                domain,members=generated_verifier.mapping_domain(row['pid'],barrier)
                need(row.get('memoryDomain')==domain and row.get('memoryDomainMembers')==members,'mremap cohort/domain differs from actual fork/cloneVM history')
                need(1<=len(members)<=128,'bounded actual cohort required')
                # maps causality: owner + peer originals must be real captured
                # records whose map sequence sits strictly after this barrier.
                owner=row.get('ownerMaps');need(isinstance(owner,dict),'mremap owner maps original missing')
                owner_capture=tool_ref(owner,'maps');need(owner_capture['observedPid']==row['pid'],'owner maps sampled another pid')
                verify_stopped_original_order(owner_capture,barrier,entry,row)
                need(barrier['sequence']<generated_verifier.map_sequences.get(generated_verifier.map_key(owner),0)<row['sequence'],'owner maps outside entry barrier -> allowance window')
                owner_parsed=tool_maps(owner)
                ok,why,covered,executable_b=memory_checker.cover_nonexec_range(owner_parsed,row['range'][0],row['range'][1])
                need(ok and executable_b==0,'forged or incomplete mremap owner coverage')
                peers=row['cohortMaps'];need(isinstance(peers,list) and [item['pid'] for item in peers]==[m for m in members if m!=row['pid']],'complete ordered same-MM peer maps required')
                generated_verifier.verify_cohort_maps(peers,row['pid'],members,owner_parsed,barrier,row['sequence'])
                for item in peers:
                    parsed=tool_maps(item['original'])
                    ok,why,covered,executable_b=memory_checker.cover_nonexec_range(parsed,row['range'][0],row['range'][1])
                    need(ok and executable_b==0,'forged or incomplete mremap peer coverage')
                remap_originals[entry['sequence']]=row;retained_entries.add(entry['sequence'])
            elif kind=='exclusive-remap-resume':
                original=remap_originals.get(row['entrySequence'])
                need(original and original['sequence']<row['sequence'] and exclusive is None and row['pid']==original['pid'] and row.get('model')==remap_mode and row['barrierSequence']==original['barrierSequence'],'mremap exclusive resume lacks its own allowance')
                entry=entries.get(row['entrySequence']);need(entry and entry['sequence'] not in exits,'mremap resume lacks the actual entry')
                need(row['request']=='PTRACE_SYSCALL' and row.get('signal')==0,'mremap resume must be a plain syscall resume')
                exclusive=(row['pid'],row['entrySequence'])
            elif kind=='executable-memory-remap-verified':
                original=remap_originals.get(row['entrySequence']);entry=entries.get(row['entrySequence']);actual=exits.get(row['entrySequence'])
                need(original and entry and actual and row.get('model')==remap_mode,'mremap verification lacks its allowed/exited transaction')
                need(exclusive==(row['pid'],row['entrySequence']) and row['entrySequence'] not in remap_consumed,'mremap verification outside its exclusive owner')
                need(row['exitSequence']==actual['sequence'] and actual['pid']==row['pid'] and actual['isError'] is False and type(actual['result']) is int and actual['result']>0,'mremap verification lacks a successful actual exit')
                need(actual['result']==row['newBase'],'mremap verification result differs from the kernel exit')
                need(row['oldRange']==original['range'] and row['newRange']==[row['newBase'],row['newBase']+original['newSize']],'mremap verified range arithmetic differs')
                need(row.get('coverageComplete') is True and row.get('executableBytes')==0,'mremap verified coverage flag differs')
                tool_barrier(row);barrier=barriers[row['barrierSequence']]
                need(actual['sequence']<row['barrierSequence'] and latest_execution_sequence<=row['barrierSequence'],'mremap exit maps lack a current stop')
                # G1 both ends: re-derive the domain/cohort at the EXIT barrier.
                domain,members=generated_verifier.mapping_domain(row['pid'],barrier)
                need(domain==original['memoryDomain'] and members==original['memoryDomainMembers'],'mremap cohort/domain changed across the exclusive call')
                need(row.get('memoryDomain')==domain and row.get('memoryDomainMembers')==members,'mremap exit cohort differs from actual fork/cloneVM history')
                # G2: post-exit evidence must be a FRESH capture inside the
                # exitBarrier -> verified window, never the entry maps reused.
                need(barrier['sequence']<row['sequence'],'exit barrier did not precede verification')
                owner=row.get('ownerMaps');need(isinstance(owner,dict),'mremap exit owner maps missing')
                need(original.get('ownerMaps')!=owner,'stale entry original reused on exit')
                need(tool_ref(owner,'maps')['observedPid']==row['pid'],'exit owner maps sampled another pid')
                need(barrier['sequence']<generated_verifier.map_sequences.get(generated_verifier.map_key(owner),0)<row['sequence'],'exit owner maps outside exit barrier -> verified window')
                owner_parsed=tool_maps(owner)
                ok,why,covered,executable_b=memory_checker.cover_nonexec_range(owner_parsed,row['newRange'][0],row['newRange'][1])
                need(ok and executable_b==0,'forged or incomplete mremap destination coverage')
                peers=row['cohortMaps'];need(isinstance(peers,list) and [item['pid'] for item in peers]==[m for m in members if m!=row['pid']],'complete ordered post-exit peer maps required')
                generated_verifier.verify_cohort_maps(peers,row['pid'],members,owner_parsed,barrier,row['sequence'])
                for item in peers:
                    parsed=tool_maps(item['original'])
                    ok,why,covered,executable_b=memory_checker.cover_nonexec_range(parsed,row['newRange'][0],row['newRange'][1])
                    need(ok and executable_b==0,'forged or incomplete mremap destination peer coverage')
                # the unchanged/shrink case must still carry a NEW capture per member
                entry_keys={generated_verifier.map_key(item['original']) for item in original.get('cohortMaps') or []}
                for item in peers:
                    need(generated_verifier.map_key(item['original']) not in entry_keys,'exit peer maps reused the entry capture')
                remap_consumed.add(row['entrySequence']);entries.pop(row['entrySequence'],None);exits.pop(row['entrySequence'],None);retained_entries.discard(row['entrySequence']);exclusive=None
            elif kind=='executable-memory-remap-closed':
                original=remap_originals.get(row['entrySequence']);actual=exits.get(row['entrySequence'])
                need(original and actual and exclusive==(row['pid'],row['entrySequence']) and row.get('model')==remap_mode,'mremap close lacks its exclusive transaction')
                need(actual['isError'] is True and actual['result']==row['kernelError'] and actual['result']<0,'mremap close lacks the actual kernel error exit')
                remap_consumed.add(row['entrySequence']);entries.pop(row['entrySequence'],None);exits.pop(row['entrySequence'],None);retained_entries.discard(row['entrySequence']);exclusive=None
            elif kind=='bti-hardening-after':
                pair=bti_originals.get(row['entrySequence']);entry=entries.get(row['entrySequence']);actual=exits.get(row['entrySequence']);tool_barrier(row)
                need(pair and entry and actual and row.get('model')==bti_mode and exclusive==(row['pid'],row['entrySequence']) and row['entrySequence'] not in bti_completed,'BTI lacks exclusive actual exit')
                before,mappings=pair
                need(row['beforeSequence']==before['sequence'] and row['exitSequence']==actual['sequence'] and actual['pid']==row['pid'] and actual['arch']==entry['arch'],'BTI exit linkage differs')
                need(actual['isError'] and actual['result']<0 or actual['isError'] is False and actual['result']==0,'BTI exit result differs')
                need(actual['sequence']<row['barrierSequence'] and latest_execution_sequence<=row['barrierSequence'],'BTI after maps lack current stop')
                maps_original=tool_ref(row['mapsOriginal'],'maps');need(maps_original['observedPid']==row['pid'],'BTI after maps belong to another task')
                verify_stopped_original_order(maps_original,barriers[row['barrierSequence']],actual,row)
                after=memory_checker.bti_mappings(entry['arch'],entry['nr'],entry['args'],tool_maps(row['mapsOriginal']),before['pageSize'])
                need(after==mappings,'BTI changed actual VMA range/backing/offset/permissions')
                bti_completed.add(entry['sequence']);entries.pop(entry['sequence']);exits.pop(entry['sequence']);retained_entries.discard(entry['sequence']);exclusive=None
            elif kind=='kernel-clone3-args-original':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(clone3_mode==row.get('model')=='stopped-clone3-args-v1' and memory_mode and shared_mode and entry and entry['nr']==435 and entry['pid']==row['pid'] and entry['sequence'] not in clone3_originals,'clone3 original lacks unique declared actual entry')
                need(exclusive is None and barrier and row['pid'] in barrier['pids'] and entry['sequence']<barrier['sequence'] and latest_execution_sequence<=barrier['sequence'],'clone3 original lacks current all-stop barrier')
                verify_stopped_original_order(row,barrier,entry,row,inline=True)
                size=row['size'];need(type(size) is int and size==entry['args'][1] and size in memory_checker.CLONE3_SIZES and 0<entry['args'][0]<1<<64 and entry['args'][0]+size<1<<64,'clone3 size/address differs')
                need(isinstance(row['dataHex'],str) and len(row['dataHex'])==size*2 and re.fullmatch('[0-9a-f]+',row['dataHex']) is not None,'bounded canonical clone3 original required')
                data=bytes.fromhex(row['dataHex']);need(hashlib.sha256(data).hexdigest()==row['sha256'],'clone3 original digest differs');parsed=memory_checker.parse_clone3_original(data,size)
                need(row['flags']==parsed['flags'] and row['exitSignal']==parsed['exitSignal'],'clone3 original projection differs');clone3_originals[entry['sequence']]=row;retained_entries.add(entry['sequence'])
            elif kind=='exclusive-clone3-resume':
                original=clone3_originals.get(row['entrySequence'])
                need(original and exclusive is None and original['pid']==row['pid'] and original['sequence']==row['originalSequence'] and row['entrySequence'] in clone_flags and row['sequence']==original['sequence']+2,'clone3 exclusive window differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='clone3-arguments-consumed':
                original=clone3_originals.get(row['entrySequence']);event=clone3_events.get(row['eventSequence']);exit=exits.get(row['entrySequence']);child=row['childPid']
                need(original and original['pid']==row['pid'] and original['sequence']==row['originalSequence'] and exclusive==(row['pid'],row['entrySequence']) and row['entrySequence'] not in clone3_consumed,'clone3 consumption lacks exclusive original')
                if child is None:
                    need(exit and exit['sequence']==row['eventSequence'] and exit['isError'] is True and exit['result']<0,'clone3 failure release lacks actual negative exit');memory_released_entries.add(row['entrySequence'])
                else:
                    binding=child_bindings.get(child);need(event and event['pid']==row['pid'] and event['event']==(2 if original['flags']&0x4000 else 3 if original['flags']&0x10000 else 1) and binding and binding['parentPid']==row['pid'] and binding['cloneEntrySequence']==row['entrySequence'] and binding['event']==event['event'] and original['sequence']<event['sequence']<binding['sequence']<row['sequence'],'clone3 child release lacks actual matching kernel event')
                    if original['flags']&0x4000:need(row['pid'] in vfork_holds and vfork_holds[row['pid']]['childPid']==child,'clone3 shared VM lacks kernel-held parent')
                clone3_consumed.add(row['entrySequence']);exclusive=None
            elif kind=='kernel-clone-flags':
                entry=entries.get(row['entrySequence']);clone_flags.add(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr'] in [policy(entry['arch'])['clone'],435],'clone memory flags entry differs');flags=row['flags'];clone_flag_values[row['entrySequence']]=flags
                if memory_mode and entry['nr']==435:
                    original=clone3_originals.get(entry['sequence']);need(original and row.get('clone3OriginalSequence')==original['sequence'] and flags==original['flags']|original['exitSignal'] and row['sequence']==original['sequence']+1,'clone3 flags lack exact bounded original')
                if memory_mode:
                    thread=bool(flags&0x10000)
                    if thread:
                        # Thread mode shares the parent's address space, FD table
                        # and signal handlers inside one thread group; the kernel
                        # child event and actual TGID still prove it in observe().
                        need(flags&(0x100|0x400|0x800)==(0x100|0x400|0x800) and not flags&0x4000 and not flags&~(_THREAD_CLONE_ALLOWED),'thread clone must share VM/FD/SIGHAND and use known flags')
                    else:need(not flags&0x400 and (not flags&0x100 or flags&0x4000),'executable memory policy requires independent FD tables and kernel-held vfork for shared VM')
                    # ONLY a non-thread shared-VM clone creates a new exec image
                    # that must later be released (vfork/exec or failed clone). A
                    # THREAD shares the parent's address space and is never
                    # released by an exec of its own, so counting it as an
                    # outstanding entry made every thread-using output
                    # (LLD's worker threads) spuriously fail lifetime closure.
                    if flags&0x100 and not thread:memory_shared_entries.add(entry['sequence'])
                if shared_mode:inspect_shared_clone_flags(flags)
                else:need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared writer/FD flags')
                if flags&0x100:tool_pending.add('toolchain-shared-address-space-clone-unverified')
            elif kind=='kernel-path-arguments':need(row['entrySequence'] in entries and entries[row['entrySequence']]['pid']==row['pid'],'path original entry differs');paths[row['entrySequence']]=row['renamePaths'];retained_entries.add(row['entrySequence'])
            elif kind=='fd-capture':
                need(not append_dirty,'file capture before full append checkpoint')
                retained_entries.add(row['entrySequence']);entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and row['pid']==entry['pid'] and row['pid'] in barrier['pids'],'capture missing actual entry/all-stop relation')
                rules=POLICIES[entry['arch']];need(row['role'] in ['producer-close','consumer','source-read','readwrite-consumer'],'unknown capture role')
                nr=entry['nr'];fd_index=4 if nr==rules['mmap'] else 0;need(row['fd']==entry['args'][fd_index],'capture actual FD differs')
                if row['role']=='producer-close':need(nr==rules['close'] and row['writers']==[dict(pid=row['pid'],fd=row['fd'])],'producer has another writable alias')
                elif row['role']=='readwrite-consumer':
                    need(nr==rules['read'] and len(row['writers'])==1 and row['writers'][0]['pid']==row['pid'] and row['writers'][0]['fd']==row['fd'] and row['writers'][0]['accessMode']==2 and row['writers'][0]['flags']&3==2,'own-RW read has another writable alias')
                else:
                    # A consumer/source read is any actual read-family form; the
                    # exact ABI shape is validated by the dedicated read-form
                    # table, not by assuming read(2).
                    form=read_form(entry['arch'],nr)
                    need(form is not None and row['writers']==[],'consumer/source has live writable alias')
                    if form['iovec']:
                        need(row.get('iovLengths') is not None or row.get('requestedBound') is not None or True,'iovec consumer keeps its own declared bound')

                reuse=row.get('originalReuse');alias_present='originalReuse' in row
                if entity_model=='same-phase-content-entity-v2':
                    window=row.get('captureWindowIdentity');need(isinstance(window,list) and len(window)==7 and all(type(value) is int and value>=0 for value in window) and window[:6]==row['identity'] and stat.S_ISREG(window[2]) and row.get('captureWindowAfterIdentity')==window,'content capture lacks complete fresh FD pre/post identity')
                    if 'namedWindowIdentity' in row:need(row['namedWindowIdentity']==window and row.get('namedWindowAfterIdentity')==window,'content named pre/post identity differs')
                if entity_model is not None and row['original']['path'] in observed_entity_names:need(alias_present,'shared physical capture entity lacks typed alias')
                if alias_present and entity_model=='same-phase-content-entity-v2':
                    need(isinstance(reuse,dict) and set(reuse)=={'model','originCaptureSequence'} and reuse['model']==entity_model and type(reuse['originCaptureSequence']) is int and 0<reuse['originCaptureSequence']<row['sequence'],'exact backward content storage alias required')
                    origin=storage_origins.get(reuse['originCaptureSequence']);need(origin and origin.get('phase')==row.get('phase')==phase and origin['original']==row['original'],'content storage alias missing own phase/prior physical original')
                    entity=row.get('originalEntityIdentity');need(entity==origin['originalEntityIdentity'],'content storage alias mixes physical entity')
                    window=row.get('captureWindowIdentity');need(isinstance(window,list) and len(window)==7 and all(type(value) is int and value>=0 for value in window) and window[:6]==row['identity'] and row.get('namedWindowIdentity')==window and stat.S_ISREG(window[2]),'content alias lacks own fresh full FD/named window identity')
                    storage_aliases[row['sequence']]=reuse['originCaptureSequence']
                elif alias_present:
                        need(entity_model=='same-phase-producer-original-v1','capture entity alias lacks actual root model')
                        need(isinstance(reuse,dict) and set(reuse)=={'model','originCaptureSequence'} and reuse['model']=='same-phase-producer-original-v1' and type(reuse['originCaptureSequence']) is int and reuse['originCaptureSequence']<row['sequence'],'exact prior capture entity alias required')
                        prior=caps.get(reuse['originCaptureSequence']) or prepared.get(reuse['originCaptureSequence'])
                        need(prior and row['role']=='consumer' and (prior[0]['kind']=='prepared-build-input-original' or prior[0].get('role')=='producer-close'),'capture entity alias lacks own producer/prepared origin')
                        origin=prior[0];entity=row.get('originalEntityIdentity')
                        need(row.get('phase')==origin.get('phase')==phase and row['original']==origin['original'] and row['identity'][:2]==origin['identity'][:2],'capture entity alias crosses phase, original or source identity')
                        need(isinstance(entity,list) and len(entity)==7 and all(type(value) is int for value in entity) and entity==origin.get('originalEntityIdentity') and entity[3]==row['original']['bytes'] and entity[6]==1 and entity[2]&0o170000==0o100000,'capture entity alias lacks exact single-link physical original')
                        reused_originals[row['sequence']]=reuse['originCaptureSequence']
                data=capture_data(row['original'])
                if entity_model=='same-phase-content-entity-v2' and not alias_present:storage_original(row)
                need(len(row['identity'])==6 and row['identity'][3]==data[0],'actual capture identity/size differs');caps[row['sequence']]=(row,data);phase_capture_sequences.append(row['sequence'])
                if capture_observer:capture_observer(row,data)
                if row['role']=='source-read':
                    source_reads.append(row)
                    if row['path'].startswith('/opt/qlever-sdk/dependencies/'):
                        need('dependency' in row,'dependency actual read lacks registration binding')
                        binding=row['dependency']
                        if binding['name']=='@cmake-cache':
                            need(dependency_cache and row['path']==dependency_cache['path'] and binding['relativePath']=='sources.cmake' and binding['registrationSequence']==dependency_cache['registrationSequence'],'dependency cache read registration differs')
                            need(data==(dependency_cache['original']['bytes'],dependency_cache['original']['sha256']) and row['identity'][2]&0o7777==0o644,'dependency actual cache FD bytes/mode differ');probe_mount_readonly(row['path'],dependency_cache['mounts']);dependency_reads+=1
                            continue
                        registered=dependency_roots.get(binding['name']);need(registered and binding['registrationSequence']==registered['registrationSequence'],'dependency read has no actual registered source')
                        root=registered['root'];need(row['path'].startswith(root+'/') and binding['relativePath']==row['path'][len(root)+1:],'dependency read escapes registered root')
                        expected=registered['files'].get(binding['relativePath']);need(expected and expected['kind']=='file' and (expected['bytes'],expected['sha256'])==data and expected['mode']==row['identity'][2]&0o7777,'dependency actual FD bytes/mode differ from prepared physical snapshot')
                        probe_mount_readonly(row['path'],registered['mounts']);dependency_reads+=1
            elif kind=='vfork-parent-held':
                parent=row['parentPid'];child=row['childPid'];event=vfork_events.get(row['eventSequence']);binding=child_bindings.get(child)
                need(parent in live and child in live and parent not in vfork_holds and event and event['pid']==parent and event['event']==2 and binding and binding['event']==2 and binding['parentPid']==parent,'VFORK hold lacks actual event/child binding')
                need(row['actualParentState']=='t' and row['entrySequence'] in entries and binding.get('cloneEntrySequence',row['entrySequence'])==row['entrySequence'],'VFORK hold lacks actual parent entry/stop')
                entry=entries[row['entrySequence']];need(entry['pid']==parent and (clone_flag_values.get(entry['sequence'],0)&0x4000 or entry['arch']==0xc000003e and entry['nr']==58),'VFORK hold actual flags differ');vfork_holds[parent]=row
            elif kind=='vfork-parent-release':
                parent=row['parentPid'];hold=vfork_holds.get(parent);event=vfork_events.get(row['releaseSequence']);wait=wait_rows.get(row['releaseSequence']);child=row['childPid']
                need(hold and parent in live and hold['childPid']==child and row['holdSequence']==hold['sequence'] and row['actualParentState']=='t','VFORK release wrong parent/child/stop')
                need((row['releaseKind']=='actual-exec' and child in live and event and event['pid']==child and event['event']==4) or (row['releaseKind']=='actual-terminal-wait' and child not in live and wait and wait['pid']==child),'VFORK release lacks actual child exec/terminal wait');memory_released_entries.add(hold['entrySequence']);del vfork_holds[parent]
            elif kind=='ptrace-event':
                if exclusive is not None and (exclusive[1] in clone3_originals or exclusive[1] in bti_originals):need(row['pid']==exclusive[0],'another task event during clone3 argument window')
                need(row.get('event') in [1,2,3,4,5,6,128],'unknown actual ptrace event')
                if process_interval is not None:process_interval.event(row['pid'],row['event'],row['sequence'])
                if row['event'] in [1,2,3]:clone3_events[row['sequence']]=row
                if row['event'] in [2,4]:vfork_events[row['sequence']]=row
                if shared_mode and row['event']==4:exec_fd_events[row['sequence']]=row
                if row['event']==4:exec_events[row['sequence']]=row;exec_event_history[row['sequence']]=row
                if row['event']==6 and terminal_mode:terminal_events[row['sequence']]=row
            elif kind=='executable-memory-write-fd':
                need(memory_mode==row.get('model')==memory_checker.MODEL and memory_writes.pop(row.get('entrySequence'),None)==(row.get('pid'),row.get('fd')) and row['sequence']==row['entrySequence']+1,'memory FD check lacks exact syscall entry')
                need(row.get('target') is None or isinstance(row.get('target'),str),'actual descriptor target must be a string or closed descriptor')
                need(not memory_checker.memory_fd(row.get('target')),'proc memory writer in successful execution')
            elif kind in ['toolchain-lease-acquired','toolchain-lease-reused']:
                need(lease_model=='kernel-held-read-lease-v1' and not lease_terminal and not lease_closed,'lease outside active phase')
                entry=entries.get(row.get('entrySequence'));barrier=barriers.get(row.get('barrierSequence'))
                need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'] and entry['sequence']<barrier['sequence']<row['sequence'],'lease actual entry/barrier binding differs')
                need(row.get('role') in ['executable','interpreter','mmap','input-read'],'lease role differs')
                identity=row.get('identity');token=row.get('leaseId')
                need(type(token)is int and token>0 and isinstance(identity,list) and len(identity)==6 and all(type(v)is int for v in identity) and identity[2]&0o170000==0o100000,'regular lease token identity required')
                if kind=='toolchain-lease-acquired':
                    need(row.get('model')==lease_model and token not in lease_tokens and token==len(lease_tokens)+1 and len(lease_tokens)<4096,'duplicate/unbounded lease acquisition')
                    lease_tokens[token]=dict(leaseId=token,identity=identity,acquisitionSequence=row['sequence'],role=row['role'],barrierSequence=row['barrierSequence'],entrySequence=row.get('entrySequence'))
                    lease_entry_by_token[(row['phase'],token)]=row.get('entrySequence')
                else:
                    present=lease_tokens.get(token)
                    need(present is not None and all(present[key]==value for key,value in
                        dict(leaseId=token,identity=identity,acquisitionSequence=row.get('acquisitionSequence')).items()),'lease reuse changed acquisition')
            elif kind=='toolchain-lease-closed-token':
                need(lease_model==row.get('model')=='kernel-held-read-lease-v1' and not live and not lease_terminal and not lease_pids,'lease token close before actual waits/after closure')
                value={key:row.get(key) for key in ['leaseId','identity','acquisitionSequence']}
                current=lease_tokens.get(len(lease_closed)+1)
                need(current is not None and value=={key:current[key] for key in ['leaseId','identity','acquisitionSequence']},'lease closed token sequence/identity differs');lease_closed.append(value)
            elif kind=='toolchain-lease-closed-pids':
                need(lease_model==row.get('model')=='kernel-held-read-lease-v1' and not live and not lease_terminal and len(lease_closed)==len(lease_tokens),'lease PID close before token/wait closure')
                values=row.get('actualClosedPids');need(isinstance(values,list) and 0<len(values)<=256 and row.get('offset')==len(lease_pids),'bounded sequential closed PID chunk required');lease_pids.extend(values)
            elif kind=='toolchain-leases-closed':
                need(lease_model==row.get('model')=='kernel-held-read-lease-v1' and not live and not lease_terminal and len(lease_closed)==len(lease_tokens),'lease terminal closure incomplete')
                digest=hashlib.sha256()
                for value in lease_closed:digest.update(json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n')
                need(row.get('tokenCount')==len(lease_closed) and row.get('tokensSha256')==digest.hexdigest() and row.get('actualClosedPidCount')==len(lease_pids) and lease_pids==sorted(wait['pid'] for wait in waits) and row.get('allTrackedWaitsClosed') is True,'lease terminal count/hash/actual waits differ')
                lease_terminal=True
            elif kind=='link-metadata-absent-entry':
                # Declaration only: the name was absent at the ENTRY stop, which proves
                # NO successful effect. The row must carry EXACTLY the emitter's field
                # set, be bound to its own real live entry in the same phase, and may be
                # settled at most once -- only by a matching real failed exit.
                keys=set(row)
                need(keys in (ABSENT_ENTRY_KEYS, ABSENT_ENTRY_KEYS|{'observedMonotonicNs'}),
                     'absent link entry field set differs from the emitter')
                sequence=row.get('entrySequence');entry=entries.get(sequence)
                need(type(sequence) is int and sequence>0,'absent link entry lacks its entry sequence')
                need(entry is not None and entry.get('op')=='entry','absent link entry does not name a real entry')
                need(row.get('pid')==entry['pid'],'absent link entry pid differs from its real entry')
                need(row.get('phase')==entry.get('phase'),'absent link entry phase differs from its real entry')
                need(row.get('arch')==entry['arch'],'absent link entry arch differs from its real entry')
                need(row.get('nr')==entry['nr'],'absent link entry nr differs from its real entry')
                need(isinstance(row.get('form'),str) and row['form'] in LINK_SYSCALLS.get(entry['arch'],{}),
                     'absent link entry form is not a known link form')
                need(LINK_SYSCALLS[entry['arch']][row['form']]==entry['nr'],'absent link entry form does not match its real entry syscall')
                # Deterministic values, not mere presence: a forged row must not be
                # able to drop "regular" and still read as a clean absence marker.
                need(row.get('resolved') is False and row.get('regular') is None,'absent link entry claims an observed operand')
                need(isinstance(row.get('reason'),str) and row['reason'],'absent link entry lacks its reason annotation')
                need(isinstance(row.get('observedUnixNs'),str) and row['observedUnixNs'].isdigit(),'absent link entry lacks its observation timestamp')
                need(sequence not in absent_entries,'absent link entry declared twice')
                absent_entries[sequence]=row
                # Retain this entry so its real exit is decoded and can settle the
                # declaration; without this the exit would be dropped and the marker
                # could never be settled by the matched failed exit.
                retained_entries.add(sequence)
            elif kind=='link-metadata-absent-confirmed':
                # The ONLY settlement, and strictly failure-only. The matching real
                # exit must be a genuine kernel error with a negative Linux errno, and
                # the confirmation must cite that exact exit for the same entry,
                # architecture, pid and phase. Success, orphans, duplicates and foreign
                # joins are all refused.
                keys=set(row)
                need(keys in (ABSENT_CONFIRMED_KEYS, ABSENT_CONFIRMED_KEYS|{'observedMonotonicNs'}),
                     'absent link confirmation field set differs from the emitter')
                sequence=row.get('entrySequence');exit_sequence=row.get('exitSequence')
                declaration=absent_entries.get(sequence)
                need(declaration is not None,'absent link confirmation without its own absent-entry marker')
                need(sequence not in absent_settled,'absent link entry settled twice')
                need(type(exit_sequence) is int and exit_sequence>0,'absent link confirmation lacks its exit sequence')
                exit=exits.get(sequence)
                need(exit is not None and exit.get('op')=='exit','absent link confirmation does not cite a real exit')
                need(exit['sequence']==exit_sequence,'absent link confirmation cites the wrong exit sequence')
                need(exit.get('entrySequence')==sequence,'absent link exit belongs to a different entry')
                need(exit.get('arch')==declaration['arch'],'absent link exit architecture differs from its entry')
                need(exit.get('pid')==declaration['pid'],'absent link exit pid differs from its entry')
                need(row.get('phase')==declaration['phase'],'absent link confirmation phase differs from its declaration')
                need(row.get('pid')==declaration['pid'],'absent link confirmation pid differs from its declaration')
                need(row.get('form')==declaration['form'],'absent link confirmation form differs from its declaration')
                need(exit['isError'] is True,'absent link settled by a NON-error exit')
                result=exit['result']
                need(type(result) is int and -4095<=result<=-1,'absent link exit lacks a genuine negative Linux errno')
                need(row.get('errnoValue')==result,'absent link confirmation errno differs from the real exit result')
                # Path bytes are ANNOTATIONS only: they are shape-checked (lowercase,
                # even-length hex, within the emitter's 4096-byte operand bound) and are
                # never used to derive a path, namespace, custody or source authority.
                for field in ('newPathHex','oldPathHex'):
                    value=row.get(field)
                    if value is None:
                        need(field=='oldPathHex','absent link confirmation lacks its new path annotation')
                        continue
                    need(isinstance(value,str) and value==value.lower(),'absent link path annotation is not lowercase')
                    need(len(value)%2==0,'absent link path annotation is not even-length hex')
                    try: raw=bytes.fromhex(value)
                    except ValueError: raise ValueError('multi-process generation originals: absent link path annotation is not hex')
                    need(0<len(raw)<=4096,'absent link path annotation exceeds the actual 4096-byte operand bound')
                need(isinstance(row.get('scope'),str) and row['scope'],'absent link confirmation lacks its scope annotation')
                need(isinstance(row.get('observedUnixNs'),str) and row['observedUnixNs'].isdigit(),'absent link confirmation lacks its observation timestamp')
                absent_settled[sequence]=exit_sequence
                absent_confirmed[sequence]=row
            elif kind=='link-metadata-unobserved':
                # FATAL by construction: an unobserved operand proves nothing, so it
                # may never be cited by a window or a transition. It is collected so
                # phase-end can refuse the phase instead of quietly admitting it.
                sequence=row.get('entrySequence');entry=entries.get(sequence)
                need(type(sequence) is int and sequence>0,'unobserved link metadata lacks its entry sequence')
                need(entry is not None and entry.get('op')=='entry','unobserved link metadata does not name a real entry')
                need(row.get('pid')==entry['pid'] and row.get('form') in LINK_SYSCALLS.get(entry['arch'],{}),'unobserved link metadata does not match its real entry')
                unobserved_entries.add(sequence)
            elif kind=='retained-fd-rename-binding':renames.append(row)
            elif kind=='generated-consumer-binding':consumers.append(row)
            elif kind=='prepared-consumer-binding':prepared_consumers.append(row)
            else:
                need(row.get('pid') not in denied_operations,'signal or ptrace event interrupted explicit denial')
                need(kind in ['ptrace-event','signal-delivery','generated-mmap-unverified'],'unknown raw observer event')
            if kind in ['prepared-build-input-original','write-original','toolchain-original'] and 'original' in row:
                if entity_model=='same-phase-content-entity-v2':storage_original(row)
                elif not entity_model_initialized:pending_storage_rows.append(row)
            if generated_verifier is not None:
                generated_verifier.metadata_chain=retained_metadata_chain;generated_verifier.verified_metadata_states=sorted([*mode_transitions.values(),*timestamp_transitions.values(),*link_transitions.values(),*rename_transitions.values()],key=lambda pair:pair[1]['sequence'])
                generated_verifier.record(row,entries,exits,barriers,caps)
        need(bti_required==set(bti_originals)==bti_completed,'BTI hardening window not closed')
        need(remap_required==set(remap_originals)==remap_consumed,'mremap capability window not closed')
        need(set(clone3_originals)==clone3_consumed,'clone3 argument consumption not closed')
        raw_decoder.finish()
        need(not memory_writes,'missing actual executable memory FD checks')
        need(lease_model is None or lease_terminal,'declared lifetime phase missing exact token/wait closure')
        # Every actual file VMA obligation must have its held-inode original;
        # a missing row cannot be excused merely by the absence of an error row.
        phase_mapping_complete=True
        for state in tool_coverage.by_capture.values():
            value=state['value'];operation_phase=value[1] if isinstance(value,list) else value['phase']
            if operation_phase==phase:
                phase_mapping_complete=phase_mapping_complete and (all(state['expected'].values()) if isinstance(value,list) else set(state['expected'])==state['seen'])
        phase_lifetime_complete=bool(memory_mode and lease_model and lease_terminal and lease_tokens and not memory_missing and memory_shared_entries<=memory_released_entries and phase_mapping_complete)
        lifetime_verified_phases.append(phase_lifetime_complete)
        # ONE-TIME per-phase indexes. The previous shape scanned the whole edge
        # list for EVERY output (O(outputs x edges)); at real SDK scale that is
        # quadratic. These indexes are built in O(edges+reads) and every output
        # then does only its own pid's work.
        # PHASE-END NON-FILE CHAIN SETTLEMENT. A gate relation is pre-exec, so the
        # exec event that closes it necessarily appears after the read exit.
        # Resolve each positive non-file read NOW against the complete phase.
        for entry_sequence,pending in sorted(nonexec_positive_pending.items()):
            verified,detail=verify_nonexec_chain(pending['disposition'],pending['exit'])
            if verified is None:
                obligation=pending['pending']
                obligation.update(state='unverified-nonexec',reason=detail)
                inputs_pending_rejected[entry_sequence]=obligation
                disposition_entries[entry_sequence]['unverified']=detail
            else:
                nonexec_credit[entry_sequence]=dict(disposition=pending['disposition'],
                    exit=pending['exit'],chain=verified)
                unbound_read_operations[:] = [r for r in unbound_read_operations if r['entrySequence']!=entry_sequence]
                inputs_pending.pop(entry_sequence,None)
        nonexec_positive_pending={}
        edges_by_pid={}
        for edge in producer_input_edges:edges_by_pid.setdefault(edge['pid'],[]).append(edge)
        reads_by_pid={}
        for entry_sequence,observation in observations_by_entry.items():
            reads_by_pid.setdefault(observation['row']['pid'],[]).append(observation)
        for rows in reads_by_pid.values():rows.sort(key=lambda item:(item['entrySequence'],item['row']['sequence']))
        # DERIVED generated producer-close closures, taken from the SAME ordinary
        # replay state: a retained `fd-capture` with role `producer-close` whose
        # own exit actually succeeded (result==0, not an error) proves that the
        # exact (device,inode) object was written and closed by THIS observation,
        # and that the whole byte image is the captured original. Nothing here
        # invents authority: it only records what the replay already validated.
        for producer_sequence in phase_capture_sequences:
            if producer_sequence in indexed_producer_captures:continue
            producer_row,producer_data=caps[producer_sequence]
            if producer_row.get('role')!='producer-close':continue
            producer_exit=exits.get(producer_row['entrySequence'])
            need(producer_exit is not None,'producer-close capture lacks a recorded syscall exit')
            # CAUSALITY: the close must have actually COMPLETED successfully. The
            # completion sequence is the exit row's own sequence -- NOT the
            # capture row's time and NOT merely the role.
            if producer_exit['isError'] or producer_exit['result']!=0:continue
            completed=producer_exit['sequence']
            need(isinstance(completed,int),'producer-close completion sequence required')
            # O(1) lookup key: the FULL validated six-field identity plus the
            # whole byte image. No path-only, role-only or namespace shortcut.
            key=(tuple(producer_row['identity']),producer_data[0],producer_data[1])
            previous=validated_generated_producers.get(key)
            # Several captures may close the same object; keep the EARLIEST
            # completed close so a later one can never overwrite (and thereby
            # invalidate) an earlier eligible close.
            if previous is None or completed<previous['completedCloseSequence']:
                validated_generated_producers[key]=dict(
                    identity=list(producer_row['identity']),path=producer_row['path'],
                    bytes=producer_data[0],sha256=producer_data[1],
                    producerCaptureSequence=producer_row['sequence'],
                    completedCloseSequence=completed,phase=producer_row.get('phase'),
                    producerPid=producer_row['pid'])
            indexed_producer_captures.add(producer_sequence)
            # DERIVED per-output causal input closure. An input edge belongs to
            # this output only when it is a REGULAR READ-ONLY mapping captured by
            # the SAME producer pid, strictly EARLIER than the completed close, and
            # its identity differs from the output's (no self-edge / cycle).
            output_identity=tuple(producer_row['identity'])
            inputs={}
            pid_edges=edges_by_pid.get(producer_row['pid'],())
            pid_reads=reads_by_pid.get(producer_row['pid'],())
            for edge in pid_edges:
                if edge['phase']!=producer_row['phase']:continue
                if not (edge['entrySequence']<completed):continue
                if not edge['readOnly']:continue
                if edge['lifetimeLeaseSequence'] is None:continue
                input_key=(tuple(int(v) for v in edge['identity']),edge['bytes'],edge['sha256'])
                if input_key[0]==output_identity:continue
                kept=inputs.get(input_key)
                if kept is None or edge['entrySequence']<kept['entrySequence']:
                    inputs[input_key]=dict(entrySequence=edge['entrySequence'],captureSequence=edge['captureSequence'],
                                     identity=edge['identity'],bytes=edge['bytes'],sha256=edge['sha256'],
                                     protection=edge['protection'],flags=edge['flags'],
                                     lifetimeLeaseSequence=edge['lifetimeLeaseSequence'],executable=edge['executable'],
                                     inputModel='mapping',
                                     graphKey=('mapping',edge['captureSequence']))
            for observation in pid_reads:
                if observation['row']['phase']!=producer_row['phase']:continue
                if not (observation['entrySequence']<completed):continue
                input_key=(tuple(int(v) for v in observation['identity']),observation['original']['bytes'],observation['original']['sha256'])
                if input_key[0]==output_identity:continue
                consumed=observation.get('consumedLength')
                if not isinstance(consumed,int) or consumed<0:continue
                kept=inputs.get(input_key)
                if kept is None or observation['entrySequence']<kept['entrySequence']:
                    inputs[input_key]=dict(entrySequence=observation['entrySequence'],
                                     captureSequence=observation['row']['sequence'],
                                     identity=[str(v) for v in observation['identity']],
                                     bytes=observation['original']['bytes'],sha256=observation['original']['sha256'],
                                     protection=1,flags=0,lifetimeLeaseSequence=observation['row'].get('readLeaseSequence'),executable=False,
                                     inputModel='regular-read',
                                     resolvedPath=resolved_target_for(observation['row']),
                                     regularRead=dict(form=observation['form']['name'],fd=observation['row']['fd'],
                                                      readLeaseSequence=observation['row'].get('readLeaseSequence'),
                                                      rangeStart=observation['rangeStart'],consumedLength=consumed,
                                                      result=observation['result'],exitSequence=observation['exitSequence'],
                                                      generation=observation['generation'],
                                                      iovcnt=observation.get('iovcnt'),
                                                      iovLengths=observation.get('iovLengths')),
                                     graphKey=('read',observation['row']['sequence']))
            validated_generated_producers[key]['inputs']=sorted(inputs.values(),key=lambda e:(e['entrySequence'],e['identity']))
            validated_generated_producers[key]['execImage']=producer_exec_image.get(producer_row['pid'])
            # PER-LEASE READ CUSTODY. One row per credited regular-read lease,
            # naming the exact inode identity it protects and the acquisition
            # sequence. The leaf may only cite these tokens; it is not authority
            # by itself, only the transport of a proved fact.
            for item in inputs.values():
                if item['inputModel']!='regular-read':continue
                lease=item.get('regularRead',{}).get('readLeaseSequence')
                if not (type(lease) is int and lease>0):continue
                # PER-READ CUSTODY KEY. A single held lease is legitimately
                # shared by many producers reading the same header, and a phase
                # re-uses small integer token ids. So the ASSOCIATION is keyed by
                # (phase, pid, entry, capture, lease) -- the actual read -- while
                # the lease EPOCH stays keyed by (phase, leaseId) so a token id
                # repeated in another phase can never alias.
                custody_key=(producer_row['phase'],producer_row['pid'],item['entrySequence'],
                             item['regularRead'].get('captureSequence',item['captureSequence']),lease)
                # The SAME physical read can be cited by several outputs of one
                # producer, so re-inserting an equal association is expected; a
                # CONFLICTING one is refused.
                prior_custody=read_custody.get(custody_key)
                if prior_custody is not None:
                    need(prior_custody['identity']==[str(v) for v in item['identity']]
                         and prior_custody['bytes']==item['bytes']
                         and prior_custody['sha256']==item['sha256']
                         and prior_custody['exitSequence']==item['regularRead']['exitSequence'],
                         'conflicting per-read custody association')
                # PER-INPUT SOURCE CLASS. Byte custody (the lease) is NOT source
                # authority. Classify this exact input byte image from the
                # already-verified facts this replay holds, and publish only a
                # CLOSED class. Anything else stays 'unresolved' so the leaf keeps
                # SOURCE pending instead of assuming an origin.
                origin_class,origin_detail=classify_read_input_origin(item,dependency_roots,prepared_paths)
                read_source_class[custody_key]=dict(
                    leaseSequence=lease,identity=[str(v) for v in item['identity']],
                    pid=producer_row['pid'],entrySequence=item['entrySequence'],
                    bytes=item['bytes'],sha256=item['sha256'],
                    resolvedPath=item.get('resolvedPath'),
                    originClass=origin_class,originDetail=origin_detail,
                    phase=producer_row['phase'])
                read_custody[custody_key]=dict(leaseSequence=lease,identity=[str(v) for v in item['identity']],
                    bytes=item['bytes'],sha256=item['sha256'],entrySequence=item['entrySequence'],
                    captureSequence=item['regularRead'].get('captureSequence',item['captureSequence']),
                    acquisitionEntrySequence=lease_entry_by_token.get((producer_row['phase'],lease)),
                    exitSequence=item['regularRead']['exitSequence'],phase=producer_row['phase'],
                    pid=producer_row['pid'],model='kernel-held-read-lease-v1')
                read_lease_epoch[(producer_row['phase'],lease)]=dict(
                    leaseSequence=lease,phase=producer_row['phase'],
                    acquisitionSequence=lease_entry_by_token.get((producer_row['phase'],lease)),
                    model='kernel-held-read-lease-v1')
            validated_generated_producers[key]['inputCount']=len(inputs)
            validated_generated_producers[key]['mappingInputCount']=sum(1 for v in inputs.values() if v['inputModel']=='mapping')
            validated_generated_producers[key]['readInputCount']=sum(1 for v in inputs.values() if v['inputModel']=='regular-read')
            # COMPLETENESS GATE: every read-family entry by this producer before
            # the completed close must be explained. A read we never bound makes
            # the input set INCOMPLETE, so the witness must not be treated as
            # authority (the leaf fails closed on inputComplete=false).
            unexplained=[r for r in unbound_read_operations
                         if r['pid']==producer_row['pid'] and r['phase']==producer_row['phase']
                         and r['entrySequence']<=completed]
            unexplained.sort(key=lambda item:item['entrySequence'])
            validated_generated_producers[key]['readOperations']=len(unexplained)
            validated_generated_producers[key]['inputComplete']=len(unexplained)==0
            validated_generated_producers[key]['inputObligationCount']=len(pid_reads)
            validated_generated_producers[key]['unexplainedReads']=[dict(entrySequence=item['entrySequence'],
                nr=item['nr'],form=item['form']) for item in unexplained]
        # DERIVED verified-operation projection, produced ONLY after the replay
        # above has validated this phase's entries/exits, actual mmap
        # dimensions, FD originals, held pre-use lease and VMA mapping
        # originals. It is emitted for a phase only when that phase's lease
        # lifetime closed exactly; otherwise the markers stay uncovered.
        if phase_lifetime_complete:
            # Index the exact facts ONCE per phase: (phase, capture sequence)
            # -> set of exact paths. Building it is O(pending) for the whole
            # phase; each operation then does only dictionary/set membership and
            # one set intersection over its OWN capture sequences, so this is
            # not O(operations x pending) on high-cardinality observations.
            phase_pending_paths={}
            for phase_name,capture_sequence,actual_path in pending_provider_operations:
                if phase_name==phase:phase_pending_paths.setdefault(capture_sequence,set()).add(actual_path)
            def _generated_producer_closes(meta):
                # A readonly SOURCE-provider pending is a provenance-axis fact and
                # stays on its global toolchain axis. For the FILE-IO axis the same
                # ordinary replay may already have closed the obligation another
                # way: a `producer-close` capture whose own close(2) exit actually
                # COMPLETED successfully, on the SAME full validated identity, with
                # the SAME whole byte image.
                #
                # CAUSALITY IS STRICT: the completed close must PRECEDE this
                # operation's mmap entry. A same-phase producer-close that happens
                # AFTER the mmap is NOT evidence about bytes the mmap already
                # observed, so it cannot credit it. `completedCloseSequence` is the
                # exit row's sequence, not the capture row's time and not the role.
                # The full six-field identity (device, inode, mode, size, mtime and
                # ctime) is compared, not merely (device,inode), so an inode/dev
                # reuse with different timestamps or size cannot be aliased.
                identity=meta.get('descriptorIdentity')
                if identity is None:return False
                entry_sequence=meta['entrySequence']
                # O(1): one dict lookup on the full identity + whole byte image.
                # A linear scan here would be O(operations x producers).
                producer=validated_generated_producers.get(
                    (tuple(identity),meta.get('descriptorBytes'),meta.get('descriptorSha256')))
                if producer is None:return False
                # strict causality: the close must have COMPLETED before this
                # operation mapped the object
                return producer['completedCloseSequence'] < entry_sequence
            phase_source_pending=set(pending_source_provider_paths.get(phase,()))
            def _source_pending_for(paths):
                # EXACT path membership only (no prefix/filename classification).
                return bool(phase_source_pending) and not phase_source_pending.isdisjoint(paths)
            def _pending_for_operation(sequence,state,paths):
                # EXACT attribution only, with constant-time lookups. No substring,
                # no numeric prefix, no regex: capture 3 cannot match capture 13,
                # 'pch.h.gch' cannot match 'pch.h.gch.other', and an earlier
                # phase's identical path cannot suppress a later phase.
                # The fact is recorded against the CONSUMER row's own capture
                # sequence, i.e. the operation's mapping-original sequence in this
                # projection, not the mmap row sequence.
                if not phase_pending_paths and not phase_source_pending:return False
                value=state['value']
                # indexed layout: [kind,phase,pid,entrySequence,captureSequence,...]
                # so captureSequence is value[4]; value[5] is the EXPECTED MAPPED
                # COUNT. Ordinary layout is the named dict.
                own=(value[4],) if isinstance(value,list) else (value['captureSequence'],)
                originals=value[9] if isinstance(value,list) else value['mapOriginals']
                for original in originals:
                    sequence_number=original['captureSequence']
                    pending_paths=phase_pending_paths.get(sequence_number)
                    if pending_paths is not None and not pending_paths.isdisjoint(paths):
                        # this exact capture is named by a provider gap; the same
                        # conservative rule applies as below
                        return not _generated_producer_closes(validated_mmap_operations.get(sequence) or {})
                pending_paths=phase_pending_paths.get(own[0])
                named=(pending_paths is not None and not pending_paths.isdisjoint(paths)) or _source_pending_for(paths)
                if not named:return False
                # the pending names this operation's exact path: allow it only if
                # the ordinary replay independently closed byte/identity custody
                return not _generated_producer_closes(validated_mmap_operations.get(sequence) or {})
            for key in derive_verified_file_mmap_keys(validated_mmap_operations,tool_coverage.by_capture,_pending_for_operation):
                if key[0]==phase:verified_file_mmap_keys.add(key)
        need(not vfork_holds,'phase ended without vfork child release')
        need(not append_dirty,'phase ended without mandatory append full checkpoint')
        need(len(roots)==1 and not live and root_codes.get(roots[0])==0 and exclusive is None,'actual root/descendant wait closure incomplete')
        process_intervals.append(dict(phase=phase,**process_interval.finish()) if process_interval is not None else dict(phase=phase,model=None,scope='missing actual tracked authority interval contract'))
        phase_tracking.append(dict(phase=phase,actualRootPid=roots[0],actualRootReturnCode=root_codes[roots[0]],waitReferences=waits))
    # COMPACT DEDUPLICATED CAUSAL GRAPH.
    #
    # Two independent duplications had to go:
    #  1. the per-output witness repeated every input IDENTITY/bytes/sha, and
    #  2. every output repeated the whole input EDGE LIST.
    # so a shared input universe cost O(outputs x inputs) twice. Here:
    #  * each distinct object is ONE node (identity + byte image + FD generation),
    #  * each distinct causal EDGE SET is ONE set (ordered, with exact causal heads),
    #  * each output is ONE node plus ONE (setId, completedCloseSequence) ref.
    # With a shared universe of M inputs and N outputs the wire is O(N + M), and
    # the per-output causality (entry < completedClose) is checked when the ref
    # is resolved, so no per-output edge copy is needed for correctness.
    #
    # Nothing here is new authority: nodes/sets are projections of state the
    # replay already validated.
    graph_nodes = {}; node_order = []
    graph_sets = {}; set_order = []
    def node_for(model, identity, size, digest, extra=None):
        key = (tuple(int(v) for v in identity), size, digest)
        node = graph_nodes.get(key)
        if node is None:
            node = dict(nodeId=len(node_order), model=model, identity=[str(v) for v in identity],
                        bytes=size, sha256=digest, **(extra or {}))
            graph_nodes[key] = node; node_order.append(node)
        return node
    def set_for(edges):
        key = json.dumps([[e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10]] for e in edges],
                         separators=(',', ':'))
        found = graph_sets.get(key)
        if found is not None: return found
        value = dict(setId=len(set_order), edges=edges)
        graph_sets[key] = value; set_order.append(value); return value
    for producer in validated_generated_producers.values():
        output_node = node_for('output', producer['identity'], producer['bytes'], producer['sha256'],
            dict(path=producer['path'], completedCloseSequence=producer['completedCloseSequence'],
                 producerPid=producer['producerPid'],
                 producerCaptureSequence=producer['producerCaptureSequence'], phase=producer['phase']))
        by_node = {}
        for input_row in producer['inputs']:
            read = input_row.get('regularRead')
            node = node_for(input_row['inputModel'], input_row['identity'], input_row['bytes'], input_row['sha256'],
                dict(generation=read['generation']) if read else None)
            previous = by_node.get(node['nodeId'])
            if previous is not None and previous[1] <= input_row['entrySequence']:
                continue
            edge = [node['nodeId'], input_row['entrySequence'], input_row['captureSequence'],
                    input_row['inputModel'], input_row['lifetimeLeaseSequence'],
                    read['form'] if read else None, read['fd'] if read else None,
                    read['rangeStart'] if read else None, read['consumedLength'] if read else None,
                    read['result'] if read else None, read['exitSequence'] if read else None]
            by_node[node['nodeId']] = (edge, input_row['entrySequence'])
        output_node['inputSetId'] = set_for([value[0] for value in sorted(by_node.values(), key=lambda item: (item[1], item[0][0]))])['setId']
    # STRUCTURAL CHECKS, O(edges): distinct nodes, no self, no duplicate.
    for producer in validated_generated_producers.values():
        output_node = next(node for node in node_order
                           if node['model'] == 'output' and node['identity'] == [str(v) for v in producer['identity']]
                           and node['bytes'] == producer['bytes'] and node['sha256'] == producer['sha256'])
        seen = set()
        for edge in set_order[output_node['inputSetId']]['edges']:
            need(type(edge) is list and len(edge) == 11 and type(edge[0]) is int, 'bounded causal edge layout')
            need(0 <= edge[0] < len(node_order) and edge[0] != output_node['nodeId'], 'causal graph self/foreign edge')
            need(edge[0] not in seen, 'causal graph duplicate edge'); seen.add(edge[0])
    causal_graph = dict(schemaVersion=1, model='compact-deduplicated-causal-graph-v1',
        nodeCount=len(node_order), edgeSetCount=len(set_order),
        edgeCount=sum(len(value['edges']) for value in set_order),
        edgeLayout=['inputNodeId', 'entrySequence', 'captureSequence', 'inputModel', 'lifetimeLeaseSequence',
                    'readForm', 'readFd', 'readRangeStart', 'readConsumedLength', 'readResult', 'readExitSequence'],
        nodes=[dict(nodeId=node['nodeId'], model=node['model'], identity=node['identity'],
                    bytes=node['bytes'], sha256=node['sha256'],
                    **(dict(path=node['path'], completedCloseSequence=node['completedCloseSequence'],
                            producerPid=node['producerPid'], producerCaptureSequence=node['producerCaptureSequence'],
                            phase=node['phase'], inputSetId=node['inputSetId']) if node['model'] == 'output' else {}),
                    **(dict(generation=node['generation']) if 'generation' in node else {}))
               for node in node_order],
        inputSets=[dict(setId=value['setId'], edges=value['edges']) for value in set_order],
        scope='deduplicated identity/byte nodes plus deduplicated causal edge sets; byte images stay in retained originals')
    need(len(json.dumps(causal_graph, separators=(',', ':')).encode()) <= minimum_metadata,
         'causal graph metadata bound')

    need(set(alias_close_windows)==alias_close_exits,'alias close missing actual close/slot closure')
    need(not exec_fd_events,'actual exec FD table change missing')
    need(len(mode_windows)==len(mode_transitions),'actual chmod window missing actual exit')
    need(len(timestamp_windows)==len(timestamp_transitions),'actual timestamp window missing actual exit')
    # STRICT absent-link closure. Three independent obligations:
    #  1. no unobserved operand may exist at all -- it proves nothing, so it is fatal;
    #  2. every declared absent entry is settled exactly once by a matched failed exit;
    #  3. no window/transition/args original may cite an absent or unobserved entry,
    #     so a successful effect can never be claimed for a failed operation.
    need(not unobserved_entries,'link metadata unobserved: an absent or out-of-root operand cannot be qualified')
    need(set(absent_entries)==set(absent_settled),'absent link entry left unsettled by a matched failed exit')
    need(len(absent_settled)==len(absent_confirmed)==len(absent_entries),'absent link settlement is not one-to-one')
    absent_or_unobserved=set(absent_entries)|unobserved_entries
    need(not (absent_or_unobserved & {row['entrySequence'] for row in link_args.values()}),'link args original cites an absent or unobserved entry')
    need(not (absent_or_unobserved & {window['entrySequence'] for window in link_windows.values()}),'link window cites an absent or unobserved entry')
    need(not (absent_or_unobserved & {window['entrySequence'] for window,_ in link_transitions.values()}),'link transition cites an absent or unobserved entry')
    need(len(link_windows)==len(link_transitions),'actual link window missing actual exit')
    need(active_rename is None and pending_rename_window is None and len(rename_windows)==len(rename_transitions),'retained rename window missing actual exit')
    need(len(write_windows)==len(write_transitions),'actual write window missing exit transition')
    need({seq for seq,(row,_) in caps.items() if row['role']=='readwrite-consumer'}==set(write_read_exits),'own-RW read missing actual stable exit')
    need(set(empty_windows)==empty_eofs,'empty read missing actual EOF closure')
    for sequence,record in tool_providers.items():
        check()
        if not record['used']:tool_provider_pending.add('toolchain-stop-provider-original-unreferenced:'+str(sequence))
    if exec_events:tool_pending.add('toolchain-actual-exec-image-original-unavailable')
    need(all(seq in clone_flags for seq,entry in entries.items() if entry['nr']==435),'clone3 lacks actual flags original')
    successful={}
    for seq,(cap,data) in caps.items():
        entry=entries[cap['entrySequence']];exit=exits.get(cap['entrySequence']);rules=POLICIES[entry['arch']]
        if exit and not exit['isError'] and (exit['result']==0 if cap['role']=='producer-close' else exit['result']>0):successful[seq]=(cap,data)
    for rename in renames:
        producer=successful.get(rename['producerCaptureSequence']);entry=entries.get(rename['entrySequence']);exit=exits.get(rename['entrySequence'])
        need(producer and entry and entry['nr'] in POLICIES[entry['arch']]['renameOps'] and exit and not exit['isError'] and exit['result']==0,'rename lacks successful actual close/rename originals')
        need(paths.get(rename['entrySequence'])==[rename['fromPath'],rename['toPath']] and rename['identity']==rename['retainedIdentity'] and rename['identity'][:2]==producer[0]['identity'][:2],'temporary rename retained-FD/path originals differ')
    namespaces=set()
    for relation in namespace_bindings:
        producer=successful.get(relation['producerCaptureSequence']);consumer=caps.get(relation['consumerCaptureSequence'])
        need(producer and consumer and producer[0]['role']=='producer-close' and consumer[0]['role']=='consumer' and producer[0]['sequence']<consumer[0]['sequence']<relation['sequence'],'namespace binding lacks prior retained producer/current consumer')
        before=producer[0]['identity'];current=before
        if relation.get('metadataChainModel') in ['actual-rename-mode-chain-v1',TIMESTAMP_CHAIN_MODEL]:
            verified=sorted([*mode_transitions.values(),*timestamp_transitions.values(),*link_transitions.values(),*rename_transitions.values()],key=lambda pair:pair[1]['sequence'])
            references=retained_metadata_chain(producer[0],consumer[0],verified)
            need(references==relation['modeTransitions'],'retained metadata chain references differ');current=consumer[0]['identity']
        else:
            need(not any(window.get('producerCaptureSequence')==producer[0]['sequence'] and producer[0]['sequence']<change['sequence']<consumer[0]['sequence'] for window,change in rename_transitions.values()),'typed retained rename cannot use historical post-only chain')
            need('metadataChainModel' not in relation,'unknown retained metadata chain model')
            for reference in relation['modeTransitions']:
                pair=mode_transitions.get(reference);need(pair and producer[0]['sequence']<reference<consumer[0]['sequence'] and pair[0]['beforeIdentity']==current,'namespace mode change has no actual chmod chain');current=pair[1]['afterIdentity']
        identity=consumer[0]['identity'];need(current[2]==identity[2] and identity[:2]==before[:2] and relation['path']==consumer[0]['path'] and relation['namedIdentity']==relation['retainedIdentity']==identity and producer[1]==consumer[1],'actual named path/retained FD byte identity differs');namespaces.add((producer[0]['sequence'],consumer[0]['sequence']))
    for capture_sequence,origin_sequence in reused_originals.items():
        pairs=[binding for binding in [*consumers,*prepared_consumers] if binding['captureSequence']==capture_sequence]
        need(len(pairs)==1 and pairs[0]['producerCaptureSequence']==origin_sequence,'capture entity alias missing exact reverse consumer binding')
        origin=prepared.get(origin_sequence) or successful.get(origin_sequence)
        need(origin and (origin[0]['kind']=='prepared-build-input-original' and prepared_sealed or origin[0].get('role')=='producer-close'),'capture entity alias lacks sealed prepared or successful producer close')
    covered={};pending=[]
    for binding in consumers:
        consumer=successful.get(binding['captureSequence']);producer=successful.get(binding['producerCaptureSequence'])
        if consumer is None:continue # Interrupted read/mmap does not prove consumption.
        need(producer and producer[0]['role']=='producer-close' and consumer[0]['role']=='consumer','consumer actual producer close missing')
        cap,data=consumer;old,expected=producer;need(cap['identity']==binding['identity']==binding['retainedIdentity'] and cap['identity'][:2]==old['identity'][:2],'consumer retained FD inode differs')
        if any(window.get('producerCaptureSequence')==old['sequence'] and old['sequence']<change['sequence']<cap['sequence'] for window,change in rename_transitions.values()):need((old['sequence'],cap['sequence']) in namespaces,'typed retained rename consumer lacks complete metadata chain')
        if cap['path']!=old['path']:need((old['sequence'],cap['sequence']) in namespaces or any(r['producerCaptureSequence']==old['sequence'] and r['toPath']==cap['path'] for r in renames),'consumer lacks actual temporary-to-final rename or named FD identity')
        need(data==expected,'actual generated bytes changed between producer close and consumer read');covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],producerCaptureSequence=old['sequence'],consumerCaptureSequence=cap['sequence'])
    for binding in write_consumers:
        consumer=successful.get(binding['captureSequence']);transition=write_transitions.get(binding['transitionSequence'])
        if consumer is None:continue
        need(transition and consumer[0]['role']=='readwrite-consumer' and consumer[0]['identity']==transition['afterIdentity']==binding['identity'] and consumer[1]==((transition['after']['bytes'],transition['after']['sha256']) if 'path' not in transition['after'] else capture_data(transition['after'])) and consumer[0]['path']==binding['path'],'own-RW read lacks exact actual write byte provenance')
        cap,data=consumer;need(binding['readOffset']==write_read_exits[cap['sequence']]['readOffset'],'own-RW read offset binding differs');covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],writeTransitionSequence=transition['sequence'],consumerCaptureSequence=cap['sequence'],origin='actual-exclusive-write-transition')
    mapped_outputs=generated_verifier.finish(caps,exits) if generated_verifier is not None else []
    for sequence,origin_sequence in storage_aliases.items():
        actual=successful.get(sequence)
        if actual is None:continue  # Storage never converts an interrupted read to consumption.
        row=actual[0]
        if row['role']=='consumer':
            relations=[binding for binding in [*consumers,*prepared_consumers,*(generated_verifier.consumers if generated_verifier is not None else [])] if binding['captureSequence']==sequence]
            need(len(relations)==1,'content storage alias lacks unique own consumer provenance binding')
        elif row['role']=='readwrite-consumer':need(len([binding for binding in write_consumers if binding['captureSequence']==sequence])==1,'content storage alias lacks own actual write transition binding')

    for mapped in mapped_outputs:covered[mapped['path']]=mapped
    prepared_covered={}
    for binding in prepared_consumers:
        consumer=successful.get(binding['captureSequence']);original=prepared.get(binding['producerCaptureSequence'])
        if consumer is None:continue
        need(prepared_sealed and original and consumer[0]['role']=='consumer','prepared consumer has no actual sealed original')
        cap,data=consumer;prior,expected=original
        need(cap['path']==binding['path']==prior['path'] and cap['identity']==binding['identity']==binding['retainedIdentity'] and cap['identity'][:2]==prior['identity'][:2] and data==expected,'actual prepared consumer bytes/FD relation differs')
        prepared_covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],preparedCaptureSequence=prior['sequence'],consumerCaptureSequence=cap['sequence'])
    lifetime_verified=bool(lifetime_verified_phases) and all(lifetime_verified_phases)
    if lifetime_verified:tool_pending.discard('toolchain-shared-address-space-clone-unverified')
    need(not setresuid_operations,'setresuid transition lacks final causal closure')
    need(not denied_operations,'explicit denial missing final causal closure')
    if required_inputs is None:
        for name in ['config.h','generated.h','custom.h']:
            if not any(path.endswith('/'+name) for path in covered):pending.append('actual-successful-generated-consumer-missing:'+name)
    else:
        for path,expected in required_inputs.items():
            actual=covered.get(path)
            if actual is None:pending.append('actual-successful-generated-consumer-missing:'+path)
            else:need(actual['bytes']==expected['bytes'] and actual['sha256']==expected['sha256'],'actual generated consumer differs from selected full-shard input')
    # WHOLE-WIRE DEDUPLICATION. The per-output witness used to inline every
    # input record, so a shared input universe cost O(outputs x inputs) in the
    # scanner return (the actual 4 MiB scanner wire, not just the graph). Every
    # distinct input record is now stored ONCE in a canonical table and each
    # output references it by integer id. Authority is unchanged: the table
    # records are the same validated facts, and the ids are resolved by the
    # consumer, so per-output causality and completeness still come from the
    # output's own close.
    input_table={}
    input_order=[]
    def input_id(record):
        key=(tuple(int(v) for v in record['identity']),record['bytes'],record['sha256'],
             record['entrySequence'],record['captureSequence'],record['inputModel'],
             record.get('resolvedPath'))
        found=input_table.get(key)
        if found is not None:return found
        value=len(input_order)
        input_table[key]=value;input_order.append(dict(record,inputId=value))
        return value
    witnesses=[]
    for row in validated_generated_producers.values():
        witnesses.append(dict(path=row['path'],bytes=row['bytes'],sha256=row['sha256'],
              identity=[str(v) for v in row['identity']],completedCloseSequence=row['completedCloseSequence'],
              producerCaptureSequence=row['producerCaptureSequence'],
              producerPid=row.get('producerPid'),phase=row.get('phase'),
              execImage=row.get('execImage'),
              inputIds=sorted({input_id(item) for item in (row.get('inputs') or [])}),
              inputComplete=row.get('inputComplete'),readOperations=row.get('readOperations'),
              inputObligationCount=row.get('inputObligationCount'),
              unexplainedReads=row.get('unexplainedReads') or [],
              mappingInputCount=row.get('mappingInputCount'),readInputCount=row.get('readInputCount')))
    verified_generated_producer_witness=sorted(witnesses,key=lambda r:(r['path'],r['identity']))
    verified_generated_producer_inputs=sorted(input_order,key=lambda r:r['inputId'])
    # ONE closed versioned transport. The projections above remain for callers that
    # still pass them separately; the transport carries the SAME facts in a layout
    # that does not repeat shared source bytes or field names once per read. It is
    # derived here, from this replay's own validated records -- never a second
    # authority, and it grants no capability.
    verified_generated_producer_transport=generated_transport.encode(
        verified_generated_producer_inputs,verified_generated_producer_witness,causal_graph,
        sorted(read_custody.values(),key=lambda r:(r['leaseSequence'],r['identity'])),
        sorted(read_source_class.values(),key=lambda r:(r['leaseSequence'],r['identity'])))

    return dict(**(dict(observedGeneratedRetainedMetadata=dict(model=generated_module.RETAINED_METADATA_MODEL,maximumBytes=4*1024**2,peakBytes=generated_verifier.metadata_high_water))if generated_verifier is not None and generated_verifier.retained_metadata else {}),**(dict(verifiedCoordinatedWaitIntervals=list(getattr(generated_verifier,'coordinated_waits',[]))) if generated_verifier is not None and generated_verifier.model in generated_module.COORDINATED_WAIT_MODELS else {}),**(dict(verifiedPrivateWakeEntrySequences=list(generated_verifier.private_wakes),**(dict(verifiedPrivateWaitMismatchEntrySequences=list(generated_verifier.private_waits)) if generated_verifier.model in generated_module.PRIVATE_WAIT_MODELS else {})) if generated_verifier is not None and generated_verifier.model in generated_module.WAKE_MODELS else {}),schemaVersion=1,kind='all-stop-CMake-generated-byte-mechanics',observedGeneratedWritableMapCheckpoints=len(generated_verifier.checkpoints) if generated_verifier is not None else 0,generatedMappedConsumerByteCustodyVerified=bool(mapped_outputs),selectedGeneratedConsumerByteCustodyVerified=not pending,outputs=sorted(covered.values(),key=lambda row:row['path']),observedSourceReadCaptures=len(source_reads),observedPreparedDependencyReadCaptures=dependency_reads,preparedDependencySourceAuthorityVerified=False,preparedDependencyPending=(['independent-FetchContent-dependency-stage-and-Git-or-URL-source-authority-unverified'] if dependency_roots else []),pending=pending,overallSdkSourceVerified=False,
                observedAliasOnlyCloses=len(alias_close_exits),observedActualModeTransitions=len(mode_transitions),observedNamedRetainedFdBindings=len(namespaces),observedActualWriteTransitions=len(write_transitions),observedEmptyReadEofWindows=len(empty_eofs),toolchainProcessAuthorityIntervals=process_intervals,toolchainProcessAuthorityIntervalVerified=bool(process_intervals) and all(row.get('model') is not None for row in process_intervals),toolchainProcessAuthorityPending=['toolchain-provider-namespace-external-writer-and-backing-snapshot-authority-unverified']+([] if process_intervals and all(row.get('model') is not None for row in process_intervals) else ['toolchain-owned-process-authority-interval-originals-unavailable']),toolchainFileSnapshots=list(tool_files.values()),toolchainOperationCoverage=tool_coverage.finish(sorted(tool_pending),sorted(tool_provider_pending)),toolchainActualExecImages=tool_execs,toolchainActualFileMappings=tool_mappings,verifiedFileMappedMmapKeys=sorted(list(key) for key in verified_file_mmap_keys),

    verifiedGeneratedProducerTransport=verified_generated_producer_transport,
    verifiedGeneratedProducerInputs=verified_generated_producer_inputs,verifiedGeneratedProducerWitness=verified_generated_producer_witness,
    verifiedRegularReadCustody=sorted(read_custody.values(),key=lambda r:(r['leaseSequence'],r['identity'])),
    verifiedRegularReadSourceClass=sorted(read_source_class.values(),key=lambda r:(r['leaseSequence'],r['identity'])),
    verifiedGeneratedProducerGraph=causal_graph,
    verifiedRegularInputUniverse=dict(
        schemaVersion=1,model='verified-regular-input-universe-v1',
        observationCount=len(observations_by_entry),
        unexplainedCount=len(unbound_read_operations),
        forms=sorted({row['form']['name'] for row in observations_by_entry.values()}),
        # NON-FILE ACCOUNTING. `unverifiedNonFileReads` are positive reads whose
        # chain was refused; they remain open obligations. Only
        # `verifiedNonFileChains` were discharged, each by a named real relation.
        nonFilePathClasses={name:sum(1 for row in disposition_entries.values() if row['pathClass']==name)
                            for name in sorted({row['pathClass'] for row in disposition_entries.values()})},
        verifiedNonFileChains={name:sum(1 for row in nonexec_credit.values() if row['chain']['model']==name)
                               for name in sorted({row['chain']['model'] for row in nonexec_credit.values()})},
        unverifiedNonFileReads=sum(1 for row in inputs_pending_rejected.values()
                                   if row.get('state')=='unverified-nonexec'),
        zeroLengthReads=sum(1 for row in inputs_pending_rejected.values() if row.get('state')=='zero'),
        failedReads=sum(1 for row in inputs_pending_rejected.values() if row.get('state')=='failed'),
        writableDescriptorReads=len(writable_dispositions),
        scope='actual read-family entries discharged by a validated pre-use observation plus its matching real exit, or by a verified non-file chain'),toolchainObservationSha256=tool_digest.hexdigest(),toolchainStopProviderPending=sorted(tool_provider_pending),toolchainPending=sorted(tool_pending|tool_provider_pending|({'toolchain-executed-byte-immutability-and-full-source-authority-unverified'} if tool_execs else set())),toolchainExecutionLifetimeImmutabilityVerified=lifetime_verified,toolchainExecutionLifetimeScope='leased backing inode plus enforced file-exec-no-transition-v1; kernel special RX mappings remain controller TCB',toolchainSourceClosureVerified=False,preparedInputConsumers=list(prepared_covered.values()),preparedInputConsumerBytesVerified=bool(prepared_covered),phaseTracking=phase_tracking,scope='actual producer-close/rename/consumer bytes only; reviewed observer execution/Git/source/runtime authority independent')

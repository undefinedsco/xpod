"""Candidate-side service image/SDK relationship originals; no capability issuer.

The existing GitHub issuer must independently authenticate this exact closed
job, its whole source recipe and the SDK -> local-runtime -> service job chain.
Registry bytes and snapshots do not prove whole application/source/ABI closure.
"""
import io
import secrets
import tarfile
import hashlib
import importlib.util
import json
import os
import stat
import posixpath
from pathlib import Path
import re
import resource
import zlib
import shutil
import sys
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
images=load('sdk-image-originals');outer=load('sdk-readonly-executor');collection=load('sdk-readonly-collection');META=outer.binding.META;need=outer.binding.need
pack_bindings=load('sdk-service-pack-bindings');need(pack_bindings.META==META,'same canonical service pack metadata bound');pack_body_references=pack_bindings.pack_body_references;verify_pack_parent=pack_bindings.verify_pack_parent

def exact_image(value,repository):
    need(isinstance(value,str) and re.fullmatch(re.escape('ghcr.io/undefinedsco/'+repository)+r'@sha256:[a-f0-9]{64}',value),'fixed actual service image repository/digest');return value

def inspect_relationship(service,local,source_sha):
    need(service.get('os')==local.get('os')=='linux' and service.get('architecture')==local.get('architecture')=='amd64','actual service/local native target')
    first=local.get('rootfs',{}).get('diff_ids');last=service.get('rootfs',{}).get('diff_ids')
    need(isinstance(first,list) and first and isinstance(last,list) and len(last)>=len(first) and first==last[:len(first)] and all(outer.binding.digest(value) for value in last),'actual service rootfs must derive from exact local-runtime rootfs')
    labels=service.get('config',{}).get('Labels',{})
    need(labels.get('org.opencontainers.image.source')=='https://github.com/undefinedsco/xpod' and labels.get('org.opencontainers.image.revision')==source_sha,'actual service registry checkout labels')
    return dict(serviceRootfsFromLocalRuntimeVerified=True,wholeApplicationSourceVerified=False,runtimeAbiVerified=False,wholeSdkSourceVerified=False)

class Retained:
    def __init__(self,out,budget):
        self.out=out;self.budget=budget;self.total=0;self.refs={}
    def reserve(self,amount):
        self.budget.check(0);need(type(amount) is int and amount>=0 and self.total+amount<=32*META,'fixed service original universe before write');self.total+=amount;return amount
    def settle(self,reserved,refs,maximum_by_path=None):
        actual=0;maximum_by_path=maximum_by_path or {}
        for ref in refs:
            maximum=maximum_by_path.get(ref['path'],META)
            need(type(maximum) is int and 0<=maximum<=32*META and type(ref['bytes']) is int and 0<=ref['bytes']<=maximum and ref['path'] not in self.refs,'unique bounded actual service original')
            path=self.out/ref['path'];need(path.resolve(strict=True)==path and not path.is_symlink(),'canonical actual retained stage original')
            self.budget.check(0)
            named=path.lstat();need(stat.S_ISREG(named.st_mode) and named.st_nlink==1 and named.st_size==ref['bytes'],'bounded single-link regular stage original before open')
            fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC);sha=hashlib.sha256();count=0
            identity=lambda v:(v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
            primary=None
            try:
                before=identity(os.fstat(fd));need(before==identity(named),'actual stage original replaced before read')
                while True:
                    self.budget.check(0);block=os.read(fd,min(65536,ref['bytes']+1-count))
                    if not block:break
                    count+=len(block);need(count<=ref['bytes'],'stage original grew');sha.update(block)
                need(count==ref['bytes'] and sha.hexdigest()==ref['sha256'] and before==identity(os.fstat(fd))==identity(path.lstat()),'actual closed service original differs')
            except BaseException as error:
                primary=error
                raise
            finally:
                try:os.close(fd)
                except BaseException:
                    if primary is None:raise
            self.refs[ref['path']]=ref;actual+=count
        need(actual<=reserved,'actual fixed original exceeded reservation');self.total-=reserved-actual
    def save(self,name,data):
        need(isinstance(data,bytes) and len(data)<=META and name not in self.refs,'bounded unique source original before open');self.reserve(len(data));path=self.out/name;path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());self.refs[name]=ref;return ref

def retain_pack_body_stream(input_path,expected,retained):
    """Ordinary fixed-domain full body only; no role/schema authority.

    The eventual collector must supply its actual same-call body and typed role.
    This interface is not enabled by any recipe. Existing stdout/cp tar bytes
    remain independently charged; an extracted second copy costs actual bytes.
    """
    check=lambda:retained.budget.check(0)
    need(isinstance(expected,dict) and set(expected)=={'bytes','sha256'} and type(expected['bytes']) is int and expected['bytes']>=0 and isinstance(expected['sha256'],str) and re.fullmatch('[a-f0-9]{64}',expected['sha256']),'exact bounded body identity required')
    check();size=expected['bytes'];digest=expected['sha256'];remaining=32*META-retained.total
    if size>remaining:
        return dict(bodyOriginalCaptured=False,pending=['service-pack-body-exceeds-actual-retained-remaining'],expectedBytes=size,remainingBytes=remaining)
    path=Path(input_path);need(path.is_absolute() and path.resolve(strict=True)==path,'canonical actual body input required')
    name='output/service-pack-bodies/'+digest+'.original';need(name not in retained.refs,'body original already retained; explicit existing-ref join required')
    destination=retained.out/name;destination.parent.mkdir(parents=True,exist_ok=True)
    need(destination.parent.resolve(strict=True)==destination.parent,'body output parent must be canonical')
    parent=destination.parent.stat();parent_id=(parent.st_dev,parent.st_ino,parent.st_mode)
    fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW);written=0;sha=hashlib.sha256()
    def identity(value):return (value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
    try:
        initial=identity(os.fstat(fd));need(stat.S_ISREG(initial[2]) and initial[3]==size and identity(os.stat(path,follow_symlinks=False))==initial,'actual regular body input identity differs')
        with destination.open('xb') as output:
            while True:
                check();part=os.read(fd,min(65536,size+1-written))
                if not part:break
                need(written+len(part)<=size,'actual body grew while streaming')
                current=destination.parent.stat();need((current.st_dev,current.st_ino,current.st_mode)==parent_id,'actual body output parent changed')
                retained.reserve(len(part));need(output.write(part)==len(part),'actual body write incomplete');sha.update(part);written+=len(part)
            output.flush();os.fsync(output.fileno());output_identity=identity(os.fstat(output.fileno()))
            need(output_identity==identity(os.stat(destination,follow_symlinks=False)),'actual body output descriptor differs')
        check();need(written==size and sha.hexdigest()==digest,'actual body bytes/SHA differ')
        need(identity(os.fstat(fd))==initial==identity(os.stat(path,follow_symlinks=False)),'actual body input changed during capture')
        need(identity(os.stat(destination,follow_symlinks=False))==output_identity and output_identity[3]==written,'actual retained body identity differs')
        ref=dict(path=name,bytes=written,sha256=digest);retained.refs[name]=ref
        return dict(bodyOriginalCaptured=True,original=ref,pending=['same-call-pack-body-role-and-tar-membership-unverified'])
    finally:os.close(fd)

def retain_pack_body_tar(input_ref,expected,retained):
    """Single fixed-basename cp TAR byte mechanics; not a body-role issuer.

    The raw cp TAR must already be a full retained original in this same ledger.
    The extracted physical copy is separately charged before every actual write.
    """
    check=lambda:retained.budget.check(0)
    need(isinstance(input_ref,dict) and set(input_ref)=={'path','bytes','sha256'} and isinstance(input_ref.get('path'),str) and retained.refs.get(input_ref['path'])==input_ref,'same retained raw cp tar required')
    need(isinstance(expected,dict) and set(expected)=={'path','bytes','sha256'} and isinstance(expected.get('path'),str) and re.fullmatch(r'service-pack-bodies/objects/[0-9]{4}-[a-f0-9]{64}\.original',expected['path']) and expected['path'].split('-')[-1]==expected['sha256']+'.original' and type(expected['bytes']) is int and expected['bytes']>=0 and isinstance(expected['sha256'],str) and re.fullmatch('[a-f0-9]{64}',expected['sha256']),'exact expected body identity required')
    check();remaining=32*META-retained.total
    if expected['bytes']>remaining:return dict(bodyOriginalCaptured=False,pending=['service-pack-body-exceeds-actual-retained-remaining'])
    raw_path=retained.out/input_ref['path'];need(raw_path.is_absolute() and raw_path.resolve(strict=True)==raw_path,'canonical retained raw tar required')
    size=input_ref['bytes'];need(type(size) is int and 0<size<=32*META,'bounded retained raw tar size');fd=os.open(raw_path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
    output_name='output/'+expected['path'];need(output_name not in retained.refs,'duplicate body needs explicit existing-ref join')
    output=retained.out/output_name;output.parent.mkdir(parents=True,exist_ok=True);need(output.parent.resolve(strict=True)==output.parent,'canonical body output parent');parent=output.parent.stat();parent_identity=(parent.st_dev,parent.st_ino,parent.st_mode)
    raw_digest=hashlib.sha256();raw_count=0
    class Raw:
        def read(self,n):
            nonlocal raw_count
            check();need(type(n) is int and 0<=n<=65536,'fixed tar read window');block=os.read(fd,min(n,size+1-raw_count));raw_count+=len(block);need(raw_count<=size,'retained raw tar grew');raw_digest.update(block);return block
    class OrdinaryOnly(load('sdk-debian-binary-originals').TarHeaderGuard):
        def read(self,n):
            block=super().read(n);need(self.ledger['members']==0,'extended pack body tar metadata refused');return block
    try:
        first=identity(os.fstat(fd));need(stat.S_ISREG(first[2]) and first[3]==size and first==identity(raw_path.lstat()),'actual raw tar identity differs')
        guard=OrdinaryOnly(Raw(),dict(bytes=0,members=0),check,metadata_members=4);seen=False;body_digest=hashlib.sha256();count=0
        with tarfile.open(fileobj=guard,mode='r|',bufsize=10240) as archive:
            for member in archive:
                check();need(not seen and member.name==Path(expected['path']).name and member.type in (tarfile.REGTYPE,tarfile.AREGTYPE) and not member.linkname and member.size==expected['bytes'],'exact single regular body member required');seen=True
                with archive.extractfile(member) as source,output.open('xb') as target:
                    while count<member.size:
                        check();block=source.read(min(65536,member.size-count));need(block,'short actual body tar member');current=output.parent.stat();need((current.st_dev,current.st_ino,current.st_mode)==parent_identity,'body output parent changed');retained.reserve(len(block));need(target.write(block)==len(block),'short actual body write');count+=len(block);body_digest.update(block)
                    target.flush();os.fsync(target.fileno());written_identity=identity(os.fstat(target.fileno()));need(written_identity==identity(output.lstat()),'retained body fd/path differs')
        while guard.read(65536):check()
        need(seen and count==expected['bytes'] and body_digest.hexdigest()==expected['sha256'],'complete actual body member digest differs')
        need(raw_count==size and raw_digest.hexdigest()==input_ref['sha256'] and first==identity(os.fstat(fd))==identity(raw_path.lstat()),'retained full raw tar changed')
        need(written_identity==identity(output.lstat()),'body changed after tar closure');ref=dict(path=output_name,bytes=count,sha256=body_digest.hexdigest());retained.refs[output_name]=ref
        return dict(bodyOriginalCaptured=True,original=ref,rawTarOriginal=input_ref,pending=['same-call-pack-body-role-and-input-closure-unverified'])
    finally:os.close(fd)

OUTPUT_INSPECT_TEMPLATE='{{json .}}'
OUTPUT_LABEL='xpod.service-output-owner'
OUTPUT_TAR_LIMIT=256*1024
OUTPUT_MANIFEST_LIMIT=128*1024
OUTPUT_ROLES=('pull','create','inspect','copy','remove','confirm-absent')
LIMITS=json.loads((HERE.parents[1]/'scripts/lib/module-artifact-limits.json').read_text())
RUNTIME_ROOTS=(('/app','app','copy-runtime-app'),('/opt/xpod/qlever','qlever','copy-runtime-sdk'))
RUNTIME_ROLES=tuple(role for _,_,role in RUNTIME_ROOTS)
RUNTIME_MEMBER_MAXIMUM=50000

OUTPUT_PACK_ROLE=pack_bindings.OUTPUT_PACK_ROLE
OUTPUT_PACK_PHASE_ROLE=pack_bindings.OUTPUT_PACK_PHASE_ROLE
OUTPUT_PACK_BODY_ROLE=pack_bindings.OUTPUT_PACK_BODY_ROLE


RUNTIME_KIND='actual-service-image-runtime-members-v1'
RUNTIME_META_MAXIMUM=4096
RUNTIME_CLEANUP_ROOM=14*META

def shared_runtime_cp_bound(retained,remaining_roots):
    """Remaining ordinary 32*META budget after fixed metadata/cleanup room."""
    need(type(remaining_roots) is int and remaining_roots>0,'runtime root share count')
    available=32*META-retained.total-RUNTIME_CLEANUP_ROOM
    share=(available-remaining_roots*3*META)//(2*remaining_roots)
    need(share>0,'service runtime cp remaining budget unavailable')
    return share

def _pax_records(raw):
    rows={};at=0
    while at<len(raw):
        space=raw.find(b' ',at);need(space>at,'pax record length')
        try:length=int(raw[at:space])
        except ValueError:raise ValueError('pax record length') from None
        need(length>space-at+1 and at+length<=len(raw) and raw[at+length-1:at+length]==b'\n','pax record bound')
        key,equals,value=raw[space+1:at+length-1].partition(b'=');need(equals and key,'pax key/value')
        name=key.decode('utf-8','strict');text=value.decode('utf-8','strict')
        need(name not in rows,'duplicate pax key')
        need(name in ['path','linkpath','size'] or (name in ['mtime','atime','ctime'] and re.fullmatch(r'-?[0-9]+(?:\.[0-9]+)?',text)),'unexpected pax key');rows[name]=text
        at+=length
    return rows

def _octal(raw,what):
    text=raw.split(b'\0')[0].strip()
    if not text:return 0
    try:value=int(text,8)
    except ValueError:raise ValueError('actual tar '+what) from None
    return value

RUNTIME_CODEC_MARKER=b'\nXPOD_RUNTIME_GZIP_BLOCKS_V1\n'

class runtime_gzip_reader:
    """Decode one indexed gzip member at a time; never materialize logical tar."""
    def __init__(self,fd,index,physical_size,check):
        self.fd,self.index,self.check=fd,index,check;self.number=0;self.pending=b'';self.at=0;self.packed_hash=hashlib.sha256();self.logical_hash=hashlib.sha256()
        need(isinstance(index,dict) and set(index)=={'schemaVersion','kind','archive','expanded','blocks'} and index['schemaVersion']==1 and index['kind']=='source-tar-gzip-block-index','runtime gzip index schema')
        need(isinstance(index['expanded'],dict) and set(index['expanded'])=={'bytes','sha256'} and type(index['expanded']['bytes']) is int and 0<index['expanded']['bytes']<=LIMITS['shardBytes'] and re.fullmatch('[a-f0-9]{64}',index['expanded']['sha256']),'runtime gzip logical bound')
        need(index['archive']['bytes']==physical_size,'runtime gzip physical size');blocks=index['blocks'];need(isinstance(blocks,list) and 0<len(blocks)<=(LIMITS['shardBytes']+65535)//65536,'runtime gzip block count')
        packed=logical=0
        for i,row in enumerate(blocks):
            check();need(isinstance(row,dict) and set(row)=={'offset','bytes','expandedOffset','expandedBytes'} and all(type(v) is int for v in row.values()) and row['offset']==packed and row['expandedOffset']==logical and 18<=row['bytes']<=65536+1024 and 0<row['expandedBytes']<=65536 and (i==len(blocks)-1 or row['expandedBytes']==65536),'runtime gzip contiguous blocks')
            packed+=row['bytes'];logical+=row['expandedBytes']
        need(packed==physical_size and logical==index['expanded']['bytes'],'runtime gzip index closure')
    def read(self,amount):
        self.check()
        if self.at==len(self.pending):
            if self.number==len(self.index['blocks']):return b''
            row=self.index['blocks'][self.number];packed=os.pread(self.fd,row['bytes'],row['offset']);need(len(packed)==row['bytes'],'runtime gzip short physical block')
            need(packed[:4]==b'\x1f\x8b\x08\x00' and packed[4:8]==bytes(4),'runtime gzip canonical header')
            decoder=zlib.decompressobj(31);raw=decoder.decompress(packed,65537);need(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail and len(raw)==row['expandedBytes'],'runtime gzip exact bounded block')
            self.packed_hash.update(packed);self.logical_hash.update(raw);self.pending=raw;self.at=0;self.number+=1
        count=min(amount,len(self.pending)-self.at);result=self.pending[self.at:self.at+count];self.at+=count;return result
    def finish(self):
        need(self.number==len(self.index['blocks']) and self.at==len(self.pending) and self.packed_hash.hexdigest()==self.index['archive']['sha256'] and self.logical_hash.hexdigest()==self.index['expanded']['sha256'],'runtime gzip complete dual SHA')

def scan_runtime_tar(path,root,archive_root,check,encoding=None):
    """Strict streaming actual docker-cp tar scan; no extraction, no huge Buffer.

    Returns rows with exact data offsets and header digests, the whole archive
    SHA, and total member content bytes. Only file/directory/symlink rows exist;
    every other tar entry type fails closed instead of being omitted.
    """
    need(isinstance(root,str) and root.startswith('/') and not root.endswith('/'),'fixed absolute runtime root')
    need(isinstance(archive_root,str) and re.fullmatch(r'[a-z0-9][a-z0-9._-]*',archive_root),'canonical archive root name')
    named=path.lstat();need(stat.S_ISREG(named.st_mode) and named.st_nlink==1,'single bounded runtime tar original')
    physical_size=named.st_size;need(0<physical_size<=32*META,'runtime tar byte bound');size=encoding['expanded']['bytes'] if encoding else physical_size;need(type(size) is int and 0<size<=LIMITS['shardBytes'],'runtime logical tar bound')
    fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
    decoded=runtime_gzip_reader(fd,encoding,physical_size,check) if encoding else None
    digest=hashlib.sha256();offset=0;ended=False;members=[];seen=set();content=0;pax={};long_name=None;long_link=None;prefix=archive_root+'/'
    def read_exact(amount):
        nonlocal offset
        check();data=bytearray()
        while len(data)<amount:
            check();block=decoded.read(min(65536,amount-len(data))) if decoded else os.read(fd,min(65536,amount-len(data)))
            if not block:raise ValueError('short actual runtime tar')
            data.extend(block)
        digest.update(data);offset+=len(data);return bytes(data)
    def header_name(raw,entry_type):
        name=raw[0:100].split(b'\0')[0];magic=raw[257:263]
        if magic in (b'ustar\0',b'ustar '):
            name=raw[345:500].split(b'\0')[0]+b'/'+name if raw[345:500].split(b'\0')[0] else name
        return name.decode('utf-8','strict'),raw[157:257].split(b'\0')[0].decode('utf-8','strict')
    try:
        initial=(named.st_dev,named.st_ino,named.st_mode,named.st_size,named.st_mtime_ns,named.st_ctime_ns,named.st_nlink)
        need((lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink))(os.fstat(fd))==initial,'runtime tar replaced before scan')
        while True:
            check()
            if offset>=size:break
            if size-offset<512:raise ValueError('truncated runtime tar header')
            header=read_exact(512)
            if header==bytes(512):
                need(size-offset>=512 and read_exact(512)==bytes(512),'runtime tar requires two zero EOF blocks');ended=True
                # The remaining stream must be zero padding only.
                while offset<size:
                    check();block=read_exact(min(65536,size-offset));need(block==bytes(len(block)),'runtime tar trailing data')
                break
            stored=_octal(header[148:156],'checksum');actual=sum(bytearray(header[:148]))+32*8+sum(bytearray(header[156:]))
            need(stored==actual,'runtime tar header checksum')
            raw_type=header[156:157];entry_type=raw_type.decode('latin-1')
            length=_octal(header[124:136],'member size')
            need(length<=32*META,'runtime tar member byte bound')
            if entry_type in ('x','g'):
                need(length<=LIMITS['metadataBytes'],'bounded runtime pax block')
                payload=read_exact(length);read_exact((512-length%512)%512)
                records=_pax_records(payload)
                if entry_type=='x':pax.update(records)
                else:need(False,'global pax metadata refused')
                continue
            if entry_type in ('L','K'):
                need(length<=4096,'bounded GNU long name');payload=read_exact(length).rstrip(b'\0').decode('utf-8','strict');read_exact((512-length%512)%512)
                need(entry_type=='L' and long_name is None,'GNU long link metadata refused');long_name=payload;continue
            name,linkname=header_name(header,entry_type)
            if 'path' in pax:name=pax.pop('path')
            if 'linkpath' in pax:linkname=pax.pop('linkpath')
            if 'size' in pax:
                need(str(length)==pax.pop('size'),'pax size differs from header')
            for key in ['mtime','atime','ctime']:pax.pop(key,None)
            need(not pax,'unconsumed pax metadata')
            if long_name is not None:name=long_name;long_name=None
            need(long_link is None,'unconsumed GNU link metadata')
            if entry_type=='5' and name.rstrip('/')==archive_root:path_part=''
            else:
                need(name.startswith(prefix),'runtime tar member outside declared root')
                path_part=name[len(prefix):].rstrip('/')
                need((path_part or entry_type=='5') and not re.search(r'[\u0000-\u001f\u007f\\]',path_part) and not any(part in ('','.','..') for part in path_part.split('/')),'canonical runtime member path')
            need(path_part not in seen,'duplicate runtime member path');seen.add(path_part)
            need(len(members)<min(LIMITS['members'],RUNTIME_MEMBER_MAXIMUM),'runtime member count bound')
            mode=_octal(header[100:108],'member mode');need(0<=mode<=0o7777,'runtime member mode')
            data_offset=offset
            if entry_type in ('0','\0','7'):
                need(length==0 or entry_type!='7','runtime contiguous file only')
                remaining=length;member_digest=hashlib.sha256()
                while remaining:
                    check();block=read_exact(min(65536,remaining));member_digest.update(block);remaining-=len(block)
                read_exact((512-length%512)%512)
                content+=length;need(content<=(LIMITS['shardBytes'] if encoding else 32*META),'runtime member aggregate byte bound')
                members.append(dict(path=path_part,type='file',mode=mode,bytes=length,sha256=member_digest.hexdigest(),offset=data_offset))
            elif entry_type=='5':
                need(length==0 and not linkname,'runtime directory shape')
                members.append(dict(path=path_part,type='directory',mode=mode,bytes=0))
            elif entry_type=='2':
                need(length==0,'runtime symlink size');need(0<len(linkname)<=4096 and not re.search(r'[\u0000-\u001f\u007f\\]',linkname),'runtime symlink target')
                if linkname.startswith('/'):
                    target=posixpath.normpath(linkname);need(target==root or target.startswith(root+'/'),'runtime symlink escapes declared root')
                else:
                    target=posixpath.normpath(posixpath.join(posixpath.dirname(root+'/'+path_part),linkname))
                    need(target.startswith('/') and not target.startswith('//'),'runtime symlink target form')
                need(target==root or target.startswith(root+'/'),'runtime symlink escapes declared root')
                members.append(dict(path=path_part,type='symlink',mode=mode,bytes=0,target=linkname))
            else:
                raise ValueError('runtime special tar member type '+repr(entry_type)+' for '+path_part)
        need(ended,'runtime tar requires two zero EOF blocks')
        if decoded:decoded.finish()
        final=(lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink))(os.fstat(fd))
        need(offset==size and final==initial==(lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink))(path.lstat()),'runtime tar changed during scan')
    finally:os.close(fd)
    need(members and members[0]['type']=='directory' and members[0]['path']=='','runtime archive root member required')
    check();return members,digest.hexdigest(),content

def stage_owner_nonce(stage,retained):
    raw=outer.bounded_original(retained.out/stage['receipt']['path'],META,lambda:retained.budget.check(10));command=json.loads(raw)['command'];need(command.count('--owner-nonce')==1,'runtime worker nonce argument');nonce=command[command.index('--owner-nonce')+1];need(re.fullmatch('[a-f0-9]{32}',nonce),'runtime worker nonce');return nonce

def capture_runtime_root(retained,role,stage,root,archive_root,image,config,cid,check):
    """Verify one actual docker-cp tar and index the held stdout original.

    No second physical copy exists: the parsed index references the same closed
    stage stdout original and every member's exact tar data offset/link target.
    """
    need(root in [value for value,_,_ in RUNTIME_ROOTS],'declared runtime root')
    stdout=stage['stdout'];raw_path=retained.out/stdout['path'];need(stdout['bytes']<=32*META,'runtime stage stdout bound');need(retained.refs.get(stdout['path'])==stdout,'same held runtime stage stdout original')
    stderr=outer.bounded_original(retained.out/stage['stderr']['path'],META,check);marker=stderr.rfind(RUNTIME_CODEC_MARKER);need(marker>=0,'actual runtime worker gzip codec closure required');encoding=None
    if marker>=0:
        state=json.loads(stderr[marker+len(RUNTIME_CODEC_MARKER):]);need(isinstance(state,dict) and set(state)=={'expanded','blocks','encoded','process'},'runtime stream codec state')
        process=state['process'];nonce=stage_owner_nonce(stage,retained);need(isinstance(process,dict) and set(process)=={'command','pid','exit','actualWait','stdoutEof','stderrEof','stderrBytes','stderrSha256'},'runtime codec process schema');need(process.get('command')==output_image_command(role,image,'xpod-service-output-'+nonce,nonce,cid) and type(process.get('pid')) is int and process['pid']>0 and type(process.get('exit')) is int and process['exit']==0 and process.get('actualWait') is True and process.get('stdoutEof') is True and process.get('stderrEof') is True and type(process.get('stderrBytes')) is int and process['stderrBytes']==marker and process.get('stderrSha256')==hashlib.sha256(stderr[:marker]).hexdigest(),'runtime codec actual child dual EOF/wait')
        need(state['encoded']=={'bytes':stdout['bytes'],'sha256':stdout['sha256']},'runtime codec complete encoded stdout')
        encoding=dict(schemaVersion=1,kind='source-tar-gzip-block-index',archive=stdout,expanded=state['expanded'],blocks=state['blocks'])
    members,archive_sha,content=scan_runtime_tar(raw_path,root,archive_root,check,encoding)
    need(archive_sha==(encoding['expanded']['sha256'] if encoding else stdout['sha256']),'runtime tar scan digest differs from closed stdout')
    evidence=sorted(path for path in [row['path'] for row in members] if root=='/app' and (path=='provenance' or path.startswith('provenance/')))
    need(len(evidence)<=RUNTIME_META_MAXIMUM,'bounded actual /app provenance inventory')
    index=dict(schemaVersion=1,kind=RUNTIME_KIND,imageReferenceByDigest=image,configDigest=config,containerId=cid,targetRoot=root,archiveRoot=archive_root,archive=dict(path=stdout['path'],bytes=stdout['bytes'],sha256=stdout['sha256']),members=members,memberContentBytes=content,evidencePayloadPaths=evidence,**(dict(encoding=encoding) if encoding else {}),sourceCoverageInferred=False,wholeServiceSourceVerified=False)
    raw=json.dumps(index,separators=(',',':'),sort_keys=True).encode()
    need(len(raw)<=LIMITS['metadataBytes'],'runtime member index metadata bound')
    reference=retained.save('output/service-runtime-members/'+role+'.original.json',raw)
    check();return dict(schemaVersion=1,kind=RUNTIME_KIND,imageReferenceByDigest=image,configDigest=config,containerId=cid,targetRoot=root,archiveRoot=archive_root,archive=index['archive'],index=reference,members=len(members),memberContentBytes=content,declaredRootMember=root,evidencePayloadInventoried=root=='/app' and bool(index['evidencePayloadPaths']),sourceCoverageInferred=False,wholeServiceSourceVerified=False)

def output_image_command(mode,image,name,nonce,cid=None,body_path=None):
    exact_image(image,'xpod')
    need(isinstance(nonce,str) and re.fullmatch('[a-f0-9]{32}',nonce) and name=='xpod-service-output-'+nonce,'unique owned service output namespace')
    need(mode in (*OUTPUT_ROLES,*RUNTIME_ROLES,OUTPUT_PACK_ROLE,OUTPUT_PACK_PHASE_ROLE,OUTPUT_PACK_BODY_ROLE,'cleanup-list','cleanup-inspect','cleanup-remove','cleanup-confirm-absent'),'fixed service output stage')
    if mode not in ('pull','create','cleanup-list'):need(isinstance(cid,str) and re.fullmatch('[a-f0-9]{64}',cid),'full owned output container ID')
    if mode=='pull':command=['docker','pull','--platform','linux/amd64',image]
    elif mode=='create':command=['docker','container','create','--pull=never','--platform','linux/amd64','--name',name,'--label',OUTPUT_LABEL+'='+nonce,'--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--no-healthcheck','--restart','no',image]
    elif mode in ('inspect','cleanup-inspect'):command=['docker','container','inspect','--format',OUTPUT_INSPECT_TEMPLATE,cid]
    elif mode=='copy':command=['docker','cp',cid+':/app/package.json','-']
    elif mode in RUNTIME_ROLES:command=['docker','cp',cid+':'+next(root for root,_,role in RUNTIME_ROOTS if role==mode),'-']
    elif mode==OUTPUT_PACK_ROLE:command=['docker','cp',cid+':/app/provenance/service-pack-originals','-']
    elif mode==OUTPUT_PACK_PHASE_ROLE:command=['docker','cp',cid+':/app/provenance/service-pack-phase','-']
    elif mode==OUTPUT_PACK_BODY_ROLE:
        need(isinstance(body_path,str) and re.fullmatch(r'service-pack-bodies/objects/[0-9]{4}-[a-f0-9]{64}\.original',body_path),'fixed pack body path')
        command=['docker','cp',cid+':/app/provenance/'+body_path,'-']
    elif mode in ('remove','cleanup-remove'):command=['docker','container','rm','--force','--volumes',cid]
    elif mode=='cleanup-list':command=['docker','container','ls','--all','--no-trunc','--filter','name=^/'+name+'$','--filter','label='+OUTPUT_LABEL+'='+nonce,'--format','{{.ID}}']
    else:command=['docker','container','ls','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}']
    return outer.binding.local_docker(command)

def image_worker(args):
    need(re.fullmatch('[a-f0-9]{40}',args.source_sha) and Path(args.source).resolve(strict=True)==Path(args.source),'actual image worker source tuple')
    command=output_image_command(args.image_worker,args.service_image,args.container_name,args.owner_nonce,args.container_id,getattr(args,'body_path',None))
    maximum=OUTPUT_TAR_LIMIT if args.image_worker=='copy' else META
    if args.image_worker in RUNTIME_ROLES:
        maximum=args.copy_byte_bound;need(type(maximum) is int and 0<maximum<=32*META,'fixed actual runtime cp stream bound')
    if args.image_worker in [OUTPUT_PACK_BODY_ROLE,OUTPUT_PACK_PHASE_ROLE]:
        maximum=args.copy_byte_bound;need(type(maximum) is int and 0<maximum<=32*META,'fixed actual cp stream bound')
    resource.setrlimit(resource.RLIMIT_FSIZE,(maximum,maximum))
    if args.image_worker in RUNTIME_ROLES:
        codec=load('sdk-service-runtime-stream')
        def check():need(shutil.disk_usage(args.source).free>=LIMITS['freeFloorBytes'],'runtime codec disk reserve')
        state=codec.encode_process(command,sys.stdout.buffer,sys.stderr.buffer,maximum,check)
        footer=RUNTIME_CODEC_MARKER+json.dumps(state,separators=(',',':'),sort_keys=True).encode()+b'\n'
        need(state['process']['stderrBytes']+len(footer)<=META,'runtime codec stderr/index metadata bound');sys.stderr.buffer.write(footer);sys.stderr.buffer.flush();return
    os.execvp(command[0],command)

def inspect_output_container(raw,image,config,cid,name,nonce,*,require_never_started=True):
    value=json.loads(raw)
    need(isinstance(value,dict) and value.get('Id')==cid and value.get('Image')==config and value.get('Name')=='/'+name,'actual stopped output CID/config/name')
    configuration=value.get('Config',{});state=value.get('State',{})
    need(configuration.get('Image')==image and configuration.get('Labels',{}).get(OUTPUT_LABEL)==nonce,'actual output image digest/owner nonce')
    if require_never_started:need(state.get('Running') is False and state.get('Status')=='created' and state.get('Pid')==0 and state.get('StartedAt')=='0001-01-01T00:00:00Z','output container must never have started')
    return value

def service_manifest_tar(path,check):
    # The exact original stream is kept as well as the extracted raw bytes.
    raw=outer.bounded_original(path,OUTPUT_TAR_LIMIT,check)
    guard=load('sdk-debian-binary-originals').TarHeaderGuard(io.BytesIO(raw),dict(bytes=0,members=0),check,metadata_members=4)
    original=None
    with tarfile.open(fileobj=guard,mode='r|',bufsize=10240) as archive:
        for item in archive:
            check();need(original is None and item.name=='package.json' and item.type in (tarfile.REGTYPE,tarfile.AREGTYPE) and not item.linkname and 0<item.size<=OUTPUT_MANIFEST_LIMIT,'single bounded regular service package.json only')
            pieces=[];count=0
            with archive.extractfile(item) as source:
                while True:
                    check();block=source.read(min(65536,item.size+1-count))
                    if not block:break
                    count+=len(block);need(count<=item.size,'service package original grew');pieces.append(block)
            need(count==item.size,'service package original truncated');original=b''.join(pieces)
    while guard.read(65536):check()
    need(original is not None and isinstance(json.loads(original),dict),'actual service root JSON object required')
    return original

def service_pack_sidecar_tar(path,check,*,phase=False):
    """Draft bounded ordinary-original reader; not wired to image acquisition.

    The fixed same-call pack writer/export must exist before a producer recipe
    may invoke this. Metadata capture is never proof that declared tar archives,
    resolver probes or package sources were actually retained/verified.
    """
    root_name='service-pack-phase' if phase else 'service-pack-originals';maximum=4*META if phase else META
    raw=outer.bounded_original(path,maximum,check)
    class OrdinaryOnly(load('sdk-debian-binary-originals').TarHeaderGuard):
        def read(self,size=-1):
            block=super().read(size)
            need(self.ledger['members']==0,'extended GNU/PAX pack sidecar metadata refused before interpretation')
            return block
    guard=OrdinaryOnly(io.BytesIO(raw),dict(bytes=0,members=0),check,metadata_members=4)
    originals={};collection=None;index_original=None;seen=set();total=0
    with tarfile.open(fileobj=guard,mode='r|',bufsize=10240) as archive:
        for item in archive:
            check();need(len(seen)<4096 and item.name not in seen,'bounded unique pack sidecar members');seen.add(item.name)
            if item.isdir():
                need(item.name in [root_name,root_name+'/',*([root_name+'/objects',root_name+'/objects/'] if not phase else [])] and item.size==0 and not item.linkname,'fixed pack sidecar directories only');continue
            need(item.type in (tarfile.REGTYPE,tarfile.AREGTYPE) and not item.linkname,'regular pack sidecar original only')
            name=item.name;is_index=name==root_name+'/materials.json'
            need(is_index or (name in [root_name+'/'+name for name in pack_bindings.phase_names(pack_bindings.BUILD_PARENT_MODEL)] if phase else re.fullmatch(r'service-pack-originals/objects/[a-f0-9]{64}\.original',name)),'fixed pack sidecar original namespace')
            need(0<=item.size<=META and (item.size>0 or phase or name==root_name+'/objects/'+hashlib.sha256(b'').hexdigest()+'.original'),'pack sidecar original byte bound')
            total+=item.size;need(total<=(3*META if phase else META),'shared pack metadata byte bound');pieces=[];count=0
            with archive.extractfile(item) as source:
                while count<item.size:
                    check();block=source.read(min(65536,item.size-count));need(block,'short pack sidecar original');count+=len(block);pieces.append(block)
            body=b''.join(pieces)
            if is_index:
                text=body.decode('utf-8','strict');need(text.encode()==body,'actual UTF-8 pack index');collection=json.loads(text);index_original=body
            else:
                relative=name[len(root_name)+1:]
                if not phase:need(relative=='objects/'+hashlib.sha256(body).hexdigest()+'.original','pack sidecar object filename/bytes differ')
                originals[relative]=body
    while guard.read(65536):check()
    if phase:
        need(isinstance(collection,dict) and collection.get('schemaVersion')==1 and collection.get('kind')=='actual-service-pack-parent-originals' and set(originals)==set(pack_bindings.phase_names(collection.get('parentModel'))),'exact actual pack parent originals');return dict(collection=collection,collectionOriginal=index_original,originals=originals)
    need(isinstance(collection,dict) and collection.get('schemaVersion')==1 and collection.get('kind')=='actual-service-pack-manifest-inputs','explicit pack sidecar collection')
    refs=collection.get('originals');need(isinstance(refs,list) and len(refs)==len(originals) and len(refs)<=4095,'closed pack sidecar original set')
    registered=set()
    for ref in refs:
        check();need(isinstance(ref,dict) and set(ref)=={'path','bytes','sha256'} and isinstance(ref.get('path'),str) and ref['path'] not in registered,'unique plain pack sidecar reference');registered.add(ref['path']);body=originals.get(ref['path']);need(body is not None and type(ref['bytes']) is int and ref['bytes']==len(body) and ref['sha256']==hashlib.sha256(body).hexdigest(),'actual pack sidecar original bytes/ref differ')
    need(registered==set(originals),'pack sidecar has unregistered originals');check()
    return dict(collection=collection,collectionOriginal=index_original,originals=originals,metadataCaptureOnly=True,packManifestTransformationVerified=False,pending=['same-call-pack-writer-and-export-not-integrated','pack-tar-originals-and-resolution-input-closure-unverified'])


def observe_output_image(image,config,retained,source,source_sha,*,capture_pack_inputs=False,capture_runtime_members=False):
    budget=retained.budget;nonce=secrets.token_hex(16);name='xpod-service-output-'+nonce;cid=None;owned=False;removed=False;stages=[];failures=[];cleanup_errors=[]
    def stage(role,*,cleanup=False,cap=15,image_stage=True,body_ref=None,copy_bound=None):
        label='service-output-'+role+('-'+Path(body_ref['path']).name[:4] if body_ref else '')
        if copy_bound is not None:need(type(copy_bound) is int and 0<copy_bound<=32*META,'exact cp stdout bound')
        held=retained.reserve((2*copy_bound+3*META) if copy_bound is not None else 5*META)
        argv=pack_bindings.service_output_worker_argv(str(source),source_sha,role,image,name,nonce,cid,body_ref['path'] if body_ref else None,copy_bound)
        # Construct the same fixed argv here before any command executes.
        output_image_command(role,image,name,nonce,cid,body_ref['path'] if body_ref else None)
        try:row=outer.commands.capture(label,argv,retained.out,source,timeout=budget.timeout(cap,0 if cleanup else 10),resource_profile='cleanup' if cleanup else 'observation')
        except BaseException:
            roles=dict(receipt='stages/'+label+'/command.receipt.json',stdout='stages/'+label+'/stdout.raw',stderr='stages/'+label+'/stderr.raw',supervisionReceipt='stages/'+label+'.receipt.json',supervisionRaw='stages/'+label+'.raw.log');refs=[];missing=[]
            try:
                for key,path in roles.items():
                    if (retained.out/path).exists():refs.append(outer.commands.ref(retained.out/path,retained.out))
                    else:missing.append(key)
                retained.settle(held,refs,{ref['path']:copy_bound for ref in refs if copy_bound is not None and ref['path'].endswith(('/stdout.raw','/stderr.raw'))})
            except BaseException as error:
                # An incomplete original cannot become a successful stage. Keep
                # the initial command failure; diagnostics never replace it.
                missing.append('retention-'+type(error).__name__)
            failures.append(dict(name=label,originals=refs,missingRoles=missing));raise
        refs=[row[key] for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]
        retained.settle(held,refs,{ref['path']:copy_bound for ref in refs if copy_bound is not None and ref['path'].endswith(('/stdout.raw','/stderr.raw'))})
        need(row['stderr']['bytes']<=META,'actual cp stderr metadata bound')
        if image_stage:stages.append(row)
        if copy_bound is not None:return row,None
        return row,outer.bounded_original(retained.out/row['stdout']['path'],OUTPUT_TAR_LIMIT if role=='copy' else META,lambda:budget.check(0 if cleanup else 10))
    try:
        stage('pull',cap=90)
        _,raw=stage('create');need(re.fullmatch(b'[a-f0-9]{64}\n',raw),'actual full created output CID');cid=raw.decode().strip()
        _,raw=stage('inspect');inspect_output_container(raw,image,config,cid,name,nonce,require_never_started=False);owned=True;inspect_output_container(raw,image,config,cid,name,nonce)
        copy,_=stage('copy');body=service_manifest_tar(retained.out/copy['stdout']['path'],lambda:budget.check(10));reference=retained.save('output/service-root-package.original.json',body)
        runtime_observation=None
        if capture_runtime_members:
            runtime_roots=[]
            for index,(root,archive_root,role) in enumerate(RUNTIME_ROOTS):
                runtime_stage,_=stage(role,image_stage=False,copy_bound=shared_runtime_cp_bound(retained,len(RUNTIME_ROOTS)-index))
                runtime_roots.append(capture_runtime_root(retained,role,runtime_stage,root,archive_root,image,config,cid,lambda:budget.check(10)))
            runtime_observation=dict(schemaVersion=1,kind='actual-stopped-service-image-runtime-roots',imageReferenceByDigest=image,configDigest=config,containerId=cid,roots=runtime_roots,wholeServiceSourceVerified=False,producerImageAcquisitionVerified=True)
        pack_observation=None
        if capture_pack_inputs:
            pack_stage,_=stage(OUTPUT_PACK_ROLE,image_stage=False)
            pack=service_pack_sidecar_tar(retained.out/pack_stage['stdout']['path'],lambda:budget.check(10))
            need(pack['collection'].get('sourceSha')==source_sha,'pack sidecar belongs to another source')
            metadata=retained.save('output/service-pack-originals/materials.json',pack['collectionOriginal'])
            for relative,body in pack['originals'].items():retained.save('output/service-pack-originals/'+relative,body)
            body_refs=pack_body_references(pack['collection'])
            phase_stage,_=stage(OUTPUT_PACK_PHASE_ROLE,image_stage=False,copy_bound=4*META)
            phase_pack=service_pack_sidecar_tar(retained.out/phase_stage['stdout']['path'],lambda:budget.check(10),phase=True)
            phase_refs={relative:retained.save('output/service-pack-phase/'+relative,body) for relative,body in phase_pack['originals'].items()}
            phase_metadata=retained.save('output/service-pack-phase/materials.json',phase_pack['collectionOriginal'])
            captured={'service-pack-originals/materials.json':dict(metadata,path='service-pack-originals/materials.json')}
            for relative,body in pack['originals'].items():captured['service-pack-originals/'+relative]=dict(path='service-pack-originals/'+relative,bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
            for relative,ref in phase_refs.items():captured['service-pack-phase/'+relative]=dict(ref,path='service-pack-phase/'+relative)
            body_observations=[]
            for ref in body_refs:
                tar_bound=pack_bindings.body_copy_bound(ref)
                # Existing two cleanup stages and final master retain their
                # own worst-case allocations; no body can consume their slot.
                need(retained.total+2*tar_bound+3*META+ref['bytes']+11*META<=32*META,'pending service-pack-body-exceeds-actual-retained-remaining')
                body_stage,_=stage(OUTPUT_PACK_BODY_ROLE,image_stage=False,body_ref=ref,copy_bound=tar_bound)
                observed=retain_pack_body_tar(body_stage['stdout'],ref,retained);need(observed['bodyOriginalCaptured'],'actual full body capture pending')
                captured[ref['path']]=ref;body_observations.append(dict(reference=ref,original=observed['original'],rawTarOriginal=body_stage['stdout'],stage=body_stage))
            mechanics=verify_pack_parent(pack['collection'],phase_pack['collection'],phase_pack['originals'],captured)
            pack_observation=dict(schemaVersion=1,kind='actual-stopped-service-image-pack-inputs',imageReferenceByDigest=image,configDigest=config,containerId=cid,stage=pack_stage,metadata=metadata,bodies=body_observations,phase=dict(stage=phase_stage,metadata=phase_metadata,receipt=phase_refs['pack.receipt.json'],raw=phase_refs['pack.raw.log'],**(dict(originals=phase_refs) if phase_pack['collection'].get('parentModel') else {})),mechanicsVerified=True,**mechanics)
        _,raw=stage('remove',cleanup=True,cap=5);need(raw.decode().strip()==cid,'actual owned output removal ID')
        _,raw=stage('confirm-absent',cleanup=True,cap=5);need(raw==b'','removed output container remains present');removed=True
        return reference,dict(schemaVersion=1,kind='actual-stopped-service-image-root-manifest',imageReferenceByDigest=image,configDigest=config,containerId=cid,containerName=name,ownerNonce=nonce,stages=stages,**(dict(packInputObservation=pack_observation) if pack_observation else {}),**(dict(runtimeMemberObservation=runtime_observation) if runtime_observation else {}))
    finally:
        if not removed:
            # Recover only this unique name+nonce if create succeeded but its
            # stdout/receipt was interrupted. Never remove an unknown name.
            try:
                if not owned:
                    cid=None
                    _,raw=stage('cleanup-list',cleanup=True,cap=3)
                    need(raw==b'' or re.fullmatch(b'[a-f0-9]{64}\n',raw),'unique owned output recovery CID')
                    if raw:
                        cid=raw.decode().strip();_,raw=stage('cleanup-inspect',cleanup=True,cap=3);inspect_output_container(raw,image,config,cid,name,nonce,require_never_started=False);owned=True
                if owned:
                    try:stage('cleanup-remove',cleanup=True,cap=4)
                    finally:
                        _,raw=stage('cleanup-confirm-absent',cleanup=True,cap=3);need(raw==b'','owned output cleanup absence unconfirmed')
            except BaseException as error:cleanup_errors.append(type(error).__name__)
            try:retained.save('output/failure.original.json',(json.dumps(dict(schemaVersion=1,kind='failed-service-output-observation',containerName=name,ownerNonce=nonce,containerId=cid,stages=stages,failedStages=failures,cleanupErrors=cleanup_errors,releaseAccepted=False),sort_keys=True)+'\n').encode())
            except BaseException:pass

SERVICE_ABI_SOURCE_PATHS={
    'abi-header':'qlever/rdf_protocol/include/xpod_rdf_physical_backend.h',
    'abi-adapter':'qlever/qlever_adapter/src/xpod_qlever_adapter.cpp',
    'abi-runtime':'qlever/qlever_local_runtime/src/xpod_qlever_local_runtime.cpp',
    'abi-client':'src/storage/rdf/LocalQleverNativeSparqlClient.ts',
}
SERVICE_ABI_HELPER_PATHS={'declarations': 'qlever/scripts/sdk-service-abi-declarations.py', 'collector': 'qlever/scripts/sdk-service-abi-collector.py', 'direct_commands': 'qlever/scripts/sdk-service-abi-direct-runtime-commands.py', 'retained_session': 'qlever/scripts/sdk-service-abi-retained-session.py', 'host_session': 'qlever/scripts/sdk-service-abi-host-session.py', 'transport': 'qlever/scripts/sdk-service-abi-transport.py', 'replay': 'qlever/scripts/sdk-service-abi-protocol-replay.py', 'helper': 'qlever/scripts/verify-local-runtime-artifacts.py', 'seed': 'qlever/scripts/sdk-service-abi-seed.py', 'source_custody': 'qlever/scripts/sdk-service-abi-source-custody.py'}
SERVICE_ABI_HELPER_PATHS.update({'role_commands': 'qlever/scripts/sdk-service-abi-role-commands.py', 'role_session': 'qlever/scripts/sdk-service-abi-bun-role-session.py', 'role_collector': 'qlever/scripts/sdk-service-abi-role-collector.py', 'read_budget_module': 'qlever/scripts/sdk-service-abi-read-budget.py', 'elf_module': 'qlever/scripts/sdk-service-abi-elf.py'})
SERVICE_ABI_PASSIVE_PATHS={'abi-role-probe':'qlever/scripts/sdk-service-abi-role-probe.mjs'}
SERVICE_CAPTURE_PATHS={**SERVICE_ABI_SOURCE_PATHS,**{'abi-helper-'+role.replace('_','-'):path for role,path in SERVICE_ABI_HELPER_PATHS.items()},**SERVICE_ABI_PASSIVE_PATHS}
SERVICE_SOURCE_ROLES=('head','manifest','status',*SERVICE_CAPTURE_PATHS,*(role+'-oid' for role in SERVICE_CAPTURE_PATHS))

def worker(mode,source,sha):
    need(mode in SERVICE_SOURCE_ROLES and re.fullmatch('[a-f0-9]{40}',sha),'fixed checkout observation')
    path=Path(source);need(path.is_absolute() and path.resolve(strict=True)==path,'canonical actual checkout path')
    resource.setrlimit(resource.RLIMIT_FSIZE,(META,META))
    if mode in SERVICE_CAPTURE_PATHS:
        arguments=['show',sha+':'+SERVICE_CAPTURE_PATHS[mode]]
    elif mode.endswith('-oid') and mode[:-4] in SERVICE_CAPTURE_PATHS:
        arguments=['rev-parse','--verify',sha+':'+SERVICE_CAPTURE_PATHS[mode[:-4]]]
    else:
        arguments={'head':['rev-parse','--verify','HEAD'],'manifest':['show',sha+':package.json'],'status':['status','--porcelain=v1','--untracked-files=no']}[mode]
    command=['git','--no-pager','-C',str(path),*arguments]
    os.execv('/usr/bin/git',command)

def native_runtime_locator(args,run,attempt,sdk,local):
    """Coordinates only; independent GitHub custody/source observers decide trust."""
    names=('native_runtime_artifact_id','native_runtime_artifact_digest','native_runtime_master_bytes','native_runtime_master_sha256')
    values=[getattr(args,name,None) for name in names]
    if all(value is None for value in values):return None
    artifact,digest,byte_count,master_sha=values
    need(type(artifact) is int and 0<artifact<=9007199254740991 and type(byte_count) is int and 0<byte_count<=META and all(isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) for value in (digest,master_sha)),'complete exact native runtime artifact locator')
    need(isinstance(args.source_sha,str) and re.fullmatch('[a-f0-9]{40}',args.source_sha) and all(type(value) is int and 0<value<=9007199254740991 for value in (run,attempt)),'same native runtime source/run tuple')
    return dict(artifactId=artifact,artifactSha256=digest,sourceSha=args.source_sha,runId=run,runAttempt=attempt,target='linux-x64',sdkProfile='service-trixie',sdkImageReferenceByDigest=exact_image(sdk,'xpod-qlever-sdk'),localRuntimeImageReferenceByDigest=exact_image(local,'xpod-qlever-local-runtime'),master=dict(path='materials.json',bytes=byte_count,sha256=master_sha))

def capture(args):
    need(re.fullmatch('[a-f0-9]{40}',args.source_sha) and args.source_sha==os.environ['GITHUB_SHA'],'same actual service checkout SHA')
    run=int(os.environ['GITHUB_RUN_ID']);attempt=int(os.environ['GITHUB_RUN_ATTEMPT']);need(run>0 and attempt>0,'actual positive service workflow tuple')
    need(type(args.sdk_artifact_id) is int and args.sdk_artifact_id>0 and 0<args.sdk_master_bytes<=META and all(re.fullmatch('[a-f0-9]{64}',value) for value in [args.sdk_artifact_digest,args.sdk_master_sha256]),'exact actual upstream SDK locator')
    service=exact_image(args.service_image,'xpod');local=exact_image(args.local_runtime_image,'xpod-qlever-local-runtime');sdk=exact_image(args.sdk_image,'xpod-qlever-sdk')
    native_ref=native_runtime_locator(args,run,attempt,sdk,local)
    source=Path(args.source);need(source.is_absolute() and source.resolve(strict=True)==source,'actual canonical checkout')
    out=Path(args.out);need(out.is_absolute() and out.parent.resolve(strict=True)==Path(os.environ['RUNNER_TEMP']).resolve(strict=True) and out.name=='service-image-originals','fixed owned original output');out.mkdir(mode=0o700,exist_ok=False)
    budget=outer.budgets.ExecutionBudget(args.deadline)
    abi_custody=None;abi_primary=None
    try:
        with collection.absolute_budget(budget):
            retained=Retained(out,budget);stages=[]
            def stage(mode):
                held=retained.reserve(5*META);row=outer.commands.capture('service-source-'+mode,['/usr/bin/python3','-I','-S','-B',str(Path(__file__).resolve()),'--worker',mode,'--source',str(source),'--source-sha',args.source_sha],out,source,timeout=budget.timeout(15),resource_profile='observation');stages.append(row);retained.settle(held,[row[key] for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]);return outer.bounded_original(out/row['stdout']['path'],META,lambda:budget.check(0))
            need(stage('head').decode().strip()==args.source_sha,'actual checkout HEAD/source differs');committed=stage('manifest');stage('status')
            references={}
            abi_observation=None
            if getattr(args,'capture_service_abi_originals',False):
                import types
                source_rows=[];source_bodies=[];helper_rows={};helper_bodies={}
                for role,path in SERVICE_CAPTURE_PATHS.items():
                    oid_raw=stage(role+'-oid');oid=oid_raw.decode('ascii').strip()
                    need(re.fullmatch('[a-f0-9]{40}',oid),'actual complete Git blob OID required')
                    oid_ref=stages[-1]['stdout']
                    raw=stage(role);need(len(raw)<=1024**2,'fixed ABI source byte bound')
                    need(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==oid,'actual Git blob OID/body differ')
                    references[role]=stages[-1]['stdout'];references[role+'-oid']=oid_ref
                    source_rows.append(dict(role=role,path=path,gitBlobOid=oid,body=references[role],oidOriginal=oid_ref))
                    if role in SERVICE_ABI_SOURCE_PATHS:
                        source_bodies.append(raw)
                    elif role not in SERVICE_ABI_PASSIVE_PATHS:
                        key=next(key for key in SERVICE_ABI_HELPER_PATHS if role=='abi-helper-'+key.replace('_','-'))
                        helper_rows[key]=dict(path=path,gitBlobOid=oid,body=references[role]);helper_bodies[key]=raw
                custody_module=types.ModuleType('xpod_abi_source_custody_bootstrap')
                custody_module.__file__=str(source/SERVICE_ABI_HELPER_PATHS['source_custody'])
                exec(compile(helper_bodies['source_custody'],custody_module.__file__,'exec'),custody_module.__dict__)
                abi_custody=custody_module.Custody(source,helper_rows,retained)
                abi_modules=abi_custody.modules
                abi_observation=dict(schemaVersion=1,sourceSha=args.source_sha,sources=source_rows,expectedAbi=abi_modules['declarations'].declarations(*source_bodies),runtimeAbiVerified=False,scope='immutable Git declarations and held helper bytes only; actual binary, loader and native membership pending')
            for label,path in [('rootManifestBefore',args.root_manifest_before),('rootManifestAfter',args.root_manifest_after),('buildMetadata',args.build_metadata)]:
                raw=outer.bounded_original(Path(path),META if label=='buildMetadata' else 128*1024,lambda:budget.check(0));references[label]=retained.save(label+'.original.json',raw)
            before=outer.bounded_original(out/references['rootManifestBefore']['path'],META,lambda:budget.check(0));after=outer.bounded_original(out/references['rootManifestAfter']['path'],META,lambda:budget.check(0));need(before==committed and after==outer.bounded_original(source/'package.json',META,lambda:budget.check(0)),'actual before/Git and after/current root manifests differ')
            need(json.loads(before).get('name')==json.loads(after).get('name')=='@undefineds.co/xpod','actual root package identity')
            # These two optional fixed siblings are archival context, never SDK authority.
            for phase,path in [('before',args.root_manifest_before),('after',args.root_manifest_after)]:
                desktop=Path(path).parent/'desktop/package.json'
                if desktop.exists():references['desktopManifest'+phase.title()]=retained.save('desktop-'+phase+'.original.json',outer.bounded_original(desktop,128*1024,lambda:budget.check(0)))
            metadata=json.loads(outer.bounded_original(out/references['buildMetadata']['path'],META,lambda:budget.check(0)));need(metadata.get('containerimage.digest')==service.split('@')[1] and outer.binding.digest(metadata.get('containerimage.config.digest')),'actual build action metadata/image digest')
            observed={}
            for role,image in [('service',service),('localRuntime',local),('sdk',sdk)]:
                held=retained.reserve(3*META);value=images.registry_originals(image,'linux-x64',out/role,budget=budget,reserve_seconds=0);refs=[value['manifestOriginal'],value['configOriginal'],*([value['platformManifestOriginal']] if 'platformManifestOriginal' in value else [])];retained.settle(held,refs);observed[role]=value
            need(observed['service']['configDigest']==metadata['containerimage.config.digest'],'actual build action and independently fetched registry config differ')
            service_config=json.loads(outer.bounded_original(out/observed['service']['configOriginal']['path'],META,lambda:budget.check(0)));local_config=json.loads(outer.bounded_original(out/observed['localRuntime']['configOriginal']['path'],META,lambda:budget.check(0)));facts=inspect_relationship(service_config,local_config,args.source_sha)
            references['serviceRootManifest'],output_observation=observe_output_image(service,observed['service']['configDigest'],retained,source,args.source_sha,capture_pack_inputs=getattr(args,'capture_service_pack_originals',False),capture_runtime_members=getattr(args,'capture_service_runtime_members',False))
            abi_runtime_observation=None
            if abi_custody is not None:
                abi_custody.assert_current()
                seed=abi_modules['seed'].generate(retained=retained,
                    helper_reference=helper_rows['helper']['body'],
                    worker_reference=helper_rows['seed']['body'],
                    assert_current=abi_custody.assert_current,transport=abi_modules['transport'],
                    control_collector=abi_modules['collector'].capture_bounded_control)
                abi_runtime_observation=abi_modules['collector'].collect(
                    image=service,config=observed['service']['configDigest'],source=source,
                    retained=retained,seed_reference=seed['original'],
                    expected_abi=abi_observation['expectedAbi'],image_commands=sys.modules[__name__],
                    direct_commands=abi_modules['direct_commands'],retained_session=abi_modules['retained_session'],
                    host_session=abi_modules['host_session'],helper=abi_modules['helper'],
                    transport=abi_modules['transport'],replay=abi_modules['replay'],
                    role_commands=abi_modules['role_commands'],
                    role_session=abi_modules['role_session'],
                    role_collector=abi_modules['role_collector'],
                    read_budget_module=abi_modules['read_budget_module'],
                    elf_module=abi_modules['elf_module'],
                    assert_current=abi_custody.assert_current)
                abi_runtime_observation['seedObservation']=seed
                abi_custody.assert_current()
            pack_observation=output_observation.pop('packInputObservation',None)
            if pack_observation:
                references['servicePackMetadata']=pack_observation['metadata']
                for role,key in [('servicePackParentMetadata','metadata'),('servicePackParentReceipt','receipt'),('servicePackParentRaw','raw')]:references[role]=pack_observation['phase'][key]
            sdk_ref=dict(artifactId=args.sdk_artifact_id,artifactSha256=args.sdk_artifact_digest,sourceSha=args.source_sha,runId=run,runAttempt=attempt,target='linux-x64',sdkProfile='service-trixie',sdkImageReferenceByDigest=sdk,master=dict(path='materials.json',bytes=args.sdk_master_bytes,sha256=args.sdk_master_sha256))
            master=dict(schemaVersion=1,kind='xpod-candidate-service-image-originals',sourcePath=str(source),controllerPath=str(Path(__file__).resolve()),sourceSha=args.source_sha,runHeadSha=args.source_sha,runId=run,runAttempt=attempt,target='linux-x64',sdkProfile='service-trixie',serviceImageReferenceByDigest=service,localRuntimeImageReferenceByDigest=local,sdkArtifact=sdk_ref,**(dict(nativeRuntimeArtifact=native_ref) if native_ref else {}),images=observed,sourceOriginals=references,outputImageObservation=output_observation,**(dict(serviceAbiDeclarations=abi_observation) if abi_observation else {}),**(dict(serviceAbiRuntimeObservation=abi_runtime_observation) if abi_runtime_observation else {}),**(dict(packInputObservation=pack_observation) if pack_observation else {}),**(dict(runtimeMemberObservation=output_observation.pop('runtimeMemberObservation')) if 'runtimeMemberObservation' in output_observation else {}),stages=stages,originals=[retained.refs[name] for name in sorted(retained.refs)],facts=facts,releaseAccepted=False,pending=['service-whole-application-source-closure-unverified','service-runtime-abi-unverified','service-sdk-source-and-compiler-closure-unverified'],scope='Actual registry/config/checkout originals; SDK relationship requires independent same-run GitHub issuer and SDK private custody')
            raw=(json.dumps(master,sort_keys=True,indent=2)+'\n').encode();ref=retained.save('service-image-materials.json',raw)
            with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('master_sha256='+ref['sha256']+'\nmaster_bytes='+str(ref['bytes'])+'\n')
            return master
    except BaseException as error:
        abi_primary=error
        raise
    finally:
        if abi_custody is not None:
            try:abi_custody.close()
            except BaseException:
                if abi_primary is None:raise

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--worker',choices=SERVICE_SOURCE_ROLES);parser.add_argument('--image-worker',choices=[*OUTPUT_ROLES,*RUNTIME_ROLES,OUTPUT_PACK_ROLE,OUTPUT_PACK_PHASE_ROLE,OUTPUT_PACK_BODY_ROLE,'cleanup-list','cleanup-inspect','cleanup-remove','cleanup-confirm-absent']);parser.add_argument('--container-id');parser.add_argument('--container-name');parser.add_argument('--owner-nonce');parser.add_argument('--source',required=True);parser.add_argument('--source-sha',required=True)
    for key in ['out','service-image','local-runtime-image','sdk-image','sdk-artifact-digest','sdk-master-sha256','native-runtime-artifact-digest','native-runtime-master-sha256','root-manifest-before','root-manifest-after','build-metadata']:parser.add_argument('--'+key)
    parser.add_argument('--capture-service-abi-originals',action='store_true');parser.add_argument('--body-path');parser.add_argument('--copy-byte-bound',type=int);parser.add_argument('--capture-service-pack-originals',action='store_true');parser.add_argument('--capture-service-runtime-members',action='store_true');parser.add_argument('--native-runtime-artifact-id',type=int);parser.add_argument('--native-runtime-master-bytes',type=int);parser.add_argument('--sdk-artifact-id',type=int);parser.add_argument('--sdk-master-bytes',type=int);parser.add_argument('--deadline',type=float);args=parser.parse_args()
    need(not(args.worker and args.image_worker),'single fixed worker mode')
    if args.image_worker:image_worker(args)
    elif args.worker:worker(args.worker,args.source,args.source_sha)
    else:capture(args)

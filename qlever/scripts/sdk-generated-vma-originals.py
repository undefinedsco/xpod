"""Finite generated-output mapping mechanics; never a source/SDK issuer.

The sole observer supplies actual stops, raw writer, original ledger and deadline.
The parser independently replays the same ABI/operation contract below. No second
tracer, process-memory reader, user path allowlist or independent byte budget.
"""
import base64
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import time
import threading
import sys

LEGACY_MODEL='actual-generated-shared-vma-single-owner-v1'
MODEL='actual-generated-shared-vma-single-owner-v2'
MAPPING_KIND='actual-exclusive-mmap-selected-file-v1'
BUILD_ROOT='/opt/qlever-sdk/build'
FLAGS=0x4001  # Linux v6.12 UAPI: MAP_SHARED | MAP_NORESERVE; exact word only.
PROTECTION=3
WINDOW_SECONDS=1.0
# One operation/ABI table, consumed by producer and independent replay.
ABI={0xc000003e:dict(open=2,openat=257,resize=77,map=9,unmap=11,close=3,write=1),0xc00000b7:dict(open=None,openat=56,resize=46,map=222,unmap=215,close=57,write=64)}
CREATE_REQUIRED=0x40|0x80
CREATE_ALLOWED=3|CREATE_REQUIRED|0x80000|0x8000|0x20000

def need(value,why):
    if not value:raise ValueError('generated VMA: '+why)
def identity(value):return [value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns]
def absent(path):
    try:os.lstat(path)
    except FileNotFoundError:return True
    return False

def operation(entry):
    need(entry.get('arch') in ABI and len(entry.get('args',[]))==6,'actual known ABI/six argument words required')
    rules=ABI[entry['arch']];return next((name for name,nr in rules.items() if nr is not None and nr==entry['nr']),None)
def create_dimensions(entry):
    op=operation(entry);args=entry['args'];need(op in ['open','openat'],'actual create syscall required')
    flags=args[1] if op=='open' else args[2]
    need(flags&3==2 and flags&CREATE_REQUIRED==CREATE_REQUIRED and flags&~CREATE_ALLOWED==0,'reviewed exclusive RW creation flags required')
    return (-100,args[0]) if op=='open' else (args[0],args[1])
def map_dimensions(entry,fd):
    need(operation(entry)=='map' and entry['args']==[0,1,PROTECTION,FLAGS,fd,0],'fixed one-byte non-executable shared mapping required')
def rounded_span(address,length,page):
    need(type(page) is int and 4096<=page<=65536 and page&(page-1)==0,'actual bounded power-of-two page geometry required')
    need(type(address) is int and address>=0 and address%page==0 and type(length) is int and length>0 and address+length<=1<<64,'aligned bounded actual VMA range required')
    size=((length+page-1)//page)*page;need(address+size<=1<<64,'rounded VMA range overflow');return size

def matching_maps(mappings,file_identity):
    dev,ino=file_identity[:2]
    return [row for row in mappings if (row['deviceMajor'],row['deviceMinor'],row['inode'])==(os.major(dev),os.minor(dev),ino)]
def verify_established(mappings,address,page,file_identity):
    size=rounded_span(address,1,page);rows=matching_maps(mappings,file_identity)
    need(len(rows)==1,'exact sole backing VMA required');row=rows[0]
    need(row['startHex']==format(address,'x') and row['endHex']==format(address+size,'x') and row['permissions']=='rw-s' and row['fileOffset']==0,'actual whole shared RW VMA geometry differs')
    return row

def reservation_bytes(peer_count,metadata_maximum):
    need(type(peer_count) is int and 0<=peer_count<128 and type(metadata_maximum) is int and 0<metadata_maximum<=4*1024**2,'canonical bounded checkpoint reservation required')
    # Four own maps plus before/after maps for every stopped peer; raw records
    # have the existing 64KiB maximum. Unused reserved bytes are never charged.
    return (5+2*peer_count)*metadata_maximum+(44+2*peer_count)*65536+6

def legacy_reservation_bytes(peer_count,metadata_maximum):return (4+2*peer_count)*metadata_maximum+(40+2*peer_count)*65536+3

def same_object(first,second):return len(first)==len(second)==6 and first[:4]==second[:4]

def raw_record(data):
    need(isinstance(data,bytes) and 0<len(data)<=4096,'bounded nonempty kernel raw required')
    return dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),encoding='base64',content=base64.b64encode(data).decode('ascii'))
def raw_bytes(record):
    need(set(record)=={'bytes','sha256','encoding','content'} and record['encoding']=='base64' and type(record['bytes']) is int and 0<record['bytes']<=4096 and isinstance(record['content'],str) and len(record['content'])<=5464,'bounded exact kernel raw encoding required')
    data=base64.b64decode(record['content'],validate=True);need(raw_record(data)==record,'kernel raw fullbytes/hash differ');return data
def proc_identity(data,pid):
    need(len(data)<=4096 and data.endswith(b'\n'),'bounded complete proc stat required');end=data.rfind(b')');need(end>0 and data[:data.find(b' ')].decode()==str(pid),'actual proc stat PID differs')
    fields=data[end+2:].split();need(len(fields)>=20 and fields[0] in [b't',b'T'] and fields[19].isdigit(),'actual stopped task/starttime required');return int(fields[19])
def kernel_link(record,path,build_root=BUILD_ROOT):
    data=raw_bytes(record);need(b'\0' not in data and data.decode('utf-8','strict')==path and path.startswith(build_root+'/') and not path.endswith(' (deleted)') and all(part not in ['', '.', '..'] for part in path.split('/')[1:]),'exact nondeleted kernel link differs')

class ProcLease:
    """Same held proc directory/stat across the selected actual syscall stop."""
    def __init__(self,runtime,pid):
        self.r=runtime;self.pid=pid;self.directory=None;self.stat=None;self.base='/proc/'+str(pid)
        try:
            self.directory=os.open(self.base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);runtime.b.retained.add(self.directory)
            self.stat=os.open('stat',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.directory);runtime.b.retained.add(self.stat)
            self.first=self.sample()
        except BaseException:
            runtime.cleanup_fds([self.stat,self.directory]);raise
    def sample(self):
        self.r.b.check();directory=identity(os.fstat(self.directory));named=identity(os.stat(self.base,follow_symlinks=False));held=identity(os.fstat(self.stat));named_stat=identity(os.stat('stat',dir_fd=self.directory,follow_symlinks=False))
        need(directory==named and stat.S_ISDIR(directory[2]) and held==named_stat and stat.S_ISREG(held[2]),'same held/named proc lease differs')
        data=os.pread(self.stat,4097,0);start=proc_identity(data,self.pid)
        need(directory==identity(os.fstat(self.directory))==identity(os.stat(self.base,follow_symlinks=False)) and held==identity(os.fstat(self.stat))==identity(os.stat('stat',dir_fd=self.directory,follow_symlinks=False)),'proc lease changed while sampling')
        result=dict(directoryIdentity=directory,statIdentity=held,statOriginal=raw_record(data),starttime=str(start))
        if hasattr(self,'first'):need(result['directoryIdentity']==self.first['directoryIdentity'] and result['statIdentity']==self.first['statIdentity'] and result['starttime']==self.first['starttime'],'proc lifetime changed across actual syscall')
        return result
    def close(self):return self.r.cleanup_fds([self.stat,self.directory])

class MemoryDomains:
    """Derived solely from already observed actual root/clone/exec/wait rows."""
    def __init__(self):self.domains={}
    def record(self,row):
        kind=row['kind']
        if kind=='owned-root-binding':
            need(not self.domains,'prior memory domain remains');self.domains[row['pid']]=row['sequence']
        elif kind=='actual-child-binding':
            need(row['parentPid'] in self.domains and row['childPid'] not in self.domains and type(row.get('cloneFlags')) is int,'actual clone flags/parent memory domain required')
            self.domains[row['childPid']]=self.domains[row['parentPid']] if row['cloneFlags']&0x100 else row['sequence']
        elif kind=='ptrace-event' and row['event']==4:
            need(row['pid'] in self.domains,'actual exec memory domain missing');self.domains[row['pid']]=-row['sequence']
        elif kind=='actual-wait-exit':
            need(row['pid'] in self.domains,'actual terminal memory domain missing');del self.domains[row['pid']]
    def unique(self,pid):
        need(pid in self.domains and [p for p,v in self.domains.items() if v==self.domains[pid]]==[pid],'mapping owner is not the sole actual memory-domain member')
        return self.domains[pid]

class Runtime:
    def __init__(self,backend):
        self.b=backend;self.mm=MemoryDomains();self.origins={};self.pending={};self.active=None;self.checkpoints={};self.reserved=0;self.metadata_bytes=0;self.spending_thread=None;self.cleanup_errors=[]
    def cleanup_fds(self,fds):
        errors=[]
        for fd in dict.fromkeys(fd for fd in fds if fd is not None and fd in self.b.retained):
            try:os.close(fd)
            except BaseException as error:errors.append(error)
            else:self.b.retained.discard(fd)
        self.cleanup_errors.extend(errors)
        return errors
    @property
    def owner(self):return self.active['pid'] if self.active is not None else None
    def record(self,row):
        self.mm.record(row);kind=row['kind']
        if kind.startswith('generated-vma-') or kind=='exclusive-generated-vma-resume':
            self.metadata_bytes+=len(json.dumps(row,separators=(',',':')).encode());need(self.metadata_bytes<=4*1024**2,'shared generated metadata bound')
        if self.active is None and kind=='kernel-syscall' and row['op']=='entry' and operation(row) in ['close','write']:
            for key,origin in list(self.origins.items()):
                if origin['pid']==row['pid'] and origin.get('fd')==row['args'][0] and self.lookup_fd(row['pid'],row['args'][0]) is origin:
                    if origin.get('checkpointed'):
                        if operation(row)=='write':self.checkpoints.pop(key,None)
                        continue
                    os.close(origin['held']);self.b.retained.remove(origin['held']);del self.origins[key]
        if self.active is not None:
            self.b.check();kind=row['kind']
            if kind in ['actual-child-binding','ptrace-event','signal-delivery','actual-wait-exit']:raise ValueError('generated VMA: unsupported event while finite mapping dirty')
            if kind=='kernel-syscall':
                need(row['pid']==self.owner,'peer executed while generated mapping active')
                if row['op']=='entry':need(operation(row) in ['close','unmap'],'unsupported syscall while finite mapping dirty')
    def lookup_fd(self,pid,fd):
        try:current=identity(os.stat('/proc/'+str(pid)+'/fd/'+str(fd)))
        except FileNotFoundError:return None
        return self.origins.get(tuple(current[:2]))
    def classify(self,pid,entry,resolve):
        op=operation(entry);args=entry['args'];b=self.b
        if self.active is not None:
            need(pid==self.owner and op in ['close','unmap'],'unsupported active mapping syscall')
            if op=='close':
                origin=self.lookup_fd(pid,args[0]);need(origin is self.active['origin'],'only selected mapped backing FD may close')
            else:
                need(args[0]==self.active['address'] and rounded_span(args[0],args[1],self.active['page'])==self.active['span'],'partial or foreign munmap unsupported')
                origin=self.active['origin']
            self.pending[pid]=dict(op=op,origin=origin,fd=args[0] if op=='close' else None)
        elif op in ['open','openat']:
            try:dirfd,address=create_dimensions(entry)
            except ValueError:return False
            path=resolve(dirfd,address)
            if not path.startswith(b.build+'/'):return False
            need(str(Path(path).resolve(strict=False))==path,'canonical generated path required')
            self.b.emit(dict(kind='generated-vma-create-path',pid=pid,entrySequence=entry['sequence'],path=path,dirFd=dirfd,pathArgIndex=0 if op=='open' else 1))
            self.pending[pid]=dict(op='create',path=path)
        elif op=='resize':
            origin=self.lookup_fd(pid,args[0])
            if origin is None:return False
            need(args[0]==origin['fd'],'new selected generated descriptor requires unsupported explicit rebinding');need(origin['pid']==pid and origin['identity'][3]==0 and args[1]==1,'only actual own empty-to-one-byte resize supported')
            self.pending[pid]=dict(op=op,origin=origin,fd=args[0])
        elif op=='map' and not(args[3]&0x20) and args[2]&2 and args[3]&1:
            origin=self.lookup_fd(pid,args[4]);need(origin is not None,'mapped output lacks actual create/resize origin');map_dimensions(entry,args[4]);need(origin['pid']==pid and origin['identity'][3]==1,'selected own one-byte origin required');self.mm.unique(pid)
            self.pending[pid]=dict(op=op,origin=origin,fd=args[4])
        else:return False
        b.tasks[pid]['capture']=(None,'generated-vma-before');return True
    def fresh_barrier(self):
        row=self.b.barrier()
        if row['sequence']!=self.b.seq:row=self.b.barrier()
        need(row['sequence']==self.b.seq,'fresh all-task barrier required');return row
    def snapshot(self,fd):
        before=identity(os.fstat(fd));need(stat.S_ISREG(before[2]) and before[3] in [0,1],'tiny regular generated original required')
        ref=self.b.snapshot_write_original(fd,before[3]);need(before==identity(os.fstat(fd)),'generated original changed during capture');return before,ref
    def maps(self,pid):return self.b.tool_maps(pid)
    def capture(self,pid):
        b=self.b;pending=self.pending[pid];op=pending['op'];entry=b.tasks[pid]['entry'];barrier=self.fresh_barrier();common=dict(kind='generated-vma-operation-window',operation=op,pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'])
        if op=='create':
            path=pending['path'];parent=Path(path).parent;need(str(parent.resolve(strict=True))==str(parent) and absent(path),'actual fresh generated name required')
            held=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW);b.retained.add(held);pending['parentFd']=held;need(identity(os.fstat(held))==identity(parent.lstat()),'same held/named create parent required');pending.update(parentFd=held,parentIdentity=identity(os.fstat(held)));common.update(path=path,parentIdentity=pending['parentIdentity'],nameAbsenceErrno=errno.ENOENT)
        else:
            origin=pending['origin'];held=origin['held'];current=identity(os.fstat(held));need(same_object(current,origin['identity']),'retained generated backing object changed')
            common.update(originSequence=origin['sequence'],path=origin['path'],identity=current,fd=pending['fd'])
            if op in ['resize','map']:
                need(current==origin['identity'] and current==identity(os.stat('/proc/'+str(pid)+'/fd/'+str(pending['fd']))),'generated preimage FD identity differs')
                _,ref=self.snapshot(held);need((ref['bytes'],ref['sha256'])==origin['data'],'generated preimage bytes differ');common['beforeOriginal']=ref
            if op=='map' and pending['fd']!=origin['fd']:
                selected_path='/proc/'+str(pid)+'/fd/'+str(pending['fd']);selected=os.open(selected_path,os.O_RDONLY|os.O_CLOEXEC);b.retained.add(selected)
                try:
                    selected_identity,selected_ref=self.snapshot(selected);flags=b.generated_fd_flags(pid,pending['fd']);path=b.generated_fd_path(pid,pending['fd']);ownership=[row for row in barrier['taskOwnership'] if row['tid']==pid]
                    need(len(ownership)==1 and flags&3==2 and flags==b.generated_fd_flags(pid,pending['fd']) and path==b.generated_fd_path(pid,pending['fd'])==origin['path'] and selected_identity==identity(os.fstat(selected))==identity(os.stat(selected_path))==identity(os.fstat(held))==origin['identity'] and (selected_ref['bytes'],selected_ref['sha256'])==origin['data'],'actual selected FD rebinding differs from retained origin')
                    binding=b.emit(dict(kind='generated-vma-selected-fd-binding',pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],originSequence=origin['sequence'],selectedFd=pending['fd'],previousFd=origin['fd'],fdTable=ownership[0]['fdTable'],identity=selected_identity,retainedIdentity=current,namedIdentity=identity(os.stat(selected_path)),flags=flags,path=path,original=selected_ref));common['selectedFdBindingSequence']=binding['sequence']
                finally:
                    primary=sys.exc_info()[1];errors=self.cleanup_fds([selected])
                    if errors and primary is None:raise errors[0]
            if op=='map':
                selected=os.open('/proc/'+str(pid)+'/fd/'+str(pending['fd']),os.O_RDONLY|os.O_CLOEXEC);b.retained.add(selected);pending['selectedHeld']=selected
                selected_identity,selected_ref=self.snapshot(selected);flags=b.generated_fd_flags(pid,pending['fd']);path=b.generated_fd_path(pid,pending['fd'])
                need(selected_identity==current==identity(os.stat('/proc/'+str(pid)+'/fd/'+str(pending['fd']))) and (selected_ref['bytes'],selected_ref['sha256'])==origin['data'] and flags&3==2 and path==origin['path'],'selected mmap FD preimage differs')
                lease=ProcLease(self,pid);pending.update(procLease=lease,selectedFlags=flags)
                common.update(selectedIdentity=selected_identity,selectedOriginal=selected_ref,selectedFlags=flags,procLease=lease.first)
                reserved=reservation_bytes(len(barrier['pids'])-1,b.tool_metadata_bytes);b.reserve_generated_bytes(reserved);self.spending_thread=threading.get_ident();common.update(reservationBytes=reserved,metadataMaximumBytes=b.tool_metadata_bytes)
                self.mm.unique(pid);aliases=b.writable_aliases(current,pid,pending['fd']);need(len(aliases)==1 and aliases[0]['pid']==pid and aliases[0]['fd']==pending['fd'],'mapped output has another writable FD alias')
                maps,values=self.maps(pid);need(not matching_maps(values,current),'backing file already has VMA aliases')
                for peer,task in b.tasks.items():
                    if task['exited'] or peer==pid:continue
                    other,items=self.maps(peer);need(not matching_maps(items,current),'peer already maps output backing')
                    common.setdefault('peerMaps',[]).append(dict(pid=peer,original=other['original']))
                page=os.sysconf('SC_PAGE_SIZE');rounded_span(0,1,page);end=min(b.deadline,time.monotonic()+WINDOW_SECONDS);pending.update(alarmToken=b.waiter.clamp(end),windowEnd=end)
                common.update(beforeMapsOriginal=maps['original'],pageBytes=page,memoryDomain=self.mm.unique(pid),aliases=aliases,windowDeadlineMonotonicNs=str(int(end*1e9)),parentDeadlineMonotonicNs=str(int(b.waiter.parent_deadline*1e9)))
            if op=='unmap':
                current,ref=self.snapshot(held);maps,values=self.maps(pid);verify_established(values,self.active['address'],self.active['page'],current);common.update(beforeOriginal=ref,beforeMapsOriginal=maps['original'],epochSequence=self.active['sequence'])
        row=b.emit(common);pending.update(window=row,preBarrier=barrier);return row
    def finish(self,pid,entry,exit):
        b=self.b;pending=self.pending[pid];window=pending['window'];op=pending['op'];need(b.exclusive==(pid,entry['sequence']) and exit['result']>=0 and exit['isError'] is False,'actual exclusive successful operation exit required')
        common=dict(kind='generated-vma-operation-exit',operation=op,pid=pid,entrySequence=entry['sequence'],windowSequence=window['sequence'],exitSequence=exit['sequence'],result=exit['result'],isError=exit['isError'])
        if op=='create':
            parent=pending['parentFd'];held=None;registered=False
            try:
                fd=exit['result'];held=os.open('/proc/'+str(pid)+'/fd/'+str(fd),os.O_RDONLY|os.O_CLOEXEC);b.retained.add(held);current,ref=self.snapshot(held)
                need(current[3]==0 and current==identity(os.stat(pending['path'],follow_symlinks=False)),'actual created FD/named empty file differ')
                need(identity(os.fstat(parent))[:3]==pending['parentIdentity'][:3] and identity(os.fstat(parent))==identity(Path(pending['path']).parent.stat()),'generated create parent object changed')
                flags=b.generated_fd_flags(pid,fd);need(flags&3==2,'actual returned create FD is not RW')
                row=b.emit(dict(common,fd=fd,fdFlags=flags,path=pending['path'],identity=current,original=ref,parentIdentity=identity(os.fstat(parent))))
                need(tuple(current[:2]) not in self.origins and len(self.origins)<128,'unique bounded generated origins required');self.origins[tuple(current[:2])]=dict(pid=pid,fd=fd,sequence=row['sequence'],path=pending['path'],held=held,identity=current,data=(ref['bytes'],ref['sha256']),original=ref);registered=True
            finally:
                primary=sys.exc_info()[1];errors=self.cleanup_fds([parent]+([held] if not registered else []))
                if parent not in b.retained:pending['parentFd']=None
                if errors and primary is None:raise errors[0]
        elif op=='resize':
            origin=pending['origin'];current,ref=self.snapshot(origin['held']);need(exit['result']==0 and current[:3]==origin['identity'][:3] and current[3]==1 and (ref['bytes'],ref['sha256'])==(1,hashlib.sha256(b'\0').hexdigest()),'actual zero extension differs')
            row=b.emit(dict(common,identity=current,original=ref,originSequence=origin['sequence']));origin.update(identity=current,data=(ref['bytes'],ref['sha256']),original=ref,sequence=row['sequence'])
        elif op=='map':
            origin=pending['origin'];current=identity(os.fstat(origin['held']));need(current==origin['identity'],'mmap changed backing preimage')
            barrier=self.fresh_barrier();need(barrier['sequence']==exit['sequence']+1 and barrier['pids']==pending['preBarrier']['pids'] and barrier.get('taskOwnership')==pending['preBarrier'].get('taskOwnership'),'mmap post-stop ownership/progress differs')
            selected=pending['selectedHeld'];selected_path='/proc/'+str(pid)+'/fd/'+str(pending['fd'])
            def selected_sample():
                before,ref=self.snapshot(selected)
                need(before==current==identity(os.fstat(origin['held']))==identity(os.stat(selected_path)) and b.generated_fd_flags(pid,pending['fd'])==pending['selectedFlags'] and b.generated_fd_path(pid,pending['fd'])==origin['path'] and (ref['bytes'],ref['sha256'])==origin['data'],'mmap selected/origin full preimage differs')
                return ref
            first_body=selected_sample();proc_first=pending['procLease'].sample();maps,values=self.maps(pid);mapping=verify_established(values,exit['result'],window['pageBytes'],current)
            link_path='/proc/'+str(pid)+'/map_files/'+mapping['startHex']+'-'+mapping['endHex']
            first_link=raw_record(os.fsencode(os.readlink(link_path)));kernel_link(first_link,origin['path'],b.build);first_link_row=b.emit(dict(kind='generated-vma-kernel-link-original',pid=pid,entrySequence=entry['sequence'],postBarrierSequence=barrier['sequence'],mapsOriginal=maps['original'],range=[mapping['startHex'],mapping['endHex']],link=first_link,procLease=proc_first))
            confirmation,confirmed=self.maps(pid);need(values==confirmed and maps['original']['bytes']==confirmation['original']['bytes'] and maps['original']['sha256']==confirmation['original']['sha256'],'mmap full maps changed between kernel link samples')
            last_link=raw_record(os.fsencode(os.readlink(link_path)));need(first_link==last_link,'kernel VMA link changed');last_body=selected_sample();proc_last=pending['procLease'].sample();last_link_row=b.emit(dict(kind='generated-vma-kernel-link-original',pid=pid,entrySequence=entry['sequence'],postBarrierSequence=barrier['sequence'],mapsOriginal=confirmation['original'],range=[mapping['startHex'],mapping['endHex']],link=last_link,procLease=proc_last))
            evidence=dict(kind=MAPPING_KIND,linkBeforeSequence=first_link_row['sequence'],linkAfterSequence=last_link_row['sequence'],postBarrierSequence=barrier['sequence'],selectedFd=pending['fd'],selectedIdentity=current,retainedIdentity=identity(os.fstat(origin['held'])),namedIdentity=identity(os.stat(selected_path)),selectedFlags=pending['selectedFlags'],beforeOriginal=window['selectedOriginal'],postOriginal=first_body,confirmationOriginal=last_body,mapsConfirmationOriginal=confirmation['original'],linkBefore=first_link,linkAfter=last_link,procBefore=proc_first,procAfter=proc_last)
            end=pending['windowEnd'];token=pending['alarmToken']
            row=b.emit(dict(common,identity=current,kernelMappingEvidence=evidence,mapsOriginal=maps['original'],mapping=mapping,memoryDomain=self.mm.unique(pid),windowDeadlineMonotonicNs=str(int(end*1e9)),parentDeadlineMonotonicNs=str(int(b.waiter.parent_deadline*1e9))))
            primary=sys.exc_info()[1];errors=pending['procLease'].close()+self.cleanup_fds([pending['selectedHeld']]);need(not errors,'mmap lease cleanup failed');pending.pop('procLease');pending.pop('selectedHeld')
            origin['fd']=pending['fd'];self.active=dict(pid=pid,origin=origin,address=exit['result'],page=window['pageBytes'],span=rounded_span(exit['result'],1,window['pageBytes']),sequence=row['sequence'],token=token)
        elif op=='close':
            origin=pending['origin'];need(exit['result']==0 and absent('/proc/'+str(pid)+'/fd/'+str(pending['fd'])) and identity(os.fstat(origin['held']))==window['identity'],'actual FD close differs; mapping remains live')
            b.emit(dict(common,originSequence=origin['sequence'],fd=pending['fd'],fdAbsenceErrno=errno.ENOENT,identity=window['identity'],epochSequence=self.active['sequence']))
        elif op=='unmap':
            origin=pending['origin'];need(exit['result']==0,'actual whole unmap success required');maps,values=self.maps(pid);need(not matching_maps(values,origin['identity']),'writable backing VMA alias remains')
            current,ref=self.snapshot(origin['held']);need(same_object(current,origin['identity']) and (ref['bytes'],ref['sha256'])==(window['beforeOriginal']['bytes'],window['beforeOriginal']['sha256']),'unmap changed backing object/bytes')
            peers=[]
            for peer,task in b.tasks.items():
                if task['exited'] or peer==pid:continue
                other,items=self.maps(peer);need(not matching_maps(items,current),'peer backing alias remained at checkpoint');peers.append(dict(pid=peer,original=other['original']))
            row=b.emit(dict(common,path=origin['path'],identity=current,retainedIdentity=current,original=ref,afterMapsOriginal=maps['original'],afterPeerMaps=peers,epochSequence=self.active['sequence'],originSequence=origin['sequence']))
            token=self.active['token'];self.active=None;b.waiter.restore(token);self.reserved=0;self.spending_thread=None;origin.update(identity=current,data=(ref['bytes'],ref['sha256']),original=ref,checkpointed=True);self.checkpoints[tuple(current[:2])]=row
        self.pending.pop(pid);return row if op!='close' else None
    def consumer(self,row,data,identity_value):
        checkpoint=self.checkpoints.get(tuple(identity_value[:2]));origin=self.origins.get(tuple(identity_value[:2]))
        if checkpoint is None:return False
        need(origin and identity(os.fstat(origin['held']))==identity_value==checkpoint['identity'] and row['path']==checkpoint['path'] and data==(checkpoint['original']['bytes'],checkpoint['original']['sha256']),'mapped consumer held byte checkpoint differs')
        self.b.emit(dict(kind='generated-vma-consumer-binding',captureSequence=row['sequence'],checkpointSequence=checkpoint['sequence'],path=row['path'],identity=identity_value));return True
    def complete_phase(self):need(self.active is None and not self.pending,'phase ended with unclosed generated mapping')
    def close(self):
        self.reserved=0;self.spending_thread=None
        # Failed closes remain in the existing observer retained set for its
        # outer cleanup retry. Try every lease, never hide a propagating error.
        self.cleanup_fds([origin['held'] for origin in self.origins.values()]+[pending.get('parentFd') for pending in self.pending.values()])
        self.cleanup_fds([pending.get('selectedHeld') for pending in self.pending.values()])
        for pending in self.pending.values():
            if pending.get('procLease'):pending['procLease'].close()
        self.origins.clear();self.pending.clear()

class Verifier:
    """Independent bounded raw/original replay; no caller Boolean approval."""
    def __init__(self,capture_data,maps_data,metadata_maximum=4*1024**2,model=LEGACY_MODEL):
        need(model in [LEGACY_MODEL,MODEL],'unknown mapping evidence model');self.model=model
        self.capture_data=capture_data;self.maps_data=maps_data;self.metadata_maximum=metadata_maximum;self.mm=MemoryDomains();self.windows={};self.origins={};self.original_sequences={};self.map_sequences={};self.map_owners={};self.pending_window=None;self.transaction=None;self.active=None;self.events={};self.checkpoints={};self.consumers=[];self.metadata_bytes=0;self.pending_mapping_entries=set();self.create_paths={};self.last_observed_ns=None;self.parent_deadline_ns=None;self.fd_bindings={}
    def original(self,reference):return self.capture_data(reference)
    @staticmethod
    def key(reference):return tuple(reference[key] for key in ['path','bytes','sha256'])
    def preimage_interval(self,row,barrier):
        # Exact producer order permits only bounded original emissions; no task
        # event can hide between the actual barrier and preimage window.
        need(barrier['sequence']>row['entrySequence'] and barrier['sequence']<row['sequence'],'fresh generated operation barrier/order required')
        for seq in range(barrier['sequence']+1,row['sequence']):need(self.events[seq]['kind'] in ['write-original','toolchain-original','generated-vma-selected-fd-binding'],'task/event between generated preimage barrier/window')
        for key in ['beforeOriginal','beforeMapsOriginal']:
            if key not in row:continue
            table=self.map_sequences if key=='beforeMapsOriginal' else self.original_sequences;sequence=table.get(self.key(row[key]),0)
            if key=='beforeMapsOriginal':need(self.map_owners.get(self.key(row[key]))==row['pid'],'preimage maps sampled a different actual PID')
            need(barrier['sequence']<sequence<row['sequence'],'generated preimage lacks its own fresh original emission')
    def allow_mapping_entry(self,row):
        need(operation(row)=='map','actual mapping entry required');map_dimensions(row,row['args'][4]);origin=next((value for value in self.origins.values() if value['pid']==row['pid'] and value['identity'][3]==1),None)
        need(origin is not None and origin['identity'][3]==1,'actual created/resized selected mapping origin missing');self.mm.unique(row['pid']);self.pending_mapping_entries.add(row['sequence']);return True
    def record(self,row,entries,exits,barriers,caps):
        kind=row['kind'];seq=row['sequence'];clock=row.get('observedMonotonicNs');need(isinstance(clock,str) and clock.isdecimal(),'actual monotonic raw observation required');now=int(clock);need(self.last_observed_ns is None or now>=self.last_observed_ns,'raw monotonic observation moved backwards');self.last_observed_ns=now;need(seq not in self.events,'duplicate generated raw sequence');self.events[seq]=row
        while len(self.events)>256:self.events.pop(next(iter(self.events)))
        if kind.startswith('generated-vma-') or kind=='exclusive-generated-vma-resume':
            self.metadata_bytes+=len(json.dumps(row,separators=(',',':')).encode());need(self.metadata_bytes<=4*1024**2,'shared generated replay metadata bound')
        if kind=='generated-vma-kernel-link-original':need(self.model==MODEL and self.transaction and self.transaction['state']=='exited' and self.transaction['window']['operation']=='map','kernel link original outside new mapping transaction')
        self.mm.record(row)
        if kind=='owned-root-binding':
            end=row.get('generatedVmaParentDeadlineMonotonicNs');need(isinstance(end,str) and end.isdecimal() and int(end)>now,'actual owned root parent deadline required');self.parent_deadline_ns=int(end)
        if self.active is None and kind=='kernel-syscall' and row['op']=='entry' and operation(row) in ['close','write']:
            for key,origin in list(self.origins.items()):
                if origin['pid']==row['pid'] and origin['fd']==row['args'][0]:
                    if origin.get('checkpointed'):
                        if operation(row)=='write':
                            for checkpoint,value in list(self.checkpoints.items()):
                                if value['identity'][:2]==origin['identity'][:2]:del self.checkpoints[checkpoint]
                        continue
                    del self.origins[key]
        if self.pending_window is not None:need(kind=='exclusive-generated-vma-resume' and row.get('captureSequence')==self.pending_window,'generated operation window must be immediately exclusively resumed')
        if self.transaction is not None:
            state=self.transaction['state']
            if state=='resumed':
                need(kind=='kernel-syscall' and row.get('op')=='exit' and row.get('pid')==self.transaction['pid'] and row.get('entrySequence')==self.transaction['entrySequence'],'foreign event during generated exclusive syscall');self.transaction['state']='exited'
            elif state=='exited':
                allowed=['write-original','toolchain-original','generated-vma-operation-exit']
                if self.model==MODEL:allowed.append('generated-vma-kernel-link-original')
                if self.model==MODEL and self.transaction['window']['operation']=='map' and seq==exits[self.transaction['entrySequence']]['sequence']+1:allowed=['all-stop-barrier']
                need(kind in allowed,'event before generated postimage closure')
            else:need(kind=='exclusive-captured-syscall-exit','generated operation close missing')
        if self.active is not None:
            if kind in ['actual-child-binding','ptrace-event','signal-delivery','actual-wait-exit']:raise ValueError('generated VMA: event while dirty mapping active')
            if kind=='kernel-syscall':
                need(row['pid']==self.active['pid'],'peer ran while mapped output dirty')
                if row['op']=='entry':need(operation(row) in ['close','unmap'],'unsupported active mapping syscall')
            now=row.get('observedMonotonicNs');need(isinstance(now,str) and now.isdecimal() and self.active['start']<=int(now)<self.active['deadline'],'finite mapping deadline absent/expired')
        if kind=='write-original':
            self.original_sequences[self.key(row['original'])]=seq
            while len(self.original_sequences)>256:self.original_sequences.pop(next(iter(self.original_sequences)))
        elif kind=='toolchain-original' and row.get('captureKind')=='maps':
            self.map_sequences[self.key(row['original'])]=seq;self.map_owners[self.key(row['original'])]=row['observedPid']
            while len(self.map_sequences)>256:
                old=next(iter(self.map_sequences));self.map_sequences.pop(old);self.map_owners.pop(old)
        elif kind=='generated-vma-create-path':
            entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'],'actual create path entry missing');dirfd,address=create_dimensions(entry);path=row['path'];need(path.startswith(BUILD_ROOT+'/') and len(os.fsencode(path))<=4096 and all(part not in ['', '.', '..'] for part in path.split('/')[1:]) and row['dirFd']==dirfd and row['pathArgIndex']==(0 if operation(entry)=='open' else 1),'actual fixed generated path arguments differ');self.create_paths[entry['sequence']]=row
        elif kind=='generated-vma-selected-fd-binding':
            self.fd_bindings[seq]=row
        elif kind=='generated-vma-operation-window':
            need(self.transaction is None and self.pending_window is None,'overlapping generated operation');entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'generated operation entry/actual all-stop missing');self.preimage_interval(row,barrier)
            op=row['operation'];args=entry['args'];need(op==operation(entry) or op=='create' and operation(entry) in ['open','openat'],'generated operation ABI differs')
            if op=='create':
                path=self.create_paths.pop(entry['sequence'],None);need(path and path['path']==row['path'] and path['sequence']<barrier['sequence'],'actual generated create path original differs')
                create_dimensions(entry);need(row['nameAbsenceErrno']==errno.ENOENT and type(row['nameAbsenceErrno']) is int and len(row['parentIdentity'])==6 and stat.S_ISDIR(row['parentIdentity'][2]),'generated create parent/actual absence required')
            else:
                origin=self.origins.get(row['originSequence']);need(origin and origin['pid']==row['pid'] and row['path']==origin['path'] and same_object(row['identity'],origin['identity']),'generated operation backing origin differs')
                if op in ['resize','map']:
                    need(row['identity']==origin['identity'] and self.original(row['beforeOriginal'])==origin['data'],'generated operation exact byte preimage differs')
                    if op=='resize':need(args[0]==row['fd']==origin['fd'] and args[1]==1 and origin['identity'][3]==0,'only empty-to-one-byte extension required')
                if op=='map':
                    need(entry['sequence'] in self.pending_mapping_entries,'mapping window has no admitted actual entry');self.pending_mapping_entries.remove(entry['sequence'])
                    map_dimensions(entry,row['fd'])
                    if row['fd']!=origin['fd']:
                        selected=self.fd_bindings.pop(row.get('selectedFdBindingSequence'),None);ownership=[item for item in barrier.get('taskOwnership',[]) if item['tid']==row['pid']]
                        need(selected and len(ownership)==1 and selected['pid']==row['pid'] and selected['entrySequence']==entry['sequence'] and selected['barrierSequence']==barrier['sequence'] and selected['originSequence']==row['originSequence'] and selected['selectedFd']==entry['args'][4]==row['fd'] and selected['previousFd']==origin['fd'] and selected['fdTable']==ownership[0]['fdTable'] and selected['identity']==selected['retainedIdentity']==selected['namedIdentity']==origin['identity'] and selected['path']==origin['path'] and selected['flags']&3==2 and self.original(selected['original'])==origin['data'] and barrier['sequence']<self.original_sequences.get(self.key(selected['original']),0)<selected['sequence']<seq,'actual selected descriptor lacks full retained-origin binding')
                    else:need('selectedFdBindingSequence' not in row,'unexpected selected descriptor rebinding')
                    need(origin['identity'][3]==1 and self.mm.unique(row['pid'])==row['memoryDomain'],'unique actual one-byte mapping domain required');rounded_span(0,1,row['pageBytes']);need(not matching_maps(self.maps_data(row['beforeMapsOriginal']),origin['identity']),'existing own VMA alias')
                    peers=row.get('peerMaps',[]);need(row.get('metadataMaximumBytes')==self.metadata_maximum and row.get('reservationBytes')==(reservation_bytes if self.model==MODEL else legacy_reservation_bytes)(len(barrier['pids'])-1,self.metadata_maximum),'checkpoint reservation does not match canonical complete peer maps/raw bound');need(sorted(r['pid'] for r in peers)==sorted(p for p in barrier['pids'] if p!=row['pid']),'complete stopped peer maps required')
                    for peer in peers:
                        need(self.map_owners.get(self.key(peer['original']))==peer['pid'] and barrier['sequence']<self.map_sequences.get(self.key(peer['original']),0)<seq and not matching_maps(self.maps_data(peer['original']),origin['identity']),'existing/unobserved peer backing map')
                    if self.model==MODEL:
                        need(row['selectedIdentity']==origin['identity'] and row['selectedFlags']&3==2 and self.original(row['selectedOriginal'])==origin['data'] and barrier['sequence']<self.original_sequences.get(self.key(row['selectedOriginal']),0)<seq,'selected actual mmap FD original absent')
                        lease=row['procLease'];need(proc_identity(raw_bytes(lease['statOriginal']),row['pid'])==int(lease['starttime']) and len(lease['directoryIdentity'])==len(lease['statIdentity'])==6 and stat.S_ISDIR(lease['directoryIdentity'][2]) and stat.S_ISREG(lease['statIdentity'][2]),'entry proc lease malformed')
                    aliases=row['aliases'];need(len(aliases)==1 and aliases[0]['pid']==row['pid'] and aliases[0]['fd']==row['fd'] and aliases[0]['accessMode']==2 and aliases[0]['flags']&3==2,'sole selected writable descriptor required')
                if op in ['close','unmap']:
                    need(self.active and self.active['originSequence']==row['originSequence'],'operation lacks active mapped epoch')
                    if op=='close':need(row['fd']==args[0],'actual selected close FD differs')
                    else:
                        need(args[0]==self.active['address'] and rounded_span(args[0],args[1],self.active['page'])==self.active['span'],'partial/foreign munmap unsupported');verify_established(self.maps_data(row['beforeMapsOriginal']),self.active['address'],self.active['page'],row['identity']);need(self.original(row['beforeOriginal'])[0]==1,'actual unmap preimage required')
            self.windows[seq]=row;self.pending_window=seq
        elif kind=='exclusive-generated-vma-resume':
            window=self.windows.get(row['captureSequence']);need(window and row['pid']==window['pid'] and row['entrySequence']==window['entrySequence'],'generated exclusive resume differs');self.pending_window=None;self.transaction=dict(pid=row['pid'],entrySequence=row['entrySequence'],window=window,state='resumed')
        elif kind=='generated-vma-operation-exit':
            transaction=self.transaction;need(transaction and transaction['state']=='exited','generated postimage outside exclusive exit');window=transaction['window'];entry=entries[window['entrySequence']];actual=exits.get(window['entrySequence']);op=window['operation']
            need(row['windowSequence']==window['sequence'] and row['operation']==op and row['pid']==window['pid'] and row['entrySequence']==entry['sequence'] and actual and actual['sequence']==row['exitSequence'] and actual['result']==row['result'] and actual['isError'] is row['isError'] is False and actual['result']>=0,'generated actual syscall exit differs')
            if op=='create':
                current=row['identity'];need(row['path']==window['path'] and row['fd']==actual['result'] and len(current)==6 and stat.S_ISREG(current[2]) and current[3]==0 and self.original(row['original'])==(0,hashlib.sha256(b'').hexdigest()) and row['parentIdentity'][:3]==window['parentIdentity'][:3] and type(row['fdFlags']) is int and row['fdFlags']&3==2,'actual generated empty create differs')
                self.origins[seq]=dict(pid=row['pid'],identity=current,path=row['path'],data=self.original(row['original']),fd=row['fd'])
            elif op=='resize':
                origin=self.origins[window['originSequence']];current=row['identity'];need(row['result']==0 and row['originSequence']==window['originSequence'] and current[:3]==origin['identity'][:3] and current[3]==1 and self.original(row['original'])==(1,hashlib.sha256(b'\0').hexdigest()),'actual zero-extension bytes differ');self.origins[seq]=dict(origin,identity=current,data=self.original(row['original']));del self.origins[window['originSequence']]
            elif op=='map':
                origin=self.origins[window['originSequence']];mapping=verify_established(self.maps_data(row['mapsOriginal']),actual['result'],window['pageBytes'],origin['identity']);need(row['mapping']==mapping and row['identity']==origin['identity'] and row['memoryDomain']==self.mm.unique(row['pid']),'actual mmap backing/domain differs')
                if self.model==LEGACY_MODEL:need('kernelMappingEvidence' not in row and row['mapFilesIdentity']==origin['identity'],'legacy actual map-files fstat required')
                else:
                    need('mapFilesIdentity' not in row,'legacy fstat cannot masquerade as kernel mapping evidence');proof=row['kernelMappingEvidence'];post=barriers.get(proof['postBarrierSequence']);pre=barriers[window['barrierSequence']]
                    need(proof['kind']==MAPPING_KIND and post and post['sequence']==actual['sequence']+1 and post['pids']==pre['pids'] and post.get('taskOwnership')==pre.get('taskOwnership'),'fresh actual mmap post-stop differs')
                    need(proof['selectedFd']==window['fd']==entry['args'][4] and proof['selectedIdentity']==proof['retainedIdentity']==proof['namedIdentity']==origin['identity'] and proof['selectedFlags']==window['selectedFlags'],'actual selected/held/named mapping backing differs')
                    need(proof['beforeOriginal']==window['selectedOriginal'],'selected mmap preimage reference differs')
                    for name in ['postOriginal','confirmationOriginal']:
                        need(self.original(proof[name])==origin['data'] and post['sequence']<self.original_sequences.get(self.key(proof[name]),0)<seq,'actual mapping body confirmation absent')
                    confirm=proof['mapsConfirmationOriginal'];need(confirm['bytes']==row['mapsOriginal']['bytes'] and confirm['sha256']==row['mapsOriginal']['sha256'] and self.maps_data(confirm)==self.maps_data(row['mapsOriginal']) and self.map_owners.get(self.key(confirm))==row['pid'] and post['sequence']<self.map_sequences.get(self.key(row['mapsOriginal']),0)<self.map_sequences.get(self.key(confirm),0)<seq,'full numeric maps confirmation differs')
                    kernel_link(proof['linkBefore'],origin['path']);need(proof['linkBefore']==proof['linkAfter'],'kernel link samples differ')
                    first=self.events.get(proof['linkBeforeSequence']);last=self.events.get(proof['linkAfterSequence'])
                    need(first and last and post['sequence']<self.map_sequences[self.key(row['mapsOriginal'])]<first['sequence']<self.map_sequences[self.key(confirm)]<last['sequence']<seq,'kernel link/maps sample order differs')
                    for sample,link,ref,proc in [(first,proof['linkBefore'],row['mapsOriginal'],proof['procBefore']),(last,proof['linkAfter'],confirm,proof['procAfter'])]:
                        need(sample['kind']=='generated-vma-kernel-link-original' and sample['pid']==row['pid'] and sample['entrySequence']==entry['sequence'] and sample['postBarrierSequence']==post['sequence'] and sample['mapsOriginal']==ref and sample['range']==[mapping['startHex'],mapping['endHex']] and sample['link']==link and sample['procLease']==proc,'kernel link raw sample differs')
                    for sample in [proof['procBefore'],proof['procAfter']]:
                        before=window['procLease'];need(sample['directoryIdentity']==before['directoryIdentity'] and sample['statIdentity']==before['statIdentity'] and sample['starttime']==before['starttime'] and proc_identity(raw_bytes(sample['statOriginal']),row['pid'])==int(before['starttime']),'actual held proc lifetime differs')
                start=int(window['observedMonotonicNs']);deadline=int(window['windowDeadlineMonotonicNs']);parent=int(window['parentDeadlineMonotonicNs']);need(row['windowDeadlineMonotonicNs']==window['windowDeadlineMonotonicNs'] and row['parentDeadlineMonotonicNs']==window['parentDeadlineMonotonicNs'] and start<int(row['observedMonotonicNs'])<deadline<=parent==self.parent_deadline_ns and deadline-start<=int(WINDOW_SECONDS*1e9),'bounded single parent-owned mapping window required')
                origin['fd']=window['fd'];self.active=dict(pid=row['pid'],originSequence=window['originSequence'],address=actual['result'],page=window['pageBytes'],span=rounded_span(actual['result'],1,window['pageBytes']),deadline=deadline,start=start,sequence=seq)
            elif op=='close':
                need(row['result']==0 and row['fd']==window['fd'] and row['fdAbsenceErrno']==errno.ENOENT and row['identity']==window['identity'] and row['epochSequence']==self.active['sequence'],'actual FD close did not retain mapped object')
            elif op=='unmap':
                origin=self.origins[window['originSequence']];need(row['result']==0 and row['originSequence']==window['originSequence'] and row['epochSequence']==self.active['sequence'] and not matching_maps(self.maps_data(row['afterMapsOriginal']),origin['identity']) and same_object(row['identity'],origin['identity']) and self.original(row['original'])==self.original(window['beforeOriginal']),'actual full-unmap/final snapshot differs');peers=row['afterPeerMaps'];barrier=barriers[window['barrierSequence']];need(sorted(p['pid'] for p in peers)==sorted(p for p in barrier['pids'] if p!=row['pid']),'complete final peer maps required')
                for peer in peers:need(self.map_owners.get(self.key(peer['original']))==peer['pid'] and row['exitSequence']<self.map_sequences.get(self.key(peer['original']),0)<seq and not matching_maps(self.maps_data(peer['original']),origin['identity']),'final peer backing alias remains/unobserved')
                self.checkpoints[seq]=dict(row,data=self.original(row['original']));origin.update(identity=row['identity'],data=self.original(row['original']),checkpointed=True);self.active=None
            if 'original' in row:
                need(row['exitSequence']<self.original_sequences.get(self.key(row['original']),0)<seq,'fresh generated postimage original missing')
            for key in ['mapsOriginal','afterMapsOriginal']:
                if key in row:need(self.map_owners.get(self.key(row[key]))==row['pid'] and row['exitSequence']<self.map_sequences.get(self.key(row[key]),0)<seq,'fresh actual post-operation maps missing')
            transaction['state']='completed'
        elif kind=='exclusive-captured-syscall-exit' and self.transaction is not None:
            need(self.transaction['state']=='completed' and row['pid']==self.transaction['pid'] and row['entrySequence']==self.transaction['entrySequence'],'generated operation exclusive close differs');del self.windows[self.transaction['window']['sequence']];self.transaction=None
        elif kind=='generated-vma-consumer-binding':self.consumers.append(row)
    def finish(self,caps,exits):
        need(self.active is None and self.transaction is None and self.pending_window is None and not self.pending_mapping_entries and not self.fd_bindings,'unclosed generated mapping/window');outputs=[]
        for row in self.consumers:
            cap=caps.get(row['captureSequence']);checkpoint=self.checkpoints.get(row['checkpointSequence']);need(cap and checkpoint,'mapped consumer originals missing');actual,data=cap;exit=exits.get(actual['entrySequence'])
            if exit is None or exit['isError'] or exit['result']<=0:continue
            need(actual['role']=='consumer' and checkpoint['sequence']<actual['sequence']<row['sequence'] and actual['identity']==row['identity']==checkpoint['identity'] and actual['path']==row['path'] and data==checkpoint['data'],'mapped generated consumer byte/identity checkpoint differs');outputs.append(dict(path=actual['path'],bytes=data[0],sha256=data[1],consumerCaptureSequence=actual['sequence'],mappedCheckpointSequence=checkpoint['sequence']))
        return outputs

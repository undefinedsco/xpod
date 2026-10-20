"""Actual stopped-tracee provider snapshots; no source authority or new tracer.

The caller must hold its existing complete all-task barrier and retained tool FD.
A read-only provider is a fact at this stop, not proof against future remounts or
an assertion of immutable tool source/complete loader coverage.
"""
import hashlib
import base64
import json
import sys
import threading
import importlib.util
import os
from pathlib import Path
import re
import stat

_spec=importlib.util.spec_from_file_location('provider_util',Path(__file__).with_name('sdk-execution-originals-util.py'));util=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(util)
class ProviderUnavailable(ValueError):pass

def need(condition,reason):
    if not condition:raise ValueError('tool provider originals: '+reason)
def canonical(path):return isinstance(path,str) and path.startswith('/') and os.path.normpath(path)==path and not path.endswith(' (deleted)') and '\x00' not in path

def identity(value):
    need(isinstance(value,list) and len(value)==6 and all(type(item) is int and 0<=item<1<<64 for item in value),'exact six-field kernel identity required');return value

def provider_for(path,mountinfo,file_identity,mount_id):
    """Use actual tracee namespace mountinfo, never the controller mount table."""
    need(canonical(path),'canonical actual named tool path required');identity(file_identity)
    try:provider=util.effective_readonly(path,mountinfo,resolve_local=False)
    except AssertionError as error:raise ProviderUnavailable(str(error)) from error
    matching=[]
    for line in mountinfo.decode('utf-8','strict').splitlines():
        fields=line.split();separator=fields.index('-');need(separator>=6 and len(fields)>separator+3,'mountinfo layout')
        mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
        if mount==provider['mount']:matching.append(fields)
    if len(matching)!=1:raise ProviderUnavailable('ambiguous stacked tool provider mount')
    need(type(mount_id) is int and mount_id>0,'actual FD mount identity required')
    if int(matching[0][0])!=mount_id:raise ProviderUnavailable('actual held FD mount differs from named read-only provider')
    major,minor=matching[0][2].split(':');need(major.isdigit() and minor.isdigit(),'mount device format')
    if (int(major),int(minor))!=(os.major(file_identity[0]),os.minor(file_identity[0])):raise ProviderUnavailable('actual named tool FD/provider device differs')
    return dict(provider,mountId=mount_id)

def bounded_mountinfo(pid,check,maximum):
    data=bytearray()
    with open('/proc/'+str(pid)+'/mountinfo','rb') as source:
        while True:
            check();block=source.read(min(65536,maximum+1-len(data)))
            if not block:break
            data.extend(block);need(len(data)<=maximum,'actual mountinfo metadata bound')
    return bytes(data)

def fd_mount_id(raw,file_identity):
    need(isinstance(raw,str) and len(raw.encode())<=4096,'bounded actual fdinfo required')
    values={}
    for line in raw.splitlines():
        key,_,value=line.partition(':')
        if key in ['mnt_id','ino']:
            need(key not in values and value.strip().isdigit(),'unique kernel FD mount/inode field required');values[key]=int(value.strip())
    need(set(values)=={'mnt_id','ino'} and values['mnt_id']>0 and values['ino']==file_identity[1],'actual FD mount/inode differs');return values['mnt_id']

def fdinfo(fd,check):
    check()
    with open('/proc/self/fdinfo/'+str(fd),'rb') as source:data=source.read(4097)
    need(len(data)<=4096,'actual FD metadata bound');return data.decode('utf-8','strict')

def capture_provider(pid,reader,actual_path,expected_identity,check,maximum_metadata):
    """Caller writes returned bytes through its one charged capture ledger."""
    need(type(pid) is int and pid>0 and type(maximum_metadata) is int and maximum_metadata>0,'bounded actual tracee required');identity(expected_identity)
    if not canonical(actual_path):raise ProviderUnavailable('actual named tool path unavailable')
    prefix='/proc/'+str(pid);namespace=root=named=None
    try:
        check();namespace=os.open(prefix+'/ns/mnt',os.O_RDONLY|os.O_CLOEXEC);root=os.open(prefix+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        namespace_name=os.readlink(prefix+'/ns/mnt');namespace_identity=util.identity(os.fstat(namespace));root_identity=util.identity(os.fstat(root))
        need(re.fullmatch(r'mnt:\[[0-9]+\]',namespace_name),'actual mount namespace format')
        named=os.open(actual_path.lstrip('/'),os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        if util.identity(os.fstat(named))!=expected_identity or util.identity(os.fstat(reader))!=expected_identity:raise ProviderUnavailable('actual tracee named path/held tool FD identity differs')
        held_info=fdinfo(reader,check);named_info=fdinfo(named,check);held_mount=fd_mount_id(held_info,expected_identity);named_mount=fd_mount_id(named_info,expected_identity)
        if held_mount!=named_mount:raise ProviderUnavailable('actual held/named FD mount differs')
        data=bounded_mountinfo(pid,check,maximum_metadata);provider=provider_for(actual_path,data,expected_identity,held_mount)
        # A fresh complete reread prevents registering mixed mount-table snapshots.
        if fdinfo(reader,check)!=held_info or fdinfo(named,check)!=named_info or bounded_mountinfo(pid,check,maximum_metadata)!=data:raise ProviderUnavailable('tracee mount table changed during provider capture')
        if (os.readlink(prefix+'/ns/mnt')!=namespace_name or util.identity(os.stat(prefix+'/ns/mnt'))!=namespace_identity or util.identity(os.fstat(namespace))!=namespace_identity or util.identity(os.stat(prefix+'/root'))!=root_identity or util.identity(os.fstat(root))!=root_identity or util.identity(os.fstat(named))!=expected_identity or util.identity(os.fstat(reader))!=expected_identity):raise ProviderUnavailable('tracee namespace/root/tool identity changed during provider capture')
        check();return data,dict(schemaVersion=1,kind='actual-stopped-tracee-tool-provider',pid=pid,actualPath=actual_path,identity=list(expected_identity),mountNamespace=namespace_name,mountNamespaceIdentity=namespace_identity,rootIdentity=root_identity,heldFdinfoRaw=held_info,namedFdinfoRaw=named_info,provider=provider)
    except OSError as error:
        if error.errno not in [1,2,3,13,20,40]:raise
        raise ProviderUnavailable('tracee tool provider unavailable errno='+str(error.errno)) from error
    finally:
        for fd in [named,root,namespace]:
            if fd is not None:os.close(fd)

def verify_provider_originals(record,mountinfo,*,pid,actual_path,file_identity):
    """Pure parser invoked only after actual all-stop/raw/FD/ref verification."""
    need(record.get('schemaVersion')==1 and record.get('kind')=='actual-stopped-tracee-tool-provider' and record.get('pid')==pid and record.get('actualPath')==actual_path and record.get('identity')==file_identity,'actual tool provider role/FD binding differs')
    namespace_identity=identity(record.get('mountNamespaceIdentity'));root_identity=identity(record.get('rootIdentity'));need(stat.S_ISDIR(root_identity[2]),'actual tracee root directory required');match=re.fullmatch(r'mnt:\[([0-9]+)\]',record.get('mountNamespace',''));need(match is not None and int(match.group(1))==namespace_identity[1],'actual namespace binding required')
    ref=record['mountinfoOriginal'];need(type(ref.get('bytes')) is int and len(mountinfo)==ref['bytes'] and hashlib.sha256(mountinfo).hexdigest()==ref.get('sha256'),'actual mountinfo original bytes differ')
    held_mount=fd_mount_id(record.get('heldFdinfoRaw'),file_identity);need(held_mount==fd_mount_id(record.get('namedFdinfoRaw'),file_identity),'actual named/held FD mounts differ')
    provider=provider_for(actual_path,mountinfo,file_identity,held_mount);need(record.get('provider')==provider,'actual effective read-only provider projection differs')
    return dict(scope='actual stopped tracee namespace named-FD effective read-only provider only',provider=provider,mountNamespace=record['mountNamespace'],identityDecimal=[str(value) for value in file_identity],mountNamespaceIdentityDecimal=[str(value) for value in record['mountNamespaceIdentity']],rootIdentityDecimal=[str(value) for value in record['rootIdentity']],mountinfoOriginal=ref)

# One syscall declaration is consumed by the producer and independent parser.
# Linux v6.12 syscall_64.tbl / asm-generic unistd ABI; unknown architectures fail.
AUTHORITY_MODEL='zero-capabilities-nnp-held-namespace-interval-v2'
AUTHORITY_SCOPE='owned traced task capability/identity and mount namespace interval only; external backing writers unverified'
_AUTHORITY_SYSCALLS={
 0xc000003e:dict(prctl=157,blocked={105,106,113,114,116,117,119,122,123,126,155,161,165,166,170,171,172,173,272,308,317,321,323,47,299,428,429,430,431,432,433,438,440,442}),
 0xc00000b7:dict(prctl=167,blocked={40,39,41,51,91,97,143,144,145,146,147,149,151,152,159,161,162,268,277,280,282,212,243,428,429,430,431,432,433,438,440,442}),
}
# PR_SET_NAME changes only the bounded task name; all other supported operations
# are getters. Authority setters, seccomp/user-dispatch and unknown prctl refuse.
_SAFE_PRCTL={2,3,5,7,9,11,13,15,16,19,21,25,27,30,37,39,40,42,46,52,56,58}
def verify_authority_syscall(arch,nr,args):
    need(arch in _AUTHORITY_SYSCALLS and type(nr) is int and 0<=nr<0x40000000 and isinstance(args,list) and len(args)==6 and all(type(value) is int and 0<=value<1<<64 for value in args),'actual authority syscall ABI required')
    rules=_AUTHORITY_SYSCALLS[arch]
    need(nr not in rules['blocked'],'authority/mount/foreign-FD mutation refused before resume')
    if nr==rules['prctl']:need(args[0] in _SAFE_PRCTL,'unknown or authority-changing prctl refused before resume')

_CAPS=('CapInh','CapPrm','CapEff','CapBnd','CapAmb')
def status_authority(raw,*,pid,tracer=None):
    need(isinstance(raw,str) and len(raw.encode())<=16384,'bounded actual process status required');values={}
    required={'Pid','TracerPid','Uid','Gid','Groups','NoNewPrivs',*_CAPS}
    for line in raw.splitlines():
        key,separator,value=line.partition(':')
        if separator and key in required:
            need(key not in values,'duplicate process authority status field');values[key]=value.strip()
    need(set(values)==required,'complete process authority fields required')
    need(values['Pid'].isdigit() and int(values['Pid'])==pid and values['TracerPid'].isdigit(),'actual process identity required')
    if tracer is not None:need(type(tracer) is int and tracer>0 and int(values['TracerPid'])==tracer,'actual observer tracer identity differs')
    need(values['NoNewPrivs']=='1','actual NoNewPrivs not enabled')
    for key in _CAPS:need(re.fullmatch(r'[0-9a-fA-F]{1,16}',values[key]) and int(values[key],16)==0,'actual process capability set is not empty')
    result={}
    for key in ['Uid','Gid','Groups']:
        words=values[key].split();need((key=='Groups' or len(words)==4) and len(words)<=256 and all(word.isdigit() and int(word)<1<<32 for word in words),'actual UID/GID/group role differs');result[key]=[int(word) for word in words]
    return dict(result,noNewPrivs=1,capabilities={key:0 for key in _CAPS})

def authority_status_diagnostic(raw,*,pid,tracer,check):
    """Bounded original failure context only; never relax the tracer assertion.

    /proc's TracerPid is namespace-relative and identifies the tracing task.
    Preserve the actual values before choosing any future mapping contract.
    """
    need(isinstance(raw,str) and len(raw.encode('utf-8'))<=16384,'diagnostic status bound')
    encoded=raw.encode('utf-8');value=dict(schemaVersion=1,kind='actual-process-authority-status-failure',traceePid=pid,observerPid=tracer,observerNativeTid=threading.get_native_id(),traceeStatus=dict(bytes=len(encoded),sha256=hashlib.sha256(encoded).hexdigest(),encoding='base64',data=base64.b64encode(encoded).decode('ascii')),processes={},namespaceLinks={},authorityVerified=False)
    for role,base in [('observer','/proc/self'),('observerThread','/proc/thread-self'),('tracee','/proc/'+str(pid))]:
        check()
        with open(base+'/status','rb') as source:data=source.read(16385)
        need(len(data)<=16384,'diagnostic process status bound');fields={}
        for line in data.decode('utf-8','strict').splitlines():
            key,separator,word=line.partition(':')
            if separator and key in ['Name','State','Tgid','Pid','PPid','TracerPid','NStgid','NSpid','Threads']:
                need(key not in fields and len(word.encode())<=512,'diagnostic process field bound');fields[key]=word.strip()
        value['processes'][role]=dict(fields=fields,statusBytes=len(data),statusSha256=hashlib.sha256(data).hexdigest())
        links={}
        for namespace in ['pid','pid_for_children','mnt','user']:
            check();link=os.readlink(base+'/ns/'+namespace);need(len(link.encode())<=128,'diagnostic namespace link bound');links[namespace]=link
        value['namespaceLinks'][role]=links
    check();output=json.dumps(value,sort_keys=True,separators=(',',':'));need(len(output.encode())<=65500,'diagnostic encoded bound');return output

def checked_tracer_authority(raw,*,pid,check):
    tracer=os.getpid()
    try:return status_authority(raw,pid=pid,tracer=tracer)
    except ValueError:
        try:diagnostic=authority_status_diagnostic(raw,pid=pid,tracer=tracer,check=check)
        except BaseException as error:
            unavailable=dict(schemaVersion=1,kind='actual-process-authority-status-diagnostic-unavailable',traceePid=pid,observerPid=tracer,errorType=type(error).__name__,authorityVerified=False)
            if isinstance(raw,str) and len(raw)<=16384:
                encoded=raw.encode('utf-8')
                if len(encoded)<=16384:unavailable['traceeStatus']=dict(bytes=len(encoded),sha256=hashlib.sha256(encoded).hexdigest(),encoding='base64',data=base64.b64encode(encoded).decode('ascii'))
            diagnostic=json.dumps(unavailable,sort_keys=True)
        try:sys.stderr.write('SDK_PROCESS_AUTHORITY_DIAGNOSTIC '+diagnostic+'\n');sys.stderr.flush()
        except BaseException:pass
        raise

def restrict_child_authority():
    """Only in the new child, before its release handshake and candidate exec."""
    import ctypes
    libc=ctypes.CDLL(None,use_errno=True)
    def call(option,*args):
        if libc.prctl(option,*(list(args)+[0]*(4-len(args))))!=0:raise OSError(ctypes.get_errno(),'controlled child prctl failed')
    call(38,1) # PR_SET_NO_NEW_PRIVS

    with open('/proc/sys/kernel/cap_last_cap','rb') as source:raw=source.read(17)
    need(len(raw)<=16 and raw.strip().isdigit(),'actual capability ABI bound');last=int(raw);need(0<=last<=63,'unsupported capability ABI')
    for capability in range(last+1):
        present=libc.prctl(23,capability,0,0,0) # PR_CAPBSET_READ
        need(present in [0,1],'actual capability bounding-set read failed')
        if present:call(24,capability) # PR_CAPBSET_DROP, before CAP_SETPCAP is lost
    call(47,4) # PR_CAP_AMBIENT_CLEAR_ALL
    class Header(ctypes.Structure):_fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
    class Data(ctypes.Structure):_fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
    header=Header(0x20080522,0);data=(Data*2)()
    if libc.capset(ctypes.byref(header),ctypes.byref(data))!=0:raise OSError(ctypes.get_errno(),'controlled child capability drop failed')
    with open('/proc/self/status','rb') as source:status=source.read(16385)
    need(len(status)<=16384,'child authority status bound');status_authority(status.decode('utf-8','strict'),pid=os.getpid())

class ProcessAuthorityHandles:
    """Keep nsfs inode objects alive until the observer closes its owned interval.

    Closing the last nsfs file reference permits inode eviction/recreation with
    fresh timestamps. Holding the actual file description avoids that ABA; full
    six-field identities are still compared on every capture, never truncated.
    """
    def __init__(self):self.handles={};self.closed=False
    def bind(self,role,fd):
        need(not self.closed,'authority namespace lease already closed')
        current=util.identity(os.fstat(fd))
        if role not in self.handles:
            held=os.dup(fd);os.set_inheritable(held,False)
            self.handles[role]=(held,current)
        held,initial=self.handles[role]
        need(current==initial==util.identity(os.fstat(held)),'held authority namespace/root identity changed')
        return dict(descriptor=held,identity=initial)
    def close(self):
        for fd,_ in self.handles.values():os.close(fd)
        self.handles.clear();self.closed=True

def capture_process_authority(pid,check,maximum_metadata,handles):
    """Caller holds its complete all-task barrier; returns actual bytes only."""
    need(type(pid) is int and pid>0,'actual stopped process required');fds={}
    def status():
        check()
        with open('/proc/'+str(pid)+'/status','rb') as source:data=source.read(16385)
        need(len(data)<=16384,'actual process status bound');return data.decode('utf-8','strict')
    try:
        before=status();first=checked_tracer_authority(before,pid=pid,check=check);namespaces={}
        for role in ['mnt','pid','user']:
            check();path='/proc/'+str(pid)+'/ns/'+role;fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC);fds[role]=fd;anchor=handles.bind(role,fd);namespaces[role]=dict(link=os.readlink(path),identity=util.identity(os.fstat(fd)),held=anchor)
        root=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC);fds['root']=root;root_identity=util.identity(os.fstat(root));root_held=handles.bind('root',root);mounts=bounded_mountinfo(pid,check,maximum_metadata)
        after=status();need(first==checked_tracer_authority(after,pid=pid,check=check) and mounts==bounded_mountinfo(pid,check,maximum_metadata),'process authority/mounts changed during all-stop capture')
        for role in ['mnt','pid','user']:
            path='/proc/'+str(pid)+'/ns/'+role;need(os.readlink(path)==namespaces[role]['link'] and util.identity(os.stat(path))==namespaces[role]['identity']==util.identity(os.fstat(fds[role]))==handles.bind(role,fds[role])['identity'],'actual process namespace changed during capture')
        need(util.identity(os.stat('/proc/'+str(pid)+'/root'))==root_identity==util.identity(os.fstat(root))==handles.bind('root',root)['identity'],'actual process root changed during capture');check()
        return mounts,dict(schemaVersion=1,kind='actual-stopped-tracee-process-authority',pid=pid,observerPid=os.getpid(),statusOriginals=[before,after],namespaces=namespaces,rootIdentity=root_identity,rootHeld=root_held)
    finally:
        for fd in fds.values():os.close(fd)

def verify_process_authority(record,mountinfo,*,pid):
    need(record.get('schemaVersion')==1 and record.get('kind')=='actual-stopped-tracee-process-authority' and record.get('pid')==pid,'actual process authority role differs')
    statuses=record.get('statusOriginals');need(isinstance(statuses,list) and len(statuses)==2,'dual actual process status required')
    first=status_authority(statuses[0],pid=pid,tracer=record.get('observerPid'));need(first==status_authority(statuses[1],pid=pid,tracer=record['observerPid']),'actual security status changed during capture')
    namespaces=record.get('namespaces');need(isinstance(namespaces,dict) and set(namespaces)=={'mnt','pid','user'},'complete actual namespace set required')
    for role,row in namespaces.items():
        values=identity(row.get('identity'));held=row.get('held');need(isinstance(held,dict) and type(held.get('descriptor')) is int and held['descriptor']>=0 and identity(held.get('identity'))==values,'actual held namespace descriptor identity required');match=re.fullmatch(role+r':\[([0-9]+)\]',row.get('link',''));need(match is not None and int(match.group(1))==values[1],'actual namespace inode differs')
    root=identity(record.get('rootIdentity'));need(stat.S_ISDIR(root[2]),'actual process root must be directory');root_held=record.get('rootHeld');need(isinstance(root_held,dict) and type(root_held.get('descriptor')) is int and root_held['descriptor']>=0 and identity(root_held.get('identity'))==root,'actual held process root descriptor identity required')
    ref=record['mountinfoOriginal'];need(type(ref.get('bytes')) is int and len(mountinfo)==ref['bytes'] and hashlib.sha256(mountinfo).hexdigest()==ref.get('sha256'),'actual authority mountinfo original differs')
    return dict(first,namespaces=namespaces,rootIdentity=root,rootHeld=root_held,mountinfoSha256=ref['sha256'],observerPid=record['observerPid'])

class ProcessAuthorityInterval:
    """Pure replay state. It never grants immutable backing/source authority."""
    def __init__(self,root_pid):
        self.root=root_pid;self.parents={root_pid:None};self.samples={};self.exec_pending={};self.exit_pending={};self.waited=set();self.closed=set();self.baseline=None;self.count=0
    def child(self,parent,child):
        need(parent in self.samples and child not in self.parents,'authority child lacks initialized parent');self.parents[child]=parent
    def event(self,pid,event,sequence):
        need(pid in self.parents,'authority event for unknown process')
        if event==4:need(pid in self.samples and pid not in self.exec_pending,'authority exec interval missing');self.exec_pending[pid]=sequence
        if event==6:need(pid in self.samples and pid not in self.exit_pending,'authority terminal interval missing');self.exit_pending[pid]=sequence
    def sample(self,row,mountinfo):
        pid=row['pid'];need(pid in self.parents and pid not in self.waited,'authority sample outside owned live interval')
        role=row.get('role');need(role in ['initial-root','initial-child','exec-stop','exit-stop'],'unknown authority observation role')
        if role.startswith('initial-'):
            need(pid not in self.samples and row.get('eventSequence') is None and role==('initial-root' if pid==self.root else 'initial-child'),'duplicate/wrong initial authority role')
        elif role=='exec-stop':need(self.exec_pending.pop(pid,None)==row.get('eventSequence'),'authority sample lacks actual exec event')
        else:
            need(self.exit_pending.pop(pid,None)==row.get('eventSequence'),'authority sample lacks actual terminal event');self.closed.add(pid)
        value=verify_process_authority(row['observation'],mountinfo,pid=pid)
        if self.baseline is None:need(pid==self.root and role=='initial-root','root authority original must be first');self.baseline=value
        need(value==self.baseline,'owned process authority/root/namespace/mounts changed during interval');self.samples[pid]=value;self.count+=1
    def syscall(self,row):
        need(row['pid'] in self.samples and row['pid'] not in self.exec_pending and row['pid'] not in self.exit_pending,'syscall resumed without authority boundary capture')
        verify_authority_syscall(row['arch'],row['nr'],row['args'])
    def wait(self,pid):
        need(pid in self.closed and pid in self.samples and pid not in self.exec_pending and pid not in self.exit_pending and pid not in self.waited,'authority interval lacks captured terminal boundary')
        self.waited.add(pid)
    def finish(self):
        need(set(self.parents)==self.waited and not self.exec_pending and not self.exit_pending,'authority interval tracked waits incomplete')
        return dict(schemaVersion=1,model=AUTHORITY_MODEL,scope=AUTHORITY_SCOPE,trackedProcesses=len(self.parents),actualAuthorityCaptures=self.count,namespaceExternalWriterAuthorityVerified=False,toolchainLifetimeImmutabilityVerified=False)

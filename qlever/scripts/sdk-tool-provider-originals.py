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

def stopped_authority_difference_diagnostic(pid,statuses,stats):
    """Bounded rejection facts only; never accept or serialize task contents."""
    try:
        def status_fields(raw):
            fields={}
            for line in raw.splitlines():
                key,separator,value=line.partition(':')
                if separator and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,47}',key):
                    fields.setdefault(key,[]).append(value)
            return fields
        first,second=[status_fields(row['data']) for row in statuses]
        changed=sorted(key for key in set(first)|set(second) if first.get(key)!=second.get(key))
        words=[row['data'][row['data'].rfind(')')+2:].split() for row in stats]
        positions=[index+3 for index in range(max(map(len,words))) if
                   (words[0][index] if index<len(words[0]) else None)!=
                   (words[1][index] if index<len(words[1]) else None)]
        value=dict(kind='stopped-authority-snapshot-difference',pid=pid,
                   authorityVerified=False,statusChangedKeys=changed[:32],
                   statusChangedKeyCount=len(changed),statChangedFields=positions[:32],
                   statChangedFieldCount=len(positions),differenceListTruncated=len(changed)>32 or len(positions)>32,
                   statusOriginals=[dict(bytes=row['bytes'],sha256=row['sha256']) for row in statuses],
                   statOriginals=[dict(bytes=row['bytes'],sha256=row['sha256']) for row in stats],
                   scope='same stopped task rejection diagnostic; raw values not printed; no authority or source qualification')
        line='SDK_STOPPED_AUTHORITY_SNAPSHOT_CHANGED '+json.dumps(value,sort_keys=True,separators=(',',':'))+'\n'
        if len(line.encode())<=4096:
            sys.stderr.write(line)
    except BaseException:
        pass  # The original stopped-authority rejection must survive diagnostics.
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

# Pure candidate checks only. The existing syscall gate remains strict until
# the backend binds both actual stopped samples and receipts to one transition.
# Single reviewed ABI/identity-axis authority shared by producer and replay.
_IDENTITY_NOOP_ABI={0xc000003e:{117:'Uid',119:'Gid'},0xc00000b7:{147:'Uid',149:'Gid'}}
def identity_noop_axis(arch,nr):
    return _IDENTITY_NOOP_ABI.get(arch,{}).get(nr) if type(arch) is int and type(nr) is int else None

def identity_noop_entry(arch,nr,args,raw,*,pid,tracer):
    axis=identity_noop_axis(arch,nr)
    need(axis in ['Uid','Gid'],'exact setres identity ABI required')
    need(isinstance(args,list) and len(args)==6 and all(type(word) is int and 0<=word<1<<64 for word in args),'setres identity uint64 argument words required')
    authority=status_authority(raw,pid=pid,tracer=tracer)
    real,effective,saved=(word&0xffffffff for word in args[:3]);old=authority[axis];sentinel=0xffffffff
    # Linux __sys_setresuid/__sys_setresgid both return before changing creds
    # only when effective also equals filesystem identity in this userns.
    need((real==sentinel or real==old[0]) and
         (effective==sentinel or effective==old[1]==old[3]) and
         (saved==sentinel or saved==old[2]),'setres identity is not an exact authority no-op')
    return authority

def verify_identity_noop_transition(arch,nr,args,before_raw,after_raw,*,pid,tracer,result):
    before=identity_noop_entry(arch,nr,args,before_raw,pid=pid,tracer=tracer)
    need(type(result) is int and result==0,'actual identity no-op successful exit required')
    after=status_authority(after_raw,pid=pid,tracer=tracer)
    need(before==after,'actual authority changed across identity no-op')
    return before

def setresuid_noop_entry(arch,nr,args,raw,*,pid,tracer):
    need(identity_noop_axis(arch,nr)=='Uid','exact setresuid ABI required')
    return identity_noop_entry(arch,nr,args,raw,pid=pid,tracer=tracer)

def verify_setresuid_noop_transition(arch,nr,args,before_raw,after_raw,*,pid,tracer,result):
    need(identity_noop_axis(arch,nr)=='Uid','exact setresuid ABI required')
    return verify_identity_noop_transition(arch,nr,args,before_raw,after_raw,pid=pid,tracer=tracer,result=result)

class StoppedIdentityNoopTransition:
    """Owned FD lease, not a JSON issuer. Core supplies its actual all-stop rows.

    The strict default syscall gate is unchanged. Both records must be emitted
    by the existing backend and independently joined to its entry/exit/barrier.
    """
    def __init__(self,pid,arch,nr,args,check,*,entry_sequence,barrier_sequence,stopped_wait_status):
        self.fds={};self.closed=False;self.check=check;self.pid=pid
        need(isinstance(args,list) and len(args)==6 and all(type(x) is int and 0<=x<1<<64 for x in args),'actual setresuid arguments required')
        self.axis=identity_noop_axis(arch,nr);need(self.axis in ['Uid','Gid'],'exact identity no-op ABI required')
        self.operation='setresuid' if self.axis=='Uid' else 'setresgid'
        self.arch=arch;self.nr=nr;self.args=list(args);self.entry_sequence=entry_sequence
        need(type(pid) is int and pid>0,'actual setresuid task required')
        need(type(entry_sequence) is int and type(barrier_sequence) is int and 0<entry_sequence<barrier_sequence,'actual entry/all-stop sequence required')
        try:
            check();self.fds['process']=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
            self.process_identity=util.identity(os.fstat(self.fds['process']))
            for role in ['status','stat']:
                self.fds[role]=os.open(role,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=self.fds['process'])
            self.namespaces={}
            for owner,base in [('tracee','/proc/'+str(pid)),('observer','/proc/self')]:
                for role in ['user','pid','mnt']:
                    key=owner+':'+role;path=base+'/ns/'+role;check()
                    fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC);self.fds[key]=fd
                    row=dict(link=os.readlink(path),identity=util.identity(os.fstat(fd)))
                    need(re.fullmatch(role+r':\[([0-9]+)\]',row['link']) is not None and int(row['link'].split('[')[1][:-1])==row['identity'][1],'actual namespace identity required')
                    self.namespaces[key]=row
            need(self.namespaces['tracee:user']==self.namespaces['observer:user'],'setresuid UID namespace differs from observer')
            self.before=self._sample(stopped_wait_status)
            self.authority=identity_noop_entry(arch,nr,self.args,self.before['statusOriginals'][0]['data'],pid=pid,tracer=os.getpid())
            self.observation=self._record('entry',entry_sequence,barrier_sequence,stopped_wait_status,self.before)
        except BaseException:
            self.close();raise
    def _read(self,role,maximum):
        self.check();fd=self.fds[role];before=util.identity(os.fstat(fd))
        need(before==util.identity(os.stat(role,dir_fd=self.fds['process'],follow_symlinks=False)),'actual authority named descriptor differs')
        os.lseek(fd,0,os.SEEK_SET);chunks=[];size=0
        while True:
            self.check();data=os.read(fd,min(4096,maximum+1-size))
            if not data:break
            size+=len(data);need(size<=maximum,'actual authority raw original bound');chunks.append(data)
        need(before==util.identity(os.fstat(fd))==util.identity(os.stat(role,dir_fd=self.fds['process'],follow_symlinks=False)),'actual authority descriptor changed during read')
        raw=b''.join(chunks);return dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),data=raw.decode('utf-8','strict'),identity=before)
    def _sample(self,wait_status):
        need(not self.closed and type(wait_status) is int and os.WIFSTOPPED(wait_status),'actual stopped wait required')
        statuses=[self._read('status',16384)];stats=[self._read('stat',4096)]
        first=status_authority(statuses[0]['data'],pid=self.pid,tracer=os.getpid())
        fields={}
        for line in statuses[0]['data'].splitlines():
            key,sep,value=line.partition(':')
            if sep and key in ['State','Tgid','Pid','TracerPid']:
                need(key not in fields,'duplicate actual stopped task field');fields[key]=value.strip()
        need(fields.get('State','').split(' ')[0] in ['t','T'],'actual task is not stopped')
        need(fields.get('Tgid','').isdigit(),'actual task group required')
        start=self._starttime(stats[0]['data'])
        for key,row in self.namespaces.items():
            self.check();owner,role=key.split(':');base='/proc/'+str(self.pid) if owner=='tracee' else '/proc/self';path=base+'/ns/'+role
            need(row['link']==os.readlink(path) and row['identity']==util.identity(os.fstat(self.fds[key]))==util.identity(os.stat(path)),'actual authority namespace changed')
        need(self.process_identity==util.identity(os.fstat(self.fds['process']))==util.identity(os.stat('/proc/'+str(self.pid),follow_symlinks=False)),'actual process directory identity changed')
        statuses.append(self._read('status',16384));stats.append(self._read('stat',4096))
        if statuses[0]['data']!=statuses[1]['data'] or stats[0]['data']!=stats[1]['data']:
            stopped_authority_difference_diagnostic(self.pid,statuses,stats)
        need(statuses[0]['data']==statuses[1]['data'] and stats[0]['data']==stats[1]['data'],'actual stopped authority changed during capture')
        need(first==status_authority(statuses[1]['data'],pid=self.pid,tracer=os.getpid()),'actual stopped authority differs')
        self.check();uname=os.uname();values=dict(zip(['sysname','nodename','release','version','machine'],uname))
        need(all(isinstance(v,str) and len(v.encode())<=1024 for v in values.values()),'actual uname bound')
        value=dict(statusOriginals=statuses,statOriginals=stats,processStarttime=start,processIdentity=self.process_identity,taskGroup=int(fields['Tgid']),namespaces=self.namespaces,uname=values)
        need(sum(x['bytes'] for x in statuses+stats)<=40960,'actual authority combined raw bound')
        return value
    def _starttime(self,raw):
        need(raw.startswith(str(self.pid)+' ('),'actual stat PID differs');end=raw.rfind(')');words=raw[end+2:].split()
        need(end>0 and len(words)>=20 and words[19].isdigit(),'actual stat starttime missing');return words[19]
    def _record(self,role,sequence,barrier,wait_status,sample):
        value=dict(schemaVersion=1,kind='actual-stopped-'+self.operation+'-'+role,pid=self.pid,observerPid=os.getpid(),observerNativeTid=threading.get_native_id(),arch=self.arch,nr=self.nr,args=self.args,entrySequence=self.entry_sequence,sequence=sequence,barrierSequence=barrier,stoppedWaitStatus=wait_status,observation=sample)
        if not getattr(self,'legacy_uid_originals',False):value['identityAxis']=self.axis
        encoded=json.dumps(value,sort_keys=True,separators=(',',':')).encode();need(len(encoded)<=65500,'actual setresuid record bound');return json.loads(encoded)
    def finish(self,*,exit_sequence,barrier_sequence,stopped_wait_status,result):
        try:
            need(type(exit_sequence) is int and type(barrier_sequence) is int and self.entry_sequence<exit_sequence<barrier_sequence,'actual setresuid exit/all-stop sequence required')
            after=self._sample(stopped_wait_status)
            need(after['processStarttime']==self.before['processStarttime'] and after['taskGroup']==self.before['taskGroup'] and after['uname']==self.before['uname'],'actual setresuid task identity switched')
            verify_identity_noop_transition(self.arch,self.nr,self.args,self.before['statusOriginals'][0]['data'],after['statusOriginals'][0]['data'],pid=self.pid,tracer=os.getpid(),result=result)
            value=self._record('exit',exit_sequence,barrier_sequence,stopped_wait_status,after);value['result']=result;return value
        finally:self.close()
    def close(self):
        if not self.closed:
            for fd in self.fds.values():os.close(fd)
            self.fds.clear();self.closed=True

class StoppedSetresuidTransition(StoppedIdentityNoopTransition):
    # Existing UID-only caller and serialized originals keep their old contract.
    def __init__(self,pid,arch,nr,args,check,**kwargs):
        need(identity_noop_axis(arch,nr)=='Uid','exact setresuid ABI required')
        self.legacy_uid_originals=True
        super().__init__(pid,arch,nr,args,check,**kwargs)

def verify_stopped_identity_noop_original(row,role):
    need(isinstance(row,dict),'actual identity original required')
    axis=identity_noop_axis(row.get('arch'),row.get('nr'));operation='setresuid' if axis=='Uid' else 'setresgid'
    need(axis in ['Uid','Gid'] and row.get('schemaVersion')==1 and row.get('kind')=='actual-stopped-'+operation+'-'+role,'actual identity original role differs')
    need((axis=='Uid' and 'identityAxis' not in row) or row.get('identityAxis')==axis,'actual identity axis differs')
    need(len(json.dumps(row,sort_keys=True,separators=(',',':')).encode())<=65536,'actual setresuid original encoded bound')
    for key in ['pid','observerPid','observerNativeTid','entrySequence','sequence','barrierSequence']:
        need(type(row.get(key)) is int and row[key]>0,'actual setresuid sequence/identity required')
    wait=row.get('stoppedWaitStatus');need(type(wait) is int and os.WIFSTOPPED(wait),'actual setresuid stopped wait missing')
    value=row.get('observation');need(isinstance(value,dict),'actual setresuid observation required')
    raws={}
    for key,maximum in [('statusOriginals',16384),('statOriginals',4096)]:
        rows=value.get(key);need(isinstance(rows,list) and len(rows)==2,'dual actual setresuid raw originals required');out=[]
        for original in rows:
            need(isinstance(original,dict) and isinstance(original.get('data'),str),'actual setresuid raw text required')
            data=original['data'].encode();need(type(original.get('bytes')) is int and len(data)==original['bytes']<=maximum and hashlib.sha256(data).hexdigest()==original.get('sha256'),'actual setresuid raw identity differs');identity(original.get('identity'));out.append(original['data'])
        need(out[0]==out[1] and rows[0]['identity']==rows[1]['identity'],'actual setresuid dual originals differ');raws[key]=out[0]
    authority=status_authority(raws['statusOriginals'],pid=row['pid'],tracer=row['observerPid'])
    fields={}
    for line in raws['statusOriginals'].splitlines():
        key,sep,val=line.partition(':')
        if sep and key in ['State','Tgid']:
            need(key not in fields,'duplicate setresuid task identity');fields[key]=val.strip()
    need(fields.get('State','').split(' ')[0] in ['t','T'] and fields.get('Tgid','').isdigit() and type(value.get('taskGroup')) is int and value['taskGroup']==int(fields['Tgid']),'actual setresuid stopped task differs')
    statraw=raws['statOriginals'];end=statraw.rfind(')');words=statraw[end+2:].split()
    need(statraw.startswith(str(row['pid'])+' (') and end>0 and len(words)>=20 and words[19].isdigit() and words[19]==value.get('processStarttime'),'actual setresuid stat starttime differs');identity(value.get('processIdentity'))
    namespaces=value.get('namespaces');need(isinstance(namespaces,dict) and set(namespaces)=={owner+':'+role for owner in ['tracee','observer'] for role in ['user','pid','mnt']},'actual setresuid namespace set differs')
    for key,ns in namespaces.items():
        role=key.split(':')[1];values=identity(ns.get('identity'));need(ns.get('link')==role+':['+str(values[1])+']','actual setresuid namespace inode differs')
    need(namespaces['tracee:user']==namespaces['observer:user'],'actual setresuid UID namespace mismatch')
    uname=value.get('uname');need(isinstance(uname,dict) and set(uname)=={'sysname','nodename','release','version','machine'} and all(isinstance(x,str) and len(x.encode())<=1024 for x in uname.values()),'actual setresuid uname required')
    return value,raws,authority

def verify_identity_noop_original_pair(entry,exit):
    """Pure replay of registered originals; core must also join real raw events."""
    before,braw,ba=verify_stopped_identity_noop_original(entry,'entry');after,araw,aa=verify_stopped_identity_noop_original(exit,'exit')
    for key in ['pid','observerPid','observerNativeTid','arch','nr','args','entrySequence']:
        need(entry.get(key)==exit.get(key),'actual setresuid transition identity differs')
    need(entry['entrySequence']==entry['sequence']<entry['barrierSequence']<exit['sequence']<exit['barrierSequence'],'actual setresuid transition order differs')
    for key in ['processStarttime','processIdentity','taskGroup','namespaces','uname']:
        need(before[key]==after[key],'actual setresuid process/namespace identity switched')
    verify_identity_noop_transition(entry['arch'],entry['nr'],entry['args'],braw['statusOriginals'],araw['statusOriginals'],pid=entry['pid'],tracer=entry['observerPid'],result=exit.get('result'))
    operation='setresuid' if identity_noop_axis(entry['arch'],entry['nr'])=='Uid' else 'setresgid'
    return dict(kind='verified-'+operation+'-noop-original-pair',pid=entry['pid'],entrySequence=entry['sequence'],exitSequence=exit['sequence'],authority=ba)

def verify_stopped_setresuid_original(row,role):
    need(isinstance(row,dict) and identity_noop_axis(row.get('arch'),row.get('nr'))=='Uid','exact setresuid ABI required')
    return verify_stopped_identity_noop_original(row,role)

def verify_setresuid_original_pair(entry,exit):
    need(isinstance(entry,dict) and identity_noop_axis(entry.get('arch'),entry.get('nr'))=='Uid','exact setresuid ABI required')
    return verify_identity_noop_original_pair(entry,exit)

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

def actual_exit_event_wait(status):
    # Linux ptrace event bits are not interpreted with the host Darwin macros.
    return type(status) is int and 0<=status<1<<32 and status>>16==6 and status&0xffff==((5<<8)|127)

def terminal_live_status_state(raw):
    fields={}
    for line in raw.splitlines():
        key,sep,value=line.partition(':')
        if sep and key=='State':need(key not in fields,'duplicate EXIT authority state');fields[key]=value.strip()
    need(fields.get('State','').split(' ')[0] in ['t','T'],'EXIT authority was not captured in its own live tracing stop')

class ExitStopAuthorityLease:
    """Capture the last strict live authority before stopping peer tasks.

    The traced task is held at its actual PTRACE_EVENT_EXIT. Nothing here
    accepts TracerPid=0 or a zombie as a live authority/FD provider.
    """
    def __init__(self,pid,wait_status,exit_status,check,maximum_metadata,handles):
        need(actual_exit_event_wait(wait_status),'actual selected EXIT event stop required')
        need(type(exit_status) is int and 0<=exit_status<1<<32 and (os.WIFEXITED(exit_status) or os.WIFSIGNALED(exit_status)),'actual EXIT event message required')
        self.fds={};self.closed=False;self.pid=pid;self.check=check;self.exit_status=exit_status
        try:
            check();self.fds['process']=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
            self.process_identity=util.identity(os.fstat(self.fds['process']))
            self.fds['stat']=os.open('stat',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=self.fds['process'])
            before=self._read('stat',4096);start=self._starttime(before['data'])
            need(before['data'][before['data'].rfind(')')+2:].split()[0] in ['t','T'],'selected EXIT event task is no longer in a live tracing stop')
            mounts,authority=capture_process_authority(pid,check,maximum_metadata,handles)
            for status_raw in authority['statusOriginals']:terminal_live_status_state(status_raw)
            after=self._read('stat',4096)
            need(before['data']==after['data'] and before['identity']==after['identity'],'EXIT event task changed during strict authority capture')
            need(self.process_identity==util.identity(os.stat('/proc/'+str(pid),follow_symlinks=False)),'held EXIT task differs')
            self.observation=dict(schemaVersion=1,kind='actual-exit-stop-authority-before-peer-barrier',pid=pid,waitStatus=wait_status,exitStatus=exit_status,processStarttime=start,processIdentity=self.process_identity,statOriginals=[before,after],authority=authority)
            need(len(json.dumps(self.observation,separators=(',',':')).encode())<=65500,'EXIT authority original encoded bound')
            self.mounts=mounts;self.starttime=start
        except BaseException:self.close();raise
    _read=StoppedIdentityNoopTransition._read
    _starttime=StoppedIdentityNoopTransition._starttime
    def assert_task_before_wait(self):
        need(not self.closed,'EXIT task lease closed before actual wait');self.check()
        need(self.process_identity==util.identity(os.fstat(self.fds['process']))==util.identity(os.stat('/proc/'+str(self.pid),follow_symlinks=False)),'EXIT task held directory differs before wait')
        value=self._read('stat',4096);need(self._starttime(value['data'])==self.starttime,'EXIT task reused before actual wait')
        return value['data'][value['data'].rfind(')')+2:].split()[0]
    def terminal_peer_original(self):
        need(self.assert_task_before_wait()=='Z','terminal peer must be an actual held zombie')
        before=self._read('stat',4096);after=self._read('stat',4096)
        need(before==after and self._starttime(before['data'])==self.starttime,'terminal peer stat/lifetime changed')
        need(before['data'][before['data'].rfind(')')+2:].split()[0]=='Z','terminal peer is not a zombie')
        need(self.process_identity==util.identity(os.fstat(self.fds['process']))==util.identity(os.stat('/proc/'+str(self.pid),follow_symlinks=False)),'terminal peer held process changed')
        return dict(pid=self.pid,processIdentity=self.process_identity,statOriginals=[before,after])
    close=StoppedIdentityNoopTransition.close

def verify_exit_stop_authority_original(record,mountinfo,actual_event,*,pid):
    need(isinstance(record,dict) and record.get('schemaVersion')==1 and record.get('kind')=='actual-exit-stop-authority-before-peer-barrier' and record.get('pid')==pid,'EXIT authority original role differs')
    need(len(json.dumps(record,separators=(',',':')).encode())<=65536,'EXIT authority original encoded bound')
    need(actual_event.get('kind')=='ptrace-event' and actual_event.get('pid')==pid and actual_event.get('event')==6 and actual_event.get('waitStatus')==record.get('waitStatus') and actual_event.get('exitStatus')==record.get('exitStatus'),'EXIT authority lacks exact actual event/message')
    wait=record.get('waitStatus');message=record.get('exitStatus')
    need(actual_exit_event_wait(wait),'EXIT original lacks actual ptrace stop')
    need(type(message) is int and 0<=message<1<<32 and (os.WIFEXITED(message) or os.WIFSIGNALED(message)),'EXIT original lacks terminal message')
    rows=record.get('statOriginals');need(isinstance(rows,list) and len(rows)==2 and rows[0]==rows[1],'EXIT task dual stat originals differ')
    for row in rows:
        need(isinstance(row,dict) and isinstance(row.get('data'),str),'EXIT stat original missing');data=row['data'].encode()
        need(type(row.get('bytes')) is int and len(data)==row['bytes']<=4096 and hashlib.sha256(data).hexdigest()==row.get('sha256'),'EXIT stat original hash differs');identity(row.get('identity'))
    raw=rows[0]['data'];end=raw.rfind(')');words=raw[end+2:].split()
    need(raw.startswith(str(pid)+' (') and end>0 and len(words)>=20 and words[0] in ['t','T'] and words[19].isdigit() and words[19]==record.get('processStarttime'),'EXIT original was not sampled at its own live stop')
    identity(record.get('processIdentity'))
    authority=record.get('authority',{})
    for raw in authority.get('statusOriginals',[]):terminal_live_status_state(raw)
    return verify_process_authority(authority,mountinfo,pid=pid)

class ProcessAuthorityInterval:
    """Pure replay state. It never grants immutable backing/source authority."""
    def __init__(self,root_pid,*,terminal_peer_model=False):
        need(type(terminal_peer_model)is bool,'typed terminal peer model required');self.terminal_peer_model=terminal_peer_model;self.terminal_originals={};self.terminal_resume_rows={}
        self.root=root_pid;self.parents={root_pid:None};self.samples={};self.exec_pending={};self.exit_pending={};self.waited=set();self.closed=set();self.baseline=None;self.count=0;self.setresuid_pending={};self.setresuid_count=0;self.terminal_samples={};self.terminal_waits={};self.terminal_messages={};self.terminal_closed_rows={};self.terminal_resumed=set()
    def child(self,parent,child):
        need(not self.setresuid_pending,'child event during exclusive setresuid transition')
        need(parent in self.samples and parent not in self.closed and parent not in self.waited and parent not in self.exit_pending and parent not in self.terminal_messages and child not in self.parents,'authority child lacks initialized live parent');self.parents[child]=parent
    def event(self,pid,event,sequence):
        need(pid in self.parents and pid not in self.closed and pid not in self.waited and pid not in self.terminal_messages and not self.setresuid_pending,'authority event for unknown/terminal process or unclosed setresuid transition')
        if event==4:need(pid in self.samples and pid not in self.exec_pending,'authority exec interval missing');self.exec_pending[pid]=sequence
        if event==6:need(pid in self.samples and pid not in self.exit_pending,'authority terminal interval missing');self.exit_pending[pid]=sequence
    def sample(self,row,mountinfo):
        need(not self.setresuid_pending,'authority boundary sample during exclusive setresuid transition')
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
    def terminal_sample(self,row,mountinfo,actual_event):
        pid=row['pid'];need(not self.setresuid_pending and pid in self.samples and pid not in self.waited and pid not in self.terminal_samples,'terminal sample outside initialized owned interval')
        need(self.exit_pending.get(pid)==row.get('eventSequence')==actual_event.get('sequence'),'terminal sample lacks pending actual EXIT event')
        need(actual_event.get('phase')==row.get('phase') and type(row.get('sequence')) is int and actual_event['sequence']<row['sequence'],'terminal early original event/phase order differs')
        value=verify_exit_stop_authority_original(row['observation'],mountinfo,actual_event,pid=pid)
        need(value==self.baseline,'strict EXIT authority differs from owned baseline')
        self.terminal_samples[pid]=dict(row=json.loads(json.dumps(row)),event=actual_event)
        self.terminal_originals[pid]=self.terminal_samples[pid]
        self.terminal_messages[pid]=row['observation']['exitStatus'];self.count+=1
    def terminal_peers(self,barrier):
        peers=barrier.get('terminalPeers',[])
        need(isinstance(peers,list)and len(peers)<=128 and(not peers or self.terminal_peer_model),'terminal peers require explicit v2 model')
        need([row['pid']for row in peers]==sorted(set(row['pid']for row in peers)),'unique ordered terminal peers required')
        for peer in peers:
            pid=peer['pid'];original=self.terminal_originals.get(pid);closed=self.terminal_closed_rows.get(pid);resume=self.terminal_resume_rows.get(pid)
            need(original and closed and resume and pid in self.closed and pid not in self.waited and pid not in self.terminal_waits,'terminal peer lacks closed/resumed live EXIT authority')
            sample=original['row'];observation=sample['observation']
            need(peer['originalSequence']==sample['sequence']and peer['closeSequence']==closed['sequence']and peer['resumeSequence']==resume['sequence']and sample['phase']==closed['phase']==resume['phase']==barrier['phase']and sample['sequence']<closed['sequence']<resume['sequence']<barrier['sequence'],'terminal peer causal references differ')
            need(peer['processIdentity']==observation['processIdentity'],'terminal peer held process identity differs')
            rows=peer['statOriginals'];need(isinstance(rows,list)and len(rows)==2 and rows[0]==rows[1],'terminal peer dual stat originals differ')
            for row in rows:
                need(isinstance(row,dict)and isinstance(row.get('data'),str),'terminal peer stat missing')
                raw=row['data'];data=raw.encode();identity(row['identity'])
                need(row['identity']==observation['statOriginals'][0]['identity']and row['bytes']==len(data)<=4096 and hashlib.sha256(data).hexdigest()==row['sha256'],'terminal peer held stat identity/bytes differ')
                end=raw.rfind(')');fields=raw[end+2:].split();need(raw.startswith(str(pid)+' (')and end>0 and len(fields)>=20 and fields[0]=='Z'and fields[19]==observation['processStarttime'],'terminal peer must retain same actual zombie lifetime')
        return {row['pid']for row in peers}
    def terminal_close(self,row,barrier):
        pid=row['pid'];sample=self.terminal_samples.get(pid)
        need(sample is not None and row.get('originalSequence')==sample['row']['sequence'] and row.get('eventSequence')==sample['event']['sequence'],'terminal close lacks identical early observation')
        need(barrier.get('kind')=='all-stop-barrier' and barrier.get('sequence')==row.get('barrierSequence') and barrier.get('phase')==row.get('phase')==sample['row'].get('phase'),'terminal close lacks same-phase peer barrier')
        need(type(row.get('sequence')) is int and sample['row']['sequence']<barrier['sequence']<row['sequence'],'terminal peer barrier must follow the early own-stop snapshot')
        live=sorted(set(self.parents)-self.waited-set(self.terminal_waits)-self.terminal_peers(barrier))
        need(barrier.get('pids')==live and barrier.get('osStates')==['t']*len(live),'terminal close peer stop universe incomplete')
        wait=self.terminal_waits.get(pid)
        need(row.get('actualWaitSequence')==(wait['sequence'] if wait else None),'terminal close actual wait reference differs')
        need(self.exit_pending.pop(pid,None)==sample['event']['sequence'],'terminal close EXIT event changed');self.closed.add(pid);self.terminal_samples.pop(pid);self.terminal_closed_rows[pid]=dict(row)
        if wait is not None:self.terminal_waits.pop(pid);self.waited.add(pid)
    def terminal_resume(self,row):
        pid=row['pid'];closed=self.terminal_closed_rows.get(pid)
        need(closed is not None and pid in self.closed and pid not in self.waited and pid not in self.terminal_resumed,'terminal resume outside its owned closed boundary')
        need(row.get('request')=='PTRACE_SYSCALL' and type(row.get('signal')) is int and row['signal']==0 and row.get('originalSequence')==closed['originalSequence'] and row.get('closeSequence')==closed['sequence']<row['sequence'],'terminal resume lacks exact signal-zero primitive/causality')
        self.terminal_resumed.add(pid);self.terminal_resume_rows[pid]=dict(row)
    def syscall(self,row):
        need(not self.setresuid_pending,'another syscall before setresuid transition consumed')
        need(row['pid'] in self.samples and row['pid'] not in self.closed and row['pid'] not in self.waited and row['pid'] not in self.terminal_messages and row['pid'] not in self.exec_pending and row['pid'] not in self.exit_pending,'syscall resumed outside live authority boundary')
        verify_authority_syscall(row['arch'],row['nr'],row['args'])
    def _setresuid_raw_join(self,observation,raw,barrier,op):
        need(isinstance(raw,dict) and isinstance(barrier,dict),'actual setresuid kernel/barrier rows required')
        need(len(json.dumps(raw,separators=(',',':')).encode())<=65536 and len(json.dumps(barrier,separators=(',',':')).encode())<=65536,'actual setresuid raw row bound')
        need(all(type(raw.get(key)) is int and raw[key]>0 for key in ['pid','sequence','arch']),'actual setresuid kernel integer identities required')
        need(raw.get('kind')=='kernel-syscall' and raw.get('op')==op and raw.get('pid')==observation['pid'] and raw.get('sequence')==observation['sequence'] and raw.get('arch')==observation['arch'],'actual setresuid kernel event differs')
        phase=raw.get('phase');need(phase in ['configure','compile'],'actual setresuid phase required')
        wait=raw.get('waitStatus');need(type(wait) is int and wait==observation['stoppedWaitStatus'] and os.WIFSTOPPED(wait) and os.WSTOPSIG(wait)==133,'actual setresuid syscall wait differs')
        need(barrier.get('kind')=='all-stop-barrier' and barrier.get('phase')==phase and barrier.get('sequence')==observation['barrierSequence'],'actual setresuid all-stop event differs')
        live=sorted(set(self.parents)-self.waited)
        need(barrier.get('pids')==live and barrier.get('osStates')==['t']*len(live) and observation['pid'] in live,'actual setresuid all-owned-task stop incomplete')
        if op=='entry':need(type(raw.get('nr')) is int and raw['nr']==observation['nr'] and isinstance(raw.get('args'),list) and all(type(word) is int and 0<=word<1<<64 for word in raw['args']) and raw['args']==observation['args'],'actual setresuid kernel argument words differ')
        else:need(type(raw.get('entrySequence')) is int and raw['entrySequence']==observation['entrySequence'] and type(raw.get('result')) is int and raw['result']==0 and raw.get('isError') is False and observation.get('result')==0,'actual setresuid kernel successful exit differs')
        return phase
    def begin_identity_noop_original(self,entry,actual_entry,entry_barrier):
        value,raws,authority=verify_stopped_identity_noop_original(entry,'entry');pid=entry['pid']
        need(pid in self.samples and pid not in self.exec_pending and pid not in self.exit_pending and pid not in self.waited and pid not in self.closed and not self.setresuid_pending,'setresuid outside initialized live authority interval')
        need(entry['entrySequence']==entry['sequence']<entry['barrierSequence'],'setresuid entry/barrier order differs')
        phase=self._setresuid_raw_join(entry,actual_entry,entry_barrier,'entry')
        identity_noop_entry(entry['arch'],entry['nr'],entry['args'],raws['statusOriginals'],pid=pid,tracer=entry['observerPid'])
        need(self.baseline is not None and entry['observerPid']==self.baseline['observerPid'],'setresuid lacks same observer authority baseline')
        for key in ['Uid','Gid','Groups','noNewPrivs','capabilities']:need(authority[key]==self.baseline[key],'setresuid entry differs from actual authority baseline')
        for role in ['user','pid','mnt']:
            need(value['namespaces']['tracee:'+role]['identity']==self.baseline['namespaces'][role]['identity'] and value['namespaces']['tracee:'+role]['link']==self.baseline['namespaces'][role]['link'],'setresuid entry namespace differs from interval')
        need(len(self.setresuid_pending)<1024,'setresuid pending transition bound')
        self.setresuid_pending[pid]=dict(entry=json.loads(json.dumps(entry)),phase=phase)
    def consume_verified_identity_noop_pair(self,entry,exit,actual_exit,exit_barrier):
        pid=entry.get('pid');pending=self.setresuid_pending.get(pid)
        need(pending is not None and pending['entry']==entry,'setresuid lacks identical registered entry original')
        need(pid in self.samples and pid not in self.exec_pending and pid not in self.exit_pending and pid not in self.waited and pid not in self.closed,'setresuid exit outside live authority interval')
        verify_identity_noop_original_pair(pending['entry'],exit)
        need(self._setresuid_raw_join(exit,actual_exit,exit_barrier,'exit')==pending['phase'],'setresuid phase changed')
        self.setresuid_pending.pop(pid);self.setresuid_count+=1
        return dict(kind='consumed-setresuid-noop-original-pair',pid=pid,entrySequence=entry['sequence'],exitSequence=exit['sequence'])
    def begin_setresuid_original(self,entry,actual_entry,entry_barrier):
        need(identity_noop_axis(entry.get('arch'),entry.get('nr'))=='Uid','exact setresuid ABI required')
        return self.begin_identity_noop_original(entry,actual_entry,entry_barrier)
    def consume_verified_setresuid_pair(self,entry,exit,actual_exit,exit_barrier):
        need(identity_noop_axis(entry.get('arch'),entry.get('nr'))=='Uid','exact setresuid ABI required')
        return self.consume_verified_identity_noop_pair(entry,exit,actual_exit,exit_barrier)
    def wait(self,pid,actual_wait=None):
        if pid in self.terminal_messages:
            need(isinstance(actual_wait,dict) and type(actual_wait.get('waitStatus')) is int and actual_wait['waitStatus']==self.terminal_messages[pid] and type(actual_wait.get('returnCode')) is int and actual_wait['returnCode']==os.waitstatus_to_exitcode(actual_wait['waitStatus']),'actual terminal wait differs from EXIT message')
            if pid in self.terminal_samples:
                need(pid not in self.terminal_waits,'duplicate deferred terminal wait');self.terminal_waits[pid]=actual_wait;return
        need(not self.setresuid_pending,'wait before setresuid transition consumed')
        need(pid in self.closed and pid in self.samples and pid not in self.exec_pending and pid not in self.exit_pending and pid not in self.waited,'authority interval lacks captured terminal boundary')
        self.waited.add(pid)
    def finish(self):
        need(not self.terminal_samples and not self.terminal_waits,'authority interval has unclosed terminal original')
        need(not self.setresuid_pending,'authority interval has unclosed setresuid transition')
        need(set(self.parents)==self.waited and not self.exec_pending and not self.exit_pending,'authority interval tracked waits incomplete')
        return dict(schemaVersion=1,model=AUTHORITY_MODEL,scope=AUTHORITY_SCOPE,trackedProcesses=len(self.parents),actualAuthorityCaptures=self.count,namespaceExternalWriterAuthorityVerified=False,toolchainLifetimeImmutabilityVerified=False)

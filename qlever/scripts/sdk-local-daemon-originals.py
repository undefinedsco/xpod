"""Fixed systemd socket-activation association; no capability issuer.

SO_PEERCRED PID1 is a transport-creator fact only. Authority requires the real
root dockerd process and a held duplicate of its exact listening Unix socket.
"""
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import sys
import select
import socket
import stat
HERE=Path(__file__).resolve().parent

def need(value,reason):
    if not value:raise ValueError('Local Docker activation: '+reason)

def identity(value):return [value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns]

def service_fields(raw):
    need(isinstance(raw,bytes) and len(raw)<=16384,'bounded service original')
    rows={}
    for line in raw.decode('utf-8','strict').splitlines():
        key,separator,value=line.partition('=');need(separator and key not in rows,'unique fixed service fields');rows[key]=value
    need(set(rows)=={'MainPID','ActiveState','SubState','InvocationID','NRestarts'},'complete fixed service fields')
    need(rows['ActiveState']=='active' and rows['SubState']=='running' and re.fullmatch('[1-9][0-9]*',rows['MainPID']) and int(rows['MainPID'])>1 and re.fullmatch('[a-f0-9]{32}',rows['InvocationID']) and re.fullmatch('0|[1-9][0-9]*',rows['NRestarts']),'actual active dockerd service tuple')
    return rows

def listener_row(raw):
    need(isinstance(raw,bytes) and len(raw)<=4*1024**2,'bounded proc Unix original')
    lines=raw.decode('ascii','strict').splitlines();need(lines and lines[0].split()==['Num','RefCount','Protocol','Flags','Type','St','Inode','Path'],'actual proc Unix header')
    matches=[]
    for line in lines[1:]:
        row=line.split()
        if len(row)==8 and row[7]=='/run/docker.sock' and row[3]=='00010000' and row[4]=='0001' and row[5]=='01':
            need(row[6].isdigit() and int(row[6])>0,'actual listener socket inode');matches.append({'raw':line,'inode':int(row[6]),'path':row[7]})
    need(len(matches)==1,'unique fixed local listening socket');return matches[0]

def verify_frame(frame,raws):
    """Raw-byte mechanics only; existing outer issuer authenticates the producer."""
    service=service_fields(raws['serviceStdout']);listener=listener_row(raws['procUnix'])
    status=raws['status'];need(isinstance(status,bytes) and len(status)<=16384,'bounded daemon status original');lines=status.decode('ascii','strict').splitlines();uids=[line.split()[1:] for line in lines if line.startswith('Uid:')];pids=[line.split()[1:] for line in lines if line.startswith('NSpid:')];need(uids==[['0','0','0','0']] and pids==[[service['MainPID']]],'actual root host daemon status')
    need(frame['mainPid']==int(service['MainPID']) and frame['service']==service,'actual service/MainPID cross-seal')
    need(frame['creatorPid']==1 and frame['creatorUid']==0 and frame['creatorExecutable']=='/usr/lib/systemd/systemd','fixed root systemd transport creator')
    need(frame['daemonExecutable']=='/usr/bin/dockerd' and re.fullmatch('[a-f0-9]{64}',frame['daemonExecutableSha256']),'exact held actual daemon executable')
    for role in ['heldListenerIdentity','namedListenerIdentity','creatorListenerIdentity']:
        value=frame[role];need(isinstance(value,list) and len(value)==6 and all(type(v) is int and v>=0 for v in value) and stat.S_ISSOCK(value[2]) and value[1]==listener['inode'],'same actual held/listening socket identity')
    need(frame['heldListenerIdentity']==frame['namedListenerIdentity']==frame['creatorListenerIdentity'],'held/named/inherited listener changed')
    need(frame['listenerName']=='/run/docker.sock' and frame['socketType']==socket.SOCK_STREAM and frame['acceptConn']==1,'actual fixed endpoint/type/acceptconn')
    need(frame['controllerPidNamespace']==frame['daemonPidNamespace']==frame['hostPidNamespace'] and frame['controllerRootIdentity']==frame['daemonRootIdentity'],'same actual host PID namespace/root')
    for role in ['pid','mnt','user']:
        row=frame['namespaces'][role];value=row['identity'];need(isinstance(value,list) and len(value)==6 and all(type(item) is int and item>=0 for item in value) and re.fullmatch(role+r':\[([0-9]+)\]',row['link']) and int(row['link'].split('[')[1][:-1])==value[1],'actual held namespace full identity/link')
    need(frame['namespaces']['pid']['link']==frame['daemonPidNamespace'],'same held daemon PID namespace')
    return dict(mainPid=frame['mainPid'],service=service,listener={'inode':listener['inode'],'path':listener['path']},daemonExecutableIdentity=frame['daemonExecutableIdentity'],daemonExecutableSha256=frame['daemonExecutableSha256'],listenerIdentity=frame['heldListenerIdentity'],controllerPidNamespace=frame['controllerPidNamespace'],daemonPidNamespace=frame['daemonPidNamespace'],hostPidNamespace=frame['hostPidNamespace'],controllerRootIdentity=frame['controllerRootIdentity'],daemonRootIdentity=frame['daemonRootIdentity'],namespaces=frame['namespaces'])

def duplicate_pidfd_listener(pidfd,targetfd):
    libc=ctypes.CDLL(None,use_errno=True)
    function=getattr(libc,'pidfd_getfd',None)
    if function is None:raise OSError(errno.ENOSYS,'pidfd_getfd required; no activation fallback')
    function.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint];function.restype=ctypes.c_int
    result=function(pidfd,targetfd,0)
    if result<0:raise OSError(ctypes.get_errno(),'actual listener pidfd_getfd refused; no fallback')
    os.set_inheritable(result,False);return result

class HeldActivatedDaemon:
    def __init__(self,creator,evidence_root,check,remaining_seconds,bounded):
        self.creator=creator;self.root=Path(evidence_root);self.check=check;self.remaining_seconds=remaining_seconds;self.bounded=bounded;self.refs={};self.frames=[];self.fds={};self.first=None;self.retained=0
        self.root.mkdir(mode=0o700,exist_ok=False)
        spec=importlib.util.spec_from_file_location('activation_commands',HERE/'sdk-command-materials.py');self.commands=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.commands)
        try:
            self.operation='actual-service-locator';raw,stage=self._service();fields=service_fields(raw);self.main_pid=int(fields['MainPID'])
            self.fds['pidfd']=os.pidfd_open(self.main_pid,0);self.fds['exe']=os.open('/proc/'+str(self.main_pid)+'/exe',os.O_RDONLY|os.O_CLOEXEC)
            for role in ['pid','mnt','user']:self.fds[role]=os.open('/proc/'+str(self.main_pid)+'/ns/'+role,os.O_RDONLY|os.O_CLOEXEC)
            self.fds['root']=os.open('/proc/'+str(self.main_pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            self.operation='actual-listener-association';unix=self._proc('/proc/net/unix',4*1024**2);self._save('proc-unix-0.original',unix);listener=listener_row(unix);self.daemon_fd=self._listener_fd(self.main_pid,listener['inode']);self.creator_fd=self._listener_fd(1,listener['inode'])
            self.listener_request=self._save('listener-request.original.json',(json.dumps(dict(mainPid=self.main_pid,daemonFd=self.daemon_fd,creatorFd=self.creator_fd,inode=listener['inode'],endpoint='/run/docker.sock',flags=0),sort_keys=True)+'\n').encode())
            self.operation='actual-pidfd-getfd';self.fds['listener']=duplicate_pidfd_listener(self.fds['pidfd'],self.daemon_fd)
            self.first=self._sample(raw,stage,unix)
        except BaseException as error:
            try:self._save('failure.original.json',(json.dumps(dict(schemaVersion=1,kind='actual-daemon-activation-refusal',operation=getattr(self,'operation','initialization'),errorType=type(error).__name__,errno=getattr(error,'errno',None),authorityVerified=False),sort_keys=True)+'\n').encode())
            except BaseException:
                if hasattr(error,'add_note'):error.add_note('Activation failure original could not be retained within same parent budget')
            self.close();raise
    def close(self):
        for fd in self.fds.values():os.close(fd)
        self.fds.clear()
    def _save(self,name,data):
        self.check();need(isinstance(data,bytes) and len(data)<=4*1024**2 and name not in self.refs,'bounded unique actual activation original')
        need(self.retained+len(data)<=4*1024**2,'same activation metadata ledger before write');self.retained+=len(data)
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        reference=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());self.refs[name]=reference;return reference
    def _service(self):
        self.check();name='service-'+str(len(self.frames));argv=['/usr/bin/python3','-I','-S','-B',str(Path(__file__).resolve()),'--systemctl-child'];need(len(str(self.root).encode())<=4096,'bounded fixed evidence path');reserved=5*65536;need(self.retained+reserved<=4*1024**2,'same activation service metadata reserve before execution');self.retained+=reserved;actual_bytes=0
        stage=self.commands.capture(name,argv,self.root,HERE,timeout=min(5,self.remaining_seconds()),resource_profile='observation')
        for role in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
            reference=stage[role];data=self.bounded(self.root/reference['path'],4*1024**2,self.check);need(len(data)==reference['bytes'] and hashlib.sha256(data).hexdigest()==reference['sha256'],'actual closed service raw differs');self.refs[reference['path']]=reference;actual_bytes+=len(data)
        need(actual_bytes<=reserved,'fixed service observation metadata exceeded reservation');self.retained-=reserved-actual_bytes
        return self.bounded(self.root/stage['stdout']['path'],16384,self.check),stage
    def _proc(self,path,maximum):
        self.check();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC);data=bytearray()
        try:
            before=os.fstat(fd)
            while True:
                self.check();chunk=os.read(fd,min(65536,maximum+1-len(data)))
                if not chunk:break
                data.extend(chunk);need(len(data)<=maximum,'bounded actual proc original')
            after=os.fstat(fd);need((before.st_dev,before.st_ino,before.st_mode)==(after.st_dev,after.st_ino,after.st_mode),'actual proc file replaced')
            return bytes(data)
        finally:os.close(fd)
    def _listener_fd(self,pid,inode):
        path=Path('/proc')/str(pid)/'fd';names=os.listdir(path);need(len(names)<=4096,'bounded actual daemon FD table');matches=[]
        for name in names:
            self.check();need(name.isdigit(),'numeric actual process FD')
            try:
                if os.readlink(path/name)=='socket:['+str(inode)+']':matches.append(int(name))
            except FileNotFoundError:continue
        need(len(matches)==1,'unique inherited listening FD in exact actual process');return matches[0]
    def _sample(self,service_raw,stage,unix_raw):
        self.check();poll=select.poll();poll.register(self.fds['pidfd'],select.POLLIN);need(not poll.poll(0),'held actual daemon exited')
        fields=service_fields(service_raw);need(int(fields['MainPID'])==self.main_pid,'actual service MainPID changed');listener=listener_row(unix_raw)
        need(self._listener_fd(self.main_pid,listener['inode'])==self.daemon_fd and self._listener_fd(1,listener['inode'])==self.creator_fd,'actual listening FD changed')
        base='/proc/'+str(self.main_pid);status=self._proc(base+'/status',16384).decode('ascii','strict');uids=[line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')];nspids=[line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:')]
        need(uids==[['0','0','0','0']] and nspids==[[str(self.main_pid)]],'actual root host daemon process')
        executable=os.readlink(base+'/exe');need(executable=='/usr/bin/dockerd','actual service process is not exact dockerd')
        exe=self.fds['exe'];before=os.fstat(exe);need(stat.S_ISREG(before.st_mode) and before.st_size<=512*1024**2,'bounded held actual dockerd executable');os.lseek(exe,0,0);digest=hashlib.sha256();count=0
        while True:
            self.check();chunk=os.read(exe,65536)
            if not chunk:break
            count+=len(chunk);need(count<=before.st_size,'actual daemon executable grew');digest.update(chunk)
        need(count==before.st_size and identity(before)==identity(os.fstat(exe))==identity(os.stat(base+'/exe')),'held actual daemon executable identity changed')
        pidns=os.readlink('/proc/self/ns/pid');daemonns=os.readlink(base+'/ns/pid');hostns=os.readlink('/proc/1/ns/pid');need(pidns==daemonns==hostns,'actual daemon/controller host PID namespace differs')
        root=identity(os.stat('/proc/self/root'));peerroot=identity(os.fstat(self.fds['root']));need(root==peerroot==identity(os.stat(base+'/root'))==identity(os.stat('/proc/1/root')),'actual daemon/controller root differs')
        namespaces={}
        for role in ['pid','mnt','user']:
            held=identity(os.fstat(self.fds[role]));need(held==identity(os.stat(base+'/ns/'+role)),'held actual daemon namespace changed');namespaces[role]=dict(link=os.readlink(base+'/ns/'+role),identity=held)
        held_listener=identity(os.fstat(self.fds['listener']));named_listener=identity(os.stat(base+'/fd/'+str(self.daemon_fd)));creator_listener=identity(os.stat('/proc/1/fd/'+str(self.creator_fd)))
        with socket.socket(fileno=os.dup(self.fds['listener'])) as listening:
            listener_name=listening.getsockname();socket_type=listening.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE);accept=listening.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN)
        frame=dict(mainPid=self.main_pid,daemonFd=self.daemon_fd,creatorFd=self.creator_fd,service=fields,creatorPid=self.creator['pid'],creatorUid=self.creator['uid'],creatorExecutable=self.creator['executablePath'],daemonExecutable=executable,daemonExecutableIdentity=identity(before),daemonExecutableSha256=digest.hexdigest(),heldListenerIdentity=held_listener,namedListenerIdentity=named_listener,creatorListenerIdentity=creator_listener,listenerName=listener_name,socketType=socket_type,acceptConn=accept,controllerPidNamespace=pidns,daemonPidNamespace=daemonns,hostPidNamespace=hostns,controllerRootIdentity=root,daemonRootIdentity=peerroot,namespaces=namespaces)
        stable=verify_frame(frame,{'serviceStdout':service_raw,'procUnix':unix_raw,'status':status.encode()})
        if self.first is not None:need(stable==self.first,'actual service/daemon/listener changed during owned interval')
        index=str(len(self.frames));frame['serviceStage']=stage;frame['procUnixOriginal']=self.refs.get('proc-unix-'+index+'.original') or self._save('proc-unix-'+index+'.original',unix_raw);frame['statusOriginal']=self._save('status-'+index+'.original',status.encode());self.frames.append(frame)
        return stable
    def sample(self):
        raw,stage=self._service();return self._sample(raw,stage,self._proc('/proc/net/unix',4*1024**2))


    def seal(self):
        self.check();need(2<=len(self.frames)<=4,'closed actual activation sample count')
        collection=dict(schemaVersion=1,kind='actual-systemd-dockerd-listener-association',listenerRequest=self.listener_request,frames=self.frames,originals=list(self.refs.values()))
        raw=(json.dumps(collection,sort_keys=True,separators=(',',':'))+'\n').encode();ref=self._save('collection.json',raw)
        # Validate the retained originals with the same pure receiver before
        # exporting ordinary references; this never enrolls an authority.
        verify_collection(collection,lambda value:self.bounded(self.root/value['path'],value['bytes'],self.check))
        prefix='daemon-activation/'
        rooted=lambda value:dict(value,path=prefix+value['path'])
        return {'daemonActivation':rooted(ref),**{'daemonActivationOriginal'+str(index):rooted(value) for index,value in enumerate(self.refs.values()) if value!=ref}}

def verify_collection(collection,read):
    need(collection.get('schemaVersion')==1 and collection.get('kind')=='actual-systemd-dockerd-listener-association','explicit activation originals collection')
    frames=collection.get('frames');need(isinstance(frames,list) and 2<=len(frames)<=4,'closed activation interval samples')
    registered={ref['path']:ref for ref in collection['originals']};need(len(registered)==len(collection['originals']) and len(registered)<=32,'unique bounded activation original universe')
    used=set()
    def original(ref):
        need(registered.get(ref.get('path'))==ref and type(ref.get('bytes')) is int and 0<=ref['bytes']<=4*1024**2,'same registered activation original')
        need(isinstance(ref['path'],str) and not ref['path'].startswith('/') and all(part not in ('','.','..') for part in ref['path'].split('/')),'canonical activation ref path')
        raw=read(ref);need(len(raw)==ref['bytes'] and hashlib.sha256(raw).hexdigest()==ref['sha256'],'actual activation original bytes/SHA');used.add(ref['path']);return raw
    request=json.loads(original(collection['listenerRequest']));need(set(request)=={'mainPid','daemonFd','creatorFd','inode','endpoint','flags'} and request['endpoint']=='/run/docker.sock' and request['flags']==0,'fixed actual listener duplication request')
    baseline=None;windows=[]
    for index,frame in enumerate(frames):
        stage=frame['serviceStage'];need(stage['name']=='service-'+str(index),'ordered exact service observations')
        actual=json.loads(original(stage['receipt']));supervision=json.loads(original(stage['supervisionReceipt']));raw=original(stage['supervisionRaw']);stdout=original(stage['stdout']);original(stage['stderr'])
        command=actual['command'];need(isinstance(command,list) and len(command)==6 and command[:4]==['/usr/bin/python3','-I','-S','-B'] and isinstance(command[4],str) and command[4].startswith('/') and command[4].endswith('/qlever/scripts/sdk-local-daemon-originals.py') and command[5]=='--systemctl-child','fixed controller service observation entry')
        need(actual['command']==command and actual['exit']==0 and actual['signal'] is None and actual['actualWait'] is True and actual['rawClosedBeforeHash'] is True and type(actual['pgid']) is int and actual['pgid']>0,'actual exact systemctl command closure')
        need(supervision['exit']==0 and supervision['signal'] is None and supervision['actualWait'] is True and supervision['ownedGroupAbsentAfterWait'] is True and supervision['rawClosedBeforeHash'] is True and supervision['pgid']==actual['pgid'] and not supervision.get('resourceStop') and not supervision.get('supervisorError') and not supervision.get('cleanupErrors') and supervision['rawSHA256']==hashlib.sha256(raw).hexdigest(),'actual service command supervisor closure')
        need(type(actual.get('startedUnixNs')) is int and type(actual.get('completedUnixNs')) is int and actual['startedUnixNs']<=actual['completedUnixNs'],'actual service observation window');windows.append(dict(startedUnixNs=actual['startedUnixNs'],completedUnixNs=actual['completedUnixNs']))
        parent=stage['receipt']['path'].rsplit('/',1)[0]+'/'
        for role in ['stdout','stderr']:
            need(actual[role]['path']==role+'.raw' and stage[role]['path']==parent+actual[role]['path'] and actual[role]['bytes']==stage[role]['bytes'] and actual[role]['sha256']==stage[role]['sha256'],'same actual systemctl raw roles')
        need(request['mainPid']==frame['mainPid'] and request['daemonFd']==frame['daemonFd'] and request['creatorFd']==frame['creatorFd'] and request['inode']==frame['heldListenerIdentity'][1],'same requested actual listener')
        stable=verify_frame(frame,{'serviceStdout':stdout,'procUnix':original(frame['procUnixOriginal']),'status':original(frame['statusOriginal'])})
        if baseline is not None:need(stable==baseline,'service/daemon/socket changed during owned interval')
        baseline=stable
    need(used==set(registered),'no extra activation originals')
    return dict(baseline,serviceWindows=windows)

if __name__=='__main__':
    need(sys.argv[1:]==['--systemctl-child'],'fixed service observation child only')
    # The actual service stdout/stderr are capped by the kernel before exec;
    # lifecycle/supervision remains the existing owned command implementation.
    resource.setrlimit(resource.RLIMIT_FSIZE,(16384,16384))
    os.execv('/usr/bin/systemctl',['systemctl','show','--no-pager','--property=MainPID','--property=ActiveState','--property=SubState','--property=InvocationID','--property=NRestarts','docker.service'])

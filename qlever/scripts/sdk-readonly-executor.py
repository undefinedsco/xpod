"""Outside-RUN, Linux-host/root-only fixed readonly Docker SDK executor.

The runner kernel and Docker daemon are explicit TCB. Candidate RUN code never
receives the daemon endpoint. This module creates originals, not admission caps.
"""
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
import platform
import re
import stat
import socket
import struct
import select
import secrets
import time
HERE=Path(__file__).resolve().parent
def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
commands=load('sdk-command-materials');budgets=load('sdk-execution-budget');binding=load('sdk-readonly-executor-bindings')
daemon_originals=load('sdk-local-daemon-originals')
IMAGE_TEMPLATE=binding.IMAGE_TEMPLATE
CONTAINER_TEMPLATE=binding.CONTAINER_TEMPLATE
ownership=binding.ownership
create_argv=binding.create_argv

def bounded_original(path,maximum,check):
    path=Path(path);check();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    def identity(v):return (v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
    try:
        first=os.fstat(fd);binding.need(stat.S_ISREG(first.st_mode) and first.st_nlink==1 and first.st_size<=maximum,'bounded single regular outer original');data=bytearray()
        while True:
            check();chunk=os.read(fd,min(65536,first.st_size+1-len(data)))
            if not chunk:break
            data.extend(chunk);binding.need(len(data)<=first.st_size,'outer original grew during bounded read')
        binding.need(len(data)==first.st_size and identity(first)==identity(os.fstat(fd))==identity(path.lstat()),'outer original identity changed')
        return bytes(data)
    finally:os.close(fd)

class LocalDaemon:
    """Authenticate the fixed local peer and keep its process identity alive."""
    def __init__(self,check,diagnose=None,activation_root=None,remaining_seconds=None):
        if any(key in os.environ for key in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']):raise RuntimeError('Remote/context Docker environment forbidden')
        self.activation=None;self.activation_root=activation_root;self.remaining_seconds=remaining_seconds
        self.socket=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.socket.settimeout(1);self.pidfd=None;self.exe=None
        try:
            check();self.socket.connect('/var/run/docker.sock');pid,uid,gid=struct.unpack('3i',self.socket.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));binding.need(uid==0 and pid>0,'actual root local daemon peer required');self.pid=pid;self.uid=uid
            self.pidfd=os.pidfd_open(pid,0);self.exe=os.open('/proc/'+str(pid)+'/exe',os.O_RDONLY|os.O_CLOEXEC)
            self.first=self.sample(check,diagnose)
        except BaseException:self.close();raise
    def close(self):
        if self.activation is not None:self.activation.close()
        self.socket.close()
        for fd in [self.pidfd,self.exe]:
            if fd is not None:os.close(fd)
        self.pidfd=self.exe=None
    def _activation_value(self,value):
        return dict(socket='unix:///var/run/docker.sock',pid=value['mainPid'],uid=0,executablePath='/usr/bin/dockerd',executableIdentity=value['daemonExecutableIdentity'],executableSha256=value['daemonExecutableSha256'],controllerPidNamespace=value['controllerPidNamespace'],daemonPidNamespace=value['daemonPidNamespace'],hostPidNamespace=value['hostPidNamespace'],controllerRootIdentity=value['controllerRootIdentity'],daemonRootIdentity=value['daemonRootIdentity'],associationModel='systemd-listener-v1',activationService=value['service'],listenerIdentity=value['listenerIdentity'])
    def seal_originals(self):
        return self.activation.seal() if self.activation is not None else {}
    def sample(self,check,diagnose=None):
        if getattr(self,'activation',None) is not None:
            check();before=os.fstat(self.exe);named=os.stat('/proc/1/exe')
            ident=lambda value:[value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns]
            binding.need(os.readlink('/proc/1/exe')=='/usr/lib/systemd/systemd' and ident(before)==ident(named)==self.activation.creator['executableIdentity'],'actual held systemd creator changed')
            value=self._activation_value(self.activation.sample());binding.need(value==self.first,'actual activated daemon changed');return value
        check();poll=select.poll();poll.register(self.pidfd,select.POLLIN);binding.need(not poll.poll(0),'actual Docker daemon process exited')
        def ident(value):return [value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns]
        def nspid(path):

            with open(path,'rb') as stream:raw=stream.read(16385)
            binding.need(len(raw)<=16384,'bounded actual host process status');raw=raw.decode();rows=[line.split()[1:] for line in raw.splitlines() if line.startswith('NSpid:')];binding.need(len(rows)==1 and len(rows[0])==1,'controller and daemon must be actual host PID namespace processes')
        nspid('/proc/self/status');nspid('/proc/'+str(self.pid)+'/status')
        pidns=os.readlink('/proc/self/ns/pid');daemonns=os.readlink('/proc/'+str(self.pid)+'/ns/pid');hostns=os.readlink('/proc/1/ns/pid');binding.need(pidns==daemonns==hostns,'Docker peer and observed proc kernel host differ')
        root=ident(os.stat('/proc/self/root'));peerroot=ident(os.stat('/proc/'+str(self.pid)+'/root'));binding.need(root==peerroot==ident(os.stat('/proc/1/root')),'host controller/daemon root differs')
        executable=os.readlink('/proc/'+str(self.pid)+'/exe')
        binding.need(len(executable.encode('utf-8'))<=4096,'bounded actual Docker peer executable path')
        # This is a failure diagnostic, never an authority enrollment. Preserve
        # actual peer identity before the exact reviewed executable check.
        if diagnose is not None and executable!='/usr/bin/dockerd' and not (executable=='/usr/lib/systemd/systemd' and self.pid==1 and getattr(self,'activation_root',None) is not None):
            diagnose(dict(schemaVersion=1,kind='actual-local-docker-peer-diagnostic',pid=self.pid,uid=self.uid,executablePath=executable,heldExecutableIdentity=ident(os.fstat(self.exe)),namedExecutableIdentity=ident(os.stat('/proc/'+str(self.pid)+'/exe')),controllerPidNamespace=pidns,daemonPidNamespace=daemonns,hostPidNamespace=hostns,controllerRootIdentity=root,daemonRootIdentity=peerroot,authorityVerified=False))
        if executable=='/usr/lib/systemd/systemd' and self.pid==1 and getattr(self,'activation_root',None) is not None:
            binding.need(callable(self.remaining_seconds) and ident(os.fstat(self.exe))==ident(os.stat('/proc/1/exe')),'same held actual systemd creator and parent budget required')
            creator=dict(pid=self.pid,uid=self.uid,executablePath=executable,executableIdentity=ident(os.fstat(self.exe)))
            self.activation=daemon_originals.HeldActivatedDaemon(creator,self.activation_root,check,self.remaining_seconds,bounded_original)
            return self._activation_value(self.activation.first)
        binding.need(executable=='/usr/bin/dockerd','unreviewed/proxy Docker peer executable')
        first=os.fstat(self.exe);os.lseek(self.exe,0,0);digest=hashlib.sha256();count=0;binding.need(first.st_size<=512*1024**2,'daemon executable size bound')
        while True:
            check();chunk=os.read(self.exe,65536)
            if not chunk:break
            count+=len(chunk);binding.need(count<=first.st_size,'daemon executable grew');digest.update(chunk)
        binding.need(count==first.st_size and ident(first)==ident(os.fstat(self.exe))==ident(os.stat('/proc/'+str(self.pid)+'/exe')),'same held daemon executable identity changed')
        value=dict(socket='unix:///var/run/docker.sock',pid=self.pid,uid=self.uid,executablePath=executable,executableIdentity=ident(first),executableSha256=digest.hexdigest(),controllerPidNamespace=pidns,daemonPidNamespace=daemonns,hostPidNamespace=hostns,controllerRootIdentity=root,daemonRootIdentity=peerroot)
        if hasattr(self,'first'):binding.need(value==self.first,'held actual Docker daemon changed during executor interval')
        return value

class HeldContainer:
    def __init__(self,pid):
        self.pid=pid;self.fds={};self.first=None
        try:
            for role in ['mnt','pid','user']:self.fds[role]=os.open('/proc/'+str(pid)+'/ns/'+role,os.O_RDONLY|os.O_CLOEXEC)
            self.fds['root']=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            root=os.fstat(self.fds['root']);self.root_object=[root.st_dev,root.st_ino,root.st_mode,root.st_size]
        except BaseException:self.close();raise
    def close(self):
        for fd in self.fds.values():os.close(fd)
        self.fds.clear()
    def sample(self,check,diagnose=None):
        def read(path,maximum):
            data=bytearray()
            with open(path,'rb') as raw:
                while True:
                    check();chunk=raw.read(min(65536,maximum+1-len(data)))
                    if not chunk:break
                    data.extend(chunk);binding.need(len(data)<=maximum,'outside proc original bound')
            return bytes(data)
        # Establish the fixed PID1 ready barrier before taking the first
        # interval sample. Never compare a partially initialized first frame
        # with a ready process after docker cp.
        ready=Path('/proc/'+str(self.pid)+'/root/opt/qlever-sdk/materials/readonly-executor.ready.json')
        while not ready.exists():check();time.sleep(.01)
        handshake=json.loads(bounded_original(ready,16384,check))
        def ident(item):return [item.st_dev,item.st_ino,item.st_mode,item.st_size,item.st_mtime_ns,item.st_ctime_ns]
        base='/proc/'+str(self.pid);namespaces={}
        for role in ['mnt','pid','user']:
            check();path=base+'/ns/'+role;held=ident(os.fstat(self.fds[role]));binding.need(held==ident(os.stat(path)),'outside actual namespace changed');namespaces[role]=dict(link=os.readlink(path),identity=held)
        root=ident(os.fstat(self.fds['root']));binding.need(root==ident(os.stat(base+'/root')),'outside actual root changed');binding.need(root[:4]==self.root_object,'held root object changed')
        children=read(base+'/task/'+str(self.pid)+'/children',65536).decode().split();binding.need(not children,'actual PID1 already has candidate child before release')
        mounts=read(base+'/mountinfo',binding.META).decode('utf-8','strict');roots=[]
        for line in mounts.splitlines():
            fields=line.split();sep=fields.index('-')
            if fields[4]=='/':roots.append(dict(mountId=int(fields[0]),device=fields[2],root=fields[3],mount=fields[4],options=fields[5].split(','),propagation=fields[6:sep],filesystem=fields[sep+1]))
        binding.need(len(roots)==1 and 'ro' in roots[0]['options'] and not roots[0]['propagation'],'actual root must be readonly/private mount')
        status=read(base+'/status',16384).decode();nsrows=[line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:')];binding.need(len(nsrows)==1 and [int(v) for v in nsrows[0]]==[self.pid,1],'actual container namespace PID1 required')
        command=read(base+'/cmdline',16384).rstrip(b'\0').split(b'\0');binding.need(command==[v.encode() for v in ['/usr/bin/python3','-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py']],'actual PID1 fixed entry image command differs')
        value=dict(containerPid=self.pid,namespacePids=[int(v) for v in nsrows[0]],ready=handshake,command=[v.decode() for v in command],rootPidStarttime=read(base+'/stat',16384).decode().rsplit(')',1)[1].split()[19],namespaces=namespaces,rootIdentity=root,rootObjectIdentity=list(self.root_object),children=[],rootMount=roots[0],mountinfo=mounts)
        binding.need(root==ident(os.fstat(self.fds['root']))==ident(os.stat(base+'/root')),'full root metadata changed inside one sample')
        if self.first is None:self.first=value
        elif binding.host_object_frame(value)!=binding.host_object_frame(self.first):
            if diagnose is not None:
                changed=[]
                def difference(left,right,path=''):
                    if type(left) is type(right) and isinstance(left,dict):
                        for key in sorted(set(left)|set(right)):
                            if key not in left or key not in right:changed.append(path+'/'+key)
                            else:difference(left[key],right[key],path+'/'+key)
                    elif left!=right:changed.append(path)
                difference(self.first,value)
                binding.need(len(changed)<=128 and all(len(path)<=256 for path in changed),'bounded held sample diagnostic paths')
                diagnose(dict(schemaVersion=1,kind='actual-held-executor-sample-difference',authorityVerified=False,baseline=self.first,current=value,changedPaths=changed))
            binding.need(False,'held executor identity changed before release')
        return value

def execute(prepared_image,identity,deadline,out,network='bridge'):
    if platform.system()!='Linux' or os.geteuid()!=0:raise RuntimeError('Trusted outside executor requires actual Linux Docker host root/proc access; no DockerDesktop or inner fallback')
    budget=budgets.ExecutionBudget(deadline);out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False);stages=[];cleanup_stages=[];originals={};created=False;held=None;record=None;daemon=None
    nonce=secrets.token_hex(32);argv,volumes=create_argv(prepared_image,identity,deadline,network,nonce);name=ownership(identity);cid=None
    def check():budget.check(30)
    def save(role,value,reserve=30):
        budget.check(reserve);data=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();binding.need(len(data)<=binding.META,'outer metadata bound');path=out/(role+'.original.json')
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        originals[role]=commands.ref(path,out);return value
    def stage(role,command,cap=30,reserve=30,cleanup=False):
        safe_role=re.sub(r'([A-Z])',lambda match:'-'+match[1].lower(),role)
        result=commands.capture(safe_role,binding.local_docker(command),out,HERE,timeout=budget.timeout(cap,reserve),resource_profile='cleanup' if cleanup else 'observation');(cleanup_stages if cleanup else stages).append(result)
        return bounded_original(out/result['stdout']['path'],binding.META,lambda:budget.check(0 if cleanup else 30))
    def stage_dec(role,command,cap=30):
        """Same reviewed transport as stage(), but the decisive-member read ceiling.

        Used ONLY for the lease-acquisition shards, whose compressed raw records
        are legitimately larger than the generic 4 MiB stdout/META bound. The
        capture layer, resource profile and bounded_original reader are unchanged;
        only the maximum passed to that reader differs for this member class.
        """
        safe_role=re.sub(r'([A-Z])',lambda match:'-'+match[1].lower(),role)
        result=commands.capture(safe_role,binding.local_docker(command),out,HERE,timeout=budget.timeout(cap,0),resource_profile='observation');cleanup_stages.append(result)
        return bounded_original(out/result['stdout']['path'],LEASE_TRACE_MEMBER_LIMIT,lambda:budget.check(0))
    def inspect(role,kind,reference,template):return save(role,json.loads(stage(role,['docker',kind,'inspect','--format',template,reference])))
    try:
        daemon=LocalDaemon(check,lambda value:save('daemonPeerDiagnostic',value),out/'daemon-activation',lambda:budget.timeout(5,60));save('daemonBefore',daemon.first)
        image=inspect('image','image',prepared_image,IMAGE_TEMPLATE);binding.need(image['Id']==prepared_image,'actual immutable prepared config ID differs')
        # Fresh dedicated volumes only. Never delete/reuse an existing volume.
        existing=stage('existing-volumes',['docker','volume','ls','--format','{{.Name}}']).decode().splitlines();binding.need(not set(volumes.values())&set(existing),'owned source/build output volume already exists')
        for role,volume in zip(['build','materials'],volumes.values()):stage('create-volume-'+role,['docker','volume','create',volume])
        cid=stage('create-executor',argv).decode().strip();binding.need(re.fullmatch('[a-f0-9]{64}',cid),'actual created Docker ID');created=True
        stage('start-executor',['docker','start',cid]);before=inspect('containerBefore','container',cid,CONTAINER_TEMPLATE);binding.verify_container(before,prepared_image,volumes);binding.need(before['State']['Running'] is True,'release-gated container not live')
        held=HeldContainer(before['State']['Pid']);save('hostBefore',held.sample(check,lambda value:save('hostIdentityDiagnostic',value,0)))
        diff=stage('root-diff-before',['docker','diff',cid]).decode();binding.need(not diff.strip(),'readonly root starts modified');save('rootDiffBefore',[])
        stage('copy-prepared',['docker','cp',cid+':/opt/qlever-sdk/materials/source-prepared.json',str(out/'source-prepared.copied.json')]);copied=bounded_original(out/'source-prepared.copied.json',binding.META,check);originals['sourcePreparedCopied']=dict(path='source-prepared.copied.json',bytes=len(copied),sha256=hashlib.sha256(copied).hexdigest());prepared=json.loads(copied);binding.same_tuple(prepared['identity'],identity);save('sourcePrepared',prepared)
        save('hostBeforeRelease',held.sample(check,lambda value:save('hostIdentityDiagnostic',value,0)));release=out/'release.original';release.write_bytes((nonce+'\n').encode());originals['release']=commands.ref(release,out);stage('release-executor',['docker','cp',str(release),cid+':/opt/qlever-sdk/materials/readonly-executor.release'])
        code=stage('wait-executor',['docker','wait',cid],19800).decode().strip();binding.need(code=='0','actual readonly SDK executor nonzero');save('wait',dict(containerId=cid,exitCode=int(code),actualDockerWait=True))
        stage('executor-logs',['docker','logs',cid],30);inspect('containerAfter','container',cid,CONTAINER_TEMPLATE)
        diff=stage('root-diff-after',['docker','diff',cid]).decode();binding.need(not diff.strip(),'readonly image root changed');save('rootDiffAfter',[])
        save('daemonAfter',daemon.sample(check));originals.update(daemon.seal_originals())
        record=dict(schemaVersion=1,model=binding.MODEL,identity=identity,preparedImageConfig=prepared_image,deadlineUnix=deadline,network=network,nonce=nonce,outputRoot=str(out),volumes=volumes,originals=dict(originals),stages=[] ,scope='Runner Docker daemon/kernel TCB; no malicious host-root resistance or inner JSON authority')
    finally:
        if held is not None:held.close()
        if daemon is not None:daemon.close()
        if created:
            primary=sys.exc_info()[1]
            try:
                # Stop before taking failure logs; preserve closed command raw
                # even when the candidate exited nonzero or never released.
                stage('stop-executor',['docker','stop','--time','10',cid],15,0,True)
                final=json.loads(stage('confirm-stopped',['docker','container','inspect','--format','{{json .State.Running}}',cid],10,0,True));binding.need(final is False,'owned executor still live after cleanup')
                if primary is not None:
                    stage('failed-executor-logs',['docker','logs',cid],10,0,True)
                    # Decisive configure + lease-acquisition context lives only
                    # inside the stopped container; retain it now, while it is
                    # still owned, into the caller's ABSOLUTE out (the uploaded
                    # tree). Retention errors never replace the original.
                    try:
                        retain_failed_configure_evidence(stage,cid,out,stage_decisive=stage_dec)
                    except BaseException as retention_error:
                        if hasattr(primary,'add_note'):
                            primary.add_note('Configure evidence retention failed: '+type(retention_error).__name__)
            except BaseException as cleanup_error:
                if primary is None:raise
                if hasattr(primary,'add_note'):primary.add_note('Executor cleanup failed: '+type(cleanup_error).__name__)
    record['stages']=[*stages,*cleanup_stages]
    allrefs=[*record['originals'].values(),*[row[field] for row in record['stages'] for field in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]]
    unique={r['path']:r for r in allrefs};binding.need(sum(r['bytes'] for r in unique.values())<=binding.META,'shared outer receiver metadata ledger exceeded')
    actual={name:bounded_original(out/name,ref['bytes'],lambda:budget.check()) for name,ref in unique.items()}
    binding.verify(record,actual,identity)
    # Seal only after actual cleanup. Copies prevent append/self-reference loops.
    save('executorCollection',record,0)
    return record
# Fixed container-side failure evidence: the decisive context lives only INSIDE
# the stopped container, so it never reaches the uploaded host tree on its own.
#
# Two corrections over the first attempt:
#  * the destination is the caller's ABSOLUTE `out` (the uploaded tree), never a
#    cwd-relative path — `docker cp` executes with cwd HERE, so a relative target
#    could materialise somewhere the workflow never uploads;
#  * acquisition is BOUNDED BY TRANSPORT, not by deleting an oversized file after
#    it already landed. Each member is streamed as a tar to stdout through the
#    reviewed `stage()` capture (whose raw stream is already capped by
#    RAW_LIMIT/resource profile), so an oversized or non-regular/parent-symlink
#    member is refused BEFORE unbounded bytes are materialised on the runner.
CONFIGURE_FAILURE_EVIDENCE=(
 ('configure-trace','materials/generation/configure.trace.jsonl'),
 ('configure-stdout','materials/generation/configure/stdout.raw'),
 ('configure-stderr','materials/generation/configure/stderr.raw'),
 ('configure-command-receipt','materials/generation/configure/command.receipt.json'),
 ('cmake-error-log','build/CMakeFiles/CMakeError.log'),
 ('cmake-output-log','build/CMakeFiles/CMakeOutput.log'),
 ('cmake-configure-log','build/CMakeFiles/CMakeConfigureLog.yaml'),
)
# Acquisition evidence that can actually NAME a lease. The observer writes its raw
# trace shards into the PRODUCER's own directory — verified from
# sdk-toolchain-materials.Session.__init__: self.directory=self.out/'toolchain-execution'
# and SdkExecutionObserver(self.directory, ...) — so the real container path is
# materials/toolchain-execution/<phase>.trace-NNNN.jsonl.gz, NOT the materials root.
#
# The container is STOPPED at this point (we only retain after stop, to keep the
# owned-resource lifecycle intact), and `docker exec` cannot run against a stopped
# container. Shard names are therefore derived DETERMINISTICALLY from the producer's
# own naming (phase name + zero-padded index) and probed with `docker cp`, which
# reads the container filesystem through the daemon and works while stopped.
LEASE_TRACE_DIR='materials/toolchain-execution'
LEASE_TRACE_PHASES=('configure',)
LEASE_TRACE_SUFFIXES=('jsonl.gz','jsonl')
# Shard count is bounded by the producer's own rolling policy: a shard is closed at
# shardBytes, and total retained bytes are bounded by remaining_source_bytes(out).
# A small fixed probe window keeps acquisition bounded without a directory listing.
LEASE_TRACE_MAX_SHARDS=4
CONFIGURE_EVIDENCE_MEMBER_LIMIT=512*1024
# The decisive lease-acquisition shards are COMPRESSED raw records and are
# legitimately larger than a CMake log. The reviewed bounded reader is reused with
# an explicit, documented ceiling instead of the 4 MiB generic stdout/META bound,
# because refusing the decisive original would silently discard all causal data.
# This is NOT a guard relaxation: the same single-regular-file / no-follow /
# identity-stable reader is used, only its maximum differs for this member class.
LEASE_TRACE_MEMBER_LIMIT=64*1024**2
def _bounded_tar_member(payload,member,maximum):
    """Decode ONE bounded tar stream and return (name,bytes) for a single regular member.

    The tar arrives already byte-capped by the reviewed capture layer. A stream is
    refused unless it holds exactly one regular-file member whose base name equals
    the expected member, so a directory, symlink, hardlink or multi-member archive
    can never be materialised as if it were the requested original.
    """
    import io
    import tarfile
    if len(payload)>maximum:raise ValueError('tar stream exceeds member cap')
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:') as archive:
        members=archive.getmembers()
        if len(members)!=1:raise ValueError('exactly one archive member required')
        entry=members[0]
        if not entry.isreg():raise ValueError('regular file member required')
        if Path(entry.name).name!=Path(member).name:raise ValueError('member name differs')
        if entry.size>maximum:raise ValueError('member exceeds byte cap')
        handle=archive.extractfile(entry)
        if handle is None:raise ValueError('member body unreadable')
        data=handle.read(maximum+1)
    if len(data)!=entry.size:raise ValueError('member length differs from header')
    if len(data)>maximum:raise ValueError('member exceeds byte cap')
    return data
def retain_failed_configure_evidence(stage,cid,out,root='/opt/qlever-sdk',stage_decisive=None):
    """Best-effort bounded retention into the caller's ABSOLUTE uploaded `out`.

    Runs only on the failure path, after the owned container is stopped and while
    it is still owned. Never raises: a retention problem must not replace the
    candidate's original failure. Every member carries an explicit status, so an
    unavailable or truncated acquisition is never presented as complete.
    """
    target=Path(out).resolve()/'failed-configure-evidence';target.mkdir(parents=True,exist_ok=True)
    rows=[]
    def entry(name,status,**extra):
        row=dict(member=name,status=status);row.update(extra);rows.append(row)
    def acquire(label,member,limits=None):
        """Stream the member as tar to stdout (transport-bounded) and materialise it."""
        maximum=(limits or CONFIGURE_EVIDENCE_MEMBER_LIMIT)
        run=stage if stage_decisive is None else stage_decisive
        try:
            payload=run('failed-evidence-'+label,
                        ['docker','cp',cid+':'+root+'/'+member,'-'],30)
        except BaseException as error:
            entry(member,'absent-or-unreadable',error=type(error).__name__);return
        try:
            data=_bounded_tar_member(payload,member,maximum)
        except BaseException as error:
            entry(member,'refused-'+type(error).__name__,cap=maximum);return
        local=target/Path(member).name
        local.write_bytes(data)
        entry(member,'retained',bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),
              path=str(local))
    for label,member in CONFIGURE_FAILURE_EVIDENCE:
        acquire(label,member)
    # Decisive lease-acquisition shards. The container is STOPPED, so `docker exec`
    # is impossible (`docker exec` needs a running process and exits non-zero on a
    # stopped container — proven by the real fixture). `docker cp` reads the
    # container filesystem through the daemon and DOES work while stopped, so each
    # shard is probed by DETERMINISTIC name derived from the producer's own naming:
    # <phase>.trace-<4-digit index>.jsonl.gz (compressed raw) then .jsonl (plain).
    # The probe window is bounded; an absent shard is recorded, never guessed.
    probes=0
    for phase in LEASE_TRACE_PHASES:
        for index in range(LEASE_TRACE_MAX_SHARDS):
            stem=phase+'.trace-'+str(index).zfill(4)
            found=False
            for suffix in LEASE_TRACE_SUFFIXES:
                member=LEASE_TRACE_DIR+'/'+stem+'.'+suffix
                probes+=1
                payload=None
                try:
                    payload=(stage_decisive or stage)(
                        'failed-evidence-lease-trace-'+stem.replace('.','-')+'-'+suffix.replace('.','-'),
                        ['docker','cp',cid+':'+root+'/'+member,'-'],30)
                except BaseException as error:
                    # The overwhelmingly common case: this index/suffix does not
                    # exist. Record only the FIRST miss per stem to stay compact.
                    if not found:
                        entry(member,'absent-or-unreadable',error=type(error).__name__)
                    continue
                try:
                    data=_bounded_tar_member(payload,member,LEASE_TRACE_MEMBER_LIMIT)
                except BaseException as error:
                    entry(member,'refused-'+type(error).__name__,cap=LEASE_TRACE_MEMBER_LIMIT)
                    found=True;break
                local=target/Path(member).name
                local.write_bytes(data)
                entry(member,'retained',bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),
                      path=str(local))
                found=True
                break
            if not found:
                continue
    retained_shards=[r for r in rows if r['status']=='retained'
                     and r['member'].startswith(LEASE_TRACE_DIR+'/')]
    (target/'manifest.json').write_text(json.dumps(
        dict(schemaVersion=1,kind='failed-configure-evidence',model='bounded-tar-transport-v3',
             sourceRoot=root,leaseTraceDir=LEASE_TRACE_DIR,
             leaseTracePhases=list(LEASE_TRACE_PHASES),
             leaseTraceSuffixes=list(LEASE_TRACE_SUFFIXES),
             leaseTraceShardLimit=LEASE_TRACE_MAX_SHARDS,
             leaseTraceProbeCount=probes,
             retainedDecisiveShards=len(retained_shards),
             memberLimit=CONFIGURE_EVIDENCE_MEMBER_LIMIT,
             leaseTraceMemberLimit=LEASE_TRACE_MEMBER_LIMIT,
             decisiveEvidenceRetained=bool(retained_shards),
             members=rows),
        sort_keys=True,indent=1)+'\n')
    return rows
def rooted_collection(record):
    """Fixed transport projection only; never copies live work or issues a cap."""
    prefix='readonly-executor/'
    def visit(value):
        if isinstance(value,list):return [visit(row) for row in value]
        if not isinstance(value,dict):return value
        if set(value)=={'path','bytes','sha256'}:
            path=value['path'];binding.need(isinstance(path,str) and not path.startswith('/') and all(part not in ('','.','..') for part in path.split('/')),'canonical outer original transport reference')
            return dict(value,path=prefix+path)
        return {key:visit(row) for key,row in value.items()}
    return visit(record)

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--prepared-image',required=True);parser.add_argument('--identity',required=True);parser.add_argument('--deadline',type=float,required=True);parser.add_argument('--out',required=True);parser.add_argument('--network',choices=['none','bridge'],default='bridge');a=parser.parse_args();execute(a.prepared_image,json.loads(a.identity),a.deadline,a.out,a.network)

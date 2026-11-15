"""Source-bound role lifecycle using the existing transport and service ledger.

Mechanical originals only. The private receiver independently verifies source,
commands, ownership, protocol, maps and the complete product member union.
"""
import hashlib,json,os,re,stat,time
from pathlib import Path
META=1024**2

def need(value,message):
 if not value:raise ValueError(message)
def identity(v):return(v.st_dev,v.st_ino,v.st_mode,v.st_nlink,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
def read_file(path,maximum,check):
 check();before=path.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=maximum,'bounded ordinary role original required')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
 try:
  need(identity(os.fstat(fd))==identity(before),'role original changed before open');parts=[];count=0
  while count<before.st_size:
   check();b=os.read(fd,min(65536,before.st_size-count));need(b,'short role original');parts.append(b);count+=len(b)
  need(identity(os.fstat(fd))==identity(before)==identity(path.lstat()),'role original changed while read');return b''.join(parts)
 finally:os.close(fd)

def inspect_container(raw,*,role,nonce,cid,config,image,probe,before=False,terminal=False,ownership_only=False):
 name='xpod-service-abi-'+role+'-'+nonce
 rows=json.loads(raw);need(type(rows)is list and len(rows)==1,'one actual inspect record required');v=rows[0];c=v.get('Config',{});h=v.get('HostConfig',{});state=v.get('State',{})
 need(v.get('Id')==cid and v.get('Name')=='/'+name and v.get('Image')==config and c.get('Image')==image,'actual role image/config/CID/name differs')
 labels=c.get('Labels',{});need(labels.get('org.xpod.service-abi-owner')==nonce and labels.get('org.xpod.service-abi-role')==role,'actual role ownership differs')
 if ownership_only:return v
 need(c.get('Entrypoint')==['/usr/local/bin/bun'] and c.get('Cmd')==['/probe.mjs',role,nonce],'actual source-bound role command differs')
 need(h.get('ReadonlyRootfs')is True and h.get('NetworkMode')=='none' and h.get('CapDrop')==['ALL'] and h.get('Init')is True and h.get('Memory')==512*META and h.get('PidsLimit')==64 and h.get('NanoCpus')==10**9 and h.get('RestartPolicy',{}).get('Name')=='no' and 'no-new-privileges' in h.get('SecurityOpt',[]),'actual role isolation differs')
 need(h.get('Tmpfs')=={'/scratch':'rw,noexec,nosuid,nodev,size=8388608,mode=0700','/tmp':'rw,noexec,nosuid,nodev,size=16777216,mode=0700'},'actual bounded role scratch differs')
 mounts=v.get('Mounts',[]);need(len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('Source')==str(probe) and mounts[0].get('Destination')=='/probe.mjs' and mounts[0].get('RW')is False,'actual held probe mount differs')
 if before:need(state.get('Status')=='created' and state.get('Running')is False and state.get('Pid')==0,'role must never have started')
 if terminal:need(state.get('Status')=='exited' and state.get('Running')is False and state.get('Pid')==0 and state.get('ExitCode')==0 and state.get('OOMKilled')is False,'actual role zero terminal state required')
 return v

def collect(role,*,image,config,nonce,source,retained,commands,bun_session,
            host_session,transport,control,read_budget,elf_module,deadline,assert_current):
 need(role in commands.ROLES,'source role required');need(time.monotonic()<deadline<=retained.budget.end,'same absolute role deadline required')
 need(re.fullmatch('sha256:[a-f0-9]{64}',config),'actual config digest required')
 source=Path(source);probe=source/'qlever/scripts/sdk-service-abi-role-probe.mjs'
 need(source.is_absolute() and probe.resolve(strict=True)==probe,'canonical source probe required')
 check=lambda:retained.budget.check(0)
 assert_current();probe_body=read_file(probe,META,check);probe_identity=identity(probe.lstat())
 prefix='abi-role-'+role+'-'+nonce;name='xpod-service-abi-'+role+'-'+nonce
 stages=[];cid=None;owned=False;absent=False;primary=None;session=None;errors=[]
 cleanup_slots=[retained.reserve(2*META) for _ in range(5)]
 tmpfs=retained.reserve(24*META);session_reserved=retained.reserve(META)
 result_reserved=retained.reserve(META)
 def charge(n):
  nonlocal session_reserved
  session_reserved+=retained.reserve(n)
 def stage(operation,cleanup=False):
  check()
  if not cleanup:assert_current()
  argv=commands.command(role,operation,image=image,nonce=nonce,
     **({'probe':str(probe)} if operation=='create' else {} if operation=='recover' else {'cid':cid}))
  allocation=cleanup_slots.pop() if cleanup and cleanup_slots else retained.reserve(2*META)
  label=prefix+'-'+str(len(stages))+'-'+operation
  row=control.capture_bounded_control(label,argv,retained,source,transport=transport,end=deadline if cleanup else deadline-5)
  retained.settle(allocation,[row[k] for k in ('receipt','stdin','stdout','stderr')]);stages.append(dict(operation=operation,command=argv,**row))
  raw=read_file(retained.out/row['stdout']['path'],META,check)
  need(len(raw)==row['stdout']['bytes'] and hashlib.sha256(raw).hexdigest()==row['stdout']['sha256'],'actual role control bytes changed');return raw
 def inspect(raw,**kwargs):
  return inspect_container(raw,role=role,nonce=nonce,cid=cid,config=config,image=image,probe=probe,**kwargs)

 def retain_raw(name,body):
  check();path=retained.out/prefix/name;path.parent.mkdir(mode=0o700,exist_ok=True)
  with path.open('xb')as f:need(f.write(body)==len(body),'short role original');f.flush();os.fsync(f.fileno())
  return dict(path=str(path.relative_to(retained.out)),bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
 try:
  raw=stage('create');need(re.fullmatch(b'[a-f0-9]{64}\n',raw),'actual full role CID required');cid=raw.decode().strip();inspect(stage('inspect'),before=True);owned=True
  executable='/app/node_modules/inngest-cli/bin/inngest' if role=='inngest-cli' else '/usr/local/bin/bun'
  locate=host_session.role_container_pid_provider(cid,executable,read_budget=read_budget,check=check)
  def membership():
   assert_current();need(identity(probe.lstat())==probe_identity and read_file(probe,META,check)==probe_body,'source probe changed')
   return host_session.observe_process(locate(),retained=retained,expected_executable=executable,original_prefix=prefix+'/membership',reference_runtime_members=True,read_budget=read_budget,elf_module=elf_module,check=check,container=dict(containerId=cid,configDigest=config,imageDigest=image))
  argv=commands.command(role,'start',image=image,nonce=nonce,cid=cid)
  session=bun_session.observe(argv,role=role,nonce=nonce,parent_deadline=deadline-5,reserve=charge,transport=transport,capture_membership=membership,check=check,outer_parent_deadline=retained.budget.end)
  refs={key:retain_raw(key+'.raw',session[key]) for key in ('stdin','stdout','stderr')}
  body={k:v for k,v in session.items()if k not in refs};raw=(json.dumps(body,sort_keys=True)+'\n').encode();need(len(raw)<=META,'bounded role session record');refs['result']=retain_raw('session.original.json',raw)
  retained.settle(session_reserved,list(refs.values()));session=dict(observation=body,originals=refs)
  need(stage('wait')==b'0\n','actual role Docker wait must be zero');inspect(stage('inspect'),terminal=True);assert_current()
  need(identity(probe.lstat())==probe_identity and read_file(probe,META,check)==probe_body,'source probe changed after role')
 except BaseException as e:primary=e
 finally:
  try:
   if not owned:
    raw=stage('recover',True);need(re.fullmatch(b'(?:[a-f0-9]{64}\n)?',raw),'unique exact owned recovery CID required')
    if raw:cid=raw.decode().strip();inspect(stage('inspect',True),ownership_only=True);owned=True
    else:absent=True
   if owned:
    inspect(stage('inspect',True),ownership_only=True);need(stage('remove',True).decode().strip()==cid,'actual role removal differs');need(stage('absent',True)==b'','owned role remains');absent=True
   if absent:
    retained.settle(tmpfs,[])
    for allocation in cleanup_slots:retained.settle(allocation,[])
  except BaseException as e:
   errors.append(type(e).__name__)
   if primary is None:primary=e
 result=dict(schemaVersion=1,role=role,containerName=name,containerId=cid,ownerNonce=nonce,imageReferenceByDigest=image,configDigest=config,stages=stages,session=session,ownedContainerAbsent=absent,cleanupErrors=errors,sourceProbeSha256=hashlib.sha256(probe_body).hexdigest(),serviceAbiVerified=False)
 if primary is not None:result['failureClass']=type(primary).__name__
 raw=(json.dumps(result,sort_keys=True)+'\n').encode();need(len(raw)<=META,'bounded role lifecycle record');ref=retain_raw('lifecycle.original.json',raw);retained.settle(result_reserved,[ref]);result['resultOriginal']=ref
 if primary is not None:raise primary
 need(absent and not errors,'complete owned role cleanup required');return result

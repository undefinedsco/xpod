"""Owned diagnostic execution in one exact prepared image; no SDK issuer."""
import hashlib,importlib.util,json,math,os,re,resource,secrets,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
META=4*1024**2;RAW=65536;HOST_RESERVE=4*META;OUTPUT_MAX=64*1024**2
ROLES=('image','create','before','start','wait','after','remove','absence','recover-owned','cleanup-inspect')
def need(v,reason):
 if not v:raise ValueError('kernel probe controller: '+reason)
def load(name):
 s=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def identity_tuple(value):
 need(isinstance(value,dict) and set(value) in [{'sourceSha','runId','runAttempt','target','sdkProfile'},{'sourceSha','runId','runAttempt','target','sdkProfile','runHeadSha'}] and re.fullmatch('[a-f0-9]{40}',value.get('sourceSha','')) and type(value.get('runId')) is int and 0<value['runId']<1<<63 and type(value.get('runAttempt')) is int and 0<value['runAttempt']<1000000 and value.get('target') in ['linux-x64','linux-arm64'] and value.get('sdkProfile') in ['module-bookworm-gcc12','service-trixie'],'actual source/job/target tuple required')
 if 'runHeadSha' in value:need(isinstance(value['runHeadSha'],str) and re.fullmatch('[a-f0-9]{40}',value['runHeadSha']),'exact actual run head required')
 return json.loads(json.dumps(value,sort_keys=True))
def command(role,plan,cid=None):
 need(role in ROLES,'fixed diagnostic stage required');image=plan['image'];need(re.fullmatch('sha256:[a-f0-9]{64}',image),'exact prepared image config required')
 nonce=plan['nonce'];name=plan['name'];need(re.fullmatch('[a-f0-9]{32}',nonce) and name=='xpod-sdk-kernel-probe-'+nonce,'owned diagnostic namespace')
 if role not in ['image','create','recover-owned']:need(isinstance(cid,str) and re.fullmatch('[a-f0-9]{64}',cid),'actual full owned CID required')
 base=['docker','--host','unix:///var/run/docker.sock']
 if role=='recover-owned':return base+['container','ls','--all','--no-trunc','--filter','name=^/'+name+'$','--filter','label=xpod.sdk-kernel-probe-owner='+nonce,'--format','{{.ID}}']
 if role=='image':return base+['image','inspect',image]
 if role=='create':
  output=Path(plan['output']);need(output.is_absolute() and output.name=='probe-output' and output.parent.name=='kernel-probe' and output.resolve(strict=True)==output and not any(c in str(output) for c in ',\n\r\x00'),'fixed canonical probe output mount')
  target=plan['identity']['target'];platform={'linux-x64':'linux/amd64','linux-arm64':'linux/arm64'}[target]
  return base+['container','create','--pull=never','--platform',platform,'--name',name,'--label','xpod.sdk-kernel-probe-owner='+nonce,'--user','0:0','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','2','--restart','no','--no-healthcheck','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16777216','--mount','type=bind,src='+plan['output']+',dst=/probe-output','--workdir','/components/qlever','--entrypoint','/usr/bin/python3',image,'-I','-B','/components/qlever/scripts/sdk-kernel-policy-probe.py','/probe-output/run','--identity',json.dumps(plan['identity'],sort_keys=True,separators=(',',':')),'--deadline',str(plan['deadline']),'--remaining-retained-bytes',str(plan['outputLimit'])]
 if role in ['before','after','cleanup-inspect']:return base+['container','inspect',cid]
 if role=='start':return base+['start','-a',cid]
 if role=='wait':return base+['wait',cid]
 if role=='remove':return base+['container','rm','--force','--volumes',cid]
 return base+['container','ls','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}']
def original(path,root,check,maximum):
 check();need(not path.is_symlink() and path.resolve(strict=True)==path,'canonical diagnostic original required');fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
 def ident(v):return (v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
 try:
  first=os.fstat(fd);need(type(maximum) is int and maximum>=0 and __import__('stat').S_ISREG(first.st_mode) and first.st_nlink==1 and first.st_size<=maximum,'regular bounded unique diagnostic original before read');h=hashlib.sha256();count=0
  while count<first.st_size:
   check();amount=min(65536,first.st_size-count);need(count+amount<=maximum,'diagnostic original read bound')
   block=os.read(fd,amount);need(block,'diagnostic original truncated');h.update(block);count+=len(block);need(count<=first.st_size,'diagnostic original grew')
  need(count==first.st_size and ident(first)==ident(os.fstat(fd))==ident(path.lstat()),'diagnostic original identity changed');return dict(path=path.relative_to(root).as_posix(),bytes=count,sha256=h.hexdigest())
 finally:os.close(fd)
def inspect_owned(value,plan,cid,*,stopped):
 need(isinstance(value,list) and len(value)==1,'unique actual container inspect');v=value[0]
 need(v.get('Id')==cid and v.get('Image')==plan['image'] and v.get('Name')=='/'+plan['name'] and v.get('Config',{}).get('Image')==plan['image'] and v.get('Config',{}).get('Labels',{}).get('xpod.sdk-kernel-probe-owner')==plan['nonce'],'actual owned container identity differs')
 if stopped is None:return v
 create=command('create',plan);tail=create[create.index(plan['image'])+1:]
 need(v.get('Path')=='/usr/bin/python3' and v.get('Args')==tail and v.get('Config',{}).get('User')=='0:0','actual fixed diagnostic entrypoint differs')
 c=v.get('HostConfig',{});need(c.get('ReadonlyRootfs') is True and c.get('Privileged') is False and c.get('NetworkMode')=='none' and c.get('CapDrop')==['ALL'] and not c.get('CapAdd') and 'no-new-privileges' in c.get('SecurityOpt',[]),'actual diagnostic isolation differs')
 need(not c.get('PidMode') and c.get('IpcMode') in ['private',''] and not c.get('Devices') and not c.get('DeviceRequests') and not c.get('VolumesFrom'),'actual diagnostic namespace/device isolation differs')
 mounts=v.get('Mounts');need(isinstance(mounts,list) and len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('Source')==plan['output'] and mounts[0].get('Destination')=='/probe-output' and mounts[0].get('RW') is True,'actual sole owned output mount differs')
 state=v.get('State',{});need(state.get('Running') is False and state.get('Pid')==0,'actual diagnostic container must be stopped')
 if stopped:need(state.get('ExitCode')==0 and state.get('OOMKilled') is False,'actual diagnostic process failed')
 else:need(state.get('Status')=='created','diagnostic container started before observation')
 return v

def run(prepared_image,identity,deadline,out,remaining_retained_bytes):
 identity=identity_tuple(identity);now=time.time();need(isinstance(deadline,(int,float)) and math.isfinite(deadline) and 0<deadline-now<=120.5,'inherited diagnostic deadline must be within 120s')
 need(type(remaining_retained_bytes) is int and HOST_RESERVE<remaining_retained_bytes<=4*1024**3,'positive caller remaining retained budget required')
 need(re.fullmatch('sha256:[a-f0-9]{64}',prepared_image),'actual prepared image config digest required');end=min(float(deadline),now+120);mono_end=time.monotonic()+end-now
 out=Path(out);need(out.name=='kernel-probe' and len(str(out).encode())<=4096 and not any(c in str(out) for c in ',\n\r\x00') and out.is_absolute() and not out.exists() and out.parent.resolve(strict=True)==out.parent,'fresh canonical caller-owned output required');out.mkdir(mode=0o700);output=out/'probe-output';output.mkdir(mode=0o700)
 plan=dict(image=prepared_image,identity=identity,nonce=secrets.token_hex(16),deadline=end,output=str(output),outputLimit=min(OUTPUT_MAX,remaining_retained_bytes-HOST_RESERVE));plan['name']='xpod-sdk-kernel-probe-'+plan['nonce']
 commands=load('sdk-command-materials');stages=[];cid=None;owned=False;create_attempted=False;failure=None;record=None
 def check(reserve=0):need(time.monotonic()+reserve<mono_end,'same absolute diagnostic deadline exhausted')
 def retained():
  inventory=[];total=0
  # Reject the complete size domain before opening or hashing any body.
  for p in sorted(out.rglob('*')):
   check();st=p.lstat();need(not __import__('stat').S_ISLNK(st.st_mode),'no diagnostic output symlink')
   if __import__('stat').S_ISREG(st.st_mode):
    need(st.st_nlink==1 and len(inventory)<4096,'unique bounded diagnostic member set');total+=st.st_size;need(total<=remaining_retained_bytes,'caller retained diagnostic budget before body read');inventory.append((p,st))
   else:need(__import__('stat').S_ISDIR(st.st_mode),'only regular diagnostic files and directories')
  result=[]
  for p,before in inventory:
   ref=original(p,out,check,before.st_size);after=p.lstat()
   key=lambda v:(v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
   need(ref['bytes']==before.st_size and key(before)==key(after),'diagnostic inventory changed while hashing');result.append(ref)
  return result,total
 def save(name,value):
  check();data=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode();need(len(data)<=META,'diagnostic metadata bound');_,current=retained();need(current+len(data)<=remaining_retained_bytes,'same diagnostic retained budget before metadata write')
  with (out/name).open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
 def stage(role,cap=10,reserve=10):
  check(reserve);request=dict(role=role,plan=plan,cid=cid);worker=[sys.executable,'-I','-B',str(Path(__file__).resolve()),'--worker',json.dumps(request,sort_keys=True,separators=(',',':'))]
  row=commands.capture('kernel-probe-'+role,worker,out,Path.cwd(),timeout=min(cap,mono_end-time.monotonic()-reserve),resource_profile='cleanup');stages.append(row);retained()
  raw=(out/row['stdout']['path']).read_bytes();need(len(raw)<=RAW,'diagnostic stage stdout bound');return raw
 try:
  save('plan.original.json',dict(schemaVersion=1,kind='qlever-kernel-probe-plan',**plan,normalModeEnabled=False,releaseAccepted=False))
  images=json.loads(stage('image'));need(isinstance(images,list) and len(images)==1 and images[0].get('Id')==prepared_image and images[0].get('Os')=='linux' and images[0].get('Architecture')=={'linux-x64':'amd64','linux-arm64':'arm64'}[identity['target']] and not images[0].get('Config',{}).get('Volumes') and not images[0].get('Config',{}).get('OnBuild'),'actual matching prepared image required')
  create_attempted=True;cid=stage('create').decode().strip();need(re.fullmatch('[a-f0-9]{64}',cid),'actual created full CID required')
  inspect_owned(json.loads(stage('before')),plan,cid,stopped=False);owned=True
  stage('start',90);need(stage('wait').strip()==b'0','actual Docker wait exit differs');inspect_owned(json.loads(stage('after')),plan,cid,stopped=True)
  refs,total=retained();record=dict(schemaVersion=1,kind='qlever-sdk-kernel-probe-controller-originals',identity=identity,deadlineUnix=end,preparedImageConfig=prepared_image,containerId=cid,containerName=plan['name'],stages=stages,probeOriginals=[x for x in refs if x['path'].startswith('probe-output/')],retainedBytesBeforeSeal=total,remainingRetainedBudgetBytes=remaining_retained_bytes,normalModeEnabled=False,releaseAccepted=False,pending=['kernel-probe-diagnostic-only-no-sdk-source-or-product-authority'])
 except BaseException as error:
  failure=error
  try:save('failure.original.json',dict(errorClass=type(error).__name__,message=str(error)[:2048],normalModeEnabled=False,releaseAccepted=False))
  except BaseException:pass
 finally:
  # No name-only deletion: only a full CID independently verified to this nonce.
  if create_attempted:
   try:
    if not owned and (not isinstance(cid,str) or re.fullmatch('[a-f0-9]{64}',cid) is None):
     candidates=stage('recover-owned',5,5).decode().splitlines();need(len(candidates)<=1,'unique owned probe cleanup lookup');cid=candidates[0] if candidates else None
    if cid is None:pass
    elif not owned:inspect_owned(json.loads(stage('cleanup-inspect',5,5)),plan,cid,stopped=None);owned=True
    if cid is not None:
     stage('remove',5,2);need(not stage('absence',2,0).strip(),'owned diagnostic container remains')
   except BaseException as cleanup:
    if failure is None:failure=cleanup
    elif hasattr(failure,'add_note'):failure.add_note('Owned probe cleanup failed: '+type(cleanup).__name__)
 if failure is not None:raise failure
 record['stages']=stages;save('kernel-probe.original.json',record);refs,total=retained();index=dict(schemaVersion=1,originals=refs,actualRetainedBytes=total,normalModeEnabled=False)
 for _ in range(10):
  encoded=(json.dumps(index,sort_keys=True,separators=(',',':'))+'\n').encode();actual=total+len(encoded)
  if actual==index['actualRetainedBytes']:break
  index['actualRetainedBytes']=actual
 else:raise ValueError('diagnostic index accounting did not converge')
 save('originals.index.json',index);return record

def worker(request):
 role=request['role'];argv=command(role,request['plan'],request.get('cid'))
 for key in ['DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']:os.environ.pop(key,None)
 resource.setrlimit(resource.RLIMIT_FSIZE,(RAW,RAW));os.execvp(argv[0],argv)
if __name__=='__main__':
 need(len(sys.argv)==3 and sys.argv[1]=='--worker','private fixed worker protocol required');worker(json.loads(sys.argv[2]))

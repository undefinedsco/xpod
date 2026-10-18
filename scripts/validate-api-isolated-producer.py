"""Finite diagnostic for a fresh graph-selected API build, never admission.

Keep the immutable manifests/lock unchanged and retain the whole installed tree.
The scoped recipe is a new diagnostic; global dependency checks are not replaced.
"""
import argparse,hashlib,importlib.util,json,os,platform,re,shutil,stat,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def validate_plan(plan,source_sha,target,mode='api-ui-v1'):
 if plan.get('sourceSha')!=source_sha or plan.get('target')!=target or mode not in ['api-ui-v1','api-ui-root-minimal-v2'] or plan.get('workspaceMode')!=mode or plan.get('executable') is not False:raise ValueError('Exact diagnostic graph required')
 rows=plan['selectedBuildRoles'];allrows={row['id']:row for row in plan['rootBuildRoles']}
 previous=None
 for row in rows:
  if row['id'] not in allrows or row['command']!=allrows[row['id']]['command'] or row['argv']!=allrows[row['id']]['argv'] or row['after']!=([previous] if previous else []):raise ValueError('Actual ordered root recipe role required')
  if not row['argv'] or row['argv'][0]!='bun':raise ValueError('Fixed Bun recipe required')
  previous=row['id']
 install=plan['isolatedInstall']['argv']
 if install[:3]!=['bun','install','--frozen-lockfile'] or any(not arg.startswith('--filter=') for arg in install[3:]):raise ValueError('Exact frozen isolated installation required')
 post=plan.get('isolatedPostinstall');explicit=[]
 if mode=='api-ui-root-minimal-v2':
  if not isinstance(post,dict) or post.get('execution')!='explicit-after-filtered-install' or not isinstance(post.get('command'),str):raise ValueError('Explicit immutable root postinstall required')
  commands=post['command'].split(' && ') if post['command'] else []
  if any(not re.fullmatch(r'bun scripts/[a-zA-Z0-9._/-]+',command) or any(part in ['', '.', '..'] for part in command[4:].split('/')) for command in commands):raise ValueError('Exact ordered root postinstall recipe required')
  expected=['bun','run','postinstall'] if commands else []
  if post.get('argv')!=expected or plan.get('rootDeclarationsInstalled') is not False or '--filter=!'+plan.get('rootName','') not in install:raise ValueError('Filtered root postinstall declaration differs')
  if commands:explicit=[('isolated-postinstall',expected,'',600)]
 elif post is not None and (post.get('execution')!='installer-owned' or post.get('argv')!=[]):raise ValueError('Installed root lifecycle must not execute twice')
 return [('isolated-install',install,'',600)]+explicit+[(row['id'],row['argv'],'',600) for row in rows]+[('api-build',plan['apiBuild']['argv'],'',600)]

def validate_postinstall_source(plan,source):
 declaration=plan.get('isolatedPostinstall')
 if declaration is not None:
  actual=json.loads((source/'package.json').read_text()).get('scripts',{}).get('postinstall','')
  if actual!=declaration.get('command'):raise ValueError('Actual immutable root postinstall differs from graph')

def inventory(source,output,end):
 """Hash every physical installed member; preserve optional/link observations."""
 helper=load('isolated_source_materials','scripts/lib/module-source-materials.py');rows=[];total=0
 for file in helper.dependency_paths(source):
  if time.monotonic()>=end:raise TimeoutError('Single isolated producer deadline')
  path=source/file if not Path(file).is_absolute() else Path(file);before=path.lstat();name=path.relative_to(source).as_posix()
  if stat.S_ISLNK(before.st_mode):row=dict(path=name,kind='symlink',target=os.readlink(path),mode=stat.S_IMODE(before.st_mode))
  elif stat.S_ISREG(before.st_mode):
   digest=hashlib.sha256();size=0
   with path.open('rb') as stream:
    for chunk in iter(lambda:stream.read(65536),b''):
     if time.monotonic()>=end:raise TimeoutError('Single isolated producer deadline')
     size+=len(chunk)
     if size>before.st_size:raise ValueError('Installed member grew')
     digest.update(chunk)
   after=path.lstat();identity=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
   if identity(before)!=identity(after) or size!=before.st_size:raise ValueError('Installed member changed')
   row=dict(path=name,kind='file',bytes=size,sha256=digest.hexdigest(),mode=stat.S_IMODE(before.st_mode));total+=size
  else:raise ValueError('Unknown installed member kind')
  rows.append(row)
  if len(rows)>250000:raise ValueError('Installed member bound')
 encoded=json.dumps(dict(rows=rows,members=len(rows),regularBytes=total,sourceVerified=False),separators=(',',':')).encode()
 if len(encoded)>64*1024**2:raise ValueError('Diagnostic inventory bound')
 with output.open('xb') as file:file.write(encoded)
 return dict(members=len(rows),regularBytes=total,inventorySha256=hashlib.sha256(encoded).hexdigest())

def transport_environment(environ,home,tmp,cache):
 # Preserve only declared transport controls; never inherit arbitrary NODE_OPTIONS.
 env={key:environ[key] for key in ['PATH','SYSTEMROOT','WINDIR','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'] if key in environ}
 for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY']:
  if key in env and (len(env[key].encode())>8192 or any(char in env[key] for char in ['\x00','\r','\n'])):raise ValueError('Bounded transport setting required: '+key)
 env.update(HOME=str(home),TMPDIR=str(tmp),CI='true',DO_NOT_TRACK='1',BUN_INSTALL_CACHE_DIR=str(cache),NODE_OPTIONS='--use-env-proxy')
 return env

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--source-sha',required=True);parser.add_argument('--target',required=True);parser.add_argument('--output',required=True);parser.add_argument('--run',action='store_true');parser.add_argument('--recipe',choices=['api-ui-v1','api-ui-root-minimal-v2'],default='api-ui-v1');args=parser.parse_args()
 if len(args.source_sha)!=40 or any(c not in '0123456789abcdef' for c in args.source_sha):raise ValueError('Exact source SHA required')
 host=('darwin' if sys.platform=='darwin' else 'linux' if sys.platform=='linux' else 'unsupported')+'-'+{'aarch64':'arm64','arm64':'arm64','x86_64':'x64'}.get(platform.machine(),'unknown')
 if host!=args.target:raise ValueError('Matching native host required')
 output=Path(args.output)
 if not output.is_absolute() or output.parent!=ROOT/'.test-data' or output.exists() or not output.name.startswith('api-isolated-producer-'):raise ValueError('Fresh owned diagnostic output required')
 bun=shutil.which('bun')
 if not bun:raise ValueError('Actual Bun required')
 plan=json.loads(subprocess.check_output([bun,str(ROOT/'scripts/plan-api-producer-graph.ts'),args.source_sha,args.target,args.recipe],cwd=ROOT,timeout=30))
 rows=validate_plan(plan,args.source_sha,args.target,args.recipe)
 if not args.run:print(json.dumps(dict(plan=plan,steps=rows,totalSeconds=3000,sourceVerified=False)));return
 # A sibling checkout prevents Node resolution from borrowing ROOT/node_modules.
 holder=ROOT.parent/'.test-data'/output.name;source=holder/'source'
 if holder.exists():raise ValueError('Fresh isolated checkout required')
 for parent in holder.parents:
  if (parent/'node_modules').exists():raise ValueError('Ambient ancestor dependencies forbidden')
 parent=load('isolated_api_preflight','scripts/api-module-producer.py')
 if shutil.disk_usage(ROOT).free<parent.FRESH_BYTES:raise ValueError('Normal API fresh-byte preflight required before isolated install')
 holder.mkdir(parents=True,mode=0o700);output.mkdir(mode=0o700);evidence=output/'evidence';evidence.mkdir(mode=0o700)
 subprocess.run(['git','worktree','add','--detach',str(source),args.source_sha],cwd=ROOT,check=True,timeout=30)
 if subprocess.check_output(['git','rev-parse','HEAD'],cwd=source).decode().strip()!=args.source_sha:raise ValueError('Immutable checkout differs')
 validate_postinstall_source(plan,source)
 (output/'graph.original.json').write_text(json.dumps(plan,indent=2));supervisor=load('isolated_supervisor','scripts/agentfs-native-ci/supervise.py');parent=load('isolated_api_parent','scripts/api-module-producer.py')
 home=output/'home';home.mkdir();tmp=output/'tmp';tmp.mkdir();env=transport_environment(os.environ,home,tmp,output/'bun-cache')
 node=shutil.which('node')
 if not node:raise ValueError('Actual Node22 env-proxy support required')
 node=str(Path(node).resolve());proxy_probe="if(!process.versions.node.startsWith('22.'))process.exit(2);process.stdout.write(JSON.stringify({node:process.versions.node,envProxyFlagAccepted:true}))"
 rows=[('node22-env-proxy-support',[node,'--use-env-proxy','-e',proxy_probe],'',10),*rows]
 result=dict(sourceSha=args.source_sha,target=args.target,checkout=str(source),completed=False,sourceVerified=False,toolchainVerified=False,inputUniverseCaptured=False,forwardedTransportKeys=[key for key in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'] if key in env],steps=[],pending=plan['pending']);end=time.monotonic()+3000
 try:
  for label,argv,cwd,cap in rows:
   remaining=end-time.monotonic()
   if remaining<=0:raise TimeoutError('Single isolated producer deadline')
   argv=([bun,*argv[1:]] if argv[0]=='bun' else argv);receipt,_=supervisor.run_stage(label,argv,evidence,source/cwd,timeout=min(cap,remaining),environment=env,fresh_bytes=2*1024**3,stop_bytes=2*1024**3)
   result['steps'].append(dict(label=label,closed=parent.closed_phase(receipt)))
   if not parent.closed_phase(receipt):raise ValueError('Isolated producer phase failed: '+label)
   if label==('isolated-postinstall' if any(row[0]=='isolated-postinstall' for row in rows) else 'isolated-install'):result['before']=inventory(source,output/'installed-before.original.json',end)
  result['after']=inventory(source,output/'installed-after.original.json',end);result['completed']=True
 finally:
  (output/'result.original.json').write_text(json.dumps(result,indent=2))
if __name__=='__main__':main()

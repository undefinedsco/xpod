"""Explicit native preparation route for the NORMAL API producer.

The parent invokes each planned phase through its existing run_stage; this file
never creates a nested supervisor/session and never issues admission facts.
"""
import base64
import hashlib
import importlib.util
import json
import configparser
import re
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import signal
import urllib.request
import time
ROOT=Path(__file__).resolve().parents[2]
POLICY=json.loads((ROOT/'packages/xpod-api/scripts/inngest-controlled-build-policy.json').read_text())
LIMITS=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())
_retained_byte_ceiling=LIMITS['sourceMaterialBytes']
def need(value,reason):
    if not value:raise ValueError('Controlled Inngest: '+reason)
def sha(file):
    value=hashlib.sha256();before=Path(file).lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1,'single regular original required')
    with Path(file).open('rb') as stream:
        count=0
        while True:
            data=stream.read(LIMITS['rangeBytes'])
            if not data:break
            count+=len(data);need(count<=before.st_size,'original grew');value.update(data)
    after=Path(file).lstat();identity=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_nlink,value.st_mtime_ns,value.st_ctime_ns);need(identity(before)==identity(after) and count==before.st_size,'original changed');return value.hexdigest()
def reference(file,output):
    p=Path(file);return dict(path=p.relative_to(output).as_posix(),bytes=p.stat().st_size,sha256=sha(p))
def target_descriptor(target):
    value=POLICY['targetDescriptors'].get(target);need(value is not None and target==value['platform']+'-'+value['arch'],'explicit reviewed target descriptor required');return value
def target_tools(target):return dict(POLICY['tools'],**target_descriptor(target)['tools'])

def relative_source_path(value):
    return isinstance(value,str) and bool(value) and not value.startswith('/') and '\\' not in value and all(part not in ('','.','..') for part in value.split('/')) and not any(ord(c)<32 for c in value)

def source_dependencies():
    rows=POLICY.get('sourceDependencies',[]);need(isinstance(rows,list) and len(rows)<=1,'reviewed finite source dependency declarations')
    for row in rows:
        need(isinstance(row,dict) and set(row)=={'name','repository','commit','destination','source','projection'} and relative_source_path(row['name']) and '/' not in row['name'] and re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',row['repository']) and re.fullmatch('[a-f0-9]{40}',row['commit']) and relative_source_path(row['destination']),'fixed source dependency identity')
        pin=row['source'];projection=row['projection']
        need(set(pin)=={'file','bytes','sha256','prefix','url'} and relative_source_path(pin['file']) and '/' not in pin['file'] and type(pin['bytes']) is int and 0<pin['bytes']<=LIMITS['shardBytes'] and re.fullmatch('[a-f0-9]{64}',pin['sha256']) and relative_source_path(pin['prefix']) and '/' not in pin['prefix'] and pin['url']=='https://codeload.github.com/'+row['repository']+'/legacy.tar.gz/'+row['commit'],'fixed complete source dependency archive')
        need(set(projection)=={'kind','declaringFile','gitmodules','pattern','root'} and projection['kind']=='fixed-go-embed-tree-v1' and relative_source_path(projection['root']),'fixed source projection kind/root')
        for ref in [projection['declaringFile'],projection['gitmodules']]:need(set(ref)=={'path','bytes','sha256'} and relative_source_path(ref['path']) and type(ref['bytes']) is int and 0<ref['bytes']<=LIMITS['metadataBytes'] and re.fullmatch('[a-f0-9]{64}',ref['sha256']),'fixed source projection declaration bytes')
        parent=Path(projection['declaringFile']['path']).parent
        need(Path(row['destination']).is_relative_to(parent) and projection['pattern']==Path(row['destination']).relative_to(parent).as_posix()+'/'+projection['root']+'/*','only the declared complete recursive Go embed tree')
    return rows

def original_pins(target):
    pins=[POLICY['source'],*target_tools(target).values(),*[row['source'] for row in source_dependencies()]]
    need(len({pin['file'] for pin in pins})==len(pins),'unique fixed original filenames');return pins

def gitlink_url(row):return 'https://api.github.com/repos/'+POLICY['repository']+'/contents/'+row['destination']+'?ref='+POLICY['sourceCommit']

def verify_gitlink_original(row,value):
    need(isinstance(value,dict) and value.get('url')==gitlink_url(row) and value.get('status')==200 and value.get('encoding')=='base64' and type(value.get('bytes')) is int and 0<value['bytes']<=65536 and isinstance(value.get('content'),str) and len(value['content'])<=4*((65536+2)//3),'bounded exact Gitlink API original')
    raw=base64.b64decode(value['content'],validate=True);need(len(raw)==value['bytes'] and hashlib.sha256(raw).hexdigest()==value.get('sha256'),'complete Gitlink API original digest');actual=json.loads(raw)
    need(actual.get('type')=='submodule' and actual.get('path')==row['destination'] and actual.get('sha')==row['commit'] and actual.get('submodule_git_url') in ['git@github.com:'+row['repository']+'.git','https://github.com/'+row['repository']+'.git'],'actual parent commit Gitlink/source repository differs');return actual

def verify_projection_declarations(work,row):
    root=work/'source';projection=row['projection']
    for ref in [projection['declaringFile'],projection['gitmodules']]:
        path=root/ref['path'];need(not root.is_symlink() and path.resolve(strict=True)==root.resolve(strict=True)/ref['path'] and reference(path,root)==ref,'actual fixed main-source projection declaration differs')
    data=(root/projection['declaringFile']['path']).read_text();need([line.strip() for line in data.splitlines() if line.strip().startswith('//go:embed')]==['//go:embed '+projection['pattern']],'unknown or changed Go embed pattern')
    config=configparser.RawConfigParser();config.read_string((root/projection['gitmodules']['path']).read_text());section='submodule "'+row['destination']+'"'
    need(config.has_section(section) and config.get(section,'path')==row['destination'] and config.get(section,'url') in ['git@github.com:'+row['repository']+'.git','https://github.com/'+row['repository']+'.git'],'main source submodule repository/path differs')

def require_host(target):
    value=target_descriptor(target);machine=os.uname().machine
    need(sys.platform==value['platform'] and machine in ({'arm64','aarch64'} if value['arch']=='arm64' else {'x86_64','amd64'}),'matching native build host required')
    # A translated Darwin process would execute the wrong compiler architecture.
    if sys.platform=='darwin':
        import ctypes
        libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True);translated=ctypes.c_int();size=ctypes.c_size_t(ctypes.sizeof(translated));rc=libc.sysctlbyname(b'sysctl.proc_translated',ctypes.byref(translated),ctypes.byref(size),None,0)
        need(rc==0 and translated.value==0 or rc==-1 and ctypes.get_errno()==2,'translated or unclassified Darwin build host refused')
def environment(work,target='linux-arm64'):
    descriptor=target_descriptor(target);work=Path(work).resolve();home=work/'home';tools=work/'tools'
    return dict(HOME=str(home),TMPDIR=str(work/'tmp'),PATH=str(tools/'node/bin')+':/usr/bin:/bin',LANG='C.UTF-8',LC_ALL='C.UTF-8',CI='1',NEXT_TELEMETRY_DISABLED='1',DO_NOT_TRACK='1',COREPACK_ENABLE_DOWNLOAD_PROMPT='0',GOPROXY='off',GOSUMDB='off',GOENV='off',GOTOOLCHAIN='local',GOWORK='off',CGO_ENABLED='0',GOOS=descriptor['goos'],GOARCH=descriptor['goarch'],**descriptor['architectureEnvironment'],GOCACHE=str(work/'go-cache'),GOMODCACHE=str(work/'go-mod-cache'))
def native_deadline(parent_deadline, now):
    need(isinstance(parent_deadline,(int,float)) and isinstance(now,(int,float)) and now < parent_deadline,'remaining parent deadline required')
    return min(parent_deadline, now + POLICY['nativeWindowSeconds'])

def phase_plan(repo,work,target,source_kind,retainedByteCeiling=LIMITS['sourceMaterialBytes']):
    """Pure plan; target/route must be explicit, never inferred from failure."""
    repo,work=Path(repo).resolve(),Path(work).resolve();target_descriptor(target);need(source_kind==POLICY['sourceKind'],'unsupported explicit source kind/target')
    need(type(retainedByteCeiling) is int and 0<=retainedByteCeiling<=LIMITS['sourceMaterialBytes'],'retained byte ceiling may only tighten')
    helper=repo/'scripts/lib/inngest-controlled-build.py';source=work/'source';node=work/'tools/node/bin/node';pnpm=work/'tools/pnpm/bin/pnpm.cjs';go=work/'tools/go/bin/go'
    def own(action):return [sys.executable,'-I','-S','-B',str(helper),action,str(work),'--target',target,'--retained-byte-ceiling',str(retainedByteCeiling)]
    return [
      ('inngest-controlled-acquire',own('acquire'),repo,POLICY['acquisitionWindowSeconds']),
      ('inngest-controlled-prepare',own('prepare'),repo,300),
      ('inngest-controlled-go-version',[str(go),'version'],source,10),
      ('inngest-controlled-node-version',[str(node),'--version'],source,10),
      ('inngest-controlled-pnpm-version',[str(node),str(pnpm),'--version'],source,10),
      ('inngest-controlled-ui-install',[str(node),str(pnpm),'--dir',str(source/'ui/apps/dev-server-ui'),'install','--frozen-lockfile','--ignore-scripts','--package-import-method=copy','--store-dir',str(work/'pnpm-store')],source,600),
      ('inngest-controlled-inputs',own('capture-inputs'),repo,LIMITS['captureTimeoutMs']/1000),
      ('inngest-controlled-ui-build',[str(node),str(pnpm),'--dir',str(source/'ui/apps/dev-server-ui'),'build'],source,600),
      ('inngest-controlled-ui-materialize',own('materialize-ui'),repo,120),
      ('inngest-controlled-go-build',[str(go),*POLICY['goArguments'],'-o',str(work/'products/inngest'),'./cmd'],source,600),
      ('inngest-controlled-finalize',own('finalize'),repo,LIMITS['captureTimeoutMs']/1000),
    ]
def verify_original(file,pin):
    file=Path(file);size=file.lstat().st_size;need(0<size<=pin.get('maximumBytes',pin.get('bytes',0)) and ('bytes' not in pin or size==pin['bytes']),'original archive size')
    if 'sha256' in pin:need(sha(file)==pin['sha256'],'fixed original SHA256')
    else:
        before=file.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1,'single regular original required');h=hashlib.sha512();count=0
        with file.open('rb') as stream:
            for block in iter(lambda:stream.read(LIMITS['rangeBytes']),b''):
                count+=len(block);need(count<=size,'original grew during SRI');h.update(block)
        after=file.lstat();need(count==size and (before.st_dev,before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'original changed during SRI')
        need('sha512-'+base64.b64encode(h.digest()).decode()==pin['integrity'],'fixed original SRI')
    return reference(file,file.parent)
def unpack_fixed(file,destination,prefix,projection=None,expanded_limit=None):
    """Called only AFTER full pinned digest verification; no arbitrary tar API."""
    if projection is None:need(not destination.exists(),'fresh extracted directory required')
    else:need(not destination.is_symlink() and (not destination.exists() or destination.is_dir() and not any(destination.iterdir())),'fresh empty source projection root required')
    destination.mkdir(mode=0o700,exist_ok=projection is not None)
    maximum=LIMITS['sourceMaterialBytes'] if expanded_limit is None else expanded_limit
    need(type(maximum) is int and 0<=maximum<=LIMITS['sourceMaterialBytes'],'bounded actual extraction remainder')
    total=0;members=set();links=[];selected=0;projection_directories=[]
    with tarfile.open(file,'r:*') as archive:
        for member in archive:
            parts=Path(member.name).parts;need(parts and parts[0]==prefix and not member.name.startswith('/') and all(p not in ('..','') for p in parts),'fixed source archive path')
            name='/'.join(parts[1:]);
            if projection is not None and name!=projection and not name.startswith(projection+'/'):continue
            if not name:need(member.isdir(),'archive root directory');continue
            need(name not in members and len(members)<LIMITS['sourceMembers'],'duplicate/member bound');members.add(name);target=destination/name
            need(all(not p.is_symlink() for p in target.parents if p!=destination.parent),'linked extraction ancestor');target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            if member.isdir():
                target.mkdir(mode=0o700,exist_ok=True)
                if projection is not None:projection_directories.append((target,member.mode&0o777))
            elif member.isfile():
                selected+=1
                total+=member.size;need(member.size<=LIMITS['shardBytes'] and total<=maximum,'expanded archive bound')
                source=archive.extractfile(member);count=0
                with target.open('xb') as output:
                    while True:
                        data=source.read(LIMITS['rangeBytes'])
                        if not data:break
                        count+=len(data);need(count<=member.size,'member growth');need(shutil.disk_usage(destination).free-len(data)>=LIMITS['freeFloorBytes'],'extraction disk floor');output.write(data)
                need(count==member.size,'truncated member');target.chmod(member.mode&0o777)
            elif member.issym():
                need(projection is None,'source projection requires regular files/directories, not symlinks');links.append((target,member.linkname))
            else:need(False,'unsupported archive entry')
    if projection is not None:
        need(selected>0,'declared Go embed source tree absent')
        for directory,mode in reversed(projection_directories):directory.chmod(mode)
    for target,link in links:
        need(not os.path.isabs(link) and '\x00' not in link,'relative source link');resolved=(target.parent/link).resolve();need(resolved.is_relative_to(destination.resolve()),'source link escapes');target.symlink_to(link)
    return total

def acquire(work,target='linux-arm64'):
    """Fixed public originals, no token/candidate URL or redirects; parent supervises."""
    originals=work/'originals';originals.mkdir(mode=0o700)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise ValueError('Controlled Inngest: redirect forbidden')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'exclusive acquisition timer required')
    previous=signal.getsignal(signal.SIGALRM)
    def expired(*unused):raise TimeoutError('Controlled Inngest: absolute acquisition deadline')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,POLICY['acquisitionWindowSeconds'])
    budget=MaterialBudget(work)
    try:
        for pin in original_pins(target):
            dependency=next((row for row in source_dependencies() if row['source']['file']==pin['file']),None);gitlink=None
            if dependency is not None:
                api=gitlink_url(dependency)
                with opener.open(urllib.request.Request(api,headers={'User-Agent':'xpod-controlled-inngest-originals','Accept-Encoding':'identity'}),timeout=30) as response:
                    need(response.status==200 and response.geturl()==api and response.headers.get('Content-Encoding','identity')=='identity','fixed Gitlink API transport');data=bytearray()
                    while True:
                        part=response.read1(min(LIMITS['rangeBytes'],65537-len(data)))
                        if not part:break
                        data.extend(part);need(len(data)<=65536,'Gitlink API metadata bound')
                gitlink=dict(url=api,status=200,bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),encoding='base64',content=base64.b64encode(data).decode());verify_gitlink_original(dependency,gitlink)
            partial=originals/(pin['file']+'.partial');count=0
            request=urllib.request.Request(pin['url'],headers={'User-Agent':'xpod-controlled-inngest-originals','Accept-Encoding':'identity'})
            with opener.open(request,timeout=30) as response:
                need(response.status==200 and response.geturl()==pin['url'] and response.headers.get('Content-Encoding','identity')=='identity','fixed original transport')
                with partial.open('xb') as out:
                    while True:
                        data=response.read(LIMITS['rangeBytes'])
                        if not data:break
                        count+=len(data);need(count<=pin.get('maximumBytes',pin.get('bytes',0)),'download byte bound');budget.reserve(len(data));out.write(data)
                verify_original(partial,pin)
                destination=originals/pin['file'];need(not destination.exists(),'fresh original destination');partial.rename(destination)
                write_metadata(work/(pin['file']+'.http.original.json'),dict(url=pin['url'],status=response.status,bytes=count,sha256=sha(destination),headers={k:response.headers[k] for k in ['Content-Length','Content-Type','ETag'] if k in response.headers},**({'gitlinkOriginal':gitlink} if gitlink is not None else {})),budget)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

def prepare(work,target='linux-arm64'):
    require_host(target)
    originals=work/'originals';need(originals.is_dir() and not (work/'source').exists(),'supplied originals and fresh workspace required')
    for folder in ['tools','products','home','tmp','go-cache','go-mod-cache']:(work/folder).mkdir(mode=0o700)
    verify_original(originals/POLICY['source']['file'],POLICY['source']);unpack_fixed(originals/POLICY['source']['file'],work/'source','inngest-inngest-'+POLICY['sourceCommit'][:7])
    for name,pin in target_tools(target).items():verify_original(originals/pin['file'],pin);unpack_fixed(originals/pin['file'],work/'tools'/name,pin['prefix'])
    for dependency in source_dependencies():
        verify_projection_declarations(work,dependency);pin=dependency['source'];verify_original(originals/pin['file'],pin)
        http=work/(pin['file']+'.http.original.json');need(http.stat().st_size<=LIMITS['metadataBytes'],'source dependency HTTP metadata bound');verify_gitlink_original(dependency,json.loads(http.read_text()).get('gitlinkOriginal'))
        target_path=work/'source'/dependency['destination'];need(target_path.parent.resolve(strict=True)==(work/'source').resolve(strict=True)/Path(dependency['destination']).parent,'source projection ancestor differs')
        used=sum(row['bytes'] for row in inventory(work/'source').values() if row['kind']=='file');remaining=LIMITS['sourceBytes']-used
        need(remaining>0,'main source leaves no projection byte budget')
        unpack_fixed(originals/pin['file'],target_path,pin['prefix'],dependency['projection']['root'],remaining)
    expected={pin['file'] for pin in original_pins(target)};need({p.name for p in originals.iterdir()}==expected,'fixed original file set')
    acquisition=[]
    for pin in original_pins(target):
        file=work/(pin['file']+'.http.original.json');need(file.stat().st_size<=LIMITS['metadataBytes'],'HTTP original metadata bound');value=json.loads(file.read_text());original=reference(originals/pin['file'],work)
        need(value.get('url')==pin['url'] and value.get('status')==200 and value.get('bytes')==original['bytes'] and value.get('sha256')==original['sha256'],'actual fixed acquisition reference');acquisition.append(reference(file,work))
    write_metadata(work/'preparation.original.json',dict(sourceKind=POLICY['sourceKind'],sourceCommit=POLICY['sourceCommit'],target=target,originals=[reference(p,work) for p in sorted(originals.iterdir())],acquisitionOriginals=acquisition,scope='producer extraction only; no authority issued'),MaterialBudget(work))

def materialize_ui(work,target='linux-arm64'):
    """The upstream Makefile copies the built dist into Go's embedded static tree."""
    source=work/'source/ui/apps/dev-server-ui/dist';target=work/'source/pkg/devserver/static'
    need(source.is_dir() and not source.is_symlink() and target.is_dir() and not target.is_symlink(),'actual UI dist and static roots')
    before=inventory(source);need(before and all(r['kind']=='file' for r in before.values()),'ordinary actual UI outputs')
    total=0
    for name,value in sorted(before.items()):
        total+=value['bytes'];need(total<=LIMITS['sourceBytes'],'UI generated input bound');destination=target/name
        for parent in destination.parents:
            if parent==target.parent:break
            need(not parent.is_symlink(),'linked static parent')
        destination.parent.mkdir(parents=True,exist_ok=True);need(not destination.is_symlink(),'linked static destination')
        with (source/name).open('rb') as inp,destination.open('wb') as out:
            count=0
            while True:
                data=inp.read(LIMITS['rangeBytes'])
                if not data:break
                count+=len(data);need(count<=value['bytes'],'UI output grew');need(shutil.disk_usage(work).free-len(data)>=LIMITS['freeFloorBytes'],'UI disk floor');out.write(data)
        need(count==value['bytes'] and sha(destination)==value['sha256'],'UI copied input bytes')
    need(inventory(source)==before,'UI outputs changed during materialization')

def inventory(root):
    rows={}
    for parent,dirs,files in os.walk(root,followlinks=False):
        dirs.sort();files.sort()
        for name in dirs+files:
            file=Path(parent)/name;relative=file.relative_to(root).as_posix();s=file.lstat()
            if stat.S_ISDIR(s.st_mode):continue
            need(stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode),'ordinary input or symlink only');need(len(rows)<LIMITS['sourceMembers'],'input member bound')
            rows[relative]=dict(kind='symlink',target=os.readlink(file)) if file.is_symlink() else dict(kind='file',bytes=s.st_size,sha256=sha(file),mode=stat.S_IMODE(s.st_mode))
    return rows

def domains(work):
    # All installed pnpm dependencies are retained, including zero-contribution
    # packages. They are build inputs, not a redistribution/license assertion.
    source=inventory(work/'source');dependencies={p:v for p,v in source.items() if 'node_modules' in Path(p).parts};source={p:v for p,v in source.items() if p not in dependencies}
    return dict(source=source,dependencies=dependencies,toolchain=inventory(work/'tools'))
def total_check(work):
    total=sum(p.stat().st_size for p in work.rglob('*') if p.is_file() and not p.is_symlink() and (p.relative_to(work).parts[0] in ['materials','originals','products'] or p.parent==work and p.suffix=='.json'))
    need(total<=min(_retained_byte_ceiling,LIMITS['sourceMaterialBytes']),'shared retained material total');need(shutil.disk_usage(work).free>=LIMITS['freeFloorBytes'],'disk floor');return total

class MaterialBudget:
    """One private ledger per capture/finalize phase; existing retained bytes count."""
    def __init__(self,work):self.work,self.charged=work,total_check(work)
    def reserve(self,count):
        need(isinstance(count,int) and count>=0,'positive material reservation')
        need(self.charged+count<=min(_retained_byte_ceiling,LIMITS['sourceMaterialBytes']),'shared retained material total '+json.dumps(dict(chargedBytes=self.charged,requestedBytes=count,retainedByteCeiling=min(_retained_byte_ceiling,LIMITS['sourceMaterialBytes'])),separators=(',',':')))
        need(shutil.disk_usage(self.work).free-count>=LIMITS['freeFloorBytes'],'disk floor before write')
        self.charged+=count

def public_source_classification(work,domain,paths=None):
    if domain!='source':return None
    need((work/'source').is_dir() and not (work/'source').is_symlink(),'canonical owned public source root required')
    value=POLICY.get('publicSourceInputs');need(value and value['kind']=='fixed-public-upstream-source-inputs' and value['repository']==POLICY['repository']=='inngest/inngest' and value['sourceCommit']==POLICY['sourceCommit'] and value['sourceArchive']==POLICY['source'],'fixed public source origin differs')
    if paths is not None and not set(paths).intersection(row['path'] for row in value['files']):return None
    verify_original(work/'originals'/POLICY['source']['file'],POLICY['source'])
    rows=value['files'];need(len(rows)==6 and len({row['path'] for row in rows})==6,'six exact public source roles required')
    for row in rows:
        name=row['path'];need(isinstance(name,str) and not name.startswith('/') and all(part not in ('','.','..') for part in name.split('/')) and 0<=row['bytes']<=LIMITS['metadataBytes'] and len(row['sha256'])==64,'bounded declared public source original')
    return {row['path']:row for row in rows}

def public_toolchain_classification(work,domain,paths,target):
    if domain!='toolchain':return None
    value=POLICY.get('publicToolchainInputs')
    need(value and value['kind']=='fixed-public-toolchain-archive-inputs' and value['tool']=='node','fixed toolchain public input declaration required')
    rows=value['files'];need(len(rows)==1,'one exact public Node distribution input required')
    row=rows[0]
    member=row.get('archiveMember');need(set(row)=={'path','archiveMember','bytes','sha256','mode'} and type(row.get('bytes')) is int and type(row.get('mode')) is int and isinstance(member,str) and member and not member.startswith('/') and all(part not in ('','.','..') for part in member.split('/')) and '\\' not in member and row.get('path')=='node/'+member and row.get('bytes')==0 and row.get('sha256')==hashlib.sha256(b'').hexdigest() and row.get('mode')==0o644,'fixed empty Node configuration declaration differs')
    if row['path'] not in paths:return None
    tools=work/'tools';need(tools.is_dir() and not tools.is_symlink(),'canonical owned toolchain root required')
    node=target_tools(target)['node']
    # The sole policy descriptor owns this complete archive pin. No downloaded
    # candidate metadata or basename can classify a different tool's config.
    verify_original(work/'originals'/node['file'],node)
    return {row['path']:{key:row[key] for key in ['path','bytes','sha256','mode']}}


def capture_domain(work,name,domain,rows,base,budget,target='linux-arm64'):
    spec=importlib.util.spec_from_file_location('controlled_source_capture',ROOT/'scripts/lib/module-source-materials.py');capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
    root=work/'materials'/name;root.mkdir(mode=0o700,parents=True)
    try:
        result=capture.capture_group(root,work,domain,[(p,base/p) for p in sorted(rows)],base,reserve_bytes=budget.reserve,public_source_inputs=public_source_classification(work,domain,rows),archive_encoding='gzip-blocks-v1',public_toolchain_inputs=public_toolchain_classification(work,domain,rows,target))
    except ValueError as error:
        if 'shared retained material total' in str(error):
            raise ValueError(str(error)+' domain='+domain+' phase='+name+' memberCount='+str(len(rows))+' declaredRegularBytes='+str(sum(row.get('bytes',0) for row in rows.values()))) from None
        raise
    total_check(work);return result

def loaded_rows(work,group):
    rows={}
    for ref in group['inventories']:
        file=work/ref['path'];need(file.stat().st_size==ref['bytes']<=LIMITS['metadataBytes'] and sha(file)==ref['sha256'],'original inventory custody')
        for row in json.loads(file.read_text()):
            path=row['path'];need(path not in rows and len(rows)<LIMITS['sourceMembers'],'inventory exact path set')
            rows[path]={k:v for k,v in row.items() if k not in ['path','archive']}
    return rows

def write_metadata(file,value,budget):
    encoded=json.dumps(value,separators=(',',':')).encode();need(len(encoded)<=LIMITS['metadataBytes'],'metadata bound')
    budget.reserve(len(encoded))
    with file.open('xb') as out:out.write(encoded)

def capture_inputs(work,target='linux-arm64'):
    need(not (work/'inputs.original.json').exists(),'fresh input snapshot required');before=domains(work);need(sum(map(len,before.values()))<=LIMITS['sourceMembers'],'combined source input member bound');records={};budget=MaterialBudget(work)
    for name,rows in before.items():records[name]=capture_domain(work,'before-'+name,name,rows,work/('tools' if name=='toolchain' else 'source'),budget,target)
    after=domains(work);need(after==before,'build inputs changed during capture')
    write_metadata(work/'inputs.original.json',dict(sourceKind=POLICY['sourceKind'],target=target,originals=records),budget);total_check(work)

def verify_binary_target(file,target):
    descriptor=target_descriptor(target)['binaryFormat']
    with Path(file).open('rb') as stream:header=stream.read(64)
    need(len(header)==64,'complete executable header required')
    if descriptor['format']=='elf64-le':need(header[:6]==b'\x7fELF\x02\x01' and int.from_bytes(header[18:20],'little')==descriptor['machine'],'matching ELF64 target required')
    else:need(descriptor['format']=='macho64-le' and int.from_bytes(header[:4],'little')==0xfeedfacf and int.from_bytes(header[4:8],'little')==descriptor['cpuType'],'matching Mach-O64 target required')

def finalize(work,target='linux-arm64'):
    budget=MaterialBudget(work);value=json.loads((work/'inputs.original.json').read_text());need(value.get('sourceKind')==POLICY['sourceKind'] and (value.get('target')==target or value.get('target') is None and target=='linux-arm64'),'same target input snapshot required');after=domains(work);before={name:loaded_rows(work,group) for name,group in value['originals'].items()};need(after['dependencies']==before['dependencies'] and after['toolchain']==before['toolchain'],'dependencies/tool originals changed during compilation')
    changed={p:v for p,v in after['source'].items() if before['source'].get(p)!=v};removed=sorted(set(before['source'])-set(after['source']));generated=capture_domain(work,'generated','source',changed,work/'source',budget);removed_refs=[]
    for at in range(0,len(removed),1000):
        file=work/'materials'/('removed-'+str(at//1000).zfill(4)+'.json');write_metadata(file,removed[at:at+1000],budget);removed_refs.append(reference(file,work))
    binary=work/'products/inngest';need(binary.is_file() and 0<binary.stat().st_size<=192*1024**2 and binary.stat().st_mode&0o111,'actual compiled executable required');verify_binary_target(binary,target)
    for pin in original_pins(target):verify_original(work/'originals'/pin['file'],pin)
    result=dict(schemaVersion=1,sourceKind=POLICY['sourceKind'],sourceCommit=POLICY['sourceCommit'],target=target,preparation=reference(work/'preparation.original.json',work),inputs=reference(work/'inputs.original.json',work),originals=value['originals'],generated=dict(changedCount=len(changed),removedCount=len(removed),removedOriginals=removed_refs,originals=generated),binary=reference(binary,work),license=reference(work/'source/LICENSE.md',work),sourceArchive=reference(work/'originals'/POLICY['source']['file'],work),scope='normal producer original materials only; no official release asset or source qualification')
    write_metadata(work/'controlled-build-materials.json',result,budget);total_check(work)

def main():
    global _retained_byte_ceiling
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['acquire','prepare','capture-inputs','materialize-ui','finalize']);parser.add_argument('work');parser.add_argument('--target',default='linux-arm64');parser.add_argument('--retained-byte-ceiling',type=int,default=LIMITS['sourceMaterialBytes']);args=parser.parse_args()
    target_descriptor(args.target);_retained_byte_ceiling=args.retained_byte_ceiling;need(0<=_retained_byte_ceiling<=LIMITS['sourceMaterialBytes'],'retained ceiling may only tighten')
    work=Path(args.work);need(work.is_absolute() and work.is_dir() and not work.is_symlink(),'canonical existing private work directory');require_host(args.target)
    {'acquire':acquire,'prepare':prepare,'capture-inputs':capture_inputs,'materialize-ui':materialize_ui,'finalize':finalize}[args.action](work,args.target)
if __name__=='__main__':main()

"""Explicit native preparation route for the NORMAL API producer.

The parent invokes each planned phase through its existing run_stage; this file
never creates a nested supervisor/session and never issues admission facts.
"""
import base64
import hashlib
import importlib.util
import json
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
def environment(work):
    work=Path(work).resolve();home=work/'home';tools=work/'tools'
    return dict(HOME=str(home),TMPDIR=str(work/'tmp'),PATH=str(tools/'node/bin')+':/usr/bin:/bin',LANG='C.UTF-8',LC_ALL='C.UTF-8',CI='1',NEXT_TELEMETRY_DISABLED='1',DO_NOT_TRACK='1',COREPACK_ENABLE_DOWNLOAD_PROMPT='0',GOPROXY='off',GOSUMDB='off',GOENV='off',GOTOOLCHAIN='local',GOWORK='off',CGO_ENABLED='0',GOOS='linux',GOARCH='arm64',GOARM64='v8.0',GOCACHE=str(work/'go-cache'),GOMODCACHE=str(work/'go-mod-cache'))
def native_deadline(parent_deadline, now):
    need(isinstance(parent_deadline,(int,float)) and isinstance(now,(int,float)) and now < parent_deadline,'remaining parent deadline required')
    return min(parent_deadline, now + POLICY['nativeWindowSeconds'])

def phase_plan(repo,work,target,source_kind,retainedByteCeiling=LIMITS['sourceMaterialBytes']):
    """Pure plan; target/route must be explicit, never inferred from failure."""
    repo,work=Path(repo).resolve(),Path(work).resolve();need(target in POLICY['targets'] and source_kind==POLICY['sourceKind'],'unsupported explicit source kind/target')
    need(type(retainedByteCeiling) is int and 0<=retainedByteCeiling<=LIMITS['sourceMaterialBytes'],'retained byte ceiling may only tighten')
    helper=repo/'scripts/lib/inngest-controlled-build.py';source=work/'source';node=work/'tools/node/bin/node';pnpm=work/'tools/pnpm/bin/pnpm.cjs';go=work/'tools/go/bin/go'
    def own(action):return [sys.executable,'-I','-S','-B',str(helper),action,str(work),'--retained-byte-ceiling',str(retainedByteCeiling)]
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
def unpack_fixed(file,destination,prefix):
    """Called only AFTER full pinned digest verification; no arbitrary tar API."""
    need(not destination.exists(),'fresh extracted directory required');destination.mkdir(mode=0o700)
    total=0;members=set();links=[]
    with tarfile.open(file,'r:*') as archive:
        for member in archive:
            parts=Path(member.name).parts;need(parts and parts[0]==prefix and not member.name.startswith('/') and all(p not in ('..','') for p in parts),'fixed source archive path')
            name='/'.join(parts[1:]);
            if not name:need(member.isdir(),'archive root directory');continue
            need(name not in members and len(members)<LIMITS['sourceMembers'],'duplicate/member bound');members.add(name);target=destination/name
            need(all(not p.is_symlink() for p in target.parents if p!=destination.parent),'linked extraction ancestor');target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            if member.isdir():target.mkdir(mode=0o700,exist_ok=True)
            elif member.isfile():
                total+=member.size;need(member.size<=LIMITS['shardBytes'] and total<=LIMITS['sourceMaterialBytes'],'expanded archive bound')
                source=archive.extractfile(member);count=0
                with target.open('xb') as output:
                    while True:
                        data=source.read(LIMITS['rangeBytes'])
                        if not data:break
                        count+=len(data);need(count<=member.size,'member growth');need(shutil.disk_usage(destination).free-len(data)>=LIMITS['freeFloorBytes'],'extraction disk floor');output.write(data)
                need(count==member.size,'truncated member');target.chmod(member.mode&0o777)
            elif member.issym():links.append((target,member.linkname))
            else:need(False,'unsupported archive entry')
    for target,link in links:
        need(not os.path.isabs(link) and '\x00' not in link,'relative source link');resolved=(target.parent/link).resolve();need(resolved.is_relative_to(destination.resolve()),'source link escapes');target.symlink_to(link)
    return total

def acquire(work):
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
        for pin in [POLICY['source'],*POLICY['tools'].values()]:
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
                write_metadata(work/(pin['file']+'.http.original.json'),dict(url=pin['url'],status=response.status,bytes=count,sha256=sha(destination),headers={k:response.headers[k] for k in ['Content-Length','Content-Type','ETag'] if k in response.headers}),budget)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

def prepare(work):
    need(sys.platform=='linux' and os.uname().machine in ['aarch64','arm64'],'matching Linux arm64 build host required')
    originals=work/'originals';need(originals.is_dir() and not (work/'source').exists(),'supplied originals and fresh workspace required')
    for folder in ['tools','products','home','tmp','go-cache','go-mod-cache']:(work/folder).mkdir(mode=0o700)
    verify_original(originals/POLICY['source']['file'],POLICY['source']);unpack_fixed(originals/POLICY['source']['file'],work/'source','inngest-inngest-'+POLICY['sourceCommit'][:7])
    for name,pin in POLICY['tools'].items():verify_original(originals/pin['file'],pin);unpack_fixed(originals/pin['file'],work/'tools'/name,pin['prefix'])
    expected={pin['file'] for pin in [POLICY['source'],*POLICY['tools'].values()]};need({p.name for p in originals.iterdir()}==expected,'fixed original file set')
    acquisition=[]
    for pin in [POLICY['source'],*POLICY['tools'].values()]:
        file=work/(pin['file']+'.http.original.json');need(file.stat().st_size<=LIMITS['metadataBytes'],'HTTP original metadata bound');value=json.loads(file.read_text());original=reference(originals/pin['file'],work)
        need(value.get('url')==pin['url'] and value.get('status')==200 and value.get('bytes')==original['bytes'] and value.get('sha256')==original['sha256'],'actual fixed acquisition reference');acquisition.append(reference(file,work))
    write_metadata(work/'preparation.original.json',dict(sourceKind=POLICY['sourceKind'],sourceCommit=POLICY['sourceCommit'],originals=[reference(p,work) for p in sorted(originals.iterdir())],acquisitionOriginals=acquisition,scope='producer extraction only; no authority issued'),MaterialBudget(work))

def materialize_ui(work):
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
        need(self.charged+count<=min(_retained_byte_ceiling,LIMITS['sourceMaterialBytes']),'shared retained material total')
        need(shutil.disk_usage(self.work).free-count>=LIMITS['freeFloorBytes'],'disk floor before write')
        self.charged+=count

def capture_domain(work,name,domain,rows,base,budget):
    spec=importlib.util.spec_from_file_location('controlled_source_capture',ROOT/'scripts/lib/module-source-materials.py');capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
    root=work/'materials'/name;root.mkdir(mode=0o700,parents=True)
    result=capture.capture_group(root,work,domain,[(p,base/p) for p in sorted(rows)],base,reserve_bytes=budget.reserve);total_check(work);return result

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

def capture_inputs(work):
    need(not (work/'inputs.original.json').exists(),'fresh input snapshot required');before=domains(work);need(sum(map(len,before.values()))<=LIMITS['sourceMembers'],'combined source input member bound');records={};budget=MaterialBudget(work)
    for name,rows in before.items():records[name]=capture_domain(work,'before-'+name,name,rows,work/('tools' if name=='toolchain' else 'source'),budget)
    after=domains(work);need(after==before,'build inputs changed during capture')
    write_metadata(work/'inputs.original.json',dict(sourceKind=POLICY['sourceKind'],originals=records),budget);total_check(work)

def finalize(work):
    budget=MaterialBudget(work);value=json.loads((work/'inputs.original.json').read_text());after=domains(work);before={name:loaded_rows(work,group) for name,group in value['originals'].items()};need(after['dependencies']==before['dependencies'] and after['toolchain']==before['toolchain'],'dependencies/tool originals changed during compilation')
    changed={p:v for p,v in after['source'].items() if before['source'].get(p)!=v};removed=sorted(set(before['source'])-set(after['source']));generated=capture_domain(work,'generated','source',changed,work/'source',budget);removed_refs=[]
    for at in range(0,len(removed),1000):
        file=work/'materials'/('removed-'+str(at//1000).zfill(4)+'.json');write_metadata(file,removed[at:at+1000],budget);removed_refs.append(reference(file,work))
    binary=work/'products/inngest';need(binary.is_file() and 0<binary.stat().st_size<=192*1024**2 and binary.stat().st_mode&0o111,'actual compiled executable required')
    for name,pin in [('source',POLICY['source']),*POLICY['tools'].items()]:verify_original(work/'originals'/pin['file'],pin)
    result=dict(schemaVersion=1,sourceKind=POLICY['sourceKind'],sourceCommit=POLICY['sourceCommit'],target='linux-arm64',preparation=reference(work/'preparation.original.json',work),inputs=reference(work/'inputs.original.json',work),originals=value['originals'],generated=dict(changedCount=len(changed),removedCount=len(removed),removedOriginals=removed_refs,originals=generated),binary=reference(binary,work),license=reference(work/'source/LICENSE.md',work),sourceArchive=reference(work/'originals'/POLICY['source']['file'],work),scope='normal producer original materials only; no official release asset or source qualification')
    write_metadata(work/'controlled-build-materials.json',result,budget);total_check(work)

def main():
    global _retained_byte_ceiling
    if len(sys.argv)==5:
        need(sys.argv[3]=='--retained-byte-ceiling' and str(int(sys.argv[4]))==sys.argv[4],'canonical explicit retained ceiling');_retained_byte_ceiling=int(sys.argv[4]);need(0<=_retained_byte_ceiling<=LIMITS['sourceMaterialBytes'],'retained ceiling may only tighten')
    need(len(sys.argv) in [3,5] and sys.argv[1] in ['acquire','prepare','capture-inputs','materialize-ui','finalize'],'fixed phase and owned work directory required');work=Path(sys.argv[2]);need(work.is_absolute() and work.is_dir() and not work.is_symlink(),'canonical existing private work directory');{'acquire':acquire,'prepare':prepare,'capture-inputs':capture_inputs,'materialize-ui':materialize_ui,'finalize':finalize}[sys.argv[1]](work)
if __name__=='__main__':main()

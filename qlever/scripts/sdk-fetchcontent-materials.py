"""Pinned FetchContent preparation. Mechanic originals never issue source trust."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import tarfile
import urllib.request

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('dependency_git_originals',HERE/'sdk-upstream-source-materials.py')
git=importlib.util.module_from_spec(spec);spec.loader.exec_module(git)
META=git.METADATA
MEMBER=git.MEMBER
ROOT=Path('/opt/qlever-sdk/dependencies')
spec=importlib.util.spec_from_file_location('dependency_shared_bindings',HERE/'sdk-generation-multiprocess-bindings.py')
bindings=importlib.util.module_from_spec(spec);spec.loader.exec_module(bindings)
parse_declarations=bindings.parse_fetchcontent_declarations
cmake_bindings=bindings.fetchcontent_source_bindings
spec=importlib.util.spec_from_file_location('dependency_shared_budget',HERE/'sdk-toolchain-materials.py')
ledger=importlib.util.module_from_spec(spec);spec.loader.exec_module(ledger)
remaining=ledger.remaining_source_bytes
LIMITS=json.loads((HERE.parents[1]/'scripts/lib/module-artifact-limits.json').read_text())
spec=importlib.util.spec_from_file_location('dependency_reviewed_tar_guard',HERE/'sdk-debian-binary-originals.py')
archive_guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive_guard)

def dump(path,value,check):git.write(path,value,check)
def rooted(value,prefix):
    if isinstance(value,list):return [rooted(item,prefix) for item in value]
    if isinstance(value,dict):
        if all(key in value for key in ('path','bytes','sha256')):return dict(value,path=prefix+'/'+value['path'])
        return {key:rooted(item,prefix) for key,item in value.items()}
    return value
def physical_inventory(source,out,materials,budget):
    source=Path(source);rows=[];shards=[];count=0;total=0;empty=[];empty_bytes=2
    def flush():
        path=out/('inventory-'+str(len(shards)).zfill(4)+'.json');value=dict(schemaVersion=1,files=rows)
        if len(json.dumps(value,sort_keys=True).encode())>remaining(materials):raise ValueError('Dependency inventory remaining budget')
        dump(path,value,budget.check);shards.append(git.ref(path,materials,budget.check))
    for directory,dirs,files in os.walk(source,followlinks=False):
        budget.check(4200)
        if not dirs and not files and Path(directory)!=source:
            path=Path(directory);before=path.lstat()
            if not stat.S_ISDIR(before.st_mode) or any(path.iterdir()):raise ValueError('Empty dependency directory changed')
            after=path.lstat();identity=lambda row:[str(value) for value in (row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_mtime_ns,row.st_ctime_ns)]
            if identity(before)!=identity(after):raise ValueError('Empty dependency directory identity changed')
            entry=dict(path=path.relative_to(source).as_posix(),identityDecimal=identity(after));empty_bytes+=len(json.dumps(entry).encode())+(2 if empty else 0)
            if len(empty)>=LIMITS['sourceMembers'] or empty_bytes>META:raise ValueError('Empty dependency directory metadata bound')
            empty.append(entry)
        linked=[name for name in dirs if (Path(directory)/name).is_symlink()];dirs[:]=sorted(name for name in dirs if name not in linked)
        for name in sorted([*files,*linked]):
            budget.check(4200);path=Path(directory)/name;before=path.lstat();relative=path.relative_to(source).as_posix()
            if stat.S_ISREG(before.st_mode):
                identity=git.ref(path,path.parent,budget.check);row=dict(path=relative,kind='file',mode=before.st_mode&0o7777,bytes=identity['bytes'],sha256=identity['sha256'])
            elif stat.S_ISLNK(before.st_mode):
                target=os.readlink(path);resolved=path.resolve(strict=True)
                if not resolved.is_relative_to(source):raise ValueError('Dependency source symlink escapes prepared root')
                data=os.fsencode(target);row=dict(path=relative,kind='symlink',mode=before.st_mode&0o7777,target=target,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
            else:raise ValueError('Dependency physical source must be regular or internal symlink')
            after=path.lstat()
            if (before.st_dev,before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Dependency inventory changed')
            if rows and len(json.dumps(dict(schemaVersion=1,files=[*rows,row])).encode())>META-4096:flush();rows=[]
            rows.append(row);count+=1;total+=row['bytes']
            if count>LIMITS['sourceMembers'] or total>LIMITS['sourceMaterialBytes']:raise ValueError('Dependency physical source inventory bound')
    if rows:flush()
    path=out/'source-inventory.json';dump(path,dict(schemaVersion=1,files=count,bytes=total,shards=shards,emptyDirectories=empty),budget.check)
    return git.ref(path,materials,budget.check)

class PreparedCollector(git.Collector):
    def command(self,name,argv,maximum=META,stdin=None):
        available=remaining(self.materials)-4*META
        if available<=0:raise ValueError('Git original shared source budget reserve')
        result=super().command(name,argv,min(maximum,available),stdin)
        remaining(self.materials);return result

def prepare_git(declaration,source,out,materials,budget):
    source.mkdir()
    collector=PreparedCollector.for_git_source(source,out,budget,declaration['repository'],declaration['commit']);collector.materials=materials
    collector.command('clone',['git','clone','--no-checkout','--config','advice.detachedHead=false',declaration['repository'],'.'])
    collector.command('checkout',['git','checkout','--detach',declaration['commit']])
    shallow=collector.command('not-shallow',['git','rev-parse','--is-shallow-repository'])
    if (collector.out/shallow['stdout']['path']).read_text().strip()!='false':raise ValueError('Complete Git acquisition required')
    config=collector.command('complete-config',['git','config','--local','--list'])
    if re.search(r'(?im)^(?:extensions\.partialclone|remote\..*\.(?:promisor|partialclonefilter))=',(collector.out/config['stdout']['path']).read_text()):raise ValueError('Partial Git acquisition refused')
    snapshot=collector.git_snapshot(allow_unmaterialized_gitlinks=True)
    path=out/'git-materials.json';dump(path,dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',**rooted(snapshot,out.relative_to(materials).as_posix()),stages=rooted(collector.stages,out.relative_to(materials).as_posix())),budget.check)
    return git.ref(path,materials,budget.check)

def download(url,target,algorithm,digest,materials,budget):
    actual=hashlib.new(algorithm);count=0
    with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept-Encoding':'identity'}),timeout=30) as response,target.open('xb') as output:
        if response.status!=200 or response.headers.get('Content-Encoding','identity')!='identity':raise ValueError('Dependency archive response differs')
        while True:
            budget.check(4200);block=response.read(65536)
            if not block:break
            count+=len(block)
            if count>MEMBER or len(block)>remaining(materials) or shutil.disk_usage(materials).free-len(block)<2*1024**3:raise ValueError('Dependency download byte/disk budget')
            output.write(block);output.flush();actual.update(block)
    if actual.hexdigest()!=digest:raise ValueError('Declared dependency archive digest differs')

def unpack(archive,source,algorithm,digest,check):
    # Hash and decode the same retained FD. Audit raw decoded headers before
    # tarfile can eagerly allocate hidden GNU/PAX extension payloads.
    identity=lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
    with archive.open('rb') as packed:
        before=os.fstat(packed.fileno());value=hashlib.new(algorithm)
        if not stat.S_ISREG(before.st_mode) or before.st_size>MEMBER:raise ValueError('Dependency archive original bound/type')
        hashed=0
        while True:
            check();block=packed.read(min(65536,before.st_size-hashed+1))
            if not block:break
            hashed+=len(block)
            if hashed>before.st_size:raise ValueError('Dependency archive grew beyond initial size while hashing')
            value.update(block)
        if hashed!=before.st_size:raise ValueError('Dependency archive truncated while hashing')
        if identity(before)!=identity(os.fstat(packed.fileno())) or identity(before)!=identity(archive.lstat()):raise ValueError('Dependency archive changed during hash')
        if value.hexdigest()!=digest:raise ValueError('Declared dependency archive digest differs')
        packed.seek(0)
        decoded=archive_guard.BoundedReader(archive_guard.codec(packed,str(archive)),LIMITS['sourceMaterialBytes'],check)
        guarded=archive_guard.TarHeaderGuard(decoded,dict(bytes=0,members=0),check)
        unpack_stream(guarded,source,check)
        # tarfile stops at logical EOF; drain through the guard to validate all
        # decoded padding/tail bytes, compression trailer and aggregate bound.
        while guarded.read(65536):check()
        if identity(before)!=identity(os.fstat(packed.fileno())) or identity(before)!=identity(archive.lstat()):raise ValueError('Dependency archive changed during decode')

def unpack_stream(guarded,source,check):
    source.mkdir();root=None;seen=set();expanded=0
    with tarfile.open(fileobj=guarded,mode='r|',bufsize=65536) as bundle:
        for item in bundle:
            check();name=item.name.removeprefix('./').rstrip('/')
            if name in ('','.'):continue
            parts=Path(name).parts
            if not parts or name.startswith('/') or any(part in ('.','..','.git') for part in parts):raise ValueError('Unsafe dependency archive path')
            if root is None:root=parts[0]
            if parts[0]!=root or name in seen:raise ValueError('Single-root unique dependency archive required')
            seen.add(name)
            if len(seen)>LIMITS['sourceMembers']:raise ValueError('Dependency archive member bound')
            relative=Path(*parts[1:]);target=source/relative
            if len(parts)==1:
                if not item.isdir():raise ValueError('Dependency archive top root must be a directory')
                continue
            if any(parent.is_symlink() for parent in target.parents if parent!=source.parent):raise ValueError('Archive symlink parent refused')
            if item.isdir():target.mkdir(parents=True,exist_ok=True);continue
            if not item.isfile():raise ValueError('Unsupported dependency archive link/special member')
            expanded+=item.size
            if item.size>MEMBER or expanded>LIMITS['sourceMaterialBytes']:raise ValueError('Dependency expanded source byte bound')
            target.parent.mkdir(parents=True,exist_ok=True)
            with bundle.extractfile(item) as stream,target.open('xb') as output:
                count=0
                for block in iter(lambda:stream.read(65536),b''):
                    check();count+=len(block)
                    if count>item.size or shutil.disk_usage(source).free-len(block)<2*1024**3:raise ValueError('Dependency extract growth/disk bound')
                    output.write(block)
                if count!=item.size:raise ValueError('Dependency archive truncated member')
            target.chmod(item.mode&0o777)
    if root is None:raise ValueError('Empty dependency archive')

def validate_nested(source,known):
    for path in sorted([*source.rglob('CMakeLists.txt'),*source.rglob('*.cmake')]):
        if '.git' in path.relative_to(source).parts:continue
        if path.stat().st_size>META:raise ValueError('Nested CMake original bound')
        clean=re.sub(r'#[^\n]*','',path.read_text())
        for match in re.finditer(r'(?im)^\s*FetchContent_Declare\s*\(\s*([^\s)]+)',clean):
            if match[1].lower() not in known:raise ValueError('Unprepared nested FetchContent declaration: '+str(path)+':'+match[1])

def prepare(source,dependencies,materials,budget):
    source=Path(source);dependencies=Path(dependencies);materials=Path(materials);out=materials/'fetchcontent';out.mkdir()
    if (source/'CMakeLists.txt').stat().st_size>META:raise ValueError('Source declaration metadata bound')
    text=(source/'CMakeLists.txt').read_text();declarations=parse_declarations(text)
    original=out/'declaration.CMakeLists.txt';original.write_bytes((source/'CMakeLists.txt').read_bytes())
    dependencies.mkdir();rows=[]
    for row in declarations:
        budget.check(4200);root=dependencies/row['name'];directory=out/row['name'];directory.mkdir()
        if row['method']=='git':
            original_ref=prepare_git(row,root,directory/'git',materials,budget)
        else:
            collector=PreparedCollector.for_source(dependencies,directory/'download',budget);collector.materials=materials
            archive=directory/'archive.tar.xz'
            collector.command('download',[sys.executable,'-B',str(Path(__file__).resolve()),'download',row['url'],str(archive),row['algorithm'],row['digest'],str(materials)])
            unpack(archive,root,row['algorithm'],row['digest'],lambda:budget.check(4200))
            record=directory/'archive-materials.json';dump(record,dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',url=row['url'],algorithm=row['algorithm'],digest=row['digest'],archive=git.ref(archive,materials,budget.check),stages=rooted(collector.stages,collector.out.relative_to(materials).as_posix())),budget.check);original_ref=git.ref(record,materials,budget.check)
        validate_nested(root,{item['name'] for item in declarations})
        inventory=physical_inventory(root,directory,materials,budget)
        rows.append(dict(name=row['name'],sourceRoot=str(root),declaration=row,sourceInventory=inventory,sourceOriginals=dict(kind=row['method'],file=original_ref)))
        print('Prepared FetchContent source '+row['name'],flush=True)
    cache=cmake_bindings(rows)
    cache_path=dependencies/'sources.cmake';cache_path.write_text(cache)
    cache_original=out/'sources.cmake';cache_original.write_text(cache)
    collection=out/'materials.json';dump(collection,dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',sourceRoot=str(source),dependenciesRoot=str(dependencies),declarationSource=dict(sourcePath=str(source/'CMakeLists.txt'),file=git.ref(original,materials,budget.check)),dependencies=rows,cmakeCache=git.ref(cache_original,materials,budget.check),cmakeCachePath=str(cache_path),pending=['independent-FetchContent-source-admission-required']),budget.check)
    remaining(materials);return git.ref(collection,materials,budget.check)

if __name__=='__main__':
    budget=git.budgets.ExecutionBudget(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX'])
    if len(sys.argv)==7 and sys.argv[1]=='download':download(sys.argv[2],Path(sys.argv[3]),sys.argv[4],sys.argv[5],Path(sys.argv[6]),budget)
    elif sys.argv[1:]==['prepare']:prepare(Path('/opt/qlever-sdk/source'),ROOT,Path('/opt/qlever-sdk/materials'),budget)
    else:raise SystemExit('Fixed FetchContent preparation protocol required')

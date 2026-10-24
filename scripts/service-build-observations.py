"""Bounded same-parent build snapshots. Not compiler-read or source authority.

Each file is sampled through one nonblocking held FD. A pre/post tree equality is
an observation, not proof of every compiler input or absence of external writes.
"""
import hashlib,json,os,stat
from pathlib import Path
LIMITS=json.loads((Path(__file__).resolve().parent/'lib/module-artifact-limits.json').read_bytes())
EXCLUDED=frozenset(['.git','.test-data','__pycache__','node_modules','dist','logs','local'])
MODEL='actual-service-build-file-snapshots-v2'
SCOPE=json.loads((Path(__file__).resolve().parent/'lib/service-workspace-build-scope.json').read_bytes())
def scope_names(value):
    if not isinstance(value,list) or not value or any(not isinstance(name,str) or not name or name in ('.','..') or '\\' in name or '/' in name for name in value):raise ValueError('Service build originals: generated directory names')
    if len(set(value))!=len(value):raise ValueError('Service build originals: duplicate generated directory name')
    return tuple(value)
def scope_roots(value):
    if not isinstance(value,list) or not value or any(not isinstance(root,str) or not root or root.startswith('/') or '\\' in root or any(part in ('','.','..') for part in root.split('/')) for root in value):raise ValueError('Service build originals: generated directory roots')
    if len(set(value))!=len(value):raise ValueError('Service build originals: duplicate generated directory root')
    return tuple(tuple(root.split('/')) for root in value)
GENERATED_NAMES=scope_names(SCOPE.get('generatedDirectoryNames'))
GENERATED_ROOTS=scope_roots(SCOPE.get('generatedDirectoryRoots'))
def is_generated(parts):
    # Component dist directories anywhere, or files strictly under one fixed UI root.
    return any(name in parts for name in GENERATED_NAMES) or any(parts[:len(root)]==root for root in GENERATED_ROOTS)
def need(value,reason):
    if not value:raise ValueError('Service build originals: '+reason)
def identity(value):return [str(value.st_dev),str(value.st_ino),str(value.st_mode),str(value.st_size),str(value.st_mtime_ns),str(value.st_ctime_ns),str(value.st_nlink)]
def sample(root,relative,check,charge_read_bytes=None):
    check();file=root/relative;prior=os.lstat(file)
    need(stat.S_ISREG(prior.st_mode) and prior.st_nlink==1 and prior.st_size<=LIMITS['shardBytes'],'bounded regular source before open')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC);error=None
    try:
        first=os.fstat(fd);need(identity(first)==identity(prior),'selected source changed before open');digest=hashlib.sha256();count=0
        while count<first.st_size:
            check();block=os.read(fd,min(LIMITS['rangeBytes'],first.st_size-count));need(block,'short build file')
            if charge_read_bytes is not None:charge_read_bytes(len(block))
            count+=len(block);digest.update(block)
        check();eof=os.read(fd,1)
        if charge_read_bytes is not None and eof:charge_read_bytes(len(eof))
        need(not eof and identity(first)==identity(os.fstat(fd))==identity(os.lstat(file)),'build file changed while hashing')
        return [relative,identity(first),digest.hexdigest()]
    except BaseException as failure:error=failure;raise
    finally:
        try:os.close(fd)
        except BaseException:
            if error is None:raise

def snapshot(root,check,*,generated=False,paths=None,charge_read_bytes=None):
    root=Path(root);need(root.resolve(strict=True)==root and stat.S_ISDIR(os.lstat(root).st_mode),'canonical build root')
    selected=[];path_bytes=0
    if paths is None:
        for current,dirs,names in os.walk(root,followlinks=False):
            check();relative=Path(current).relative_to(root);parts=tuple(relative.parts);generated_here=is_generated(parts);blocked=EXCLUDED-({'dist'} if generated else set())
            dirs[:]=sorted(name for name in dirs if name not in blocked)
            for name in dirs:need(stat.S_ISDIR(os.lstat(Path(current)/name).st_mode),'source directory symlink refused')
            if generated!=generated_here:continue
            for name in sorted(names):
                name=(relative/name).as_posix();path_bytes+=len(name.encode('utf-8'));need(path_bytes<=LIMITS['metadataBytes']-4096 and len(selected)<LIMITS['members'],'build observed path metadata bound before append');selected.append(name)
    else:selected=list(paths)
    rows=[];charged=0;encoded=0
    for relative in selected:
        need(isinstance(relative,str) and relative and len(relative.encode('utf-8'))<=4096 and not relative.startswith('/') and all(part not in ['','..','.'] for part in relative.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in relative),'ordinary build relative path')
        need(is_generated(tuple(relative.split('/')))==generated,'declared generated/source snapshot partition')
        row=sample(root,relative,check,charge_read_bytes);charged+=int(row[1][3]);need(charged<=LIMITS['sourceMaterialBytes'],'build sample aggregate read bound')
        encoded+=len(json.dumps(row,separators=(',',':')).encode())+1;need(encoded<=LIMITS['metadataBytes']-4096,'build snapshot metadata before append');rows.append(row)
    return dict(schemaVersion=1,kind=MODEL,generated=generated,excludedDirectoryNames=sorted(EXCLUDED),generatedDirectoryNames=list(GENERATED_NAMES),generatedDirectoryRoots=['/'.join(root) for root in GENERATED_ROOTS],rows=rows,observedFileBytes=charged,authorityVerified=False)

def write_snapshot(file,value,check,remaining):
    # The caller already reserved one metadata maximum before sampling.
    check();raw=(json.dumps(value,separators=(',',':'))+'\n').encode();need(len(raw)<=LIMITS['metadataBytes'] and len(raw)<=remaining,'same parent snapshot allocation')
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600);primary=None
    try:
        for offset in range(0,len(raw),LIMITS['rangeBytes']):
            check();block=raw[offset:offset+LIMITS['rangeBytes']];written=0
            while written<len(block):check();amount=os.write(fd,block[written:]);need(amount>0,'snapshot write progress');written+=amount
        os.fsync(fd)
    except BaseException as failure:primary=failure;raise
    finally:
        try:os.close(fd)
        except BaseException:
            if primary is None:raise
    return len(raw)

"""Supervised fixed child: stopped-volume originals -> bounded sharded context.

Never extracts candidate tar on the controller. Docker daemon/kernel are TCB;
all output shards are actual bytes supplied later to the same linked build.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import resource
import shutil
import sys
import tarfile
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
outer=load('sdk-readonly-executor');binary=load('sdk-debian-binary-originals');LIMITS=binary.LIMITS

def need(value,why):
    if not value:raise ValueError('Readonly result context: '+why)

def bound_docker_raw():
    # Applied only to the Docker CLI grandchild, never the context writer.
    # stdout tar pipes are bounded by CheckedStream; raw regular log files are
    # hard-limited by the kernel before a candidate log storm can spend ledger.
    resource.setrlimit(resource.RLIMIT_FSIZE,(LIMITS['metadataBytes'],resource.getrlimit(resource.RLIMIT_FSIZE)[1]))

class Shards:
    def __init__(self,out,ceiling,check):
        self.out,self.ceiling,self.check=Path(out),ceiling,check;self.total=0;self.refs=[];self.raw=None;self.digest=None;self.count=0
    def write(self,data):
        self.check();need(self.total+len(data)<=self.ceiling,'same retained ledger exhausted before write');at=0
        while at<len(data):
            self.check()
            if self.raw is None:
                need(len(self.refs)<LIMITS['sourceMaterialFiles'],'context shard count');self.name='result-context.%04d.tarstream'%len(self.refs);self.raw=(self.out/self.name).open('xb');self.digest=hashlib.sha256();self.count=0
            size=min(65536,len(data)-at,LIMITS['shardBytes']-self.count);chunk=data[at:at+size];need(shutil.disk_usage(self.out).free-len(chunk)>=LIMITS['freeFloorBytes'],'controller disk floor before context write');self.raw.write(chunk);self.digest.update(chunk);self.total+=size;self.count+=size;at+=size
            if self.count==LIMITS['shardBytes']:self.close_part()
        return len(data)
    def close_part(self):
        if self.raw:
            self.raw.flush();os.fsync(self.raw.fileno());self.raw.close();self.refs.append(dict(path=self.name,bytes=self.count,sha256=self.digest.hexdigest()));self.raw=None
    def close(self):self.close_part()

class CheckedStream:
    def __init__(self,raw,check):self.raw,self.check=raw,check;self.count=0;self.sha=hashlib.sha256()
    def read(self,size):
        self.check();need(type(size) is int and 0<=size<=65536,'bounded actual tar stream read');data=self.raw.read(size);self.count+=len(data);need(self.count<=LIMITS['sourceMaterialBytes'],'source stream bound');self.sha.update(data);return data

def copy_tar(raw,archive,domain,check,seen):
    stream=CheckedStream(raw,check);guard=binary.TarHeaderGuard(stream,{'bytes':0,'members':0},check,metadata_members=LIMITS['sourceMembers'])
    with tarfile.open(fileobj=guard,mode='r|',bufsize=65536) as source:
        for member in source:
            check();parts=PurePosixPath(member.name).parts;need(parts and parts[0]==domain and not member.name.startswith('/') and all(p not in ('','..','.') for p in parts),'exact exported volume member path')
            need(member.name not in seen and len(seen)<LIMITS['sourceMembers'],'unique bounded exported member set');seen.add(member.name)
            need(member.isdir() or member.isfile() or member.issym(),'no device/fifo/hardlink in compiled context')
            if member.issym():need(len(member.linkname.encode())<=4096 and '\x00' not in member.linkname,'bounded literal symlink')
            member.pax_headers={};archive.addfile(member,source.extractfile(member) if member.isfile() else None)
    # tarfile stops at first EOF; read the entire actual Docker stream and reject
    # nonzero trailing material. No hidden second archive is silently discarded.
    while True:
        chunk=guard.read(65536)
        if not chunk:break
        need(not any(chunk),'nonzero trailing exported tar')
    return dict(bytes=stream.count,sha256=stream.sha.hexdigest())

VERIFICATION_SCRIPTS=('check-qlever-real-adapter-build.cjs','check-qlever-real-runtime.cjs','check-qlever-upstream-patches.cjs')

def verification_originals(context_originals,source_sha,check):
    """Read only the three exact immutable Git-context members; no extraction.
    Same retained tar, full SHA, guarded headers, same deadline and 4MiB buffers.
    """
    check();need(isinstance(source_sha,str) and outer.binding.re.fullmatch('[a-f0-9]{40}',source_sha),'same immutable verification source SHA')
    context_path=Path(context_originals);raw=outer.bounded_original(context_path,LIMITS['metadataBytes'],check);context=json.loads(raw)
    need(context.get('schemaVersion')==1 and context.get('sourceSha')==source_sha and isinstance(context.get('files'),list) and len(context['files'])<=LIMITS['sourceMembers'],'same bounded source context metadata')
    archive_ref=context.get('archive');need(isinstance(archive_ref,dict) and archive_ref.get('path')=='context.original.tar' and type(archive_ref.get('bytes')) is int and 0<archive_ref['bytes']<=LIMITS['shardBytes'] and outer.binding.re.fullmatch('[a-f0-9]{64}',archive_ref.get('sha256','')),'exact immutable source tar reference')
    targets={}
    for name in VERIFICATION_SCRIPTS:
        source='qlever/scripts/'+name;rows=[row for row in context['files'] if isinstance(row,dict) and isinstance(row.get('file'),dict) and row['file'].get('path')==source]
        need(len(rows)==1 and type(rows[0].get('mode')) is int and 0<=rows[0]['mode']<=0o7777 and type(rows[0]['file'].get('bytes')) is int and 0<rows[0]['file']['bytes']<=LIMITS['metadataBytes'] and outer.binding.re.fullmatch('[a-f0-9]{64}',rows[0]['file'].get('sha256','')),'unique fixed verification original')
        targets[source]=rows[0]
    need(sum(row['file']['bytes'] for row in targets.values())<=LIMITS['metadataBytes'],'aggregate verification original memory bound')
    path=context_path.parent/'context.original.tar';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    def identity(value):return (value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
    found={}
    try:
        before=os.fstat(fd);need(outer.stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size==archive_ref['bytes'] and identity(before)==identity(path.lstat()),'same held immutable source tar')
        with os.fdopen(os.dup(fd),'rb') as original:
            stream=CheckedStream(original,check);guard=binary.TarHeaderGuard(stream,{'bytes':0,'members':0},check,metadata_members=LIMITS['sourceMembers'])
            with tarfile.open(fileobj=guard,mode='r|',bufsize=65536) as archive:
                for member in archive:
                    check()
                    if member.name not in targets:continue
                    row=targets[member.name];ref=row['file'];need(member.name not in found and member.isfile() and member.size==ref['bytes'] and member.mode==row['mode'],'one regular immutable verification member')
                    parts=[];count=0;digest=hashlib.sha256();source=archive.extractfile(member)
                    while count<member.size:
                        check();data=source.read(min(65536,member.size-count));need(data,'complete verification source bytes');parts.append(data);count+=len(data);digest.update(data)
                    need(digest.hexdigest()==ref['sha256'],'verification original full SHA');found[member.name]=b''.join(parts)
            while True:
                block=guard.read(65536)
                if not block:break
                need(not any(block),'immutable source tar trailing material')
            need(stream.count==archive_ref['bytes'] and stream.sha.hexdigest()==archive_ref['sha256'],'complete immutable context tar SHA')
        check();need(identity(before)==identity(os.fstat(fd))==identity(path.lstat()) and set(found)==set(targets),'verification source custody/closure changed')
    finally:os.close(fd)
    return [(name,found['qlever/scripts/'+name]) for name in VERIFICATION_SCRIPTS]


def export(cid,out,deadline,ceiling,dockerfile,source_context=None,source_sha=None):
    need(outer.binding.re.fullmatch('[a-f0-9]{64}',cid) is not None,'fixed stopped container ID');need(type(ceiling) is int and 0<ceiling<=LIMITS['sourceMaterialBytes'],'parent remaining retained ceiling');budget=outer.budgets.ExecutionBudget(deadline);check=lambda:budget.check(30)
    verification=verification_originals(source_context,source_sha,check) if source_context is not None else []
    out=Path(out);out.mkdir(exist_ok=False);writer=Shards(out,ceiling,check);seen=set();streams={}
    try:
        with tarfile.open(fileobj=writer,mode='w|',format=tarfile.PAX_FORMAT,bufsize=65536) as archive:
            info=tarfile.TarInfo('Dockerfile');info.size=len(dockerfile);info.mode=0o444;archive.addfile(info,io.BytesIO(dockerfile))
            for name,data in verification:
                check();info=tarfile.TarInfo('verification/'+name);info.size=len(data);info.mode=0o444;archive.addfile(info,io.BytesIO(data));seen.add(info.name)
            for domain in ['build','materials']:
                check();command=outer.binding.local_docker(['docker','cp',cid+':/opt/qlever-sdk/'+domain,'-']);child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=sys.stderr,preexec_fn=bound_docker_raw)
                try:
                    streams[domain]=copy_tar(child.stdout,archive,domain,check,seen);child.stdout.close();need(child.wait(timeout=budget.timeout(30,30))==0,'actual Docker volume export exit')
                finally:
                    if child.poll() is None:child.kill();child.wait()
    finally:writer.close()
    result=dict(schemaVersion=1,containerId=cid,context=writer.refs,encodedBytes=writer.total,sourceStreams=streams,members=len(seen),noHostExtraction=True)
    data=(json.dumps(result,sort_keys=True)+'\n').encode();need(len(data)<=LIMITS['metadataBytes'] and writer.total+len(data)<=ceiling,'context metadata shared retained ledger');(out/'result-context.json').write_bytes(data);return result

def copy_inner_stream(raw,destination,check,ceiling):
    """Same guarded tar semantics, one actual regular-file copy, no symlinks.
    Runtime build-context shards stay outside this source artifact domain.
    """
    need(type(ceiling) is int and 0<=ceiling<=LIMITS['sourceMaterialBytes'],'same parent inner remaining ceiling')
    destination=Path(destination);destination.mkdir(mode=0o700,exist_ok=False);total=0;files=[]
    class Inner:
        def addfile(self,member,stream):
            nonlocal total
            check();need(member.isdir() or member.isfile(),'only retained regular SDK originals')
            parts=PurePosixPath(member.name).parts;relative=Path(*parts[1:]);path=destination/relative
            if member.isdir():path.mkdir(mode=0o700,parents=True,exist_ok=True);return
            need(parts[1:] and member.size<=LIMITS['shardBytes'] and (not path.name.endswith('.json') or member.size<=LIMITS['metadataBytes']),'bounded SDK member/metadata original')
            need(total+member.size<=ceiling,'remaining source ledger before opening member');path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);digest=hashlib.sha256();count=0
            with path.open('xb') as output:
                while count<member.size:
                    check();chunk=stream.read(min(65536,member.size-count));need(chunk,'truncated SDK inner original')
                    need(total+len(chunk)<=ceiling,'remaining source ledger before write');need(shutil.disk_usage(destination).free-len(chunk)>=LIMITS['freeFloorBytes'],'controller disk floor before inner write');output.write(chunk);digest.update(chunk);count+=len(chunk);total+=len(chunk)
                output.flush();os.fsync(output.fileno())
            need(count==member.size,'complete actual SDK original');files.append(dict(path='inner/'+relative.as_posix(),bytes=count,sha256=digest.hexdigest()))
    actual=copy_tar(raw,Inner(),'materials',check,set());return dict(sourceStream=actual,bytes=total,files=files)

def build_from_shards(plan,context,deadline,builder,platform,metadata,identity):
    budget=outer.budgets.ExecutionBudget(deadline);check=lambda:budget.check(30)
    command=outer.binding.local_docker(['docker','buildx','build','--builder',builder,'--platform',platform,'--progress','rawjson','--load','--no-cache-filter','linked-verification','--metadata-file',metadata,'--build-arg','XPOD_QLEVER_SDK_DEADLINE_UNIX='+str(deadline),'--build-arg','XPOD_QLEVER_SDK_IDENTITY='+json.dumps(identity,sort_keys=True,separators=(',',':')),'-'])
    child=subprocess.Popen(command,stdin=subprocess.PIPE,preexec_fn=bound_docker_raw)
    try:
        for ref in plan['context']:
            check();path=Path(context)/ref['path'];need(outer.binding.re.fullmatch(r'result-context\.[0-9]{4}\.tarstream',ref['path']) is not None,'fixed context shard name')
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            def ident(v):return (v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
            try:
                first=os.fstat(fd);need(outer.stat.S_ISREG(first.st_mode) and first.st_nlink==1 and first.st_size==ref['bytes'] and 0<first.st_size<=LIMITS['shardBytes'],'bounded exact context shard identity');sha=hashlib.sha256();count=0
                while True:
                    check();chunk=os.read(fd,min(65536,first.st_size+1-count))
                    if not chunk:break
                    count+=len(chunk);need(count<=first.st_size,'context shard grew');sha.update(chunk);child.stdin.write(chunk)
                need(count==first.st_size and sha.hexdigest()==ref['sha256'] and ident(first)==ident(os.fstat(fd))==ident(path.lstat()),'sameFD complete exported shard bytes changed')
            finally:os.close(fd)
        child.stdin.close();need(child.wait(timeout=budget.timeout(19800,30))==0,'actual linked build exit')
    finally:
        if child.poll() is None:child.kill();child.wait()

def cleanup_builder(plan,budget):
    builder=plan['builder'];need(outer.binding.re.fullmatch('[A-Za-z0-9_-]{1,100}',builder) is not None,'owned builder cleanup')
    def names(role):
        child=subprocess.Popen(outer.binding.local_docker(['docker','buildx','ls','--format','{{json .Name}}']),stdout=subprocess.PIPE,preexec_fn=bound_docker_raw);data=bytearray()
        try:
            while True:
                budget.check();part=child.stdout.read(min(65536,LIMITS['metadataBytes']+1-len(data)))
                if not part:break
                data.extend(part);need(len(data)<=LIMITS['metadataBytes'],'bounded actual cleanup builder list')
            need(child.wait(timeout=budget.timeout(10))==0,'actual cleanup builder listing failed')
        finally:
            child.stdout.close()
            if child.poll() is None:child.kill();child.wait()
        path=Path(plan['originals'])/('cleanup-builders-'+role+'.original.jsonlines')
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        return [json.loads(line) for line in data.splitlines()]
    before=names('before')
    if builder in before:
        child=subprocess.Popen(outer.binding.local_docker(['docker','buildx','rm',builder]),preexec_fn=bound_docker_raw)
        try:need(child.wait(timeout=budget.timeout(10))==0,'actual owned builder cleanup exit')
        finally:
            if child.poll() is None:child.kill();child.wait()
    need(builder not in names('after'),'owned builder still present after cleanup')

def final_image_copy(mode,plan,budget):
    config=plan['imageConfig'];need(outer.binding.digest(config),'actual linked image config')
    if mode=='image-copy-create':command=['docker','create','--read-only','--network','none','--cap-drop','ALL','--entrypoint','/bin/true',config]
    else:
        cid=plan['containerId'];need(outer.binding.re.fullmatch('[a-f0-9]{64}',cid) is not None,'actual retained image container')
        command=['docker','container','inspect','--format','{{json .State.Running}}',cid] if mode=='image-copy-inspect' else ['docker','rm',cid]
    child=subprocess.Popen(outer.binding.local_docker(command),preexec_fn=bound_docker_raw)
    try:need(child.wait(timeout=budget.timeout(30))==0,'actual final image copy owner command')
    finally:
        if child.poll() is None:child.kill();child.wait()

def copy_final_inner(plan,budget):
    cid=plan['containerId'];need(outer.binding.re.fullmatch('[a-f0-9]{64}',cid) is not None,'actual stopped final image container')
    child=subprocess.Popen(outer.binding.local_docker(['docker','cp',cid+':/opt/qlever-sdk/materials','-']),stdout=subprocess.PIPE,stderr=sys.stderr,preexec_fn=bound_docker_raw)
    try:
        result=copy_inner_stream(child.stdout,plan['destination'],lambda:budget.check(30),plan['remainingRetainedBytes']-LIMITS['metadataBytes'])
        child.stdout.close();need(child.wait(timeout=budget.timeout(30,30))==0,'actual final inner copy wait');data=(json.dumps(result,sort_keys=True)+'\n').encode();need(len(data)<=LIMITS['metadataBytes'],'bounded inner copy manifest')
        with Path(plan['manifest']).open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
    finally:
        if not child.stdout.closed:child.stdout.close()
        if child.poll() is None:child.kill();child.wait()

def dispatch(mode,plan):
    budget=outer.budgets.ExecutionBudget(plan['deadlineUnix']);budget.check(0 if mode in ['remove-builder','image-copy-remove'] else 30)
    if mode=='export':return export(plan['containerId'],plan['context'],plan['deadlineUnix'],plan['remainingRetainedBytes'],plan['dockerfile'].encode(),plan.get('sourceContextOriginals'),plan.get('sourceSha'))
    if mode=='build':
        need(outer.binding.re.fullmatch('[A-Za-z0-9_-]{1,100}',plan['builder']) is not None and plan['platform'] in ['linux/amd64','linux/arm64'],'fixed owned builder/platform')
        return build_from_shards(plan['export'],plan['context'],plan['deadlineUnix'],plan['builder'],plan['platform'],plan['metadata'],plan['identity'])
    if mode=='copy-final-inner':return copy_final_inner(plan,budget)
    if mode in ['image-copy-create','image-copy-inspect','image-copy-remove']:return final_image_copy(mode,plan,budget)
    need(mode=='remove-builder','fixed normal child mode');return cleanup_builder(plan,budget)

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['export','build','remove-builder','copy-final-inner','image-copy-create','image-copy-inspect','image-copy-remove']);parser.add_argument('--plan',required=True);args=parser.parse_args()
    plan=json.loads(outer.bounded_original(args.plan,LIMITS['metadataBytes'],lambda:None));dispatch(args.mode,plan)

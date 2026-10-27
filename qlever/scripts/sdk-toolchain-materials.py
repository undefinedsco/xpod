"""Single observer producer adapter. Originals describe facts, never admission."""
import stat
import base64
import hashlib
import sys
import importlib.util
import json
import os
import stat
from pathlib import Path
import time

HERE=Path(__file__).resolve().parent
METADATA=4*1024**2
LIMIT=4*1024**3
CONTEXT_RESERVE=512*1024**2

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
commands=load('execution_commands','sdk-command-materials.py')
raw_records=load('execution_raw_records','sdk-execution-originals-util.py')
wire_reader=load('execution_wire_reader','sdk-raw-wire-reader.py')

def write(path,value):
    data=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
    if len(data)>METADATA:raise ValueError('Execution metadata exceeds canonical bound')
    with Path(path).open('xb') as stream:stream.write(data)

def remaining_source_bytes(out,limit=LIMIT-CONTEXT_RESERVE):
    total=0
    for path in Path(out).rglob('*'):
        if path.is_symlink():raise ValueError('Source material originals must not be symlinks')
        if path.is_file():total+=path.stat().st_size
    if total>limit:raise ValueError('Existing source originals exceed remaining shared budget')
    return limit-total


def failure_diagnostic(result,out,directory,check):
    """Closed retained originals only; fixed metadata, never a success receipt."""
    out=Path(out).resolve(strict=True);directory=Path(directory).resolve(strict=True)
    directory.relative_to(out);tracking=result['trackingReceipt'];command=result['commandReceipt']
    identity=lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
    parents={};images={};nonzero={};refs=[];tail=b'';total=0;logical_total=0;raw_decoder=raw_records.RawRecordDecoder()
    def scan(path,expected,parse=False,keep_tail=False):
        nonlocal total,tail,logical_total
        check();path=Path(path);path=path.parent.resolve(strict=True)/path.name;path.relative_to(out)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            before=os.fstat(fd);size=0;digest=hashlib.sha256()
            if not stat.S_ISREG(before.st_mode) or before.st_size>LIMIT:raise ValueError('bounded regular failure original required')
            def blocks():
                nonlocal size,total,tail
                while True:
                    check();block=os.read(fd,65536)
                    if not block:break
                    size+=len(block);total+=len(block)
                    if size>before.st_size or total>LIMIT:raise ValueError('failure original aggregate bound')
                    digest.update(block)
                    if keep_tail:tail=(tail+block)[-32768:]
                    yield block
            rows=wire_reader.iter_shard_records(blocks(),expected,check=check,maximum_encoded=LIMIT,maximum_logical=LIMIT) if parse else blocks()
            for raw in rows:
                logical_total+=len(raw)
                if logical_total>LIMIT:raise ValueError('failure logical original aggregate bound')
                if not parse:continue
                row=raw_decoder.feed(raw)
                if row is None:continue
                if row.get('kind')=='actual-child-binding':
                    if len(parents)>=250000:raise ValueError('failure process inventory bound')
                    parents[row['childPid']]=row['parentPid']
                if row.get('kind')=='actual-wait-exit':
                    if row.get('actualExecImage') is not None:images[row['pid']]=row['actualExecImage']
                    if row['returnCode']!=0:
                        if len(nonzero)>=250000:raise ValueError('failure wait inventory bound')
                        nonzero[row['pid']]=dict(pid=row['pid'],returnCode=row['returnCode'],sequence=row['sequence'])
            if identity(before)!=identity(os.fstat(fd)) or identity(before)!=identity(path.lstat()):raise ValueError('failure original changed')
            actual=dict(path=str(path.relative_to(out)),bytes=size,sha256=digest.hexdigest())
            if (actual['bytes'],actual['sha256'])!=(expected['bytes'],expected['sha256']):raise ValueError('failure original reference differs')
            return actual
        finally:os.close(fd)
    refs.append(scan(directory/'stdout.raw',command['stdout']))
    stderr=scan(directory/'stderr.raw',command['stderr'],keep_tail=True);refs.append(stderr)
    shards=result['rawTraceShards']
    if len(shards)>32:raise ValueError('failure raw shard count bound')
    for row in shards:refs.append(scan(row['path'],row,parse=True))
    raw_decoder.finish()
    failures=[]
    for pid,row in sorted(nonzero.items())[:8]:
        chain=[];seen=set();current=pid
        while current and current not in seen and len(chain)<8:
            seen.add(current);entry=dict(pid=current,parentPid=parents.get(current),actualExecImage=images.get(current));chain.append(entry);current=parents.get(current)
        failures.append(dict(row,actualImageParentChain=chain,chainTruncated=bool(current)))
    value=dict(schemaVersion=1,kind='sdk-observer-failed-phase-diagnostic',actualRootPid=tracking['actualRootPid'],actualRootReturnCode=tracking['actualRootReturnCode'],actualTrackedWait=tracking['actualTrackedWait'],trackedProcessesClosed=tracking['trackedProcessesClosed'],scope='actual closed wait/image-parent chain only; no inferred argv/tool identity or successful SDK admission',nonzeroWaitCount=len(nonzero),nonzeroWaits=failures,nonzeroWaitsTruncated=len(nonzero)>len(failures),originals=refs,stderrExcerpt=dict(original=stderr,offset=stderr['bytes']-len(tail),bytes=len(tail),encoding='base64',data=base64.b64encode(tail).decode('ascii')))
    # Path/image data are fixed metadata. Shrink samples rather than ever print
    # environment or arbitrary argv to compensate for a large diagnostic.
    while len(json.dumps(value,sort_keys=True).encode())>65500 and value['nonzeroWaits']:
        value['nonzeroWaits'].pop();value['nonzeroWaitsTruncated']=True
    if len(json.dumps(value,sort_keys=True).encode())>65500:raise ValueError('failure diagnostic encoded bound')
    return value

# Failure-only originals, never successful compilation/source authority. Paths
# are a closed list: the nested actual CMake command owns the first three.
CMAKE_FAILURE_PATHS=(('materials','generation/configure/command.receipt.json'),('materials','generation/configure/stdout.raw'),('materials','generation/configure/stderr.raw'),('build','CMakeFiles/CMakeError.log'),('build','CMakeFiles/CMakeOutput.log'),('build','CMakeFiles/CMakeConfigureLog.yaml'))
CMAKE_FAILURE_PHASE_STREAMS=('stdout.raw','stderr.raw')
CMAKE_FAILURE_SOURCE_LIMIT=4*1024**2
CMAKE_FAILURE_RETAIN_LIMIT=256*1024

def cmake_failure_originals(out,build,directory,check,remaining_bytes):
    """Read only fixed failed-phase logs, holding every parent without links.

    The six fixed CMake/generation paths are followed by the failed phase's own
    closed stdout/stderr, so a timed-out compile keeps the bytes it actually
    produced. Large-but-bounded sources retain a labelled tail, not a fictitious
    complete original. Both source and retained bytes are hashed. No trace/ENV
    scan, no arbitrary glob, and no build-tree walk.
    """
    check();out=Path(os.path.abspath(out));build=Path(os.path.abspath(build));directory=Path(os.path.abspath(directory))
    if directory not in (out/'stages/configure',out/'stages/compile'):raise ValueError('fixed failed observer phase directory required')
    ident=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
    obj=lambda value:(value.st_dev,value.st_ino,value.st_mode)
    held=[];bindings=[]
    def close_all():
        primary=sys.exc_info()[1];error=None
        for fd in reversed(held):
            try:os.close(fd)
            except BaseException as value:
                if error is None:error=value
        if error is not None and primary is None:raise error
    def directory_fd(path):
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC);held.append(fd)
        for part in path.parts[1:]:
            check();parent=fd;fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent);held.append(fd);bindings.append((parent,part,fd,obj(os.fstat(fd))))
        return fd
    def stable_directories():
        for parent,name,fd,initial in bindings:
            check()
            if initial!=obj(os.fstat(fd)) or initial!=obj(os.stat(name,dir_fd=parent,follow_symlinks=False)):raise ValueError('failure log directory identity changed')
    rows=[];payloads=[];charged=0;destination=None
    try:
        roots={}
        for domain,path in [('materials',out),('build',build)]:
            try:roots[domain]=directory_fd(path)
            except FileNotFoundError:roots[domain]=None
        stage_fd=directory_fd(directory)
        # Append only the actual failed phase's closed stdout/stderr inputs after
        # the fixed six; a configure run and a compile run never select each
        # other's stream. Ordinals 1..6 above remain unchanged.
        paths=(*CMAKE_FAILURE_PATHS,*(('materials',str(Path('stages')/directory.name/name)) for name in CMAKE_FAILURE_PHASE_STREAMS))
        for ordinal,(domain,relative) in enumerate(paths,1):
            check();base=dict(sourceDomain=domain,sourceRelativePath=relative)
            if roots[domain] is None:rows.append(dict(base,status='missing'));continue
            fd=None
            try:
                parent=roots[domain]
                for part in Path(relative).parts[:-1]:
                    previous=parent;parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent);held.append(parent);bindings.append((previous,part,parent,obj(os.fstat(parent))))
                name=Path(relative).name
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent);held.append(fd)
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:raise ValueError('single regular failure log required')
                if before.st_size>CMAKE_FAILURE_SOURCE_LIMIT:
                    rows.append(dict(base,status='source-byte-bound',sourceBytes=before.st_size));continue
                amount=min(before.st_size,CMAKE_FAILURE_RETAIN_LIMIT)
                # Reserve metadata too, before the first body read or write.
                if type(remaining_bytes()) is not int or remaining_bytes()<amount+65536:
                    rows.append(dict(base,status='retained-byte-budget',sourceBytes=before.st_size));continue
                digest=hashlib.sha256();tail=b'';observed=0
                while True:
                    check();block=os.read(fd,min(65536,before.st_size+1-observed))
                    if not block:break
                    observed+=len(block)
                    if observed>before.st_size:raise ValueError('failure log grew')
                    digest.update(block);tail=(tail+block)[-CMAKE_FAILURE_RETAIN_LIMIT:]
                stable_directories()
                if observed!=before.st_size or ident(before)!=ident(os.fstat(fd)) or ident(before)!=ident(os.stat(name,dir_fd=parent,follow_symlinks=False)):raise ValueError('failure log changed during read')
                if remaining_bytes()<len(tail)+65536:raise ValueError('failure retained budget changed')
                if destination is None:
                    os.mkdir('cmake-failure',mode=0o700,dir_fd=stage_fd);destination=os.open('cmake-failure',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=stage_fd);held.append(destination)
                retained_name=str(ordinal).zfill(2)+'.original.raw';target=os.open(retained_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=destination);held.append(target)
                try:
                    offset=0
                    while offset<len(tail):
                        check();count=os.write(target,tail[offset:offset+65536])
                        if count<=0:raise ValueError('failure original write made no progress')
                        offset+=count
                    os.fsync(target)
                    target_identity=ident(os.fstat(target))
                    if target_identity!=ident(os.stat(retained_name,dir_fd=destination,follow_symlinks=False)):raise ValueError('retained failure original identity changed')
                finally:
                    os.close(target);held.remove(target)
                charged+=len(tail)
                reference=dict(path=str((directory/'cmake-failure'/retained_name).relative_to(out)),bytes=len(tail),sha256=hashlib.sha256(tail).hexdigest())
                row=dict(base,status='retained',sourceIdentity=list(ident(before)),sourceBytes=observed,sourceSha256=digest.hexdigest(),sourceOffset=observed-len(tail),complete=observed==len(tail),original=reference,retainedIdentity=list(target_identity))
                rows.append(row);payloads.append((row,tail))
            except FileNotFoundError:rows.append(dict(base,status='missing'))
            except Exception as error:rows.append(dict(base,status='unavailable',errorType=type(error).__name__))
            finally:
                if fd is not None:
                    os.close(fd);held.remove(fd)
        stable_directories()
        return dict(schemaVersion=1,kind='actual-failed-cmake-fixed-log-originals',phase=directory.name,authorityVerified=False,sourceByteLimit=CMAKE_FAILURE_SOURCE_LIMIT,perOriginalRetainedLimit=CMAKE_FAILURE_RETAIN_LIMIT,retainedBytes=charged,originals=rows),payloads
    finally:close_all()

def emit_cmake_failure_originals(out,build,directory,check,remaining_bytes,result=None):
    """Best effort failure transport; diagnostics cannot replace the cause."""
    try:
        summary,payloads=cmake_failure_originals(out,build,directory,check,remaining_bytes)
        if result is not None:
            tracking=result['trackingReceipt']
            summary['failedPhase']=dict(actualRootPid=tracking['actualRootPid'],actualRootReturnCode=tracking['actualRootReturnCode'],actualTrackedWait=tracking['actualTrackedWait'],trackedProcessesClosed=tracking['trackedProcessesClosed'],commandReceipt=commands.ref(Path(directory)/'command.receipt.json',out),trackingReceipt=commands.ref(Path(directory)/'tracking.receipt.json',out))
        print('SDK_CMAKE_FAILURE_ORIGINALS '+json.dumps(summary,sort_keys=True,separators=(',',':')),file=sys.stderr,flush=True)
        for row,data in payloads:
            for offset in range(0,len(data),32768):
                check();block=data[offset:offset+32768]
                value=dict(schemaVersion=1,kind='actual-failed-cmake-original-chunk',path=row['original']['path'],original=row['original'],offset=offset,bytes=len(block),sha256=hashlib.sha256(block).hexdigest(),encoding='base64',data=base64.b64encode(block).decode('ascii'))
                print('SDK_CMAKE_FAILURE_ORIGINAL_CHUNK '+json.dumps(value,sort_keys=True,separators=(',',':')),file=sys.stderr,flush=True)
    except BaseException as error:
        try:print('SDK_CMAKE_FAILURE_ORIGINALS_UNAVAILABLE '+json.dumps(dict(errorType=type(error).__name__),sort_keys=True),file=sys.stderr,flush=True)
        except BaseException:pass

class Session:
    def __init__(self,out,source,build,budget,check,maximum_bytes,prepared_dependencies=None):
        self.out=Path(out);self.build=Path(build);self.directory=self.out/'toolchain-execution';self.directory.mkdir()
        self.budget=budget;self.phases=[];self.results=[];self.closed=False;self.tool_files=[];self.tool_captures=set()
        backend=load('execution_backend','sdk-ptrace-execution.py')
        dependency_options={}
        if prepared_dependencies is not None:
            collection=self.out/prepared_dependencies['path']
            if collection!=self.out/'fetchcontent/materials.json' or commands.ref(collection,self.out)!=prepared_dependencies:raise ValueError('Actual fixed dependency collection differs')
            with Path('/proc/self/mountinfo').open('rb') as stream:mounts=stream.read(METADATA+1)
            if len(mounts)>min(METADATA,remaining_source_bytes(self.out)):raise ValueError('Dependency provider mountinfo bound')
            mount_path=self.directory/'dependency-provider.mountinfo.raw'
            with mount_path.open('xb') as stream:stream.write(mounts)
            dependency_options['prepared_dependencies']=dict(collection=dict(prepared_dependencies,path=str(collection)),mountinfo=dict(commands.ref(mount_path,self.out),path=str(mount_path)))
        self.observer=backend.SdkExecutionObserver(self.directory,source,build,deadline_monotonic=budget.end,check_budget=check,maximum_bytes=maximum_bytes,maximum_stdio_bytes=commands.RAW_LIMIT,**dependency_options)
    def original_bytes(self):
        # Stage originals live outside the execution directory. Count the unique
        # canonical set, not one directory or repeated collection references.
        paths={path.resolve(strict=True) for path in self.directory.rglob('*') if path.is_file()}
        for stage in self.phases:
            for field in ['receipt','stdout','stderr','trackingReceipt']:
                row=stage[field];path=self.out/row['path']
                if commands.ref(path,self.out)!=row:raise ValueError('Execution stage original changed')
                paths.add(path.resolve(strict=True))
        return sum(path.stat().st_size for path in paths)
    def phase(self,name,argv,inputs,cap,reserve):
        # Inter-phase generation snapshots also consume the same domain. Only
        # tighten the observer's existing ceiling; retain the same live instance.
        available=remaining_source_bytes(self.out)
        self.observer.tighten_remaining(available)
        timeout=self.budget.timeout(cap,reserve)
        for row in inputs:
            if commands.ref(self.out/row['path'],self.out)!=row:raise ValueError('Execution phase input differs')
        directory=self.out/'stages'/name;directory.mkdir(parents=True)
        environment={key:value for key,value in os.environ.items() if key not in ('GH_TOKEN','GITHUB_TOKEN')}
        try:
            result=self.observer.phase(name,argv,min(self.budget.end-reserve,time.monotonic()+timeout),cwd=str(HERE.parent),env=environment,stdoutPath=directory/'stdout.raw',stderrPath=directory/'stderr.raw')
        except BaseException:
            emit_cmake_failure_originals(self.out,self.build,directory,lambda:self.budget.check(30),lambda:remaining_source_bytes(self.out))
            raise
        write(directory/'command.receipt.json',result['commandReceipt']);write(directory/'tracking.receipt.json',result['trackingReceipt'])
        if result['commandReceipt']['exit']!=0 or result['commandReceipt']['signal'] is not None or result['trackingReceipt']['actualTrackedWait'] is not True or result['trackingReceipt']['trackedProcessesClosed'] is not True:
            emit_cmake_failure_originals(self.out,self.build,directory,lambda:self.budget.check(30),lambda:remaining_source_bytes(self.out),result)
            try:
                diagnostic=failure_diagnostic(result,self.out,directory,self.budget.check)
                print('SDK_OBSERVER_PHASE_FAILURE '+json.dumps(diagnostic,sort_keys=True),file=sys.stderr,flush=True)
            except BaseException as error:
                try:print('SDK_OBSERVER_PHASE_FAILURE_UNAVAILABLE '+json.dumps(dict(actualRootPid=result['trackingReceipt'].get('actualRootPid'),actualRootReturnCode=result['trackingReceipt'].get('actualRootReturnCode'),errorType=type(error).__name__),sort_keys=True),file=sys.stderr,flush=True)
                except BaseException:pass
            raise ValueError('Actual observer phase failed or tracked waits incomplete')
        def reference(original):
            actual=commands.ref(original['path'],self.out)
            if any(actual[key]!=original[key] for key in ('bytes','sha256')):raise ValueError('Execution original changed')
            return actual
        traces=[dict(reference(row),**({'wire':row['wire']} if 'wire' in row else {})) for row in result['rawTraceShards']]
        captures=[reference(row) for row in result['captureFiles']]
        snapshots=self.tool_snapshots(name,result['observedToolFiles'],captures,reference)
        for row in inputs:
            if commands.ref(self.out/row['path'],self.out)!=row:raise ValueError('Execution phase input mutated')
        stage=dict(name=name,closureKind='ptrace-tracked-phase-v1',receipt=commands.ref(directory/'command.receipt.json',self.out),stdout=commands.ref(directory/'stdout.raw',self.out),stderr=commands.ref(directory/'stderr.raw',self.out),trackingReceipt=commands.ref(directory/'tracking.receipt.json',self.out),rawTraceShards=traces,inputs=list(inputs),outputs=[])
        self.phases.append(stage);self.results.append(dict(rawTraceShards=traces,captureFiles=captures,toolFileSnapshots=snapshots));return stage
    def tool_snapshots(self,name,rows,captures,reference):
        parent={row['path']:row for row in captures};normalized=[]
        for row in rows:
            identity=row['identity'];mode=row['actualMode'];original=reference(row['original'])
            if (row['phase']!=name or row['sourceKind']!='actual-tool-file-fd-snapshot' or row['role']!='observed-tool-file'
                    or row['rawEventKind']!='toolchain-original' or type(row['captureSequence']) is not int or row['captureSequence']<=0
                    or not isinstance(row['actualOriginalPath'],str) or not row['actualOriginalPath'].startswith('/') or '\0' in row['actualOriginalPath']
                    or not isinstance(identity,list) or len(identity)!=6 or any(type(value) is not int for value in identity)
                    or type(mode) is not int or mode!=identity[2] or not stat.S_ISREG(mode) or identity[3]!=original['bytes']):
                raise ValueError('Observed tool snapshot phase/identity binding differs')
            if parent.get(original['path'])!=original:raise ValueError('Observed tool snapshot lacks same-phase parent capture')
            if original['path'] in self.tool_captures:raise ValueError('Observed tool snapshot repeated across phases')
            self.tool_captures.add(original['path']);normalized.append(dict(row,original=original))
        indexes=[];batch=[]
        def flush():
            target=self.directory/(name+'-tools-'+str(len(indexes)).zfill(4)+'.json')
            value=dict(schemaVersion=1,rows=batch)
            encoded=len((json.dumps(value,sort_keys=True,indent=2)+'\n').encode())
            if encoded>remaining_source_bytes(self.out):raise ValueError('Tool index exceeds remaining shared budget')
            write(target,value);indexes.append(commands.ref(target,self.out))
        for row in normalized:
            if batch and len(json.dumps(dict(schemaVersion=1,rows=[*batch,row]),sort_keys=True,indent=2).encode())>METADATA-1024:flush();batch=[]
            batch.append(row)
        if batch:flush()
        self.tool_files.extend(normalized)
        return dict(indexes=indexes,files=len(normalized),bytes=sum(row['original']['bytes'] for row in normalized))
    def after_tool_inputs(self,file_identity):
        matches={};pending=[]
        for row in self.tool_files:
            original=row['actualOriginalPath'];path=Path(original)
            try:
                before=path.lstat()
                identity=lambda item:[item.st_dev,item.st_ino,item.st_mode,item.st_size,item.st_mtime_ns,item.st_ctime_ns]
                if not stat.S_ISREG(before.st_mode) or str(path.resolve(strict=True))!=original:raise ValueError('unnamed or aliased tool path')
                actual=file_identity(path)
                if identity(before)!=row['identity'] or identity(path.lstat())!=row['identity'] or (actual['bytes'],actual['sha256'],actual['mode'])!=(row['original']['bytes'],row['original']['sha256'],row['actualMode']&0o7777):raise ValueError('tool bytes/identity changed')
            except (FileNotFoundError,PermissionError,ValueError):
                pending.append(dict(path=original,reason='observed-tool-file-unavailable-or-changed-before-after-archive'));continue
            matches[original]=dict(identity=row['identity'],bytes=actual['bytes'],sha256=actual['sha256'],mode=actual['mode'])
        return matches,pending
    def tool_input_pending(self,inventory):
        selected={row['originalPath']:row for row in inventory['files']};pending=[]
        for row in self.tool_files:
            actual=selected.get(row['actualOriginalPath'])
            reason=None
            if actual is None:reason='observed-tool-file-missing-from-after-full-shard'
            elif (actual['bytes'],actual['sha256'],actual['mode'])!=(row['original']['bytes'],row['original']['sha256'],row['actualMode']&0o7777):reason='observed-tool-file-differs-from-after-full-shard'
            if reason:pending.append(dict(path=row['actualOriginalPath'],reason=reason))
        return pending
    def close(self):
        self.observer.close();self.closed=True
    def abort(self):
        if not self.closed:self.observer.abort();self.closed=True
    def finalize(self,inner,upstream_reference,inventory):
        observer=[]
        # Preserve the complete fixed backend import graph; same immutable Git
        # sourcePath verification remains the receiver's responsibility.
        for filename in ['sdk-ptrace-execution.py','sdk-ptrace-kernel.py','sdk-execution-originals-util.py','sdk-generation-multiprocess-bindings.py','sdk-blocking-owned-wait.py','sdk-tool-provider-originals.py','sdk-generated-vma-originals.py','sdk-coordinated-wait.py','sdk-original-chunk-store.py','sdk-tool-lifetime-leases.py','sdk-executable-memory-policy.py','sdk-raw-wire-codec.py','sdk-raw-wire-reader.py']:
            path=HERE/filename
            if not path.is_file():raise ValueError('Observer original source missing: '+filename)
            target=self.directory/filename
            with path.open('rb') as source,target.open('xb') as destination:
                while True:
                    self.budget.check();block=source.read(65536)
                    if not block:break
                    destination.write(block)
            observer.append(dict(sourcePath='qlever/scripts/'+filename,file=commands.ref(target,self.out)))
        selected=self.directory/'selected-inputs.json'
        write(selected,dict(schemaVersion=1,files=[dict(originalPath=row['originalPath'],actualInput=row) for row in inventory['files']],unresolvedInputs=inventory['pending']))
        phases=[]
        for stage,result in zip(self.phases,self.results):
            indexes=[];batch=[]
            def flush():
                target=self.directory/(stage['name']+'-captures-'+str(len(indexes)).zfill(4)+'.json');write(target,dict(schemaVersion=1,files=batch));indexes.append(commands.ref(target,self.out))
            for row in result['captureFiles']:
                if batch and len(json.dumps(dict(schemaVersion=1,files=[*batch,row]),indent=2).encode())>METADATA-1024:flush();batch=[]
                batch.append(row)
            if batch:flush()
            phases.append(dict(name=stage['name'],backend=dict(id='ptrace-all-stop-process-v1',observerOriginals=observer,coverage=dict(processModel='all-observed-descendants-single-thread',consumerIo=['read'],unsupported=['CLONE_THREAD','CLONE_FILES','async-io','shared-writable-mmap','generated-input-mmap'])),phaseBinding=stage,rawTraceShards=result['rawTraceShards'],captures=dict(indexes=indexes,files=len(result['captureFiles']),bytes=sum(row['bytes'] for row in result['captureFiles'])),selectedInputs=commands.ref(selected,self.out),toolFileSnapshots=result['toolFileSnapshots']))
        upstream=json.loads((self.out/upstream_reference['path']).read_text())
        mount=self.observer.source_provider_originals['mountinfo']
        mountref=commands.ref(self.directory/mount['path'],self.out)
        collection=dict(schemaVersion=1,kind='qlever-sdk-toolchain-execution-originals',sourceRoot='/opt/qlever-sdk/source',buildRoot='/opt/qlever-sdk/build',deadlineUnix=self.budget.deadline_unix,sourceProviderOriginals=dict(mountinfo=mountref),preparedSource=dict(upstreamInventory=upstream['postpatchInventory'],beforeInputs=inner['inputsBefore'],afterInputs=inner['inputsAfter'],symlinks=inner['symlinkOriginals'],generationMetadata=inner['generationMetadata']),phases=phases)
        target=self.directory/'final-materials.json';write(target,collection)
        total=self.original_bytes()
        if total>LIMIT:raise ValueError('Execution originals exceed shared source bound')
        return commands.ref(target,self.out),total

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
    parents={};images={};nonzero={};refs=[];tail=b'';total=0
    def scan(path,expected,parse=False,keep_tail=False):
        nonlocal total,tail
        check();path=Path(path);path=path.parent.resolve(strict=True)/path.name;path.relative_to(out)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            before=os.fstat(fd);size=0;digest=hashlib.sha256();pending=b''
            if not stat.S_ISREG(before.st_mode) or before.st_size>LIMIT:raise ValueError('bounded regular failure original required')
            while True:
                check();block=os.read(fd,65536)
                if not block:break
                size+=len(block);total+=len(block)
                if size>before.st_size or total>LIMIT:raise ValueError('failure original aggregate bound')
                digest.update(block)
                if keep_tail:tail=(tail+block)[-32768:]
                if parse:
                    pending+=block
                    while b'\n' in pending:
                        line,pending=pending.split(b'\n',1)
                        if len(line)>65535:raise ValueError('failure raw record bound')
                        row=json.loads(line)
                        if row.get('kind')=='actual-child-binding':
                            if len(parents)>=250000:raise ValueError('failure process inventory bound')
                            parents[row['childPid']]=row['parentPid']
                        if row.get('kind')=='actual-wait-exit':
                            if row.get('actualExecImage') is not None:images[row['pid']]=row['actualExecImage']
                            if row['returnCode']!=0:
                                if len(nonzero)>=250000:raise ValueError('failure wait inventory bound')
                                nonzero[row['pid']]=dict(pid=row['pid'],returnCode=row['returnCode'],sequence=row['sequence'])
                    if len(pending)>65536:raise ValueError('failure partial raw record bound')
            if pending:raise ValueError('failure raw incomplete line')
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

class Session:
    def __init__(self,out,source,build,budget,check,maximum_bytes):
        self.out=Path(out);self.directory=self.out/'toolchain-execution';self.directory.mkdir()
        self.budget=budget;self.phases=[];self.results=[];self.closed=False;self.tool_files=[];self.tool_captures=set()
        backend=load('execution_backend','sdk-ptrace-execution.py')
        self.observer=backend.SdkExecutionObserver(self.directory,source,build,deadline_monotonic=budget.end,check_budget=check,maximum_bytes=maximum_bytes,maximum_stdio_bytes=commands.RAW_LIMIT)
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
        result=self.observer.phase(name,argv,min(self.budget.end-reserve,time.monotonic()+timeout),cwd=str(HERE.parent),env=environment,stdoutPath=directory/'stdout.raw',stderrPath=directory/'stderr.raw')
        write(directory/'command.receipt.json',result['commandReceipt']);write(directory/'tracking.receipt.json',result['trackingReceipt'])
        if result['commandReceipt']['exit']!=0 or result['commandReceipt']['signal'] is not None or result['trackingReceipt']['actualTrackedWait'] is not True or result['trackingReceipt']['trackedProcessesClosed'] is not True:
            try:
                diagnostic=failure_diagnostic(result,self.out,directory,self.budget.check)
                print('SDK_OBSERVER_PHASE_FAILURE '+json.dumps(diagnostic,sort_keys=True),file=sys.stderr,flush=True)
            except Exception as error:
                print('SDK_OBSERVER_PHASE_FAILURE_UNAVAILABLE '+json.dumps(dict(actualRootPid=result['trackingReceipt'].get('actualRootPid'),actualRootReturnCode=result['trackingReceipt'].get('actualRootReturnCode'),errorType=type(error).__name__),sort_keys=True),file=sys.stderr,flush=True)
            raise ValueError('Actual observer phase failed or tracked waits incomplete')
        def reference(original):
            actual=commands.ref(original['path'],self.out)
            if any(actual[key]!=original[key] for key in ('bytes','sha256')):raise ValueError('Execution original changed')
            return actual
        traces=[reference(row) for row in result['rawTraceShards']]
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
        for filename in ['sdk-ptrace-execution.py','sdk-ptrace-kernel.py','sdk-execution-originals-util.py','sdk-generation-multiprocess-bindings.py','sdk-blocking-owned-wait.py']:
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

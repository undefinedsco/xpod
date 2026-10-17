"""Single observer producer adapter. Originals describe facts, never admission."""
import importlib.util
import json
import os
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

class Session:
    def __init__(self,out,source,build,budget,check,maximum_bytes):
        self.out=Path(out);self.directory=self.out/'toolchain-execution';self.directory.mkdir()
        self.budget=budget;self.phases=[];self.results=[];self.closed=False
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
            raise ValueError('Actual observer phase failed or tracked waits incomplete')
        def reference(original):
            actual=commands.ref(original['path'],self.out)
            if any(actual[key]!=original[key] for key in ('bytes','sha256')):raise ValueError('Execution original changed')
            return actual
        traces=[reference(row) for row in result['rawTraceShards']]
        captures=[reference(row) for row in result['captureFiles']]
        for row in inputs:
            if commands.ref(self.out/row['path'],self.out)!=row:raise ValueError('Execution phase input mutated')
        stage=dict(name=name,closureKind='ptrace-tracked-phase-v1',receipt=commands.ref(directory/'command.receipt.json',self.out),stdout=commands.ref(directory/'stdout.raw',self.out),stderr=commands.ref(directory/'stderr.raw',self.out),trackingReceipt=commands.ref(directory/'tracking.receipt.json',self.out),rawTraceShards=traces,inputs=list(inputs),outputs=[])
        self.phases.append(stage);self.results.append(dict(rawTraceShards=traces,captureFiles=captures));return stage
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
            phases.append(dict(name=stage['name'],backend=dict(id='ptrace-all-stop-process-v1',observerOriginals=observer,coverage=dict(processModel='all-observed-descendants-single-thread',consumerIo=['read'],unsupported=['CLONE_THREAD','CLONE_FILES','async-io','shared-writable-mmap','generated-input-mmap'])),phaseBinding=stage,rawTraceShards=result['rawTraceShards'],captures=dict(indexes=indexes,files=len(result['captureFiles']),bytes=sum(row['bytes'] for row in result['captureFiles'])),selectedInputs=commands.ref(selected,self.out)))
        upstream=json.loads((self.out/upstream_reference['path']).read_text())
        mount=self.observer.source_provider_originals['mountinfo']
        mountref=commands.ref(self.directory/mount['path'],self.out)
        collection=dict(schemaVersion=1,kind='qlever-sdk-toolchain-execution-originals',sourceRoot='/opt/qlever-sdk/source',buildRoot='/opt/qlever-sdk/build',deadlineUnix=self.budget.deadline_unix,sourceProviderOriginals=dict(mountinfo=mountref),preparedSource=dict(upstreamInventory=upstream['postpatchInventory'],beforeInputs=inner['inputsBefore'],afterInputs=inner['inputsAfter'],symlinks=inner['symlinkOriginals'],generationMetadata=inner['generationMetadata']),phases=phases)
        target=self.directory/'final-materials.json';write(target,collection)
        total=self.original_bytes()
        if total>LIMIT:raise ValueError('Execution originals exceed shared source bound')
        return commands.ref(target,self.out),total

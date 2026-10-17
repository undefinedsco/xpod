"""CMake trace and metadata originals; no generated-input source authority."""
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
commands=load('generation_commands','sdk-command-materials.py')
budgets=load('generation_budget','sdk-execution-budget.py')
MEMBER=512*1024**2
METADATA=4*1024**2
METADATA_NAMES={'build.make','DependInfo.cmake','flags.make','link.txt','Makefile.cmake','cmake.check_cache'}

def write(path,value,check):
    size=0
    with Path(path).open('x') as output:
        for text in json.JSONEncoder(sort_keys=True,ensure_ascii=True).iterencode(value):
            check();size+=len(text)
            if size>METADATA:raise ValueError('CMake metadata byte bound')
            output.write(text)

def configure(out,source,build,argv,check):
    out=Path(out).resolve();source=Path(source).resolve();build=Path(build).resolve()
    if not argv or Path(argv[0]).name!='cmake' or any(arg.startswith('--trace') for arg in argv):
        raise ValueError('Actual CMake argv with producer-owned trace flags required')
    for option,value in [('-S',source),('-B',build)]:
        if argv.count(option)!=1 or argv.index(option)+1>=len(argv) or Path(argv[argv.index(option)+1]).resolve()!=value:
            raise ValueError('Actual CMake source/build binding differs')
    out.mkdir(parents=True,exist_ok=False);directory=out/'configure';directory.mkdir()
    trace=out/'configure.trace.jsonl';actual=[*argv,'--trace-expand','--trace-format=json-v1','--trace-redirect='+str(trace)]
    check()
    # Reuse the existing leaf executor: actual Popen/wait, inherited PGID and closed raw streams.
    # The parent configure stage owns deadline, disk and final process-group closure.
    try:commands.exec_child(actual,directory)
    except SystemExit as result:
        if result.code!=0:raise
    check()
    originals={key:commands.ref(directory/file,out.parent) for key,file in [('receipt','command.receipt.json'),('stdout','stdout.raw'),('stderr','stderr.raw')]}
    receipt=json.loads((directory/'command.receipt.json').read_text())
    if receipt['pgid']!=os.getpgrp() or receipt['exit']!=0 or not receipt['actualWait']:raise ValueError('CMake actual child execution differs')
    for path in [trace,directory/'stdout.raw',directory/'stderr.raw']:
        if path.stat().st_size>MEMBER:raise ValueError('CMake raw original member bound')
    value=dict(schemaVersion=1,kind='qlever-sdk-cmake-configure-originals',sourceRoot=str(source),buildRoot=str(build),
        workingDirectory=os.getcwd(),configureTrace=commands.ref(trace,out.parent),configureCommand=originals,
        scope='Actual parent CMake trace; nested tool exec and IO closure unverified')
    write(out/'configure-materials.json',value,check)
    return value

def metadata_paths(build,check):
    build=Path(build).resolve();required=[build/'CMakeCache.txt',build/'compile_commands.json',build/'CMakeFiles/Makefile.cmake']
    if any(not path.is_file() for path in required):raise ValueError('Actual CMake baseline metadata originals missing')
    result=set()
    def candidate(path):
        resolved=path.resolve(strict=True)
        if not resolved.is_relative_to(build):raise ValueError('CMake metadata escaped build root')
        if not resolved.is_file():raise ValueError('CMake metadata original must be regular')
        result.add(path)
    for path in required:candidate(path)
    if (build/'Makefile').is_file():candidate(build/'Makefile')
    for directory,dirs,names in os.walk(build,followlinks=False):
        check();dirs[:]=[name for name in dirs if name!='.git' and not (Path(directory)/name).is_symlink()]
        for name in names:
            if name not in METADATA_NAMES:continue
            path=Path(directory)/name
            candidate(path)
            if len(result)>10000:raise ValueError('CMake metadata member count bound')
    return result

def snapshot(out,build,phase,archive,identity,check):
    if phase not in ('before','after'):raise ValueError('CMake metadata phase differs')
    out=Path(out);directory=out/'generation'/phase;directory.mkdir(parents=True,exist_ok=False)
    files=metadata_paths(build,check);observed={}
    for path in files:
        check();resolved=path.resolve(strict=True)
        if resolved.stat().st_size>MEMBER:raise ValueError('CMake metadata member bound')
        observed[str(resolved)]=identity(resolved)
    inventory=archive(files,directory/'domains',observed)
    for row in inventory['shards']:row['path']='generation/'+phase+'/'+row['path']
    inventory['observationScope']='after-configure-before-compile' if phase=='before' else 'after-compile'
    write(directory/'inventory.json',inventory,check)
    return commands.ref(directory/'inventory.json',out)

def finalize(out,build,before_metadata,after_metadata,inventory,before,stages,check):
    out=Path(out);build=Path(build).resolve();directory=out/'generation'
    original=directory/'configure-materials.json'
    if original.stat().st_size>METADATA:raise ValueError('CMake configure collection bound')
    value=json.loads(original.read_text());bindings=[stage for stage in stages if stage['name'] in ('configure','compile')]
    if sorted(row['name'] for row in bindings)!=['compile','configure']:raise ValueError('Actual CMake parent phase bindings required')
    selected=[]
    for row in inventory['files']:
        check();path=Path(row['originalPath'])
        if not path.is_relative_to(build):continue
        expected=before.get(str(path))
        selected.append(dict(originalPath=str(path),actualInput=row,beforeObservation=expected,
            reason='before-after-bytes-only; actual-generation-command-and-IO-causality-unverified'))
    write(directory/'selected-inputs.json',dict(schemaVersion=1,files=selected),check)
    value.update(kind='qlever-sdk-cmake-generation-originals',configureOriginals=commands.ref(original,out),beforeMetadata=before_metadata,afterMetadata=after_metadata,
        selectedInputs=commands.ref(directory/'selected-inputs.json',out),actualInputInventory=commands.ref(out/'inputs-after.json',out),
        phaseBindings={row['name']:row for row in bindings},
        pending=['CMake-trace-does-not-prove-child-exec-and-IO-closure','independent-generated-input-causality-unverified'])
    write(directory/'final-materials.json',value,check)
    total=0
    for path in directory.rglob('*'):
        check()
        if path.is_file():
            size=path.stat().st_size
            if size>MEMBER:raise ValueError('CMake original member bound')
            total+=size
    if total>4*1024**3:raise ValueError('CMake generation aggregate bound')
    return commands.ref(directory/'final-materials.json',out),total

if __name__=='__main__':
    if len(sys.argv)<7 or sys.argv[1]!='configure' or sys.argv[5]!='--':raise SystemExit('Private CMake capture protocol required')
    import resource
    # Applies only to this helper and its child; never to the parent shell/runtime image.
    current=resource.getrlimit(resource.RLIMIT_FSIZE)
    limit=MEMBER if current[1]==resource.RLIM_INFINITY else min(MEMBER,current[1])
    resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
    budget=budgets.ExecutionBudget(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX'])
    configure(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]),sys.argv[6:],lambda:budget.check(4200))

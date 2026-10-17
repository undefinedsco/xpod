"""Module SDK build-side originals. Image/origin admission belongs outside Docker."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import tarfile

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('sdk_commands',HERE/'sdk-command-materials.py')
commands=importlib.util.module_from_spec(spec);spec.loader.exec_module(commands)
SDK_TOOLS=(('gcc-12','tool-gcc-12'),('g++-12','tool-gxx-12'),('ld.bfd','tool-ld-bfd'),
           ('ar','tool-ar'),('ranlib','tool-ranlib'),('cmake','tool-cmake'),('make','tool-make'),
           ('python3','tool-python3'),('git','tool-git'))
spec=importlib.util.spec_from_file_location('sdk_tar_budget',HERE/'sdk-tar-budget.py')
tar_budget=importlib.util.module_from_spec(spec);spec.loader.exec_module(tar_budget)
LIMIT=4*1024**3
spec=importlib.util.spec_from_file_location('sdk_budget',HERE/'sdk-execution-budget.py')
budget_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(budget_module)
EXECUTION_BUDGET=None
EXECUTION_RESERVE=600

def check_budget():
    if EXECUTION_BUDGET is not None:EXECUTION_BUDGET.check(EXECUTION_RESERVE)

def initialize_budget(reserve=600):
    global EXECUTION_BUDGET,EXECUTION_RESERVE
    EXECUTION_RESERVE=reserve
    EXECUTION_BUDGET=budget_module.ExecutionBudget(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX'])
    return EXECUTION_BUDGET


def dump(path,value):
    Path(path).write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')

def file_identity(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file():raise ValueError('SDK selected original must be regular')
    with path.open('rb') as stream:
        before=os.fstat(stream.fileno());value=hashlib.sha256();observed=0
        if before.st_size>tar_budget.SHARD_LIMIT:raise ValueError('SDK original exceeds fixed member budget')
        for block in iter(lambda:stream.read(65536),b''):
            check_budget();observed+=len(block)
            if observed>before.st_size:raise ValueError('SDK original grew beyond observed bound')
            value.update(block)
        after=os.fstat(stream.fileno())
    identity=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_mode)
    if identity(before)!=identity(after) or identity(path.lstat())!=identity(after):raise ValueError('SDK original changed while observed')
    return dict(bytes=after.st_size,sha256=value.hexdigest(),mode=after.st_mode&0o7777)

def archive_inputs(files,out,before,compile_outputs=(),metadata_originals=()):
    """Only actual compiler-reported inputs are retained; candidate hashes are not copies."""
    files=tuple(files)
    out=Path(out);out.mkdir(parents=True,exist_ok=False);inventory=[];total=0;pending=[]
    compile_outputs={str(Path(path).resolve(strict=True)) for path in compile_outputs}
    metadata_originals={str(Path(path).resolve(strict=True)) for path in metadata_originals}
    links={}
    for value in files:
        for path in [Path(value),*Path(value).parents]:
            if path.is_symlink():
                target=os.readlink(path);raw=os.fsencode(target)
                links[str(path)]=dict(originalPath=str(path),linkTarget=target,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
    for path in sorted(set(Path(value).resolve(strict=True) for value in files)):
        check_budget()
        actual=file_identity(path);total+=actual['bytes']
        if total>LIMIT:raise ValueError('SDK source domains exceed shared 4GiB budget')
        expected=before.get(str(path))
        if expected is None and str(path) not in compile_outputs and str(path) not in metadata_originals:pending.append(dict(path=str(path),reason='generated-or-unobserved-before-compile'))
        elif expected is not None and expected!=actual:raise ValueError('SDK compiler input differs from before observation')
        inventory.append(dict(originalPath=str(path),archivePath=str(path).lstrip('/'),
                              role='compile-output' if str(path) in compile_outputs else 'installed-metadata' if str(path) in metadata_originals else 'observed-input',**actual))
    # A bounded source shard can be independently retained and rehashed.
    shards=[];batch=[];size=0
    def tar_info(row):
        info=tarfile.TarInfo(row['archivePath']);info.size=row['bytes'];info.mode=row['mode']
        return info
    def write_batch():
        if not batch:return
        target=out/('inputs-'+str(len(shards))+'.tar')
        with tarfile.open(target,'w') as bundle:
            for row in batch:
                check_budget()
                if shutil.disk_usage(out).free-row['bytes']<2*1024**3:raise ValueError('SDK input archive disk floor')
                source=Path(row['originalPath'])
                if file_identity(source)!={key:row[key] for key in ['bytes','sha256','mode']}:raise ValueError('SDK input changed before archive')
                info=tar_info(row)
                with source.open('rb') as stream:bundle.addfile(info,stream)
                if file_identity(source)!={key:row[key] for key in ['bytes','sha256','mode']}:raise ValueError('SDK input changed while archiving')
        if target.stat().st_size>tar_budget.SHARD_LIMIT:raise ValueError('SDK encoded tar exceeds shard byte budget')
        shards.append(commands.ref(target,out.parent))
    for row in inventory:
        encoded=tar_budget.member_bytes(tar_info(row))
        tar_budget.require_fit(encoded)
        if batch and tar_budget.archive_bytes(size+encoded)>tar_budget.SHARD_LIMIT:write_batch();batch=[];size=0
        batch.append(row);size+=encoded
    write_batch()
    return dict(schemaVersion=1,files=inventory,shards=shards,totalBytes=total,symlinkOriginalTargets=list(links.values()),pending=pending)

def dependency_paths(build):
    result=set()
    for depfile in Path(build).rglob('*.o.d'):
        if depfile.stat().st_size>8*1024**2:raise ValueError('SDK dependency record budget')
        text=depfile.read_text().replace('\\\n',' ')
        if ':' not in text:raise ValueError('Malformed actual compiler dependency record')
        for name in shlex.split(text.split(':',1)[1]):
            path=Path(name);result.add(path if path.is_absolute() else Path(build)/path)
    if not result:raise ValueError('Actual compiler dependency originals missing')
    return result

def configure_inputs(build):
    file=Path(build)/'CMakeFiles/Makefile.cmake'
    if not file.is_file():raise ValueError('Actual CMake configure dependency originals missing')
    match=re.search(r'set\(CMAKE_MAKEFILE_DEPENDS\s+(.*?)\n\)',file.read_text(),re.S)
    if not match:raise ValueError('Actual CMake configure dependency layout unsupported')
    result={file}
    for name in shlex.split(match.group(1)):
        path=Path(name);path=path if path.is_absolute() else Path(build)/path
        if not path.is_file():raise ValueError('Recorded CMake input original missing')
        result.add(path)
    return result

spec=importlib.util.spec_from_file_location('sdk_debian_acquisition',HERE/'sdk-debian-source-acquisition.py')
debian_acquisition=importlib.util.module_from_spec(spec);spec.loader.exec_module(debian_acquisition)

spec=importlib.util.spec_from_file_location('sdk_symlinks',HERE/'sdk-symlink-originals.py')
symlinks=importlib.util.module_from_spec(spec);spec.loader.exec_module(symlinks)

spec=importlib.util.spec_from_file_location('sdk_upstream_inner',HERE/'sdk-upstream-source-materials.py')
upstream=importlib.util.module_from_spec(spec);spec.loader.exec_module(upstream)

spec=importlib.util.spec_from_file_location('sdk_generation_inner',HERE/'sdk-generation-materials.py')
generation=importlib.util.module_from_spec(spec);spec.loader.exec_module(generation)

def build_materials(component,source,build,out,jobs):
    component=Path(component);source=Path(source);build=Path(build);out=Path(out);out.mkdir(parents=True,exist_ok=False)
    budget=initialize_budget(4200);stages=[]
    identity=json.loads(os.environ['XPOD_QLEVER_SDK_IDENTITY'])
    if identity.get('sdkProfile')!='module-bookworm-gcc12':raise ValueError('Actual SDK producer identity required')
    def stage(name,command,inputs=(),timeout=30,reserve=4200):
        row=commands.capture(name,command,out,component,inputs,timeout=budget.timeout(timeout,reserve));stages.append(row);return row
    private_key='XPOD_QLEVER_UPSTREAM_MATERIALS_DIR'
    if private_key in os.environ:raise ValueError('Upstream capture directory is owned by the module producer')
    os.environ[private_key]=str(out/'upstream-source')
    try:
        stage('configure',['bash',str(component/'scripts/build-module-runtime-sdk.sh'),'prepare-only'],timeout=1800)
    finally:
        del os.environ[private_key]
    generation_before=generation.snapshot(out,build,'before',archive_inputs,file_identity,check_budget)
    # Candidate roots are observations only, not redistributed SDK contents.
    before_links={};before_bindings={}
    def candidate(path):
        symlinks.observe([path],before_links,check_budget)
        lexical=os.path.abspath(path);resolved=Path(path).resolve(strict=True)
        if lexical!=str(resolved):
            before_bindings[lexical]=dict(resolvedTarget=str(resolved),targetIdentity=symlinks.identity(resolved.stat()))
        return resolved
    candidates=set();compile_commands=json.loads((build/'compile_commands.json').read_text())
    roots={component,source,build,Path('/opt/qlever-sdk/profile')}
    for entry in compile_commands:
        tokens=entry.get('arguments') or shlex.split(entry['command'])
        for index,token in enumerate(tokens):
            value=tokens[index+1] if token in ['-I','-isystem'] and index+1<len(tokens) else token[2:] if token.startswith('-I') else None
            if value:roots.add(Path(value) if Path(value).is_absolute() else Path(entry['directory'])/value)
    # GCC reports its own actual default header search paths; no hardcoded SDK copy.
    row=stage('compiler-search',['g++-12','-E','-x','c++','-v','/dev/null'])
    search=(out/row['stderr']['path']).read_text();inside=False
    for line in search.splitlines():
        if '#include <...> search starts here:' in line:inside=True;continue
        if 'End of search list.' in line:inside=False
        if inside and line.startswith(' '):roots.add(Path(line.strip()))
    for root in sorted(roots):
        if not root.is_dir():continue
        for path in root.rglob('*'):
            check_budget()
            if '.git' in path.parts or '__pycache__' in path.parts or not path.is_file():continue
            candidates.add(candidate(path))
            if len(candidates)>100000:raise ValueError('SDK candidate input count budget')
    candidates.update(candidate(path) for path in configure_inputs(build))
    for name,stage_id in SDK_TOOLS:
        tool=shutil.which(name)
        if not tool:raise ValueError('Actual SDK tool missing: '+name)
        candidates.add(candidate(tool))
        stage(stage_id,[tool,'--version'])
    compiler=stage('compiler-program',['g++-12','-print-prog-name=cc1plus'])
    cc1plus=candidate(Path((out/compiler['stdout']['path']).read_text().strip()));candidates.add(cc1plus)
    link_tokens=shlex.split((build/'CMakeFiles/qlever-server.dir/link.txt').read_text())
    for token in link_tokens:
        path=Path(token)
        if path.is_absolute() and path.is_file() and re.search(r'\.(?:a|so(?:\.[A-Za-z0-9_.+-]+)?)$',token):candidates.add(candidate(path))
    before={};total=0
    for path in sorted(candidates):
        actual=file_identity(path);total+=actual['bytes']
        if total>LIMIT:raise ValueError('SDK candidate observation budget')
        before[str(path)]=actual
    dump(out/'inputs-before.json',before)
    before_ref=commands.ref(out/'inputs-before.json',out)
    symlinks.save(out/'symlinks-before.json',before_links,before_bindings,check_budget)
    before_links_ref=commands.ref(out/'symlinks-before.json',out)
    stage('compile',['bash',str(component/'scripts/build-qlever-runtime-sdk.sh'),'build-prepared'],[before_ref,before_links_ref,generation_before],14400,reserve=4800)
    selected=dependency_paths(build)
    # Preserve original depfiles and actual direct linker inputs as build outputs.
    outputs=set(build.rglob('*.o.d'));selected.update(outputs)
    link=build/'CMakeFiles/qlever-server.dir/link.txt';selected.add(link)
    for token in shlex.split(link.read_text()):
        if re.search(r'\.(?:o|a|so(?:\.[A-Za-z0-9_.+-]+)?)$',token):
            path=Path(token);path=path if path.is_absolute() else build/path
            if path.is_file():
                selected.add(path)
                if path.is_relative_to(build):outputs.add(path)
    selected.update(configure_inputs(build))
    selected.update(path for path in Path('/opt/qlever-sdk/profile').rglob('*') if path.is_file() and not path.is_symlink())
    selected.update(path for path in (component/'scripts').iterdir() if path.is_file() and path.suffix in ['.py','.sh'])
    selected.update([build/'compile_commands.json',build/'CMakeCache.txt',component/'qlever.lock.json'])
    selected.update(Path(shutil.which(name)) for name,_ in SDK_TOOLS)
    selected.add(cc1plus)
    ownership=[];installed=set();metadata_originals=set()
    for original in Path('/var/lib/dpkg/info').glob('*.list'):
        if original.stat().st_size>16*1024**2:raise ValueError('Package ownership original budget')
        members=set(original.read_text().splitlines())
        if any(str(path) in members for path in selected):
            ownership.append(original);selected.add(original);metadata_originals.add(original);installed.add(original.name.removesuffix('.list').split(':')[0])
    for package in sorted(installed):
        copyright=Path('/usr/share/doc')/package/'copyright'
        if copyright.is_file():
            selected.add(copyright);metadata_originals.add(copyright)
    ledger=stage('source-package-identities',['dpkg-query','-W','-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n'])
    grants=[]
    for root in [component,source,build/'_deps']:
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink() and path.name.lower().startswith(('license','copying','notice','copyright')):
                grants.append(path);selected.add(path)
    after_links=symlinks.observe(selected,{},check_budget)
    link_pending=symlinks.compare(before_links,after_links,selected)
    # A new symlink at a previously ordinary input cannot borrow another candidate's bytes.
    after_bindings={}
    for path in selected:
        lexical=os.path.abspath(path)
        if lexical in before_bindings:
            actual=dict(resolvedTarget=str(Path(path).resolve(strict=True)),targetIdentity=symlinks.identity(Path(path).stat()))
            after_bindings[lexical]=actual
            if actual!=before_bindings[lexical]:raise ValueError('SDK selected aliased input identity changed during compile')
        if lexical in before and lexical!=str(Path(path).resolve(strict=True)) and path not in outputs:
            raise ValueError('SDK ordinary input replaced by symlink during compile')
    symlinks.save(out/'symlinks-after.json',after_links,after_bindings,check_budget)
    after_links_ref=commands.ref(out/'symlinks-after.json',out)
    symlink_bytes=before_links_ref['bytes']+after_links_ref['bytes']
    inventory=archive_inputs(selected,out/'domains',before,outputs,metadata_originals)
    inventory['symlinkBeforeOriginals']=before_links_ref
    inventory['symlinkAfterOriginals']=after_links_ref
    inventory['symlinkCausalityPending']=link_pending
    inventory['packageOwnershipOriginals']=[str(path) for path in ownership]
    inventory['sourcePackageIdentityRaw']=ledger['stdout']
    dump(out/'inputs-after.json',inventory)
    generation_after=generation.snapshot(out,build,'after',archive_inputs,file_identity,check_budget)
    generation_ref,generation_bytes=generation.finalize(out,build,generation_before,generation_after,inventory,before,stages,check_budget)
    upstream_ref,upstream_bytes=upstream.finalize(out,source,inventory,stages,check_budget)
    def source_stage(name,argv,cwd):
        row=commands.capture(name,argv,out,cwd,timeout=budget.timeout(900,3600));stages.append(row);return row
    debian_ref,debian_bytes=debian_acquisition.acquire(out,
        [str(Path(path).resolve(strict=True)) for path in selected],
        {path.name.removesuffix('.list'):path.read_bytes() for path in ownership},
        ledger['stdout'],LIMIT-512*1024**2-symlink_bytes-upstream_bytes-generation_bytes-sum(row['bytes'] for row in inventory['shards']),
        source_stage,commands.ref,check_budget)

    dump(out/'build-inner.json',dict(schemaVersion=1,kind='qlever-linux-sdk-inner-originals',identity=identity,stages=stages,
        executionBudget=dict(deadlineUnix=budget.deadline_unix,remainingSeconds=budget.remaining()),inputsBefore=before_ref,inputsAfter=commands.ref(out/'inputs-after.json',out),domains=inventory['shards'],
        generationMaterials=generation_ref,generationMaterialBytes=generation_bytes,
        generationMetadata=dict(before=generation_before,after=generation_after),
        upstreamSource=upstream_ref,upstreamSourceBytes=upstream_bytes,
        symlinkOriginalBytes=symlink_bytes,symlinkOriginals=dict(before=before_links_ref,after=after_links_ref),
        grantOriginals=[str(path) for path in grants],debianSources=debian_ref,debianSourceBytes=debian_bytes,
        pending=['official-image-build-artifact-custody-unavailable','Debian-Sources-to-signed-InRelease-checksum-binding-unverified',
                 'toolchain-original-domain-not-yet-complete',*(['symlink-original-unavailable-before-compile'] if link_pending else []),*(['generated-input-causality-unavailable'] if inventory['pending'] else [])]))

def linked_materials(component,source,build,out,jobs):
    budget=initialize_budget()
    out=Path(out);original=commands.ref(out/'build-inner.json',out);stages=[]
    if json.loads((out/'build-inner.json').read_text())['executionBudget']['deadlineUnix']!=budget.deadline_unix:
        raise ValueError('SDK linked stage deadline differs from actual build')
    base=['--qlever-source',source,'--qlever-build-dir',build,'--adapter-build-dir','/tmp/module-real-adapter']
    stages.append(commands.capture('test-adapter',['node',str(Path(component)/'scripts/check-qlever-real-adapter-build.cjs'),*base,'--skip-upstream-configure','--jobs',jobs],out,component,[original],timeout=budget.timeout(1800,2400)))
    stages.append(commands.capture('test-runtime',['node',str(Path(component)/'scripts/check-qlever-real-runtime.cjs'),*base,'--runtime-build-dir','/tmp/module-real-runtime','--skip-prerequisites','--jobs',jobs],out,component,[original],timeout=budget.timeout(1800,600)))
    dump(out/'linked-inner.json',dict(schemaVersion=1,kind='qlever-linux-sdk-linked-originals',executionBudget=dict(deadlineUnix=budget.deadline_unix,remainingSeconds=budget.remaining()),build=original,stages=stages,releaseAccepted=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['build','linked']);args=parser.parse_args()
    values=dict(component='/components/qlever',source='/opt/qlever-sdk/source',build='/opt/qlever-sdk/build',out='/opt/qlever-sdk/materials',jobs=os.environ.get('XPOD_QLEVER_BUILD_JOBS','2'))
    (build_materials if args.phase=='build' else linked_materials)(**values)

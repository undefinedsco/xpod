"""Source/toolchain/loader originals from one actual macOS build; no admission issuer."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/agentfs-native-ci'))
from supervise import run_checked_stage

GIB = 1024 ** 3
SOURCE_BYTES = 512 * 1024 ** 2
SOURCE_MEMBERS = 20000


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(65536), b''): result.update(block)
    return result.hexdigest()


def reference(path, root):
    path, root = Path(path), Path(root)
    if path.is_symlink() or not path.is_file(): raise RuntimeError('Native material must be regular')
    return dict(path=str(path.relative_to(root)), sha256=digest(path), sizeBytes=path.stat().st_size)


def source_link(path, root, relative):
    """Inspect only paths inside root; never open a symlink target's bytes."""
    import stat
    root = Path(root)
    if root.is_symlink() or not root.is_dir() or root.resolve()!=root:
        raise RuntimeError('Native source root changed: '+relative)
    pending = list(Path(relative).parts); resolved = []; visited = set()
    while pending:
        part = pending.pop(0)
        if part in ('', '.'): continue
        if part == '..':
            if not resolved: raise RuntimeError('Native source link escapes root: '+relative)
            resolved.pop(); continue
        candidate = root.joinpath(*resolved, part)
        try: info = candidate.lstat()
        except OSError: raise RuntimeError('Native source link broken: '+relative) from None
        if stat.S_ISLNK(info.st_mode):
            key = tuple(resolved+[part])
            if key in visited or len(visited)>=40: raise RuntimeError('Native source link loop: '+relative)
            visited.add(key); target = os.readlink(candidate)
            if os.path.isabs(target): raise RuntimeError('Native source link absolute target: '+relative)
            pending = list(Path(target).parts)+pending
        else:
            if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
                raise RuntimeError('Native source link nonregular target: '+relative)
            if pending and not stat.S_ISDIR(info.st_mode): raise RuntimeError('Native source link broken: '+relative)
            resolved.append(part)
    info = path.lstat(); target = os.readlink(path); raw = os.fsencode(target)
    return dict(path=relative,type='symlink',linkTarget=target,mode=stat.S_IMODE(info.st_mode),
                sha256=hashlib.sha256(raw).hexdigest(),sizeBytes=len(raw))


def source_kit_inventory(kit_root):
    """Inventory original link objects; never recurse through directory links."""
    kit_root=Path(kit_root).resolve(strict=True)
    files=[]
    for member in sorted(kit_root.rglob('*')):
        relative=member.relative_to(kit_root)
        if member.is_symlink():
            parts=relative.parts
            count=2 if parts[0]=='fetchcontent' else 1
            if parts[0] not in ('engine','workspace','fetchcontent') or len(parts)<=count:
                raise RuntimeError('Invalid native source namespace: '+str(relative))
            namespace_root=kit_root.joinpath(*parts[:count])
            ref=source_link(member,namespace_root,str(member.relative_to(namespace_root)))
            ref['path']=str(relative);files.append(ref)
        elif member.is_file(): files.append(reference(member,kit_root))
        elif not member.is_dir(): raise RuntimeError('Native source nonregular member: '+str(relative))
    return files


def snapshot_sources(roots, destination, tracked=None):
    """Copy real before-build source bytes, preserving their originating layout."""
    destination = Path(destination).resolve()
    result = []; total = 0
    for namespace, root in roots:
        root = Path(root).resolve(strict=True)
        for source in sorted((root / name for name in tracked) if namespace == 'workspace' and tracked is not None else root.rglob('*')):
            relative = source.relative_to(root)
            if any(part in ['.git', '__pycache__', '.test-data', 'node_modules', 'dist'] for part in relative.parts): continue
            if source.is_symlink():
                link = source_link(source,root,str(relative))
                total += link['sizeBytes']
                if total>SOURCE_BYTES or len(result)>=SOURCE_MEMBERS: raise RuntimeError('Native source kit budget exceeded')
                if shutil.disk_usage(destination.parent).free<2*GIB: raise RuntimeError('Native source free-space floor')
                target = destination/namespace/relative; target.parent.mkdir(parents=True,exist_ok=True)
                os.symlink(link['linkTarget'],target)
                if (target.lstat().st_mode & 0o7777)!=link['mode']:
                    if not hasattr(os,'lchmod'): raise RuntimeError('Native source link mode unsupported: '+str(relative))
                    os.lchmod(target,link['mode'])
                identity = source.lstat()
                stored = dict(link,path=str(target.relative_to(destination)))
                result.append(dict(original=str(source),sourceRoot=str(root),sourceRelative=str(relative),
                                   originalIdentity=dict(device=identity.st_dev,inode=identity.st_ino),reference=stored))
                continue
            if source.is_dir(): continue
            if not source.is_file(): raise RuntimeError('Native source nonregular member')
            total += source.stat().st_size
            if total > SOURCE_BYTES or len(result) >= SOURCE_MEMBERS: raise RuntimeError('Native source kit budget exceeded')
            if shutil.disk_usage(destination.parent).free < 2 * GIB: raise RuntimeError('Native source free-space floor')
            target = destination / namespace / relative; target.parent.mkdir(parents=True, exist_ok=True)
            before = digest(source)
            with source.open('rb') as original, target.open('xb') as copied: shutil.copyfileobj(original, copied, 65536)
            row = reference(target, destination)
            if row['sha256'] != before or digest(source) != before: raise RuntimeError('Source changed during snapshot')
            result.append(dict(original=str(source), reference=row))
    for row in result:
        if row['reference'].get('type')=='symlink':
            stored = destination/row['reference']['path']
            namespace_root = destination/Path(row['reference']['path']).parts[0]
            # FetchContent namespaces have two path components.
            if Path(row['reference']['path']).parts[0]=='fetchcontent': namespace_root /= Path(row['reference']['path']).parts[1]
            source_link(stored,namespace_root,str(stored.relative_to(namespace_root)))
    if not result: raise RuntimeError('Native source kit empty')
    return result


def verify_source_snapshot(rows):
    after = []
    for row in rows:
        source = Path(row['original']); expected = row['reference']
        if expected.get('type')=='symlink':
            actual = source_link(source,Path(row['sourceRoot']),row['sourceRelative'])
            actual['path'] = expected['path']
            identity = source.lstat()
            if actual!=expected or dict(device=identity.st_dev,inode=identity.st_ino)!=row['originalIdentity']:
                raise RuntimeError('Native source link changed: '+row['sourceRelative'])
            after.append(actual); continue
        if source.is_symlink() or not source.is_file(): raise RuntimeError('Native input disappeared or became link')
        actual = dict(path=expected['path'], sha256=digest(source), sizeBytes=source.stat().st_size)
        if actual != expected: raise RuntimeError('Native source input changed during build')
        after.append(actual)
    return after


def observe_input_document(document):
    rows = document['files']
    if len(rows) > SOURCE_MEMBERS or sum(row['reference']['sizeBytes'] for row in rows) > SOURCE_BYTES:
        raise RuntimeError('Native observation inventory budget exceeded')
    source_kit = Path(document['sourceKitPath'])
    if digest(source_kit) != document['sourceKitSha256']:
        raise RuntimeError('Native source kit changed')
    before = [row['reference'] for row in rows]
    if json.loads(source_kit.read_text())['files'] != before or len({row['path'] for row in before}) != len(before):
        raise RuntimeError('Native source kit and observation inventories differ')
    return dict(schemaVersion=1,target=document['target'],sourceKitSha256=digest(source_kit),
                helperSha256=digest(document['helperPath']),
                filesBefore=[row['reference'] for row in rows],filesAfter=verify_source_snapshot(rows))


def observe(target, work, archive):
    expected = 'darwin-' + {'arm64':'arm64', 'x86_64':'x64'}.get(platform.machine(), 'unsupported')
    if platform.system() != 'Darwin' or target != expected: raise RuntimeError('Actual same-target macOS worker required')
    archive, work = Path(archive).resolve(), Path(work).resolve()
    materials = archive.parent / 'native-materials'
    if materials.exists(): raise RuntimeError('Fresh native material output required')
    materials.mkdir(parents=True, mode=0o700); stages = materials / 'stages'; stages.mkdir()
    records = []; env = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE='1')
    def stage(name, command, timeout=120):
        receipt, raw = run_checked_stage(name, command, stages, ROOT, timeout=timeout, environment=env,
                                        fresh_bytes=4*GIB, stop_bytes=2*GIB, poll_seconds=.2, target=materials)
        records.append(dict(name=name, receipt=reference(stages / (name+'.receipt.json'), materials), raw=reference(stages / (name+'.raw.log'), materials)))
        return raw.strip()
    source_sha = stage('source-head', ['git','rev-parse','HEAD'])
    if source_sha != os.environ['GITHUB_SHA']: raise RuntimeError('Actual native source/event mismatch')
    if stage('source-clean', ['git','status','--porcelain','--untracked-files=all','--','qlever','.github/workflows/build-qlever-macos-runtime.yml']): raise RuntimeError('Native producer source dirty')
    script = ROOT / 'qlever/scripts/build-macos-local-runtime.sh'
    stage('native-prepare', ['bash',str(script),'prepare-only'], timeout=1800)
    engine = work / 'source'; build = work / 'qlever-build'
    engine_sha = stage('engine-head', ['git','-C',str(engine),'rev-parse','HEAD'])
    lock = json.loads((ROOT / 'qlever/qlever.lock.json').read_text())
    if engine_sha != lock['commit']: raise RuntimeError('Native engine checkout differs from lock')
    stage('engine-patch-diff', ['git','-C',str(engine),'diff','--binary','HEAD'])
    spec = importlib.util.spec_from_file_location('cache_reader', ROOT / 'qlever/scripts/validate-prior-sdk.py')
    cache_reader = importlib.util.module_from_spec(spec); spec.loader.exec_module(cache_reader)
    cache = cache_reader.parse_cache(build / 'CMakeCache.txt')
    compiler = Path(cache['CMAKE_C_COMPILER']).resolve(); cxx = Path(cache['CMAKE_CXX_COMPILER']).resolve()
    linker = Path(stage('linker-path', ['xcrun','--find','ld'])).resolve()
    def toolchain(prefix):
        compiler_version = stage(prefix+'-compiler-version', [str(cxx),'--version'])
        effective_clang = Path(stage(prefix+'-effective-clang-path',['xcrun','--find','clang'])).resolve()
        builtin_headers = stage(prefix+'-compiler-resource-dir',[str(effective_clang),'-print-resource-dir'])
        linker_version = stage(prefix+'-linker-version', [str(linker),'-v'])
        sdk = stage(prefix+'-sdk-path', ['xcrun','--show-sdk-path'])
        sdk_version = stage(prefix+'-sdk-version', ['xcrun','--show-sdk-version'])
        sdk_build = stage(prefix+'-sdk-build', ['xcrun','--show-sdk-build-version'])
        host = stage(prefix+'-host-version', ['sw_vers','-productVersion'])
        brew_raw = stage(prefix+'-brew-dependencies', ['brew','info','--json=v2','boost','icu4c','openssl@3','zstd','jemalloc','pkg-config','sqlite','dylibbundler','ninja','ccache'])
        dependencies = json.loads(brew_raw)
        # Select identity fields; analytics/update counters are not compiler inputs.
        formulas = [dict(name=row['full_name'], versions=row['versions'], installed=row['installed'], license=row.get('license')) for row in dependencies['formulae']]
        settings = Path(sdk) / 'SDKSettings.json'
        return dict(compilerPath=str(compiler), compilerSha256=digest(compiler), cxxPath=str(cxx), cxxSha256=digest(cxx),
                    compilerVersion=compiler_version,effectiveClangPath=str(effective_clang),effectiveClangSha256=digest(effective_clang),
                    compilerBuiltinResourceDirectory=builtin_headers,linkerPath=str(linker), linkerSha256=digest(linker), linkerVersion=linker_version,
                    sdkPath=sdk, sdkVersion=sdk_version, sdkBuild=sdk_build, sdkSettingsSha256=digest(settings),
                    hostVersion=host, minimumOS=cache.get('CMAKE_OSX_DEPLOYMENT_TARGET'), dependencies=formulas)
    before = toolchain('before')
    kit_root = materials / 'source-kit'; kit_root.mkdir()
    tracked = stage('workspace-tracked-inputs', ['git','ls-files','--','qlever']).splitlines()
    roots = [('engine',engine), ('workspace',ROOT)]
    deps = build / '_deps'
    if deps.exists(): roots += [('fetchcontent/'+path.name,path) for path in sorted(deps.iterdir()) if path.is_dir() and path.name.endswith('-src')]
    snapshot = snapshot_sources(roots, kit_root, tracked)
    tool_input = kit_root / 'toolchain-before.json'; tool_input.write_text(json.dumps(before,sort_keys=True,indent=2)+'\n')
    for name in ['compile_commands.json','CMakeCache.txt','CMakeFiles/qlever-server.dir/link.txt']:
        original = build / name; target_file = kit_root / 'compiler-inputs' / Path(name).name
        target_file.parent.mkdir(exist_ok=True); shutil.copyfile(original,target_file)
        snapshot.append(dict(original=str(original),reference=reference(target_file,kit_root)))
    sdk_settings = Path(before['sdkPath'])/'SDKSettings.json'
    settings_copy = kit_root/'compiler-inputs/SDKSettings.json'
    if sdk_settings.is_symlink() or not sdk_settings.is_file(): raise RuntimeError('SDK settings must be a regular original')
    shutil.copyfile(sdk_settings,settings_copy)
    if digest(settings_copy) != before['sdkSettingsSha256']: raise RuntimeError('SDK settings changed before snapshot')
    snapshot.append(dict(original=str(sdk_settings),reference=reference(settings_copy,kit_root)))
    snapshot.append(dict(original=str(tool_input),reference=reference(tool_input,kit_root)))
    snapshot.sort(key=lambda row: row['reference']['path'])
    if len(snapshot)>SOURCE_MEMBERS or sum(row['reference']['sizeBytes'] for row in snapshot)>SOURCE_BYTES:
        raise RuntimeError('Native full source kit budget exceeded')
    source_kit = dict(schemaVersion=1,status='native-source-materials',toolchain=before['compilerVersion'].splitlines()[0],
                      engine=dict(repository=lock['repository'],commit=lock['commit']),
                      files=[row['reference'] for row in snapshot],
                      scope='Actual sources/configuration and observed SDK/compiler identity; external SDK distribution is not copied')
    if source_kit_inventory(kit_root)!=source_kit['files']:
        raise RuntimeError('Native source snapshot differs from kit inventory')
    kit_path = materials/'source-kit.json'
    kit_path.write_text(json.dumps(source_kit,sort_keys=True,indent=2)+'\n')
    observation_before = dict(filesBefore=[row['reference'] for row in snapshot], sourceSha=source_sha, engine=lock, toolchain=before)
    (materials/'inputs-before.json').write_text(json.dumps(observation_before,sort_keys=True,indent=2)+'\n')
    # The canonical source archive preserves links; upload-artifact directory
    # traversal alone must never substitute dereferenced link targets.
    stage('source-kit-archive',['tar','-cf',str(materials/'source-kit.tar'),'-C',str(kit_root),'.'],timeout=300)
    stage('native-build', ['bash',str(script),'build-prepared'], timeout=9000)
    # Re-read actual original source paths in an independently owned process.
    snapshot_path = materials / 'source-snapshot.json'
    snapshot_path.write_text(json.dumps(dict(files=snapshot,target=target,sourceKitPath=str(kit_path),
                             sourceKitSha256=digest(kit_path),helperPath=str(work/'artifact/bin/xpod_qlever_local_runtime')),sort_keys=True)+'\n')
    observed_raw = stage('native-input-observation', [sys.executable,str(Path(__file__).resolve()),'--verify-inputs',str(snapshot_path)])
    observation = json.loads(observed_raw)
    after_files = observation['filesAfter']
    (materials/'input-observation.json').write_text(json.dumps(observation,sort_keys=True,indent=2)+'\n')
    after = toolchain('after')
    if before != after: raise RuntimeError('Actual compiler/SDK/dependency identities changed during native build')
    if stage('engine-commit-after', ['git','-C',str(engine),'rev-parse','HEAD']) != engine_sha:
        raise RuntimeError('Native engine commit changed during build')
    if stage('source-clean-after', ['git','status','--porcelain','--untracked-files=all','--','qlever','.github/workflows/build-qlever-macos-runtime.yml']): raise RuntimeError('Producer source changed')
    local_cache = cache_reader.parse_cache(work/'local-build/CMakeCache.txt')
    for key, actual in [('CMAKE_C_COMPILER',compiler),('CMAKE_CXX_COMPILER',cxx)]:
        if Path(local_cache[key]).resolve() != actual: raise RuntimeError('Local helper compiler differs from observed toolchain')
    if local_cache.get('CMAKE_OSX_DEPLOYMENT_TARGET') != before['minimumOS']:
        raise RuntimeError('Local helper deployment target differs from observed configuration')
    runtime = work / 'artifact'; binary = runtime / 'bin/xpod_qlever_local_runtime'
    stage('native-test', [sys.executable,str(ROOT/'qlever/scripts/verify-local-runtime-artifacts.py'),
          '--prefix',str(runtime),'--lock',str(ROOT/'qlever/qlever.lock.json'),
          '--build-source','macos-'+target.removeprefix('darwin-'),
          '--smoke-database',str(work/'independent-runtime-smoke.sqlite')], timeout=300)
    stage('native-archive', ['tar','-czf',str(archive),'-C',str(runtime),'.'], timeout=300)
    if not archive.is_file(): raise RuntimeError('Actual built archive absent')
    stage('binary-file', ['file',str(binary)])
    loader_members = []
    for number, member in enumerate([binary,*sorted((runtime/'lib').glob('*'))]):
        if member.is_symlink() or not member.is_file(): raise RuntimeError('Native loader member must be regular')
        loader_members.append(dict(member=reference(member,runtime),loaderStage='loader-'+str(number),
                                   minimumOSStage='minos-'+str(number),signatureStage='codesign-'+str(number),
                                   sourceBindingStatus='primary-source-proposal' if member==binary else 'pending',
                                   sourceBindingPending=[] if member==binary else ['companion-dylib-source-sdk-bindings-unavailable']))
        stage('loader-'+str(number), ['otool','-L',str(member)])
        stage('minos-'+str(number), ['otool','-l',str(member)])
        stage('codesign-'+str(number), ['codesign','--verify','--verbose=2',str(member)])
    # The helper has a JSON protocol, not a --version CLI. The build stage
    # already captures the canonical ready/ABI/RDF/FTS/VEC/shutdown smoke.
    stage('actual-compile-commands', ['ninja','-C',str(build),'-t','commands'])
    stage('actual-dependency-files', ['ninja','-C',str(build),'-t','deps'])
    stage('actual-local-compile-commands', ['ninja','-C',str(work/'local-build'),'-t','commands'])
    (materials/'inputs-after.json').write_text(json.dumps(dict(filesAfter=after_files,toolchain=after),sort_keys=True,indent=2)+'\n')
    if digest(binary) != observation['helperSha256']: raise RuntimeError('Helper changed after input observation')
    terms = [ref for ref in source_kit['files'] if Path(ref['path']).name.lower().startswith(('license','copying','copyright','notice'))]
    if not terms: raise RuntimeError('Actual source terms absent')
    patches = [ref for ref in source_kit['files'] if ref['path'].startswith('workspace/qlever/patches/') and ref['path'].endswith('.patch')]
    tool_ref = reference(tool_input,kit_root)
    receipt = dict(schemaVersion=1,target=target,engine=source_kit['engine'],sourceKitSha256=digest(kit_path),
                   helperSha256=digest(binary),compiler=dict(toolchain=source_kit['toolchain'],observedToolchainSha256=tool_ref['sha256'],sdkSettingsSha256=before['sdkSettingsSha256']),
                   testsPassed=True,buildArguments=['bash',str(script),'build-prepared'],
                   stagedVerifiedFilesOnly=True,sourceFiles=len(source_kit['files']),
                   scope='Derived only after actual closed build/input/test stages; official admission remains central',
                   pending=['companion-dylib-source-sdk-bindings-unavailable','external-sdk-distribution-not-copied'])
    (materials/'native-receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    def local_stage(name):
        row = next(row for row in records if row['name']==name)
        return dict(kind='local',receipt=row['receipt'],raw=row['raw'])
    role_binding = dict(binary=reference(binary,runtime),target=target,sourceKit=reference(kit_path,materials),
                        sourceRoot='source-kit',nativeReceipt=reference(materials/'native-receipt.json',materials),
                        patches=patches,terms=terms,toolchainInputs=[tool_ref,reference(settings_copy,kit_root)],
                        compilerBindings=[dict(field='observedToolchainSha256',file=tool_ref),
                                          dict(field='sdkSettingsSha256',file=reference(settings_copy,kit_root))],
                        inputObservation=reference(materials/'input-observation.json',materials),
                        observationStage=local_stage('native-input-observation'),
                        buildStage=local_stage('native-build'),
                        testStage=local_stage('native-test'))
    # A binding proposal is original metadata, not an issued NativeMaterialIndex.
    # Central packing must bind product-relative paths and observed custody.
    (materials/'binding-proposal.json').write_text(json.dumps(role_binding,sort_keys=True,indent=2)+'\n')
    dependency_roots=[('workspace',str(ROOT/'qlever')),('engine',str(engine)),('generated-build',str(build)),
                      ('apple-sdk',before['sdkPath']),('compiler-builtin',before['compilerBuiltinResourceDirectory'])]
    if deps.exists():dependency_roots += [('fetchcontent-source',str(path)) for path in sorted(deps.iterdir()) if path.is_dir() and path.name.endswith('-src')]
    dependency_roots += [('homebrew',stage('brew-prefix',['brew','--prefix']))]
    stage('dependency-inventory',[sys.executable,str(ROOT/'qlever/scripts/macos_dependency_inventory.py'),
          '--raw',str(stages/'actual-dependency-files.raw.log'),'--roots',json.dumps(dependency_roots),
          '--out',str(materials/'dependency-inventory.json')],timeout=120)
    cellar=stage('brew-cellar',['brew','--cellar'])
    stage('companion-originals',[sys.executable,str(ROOT/'qlever/scripts/macos_companion_originals.py'),
          '--build-raw',str(stages/'native-build.raw.log'),'--cellar',cellar,'--runtime',str(runtime),
          '--out',str(materials/'companions')],timeout=300)
    metadata = dict(schemaVersion=1,target=target,record=dict(toolchain=before,sourceSha=source_sha,binary=reference(binary,runtime)),loaderMembers=loader_members,stages=records)
    (materials/'runtime-admission.metadata.json').write_text(json.dumps(metadata,sort_keys=True,indent=2)+'\n')
    final = dict(schemaVersion=1,status='native-build-test-materials',releaseAccepted=False,target=target,sourceSha=source_sha,
                 runId=os.environ['GITHUB_RUN_ID'],runAttempt=os.environ['GITHUB_RUN_ATTEMPT'],jobName=os.environ['GITHUB_JOB'],
                 nativeBuildSourceSha=source_sha,sourceArchive=reference(materials/'source-kit.tar',materials),sourceKit=reference(materials/'source-kit.json',materials),
                 metadata=reference(materials/'runtime-admission.metadata.json',materials),binary=reference(binary,runtime),
                 inputsBefore=reference(materials/'inputs-before.json',materials),
                 inputsAfter=reference(materials/'inputs-after.json',materials),
                 runtimeManifest=reference(runtime/'manifest.json',runtime),
                 nativeReceipt=reference(materials/'native-receipt.json',materials),
                 companionMaterials=reference(materials/'companions/materials.json',materials),
                 dependencyInventory=reference(materials/'dependency-inventory.json',materials),
                 bindingProposal=reference(materials/'binding-proposal.json',materials),
                 inputObservation=reference(materials/'input-observation.json',materials),
                 archive=dict(path=archive.name,sha256=digest(archive),sizeBytes=archive.stat().st_size),
                 pending=['companion-dylib-source-sdk-bindings-unavailable','external-sdk-distribution-not-copied',
                          'official-origin-custody-admission-unavailable'],
                 scope='Actual native source/toolchain/loader/smoke originals; official custody and ABI admission remain central')
    (materials/'final.json').write_text(json.dumps(final,sort_keys=True,indent=2)+'\n')
    return final


def verify_cache(root):
    """Rehash cached originals without granting their origin or rebinding SHA."""
    root = Path(root).resolve(); materials = root / 'native-materials'
    def check(base, ref):
        member = base / ref['path']
        if Path(ref['path']).is_absolute() or '..' in Path(ref['path']).parts:
            raise RuntimeError('Unsafe cached native material path')
        if any(part.is_symlink() for part in [member, *member.parents] if part != base.parent):
            raise RuntimeError('Cached native material link')
        if reference(member, base) != ref: raise RuntimeError('Cached native material changed')
    final = json.loads((materials / 'final.json').read_text())
    if final['status'] != 'native-build-test-materials' or final['releaseAccepted'] is not False:
        raise RuntimeError('Invalid cached native material status')
    check(root, final['archive'])
    for key in ['sourceKit', 'metadata', 'inputsBefore', 'inputsAfter', 'nativeReceipt', 'bindingProposal', 'inputObservation']: check(materials, final[key])
    kit = json.loads((materials / final['sourceKit']['path']).read_text())
    if source_kit_inventory(materials/'source-kit')!=kit['files']:
        raise RuntimeError('Cached native source kit inventory changed')
    if 'sourceArchive' in final: check(materials,final['sourceArchive'])
    if 'dependencyInventory' in final:check(materials,final['dependencyInventory'])
    if 'companionMaterials' in final:
        check(materials,final['companionMaterials'])
        companion=json.loads((materials/final['companionMaterials']['path']).read_text())
        for ref in companion['files']:check(materials/'companions/originals',ref)
    metadata = json.loads((materials / final['metadata']['path']).read_text())
    for stage in metadata['stages']:
        for key in ['receipt', 'raw']: check(materials, stage[key])
    return final


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--target'); group.add_argument('--verify-cache'); group.add_argument('--verify-inputs')
    args = parser.parse_args()
    if args.verify_cache: verify_cache(args.verify_cache)
    elif args.verify_inputs:
        document = json.loads(Path(args.verify_inputs).read_text())
        print(json.dumps(observe_input_document(document),sort_keys=True))
    else: observe(args.target,os.environ['XPOD_QLEVER_PLATFORM_BUILD_ROOT'],os.environ['XPOD_QLEVER_PLATFORM_RUNTIME_ARCHIVE'])

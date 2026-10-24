"""Same-FD SDK ZIP execution-original scanner; never executes candidate code."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
wire_reader=load('sdk-raw-wire-reader');zip_originals=load('sdk-zip-originals');bindings=load('sdk-generation-multiprocess-bindings');originals_util=load('sdk-execution-originals-util');LIMITS=zip_originals.LIMITS

def retain_dependency_read_capture(row,digest,registrations,paths,originals):
    """Projection only; caller must complete observe() full raw/FD validation."""
    binding=row.get('dependency');bindings.need(isinstance(binding,dict),'dependency FD capture registration required')
    registration=registrations.get(binding.get('registrationSequence'));bindings.need(registration,'dependency read actual raw registration unavailable')
    if binding.get('name')=='@cmake-cache':bindings.need(row['path']=='/opt/qlever-sdk/dependencies/sources.cmake' and binding.get('relativePath')=='sources.cmake','fixed dependency cache capture role')
    else:bindings.need(binding.get('name')==registration.get('name') and isinstance(binding.get('relativePath'),str) and not binding['relativePath'].startswith('/') and all(part not in ('','.', '..') for part in binding['relativePath'].split('/')) and '\\' not in binding['relativePath'] and row['path']==registration['sourceRoot']+'/'+binding['relativePath'],'dependency capture actual root/path differs')
    current={key:dict(bytes=registration[field]['bytes'],sha256=registration[field]['sha256']) for key,field in [('prepared','sourcePreparedOriginal'),('collection','collectionOriginal'),('declaration','declarationOriginal'),('cache','cmakeCacheOriginal')]}
    bindings.need(originals is None or originals==current,'dependency FD captures mix origin originals')
    value=dict(path=row['path'],bytes=digest[0],sha256=digest[1],mode=row['identity'][2]&0o7777)
    previous=paths.get(row['path'])
    if previous:bindings.need(all(previous[key]==item for key,item in value.items()),'dependency captured path bytes/mode changed');previous['captures']+=1
    else:value['captures']=1;paths[row['path']]=value
    bindings.need(len(paths)<=LIMITS['sourceMembers'],'dependency captured path projection bound')
    return current


def retain_postpatch_source_read_capture(row,digest,paths):
    """Projection only; caller must complete observe() raw/FD validation first."""
    value=dict(path=row['path'],bytes=digest[0],sha256=digest[1],mode=row['identity'][2]&0o7777)
    previous=paths.get(row['path'])
    if previous:bindings.need(all(previous[key]==item for key,item in value.items()),'postpatch source captured path bytes/sha256/mode changed');previous['captures']+=1;value=previous
    else:value['captures']=1;paths[row['path']]=value
    bindings.need(len(paths)<=LIMITS['sourceMembers'],'postpatch source captured path projection bound')
    return paths[row['path']]

def observe(archive_path,plan):
    remaining=plan['remainingMilliseconds'];bindings.need(isinstance(remaining,(int,float)) and 0<remaining<=LIMITS['timeoutMs'],'shared remaining deadline required')
    deadline=time.monotonic()+remaining/1000
    def check():bindings.need(time.monotonic()<deadline,'same generated-source deadline expired')
    with zip_originals.registered_zip_originals(archive_path,'inner/toolchain-execution/',check) as member:
        def stream(ref):
            with member(ref) as source:
                count=0;digest=hashlib.sha256()
                while True:
                    check();block=source.read(LIMITS['rangeBytes'])
                    if not block:break
                    count+=len(block);bindings.need(count<=ref['bytes'],'registered original byte bound');digest.update(block);yield block
                bindings.need(count==ref['bytes'] and digest.hexdigest()==ref['sha256'],'whole original bytes differ')
        def small(ref):
            bindings.need(ref['bytes']<=LIMITS['metadataBytes'],'metadata original bound');return json.loads(b''.join(stream(ref)))
        provider=plan['sourceProviderOriginals']['mountinfo'];bindings.need(provider['path']=='inner/toolchain-execution/source-provider.mountinfo.raw' and provider['bytes']<=LIMITS['metadataBytes'],'fixed bounded source provider original required')
        originals_util.effective_readonly(plan['sourceRoot'],b''.join(stream(provider)),resolve_local=False)
        phase_rows=[];all_refs={};postpatch_reads={};unresolved_sources=set();uncovered=set();unclassified_entries=[];used_originals=set();dependency_registrations={};dependency_reads={};dependency_originals=None
        for phase in plan['phases']:
            local={}
            for ref in phase['captures']['indexes']:
                index=small(ref);bindings.need(index.get('schemaVersion')==1 and isinstance(index.get('files'),list),'capture index schema')
                for original in index['files']:
                    name=bindings.capture_inventory_name(original['path']);bindings.need(name not in local,'unique registered capture role')
                    bindings.need(original['bytes']<=LIMITS['shardBytes'],'capture original bound');local[name]=original
                    if name in all_refs:bindings.need(all_refs[name]==original,'global physical capture ambiguity')
                    all_refs[name]=original
            bindings.need(len(local)==phase['captures']['files'] and sum(ref['bytes'] for ref in local.values())==phase['captures']['bytes'],'actual capture original inventory differs')
            phase_rows.append((phase['name'],phase['rawTraceShards']))
        bindings.need(sum(ref['bytes'] for ref in all_refs.values())+sum(ref['bytes'] for _,rows in phase_rows for ref in rows)<=LIMITS['sourceMaterialBytes'],'execution originals exceed shared source budget')
        def read_original(name,maximum):
            ref=all_refs.get(name);bindings.need(ref and ref['bytes']<=maximum,'same registered capture original required');used_originals.add(name);return stream(ref)
        commands={phase['name']:phase['actualCommand'] for phase in plan['phases']}
        def lines(phase_name,refs):
            for ref in refs:
                yield from wire_reader.iter_shard_records(stream(ref),ref,check=check,maximum_encoded=LIMITS['shardBytes'],maximum_logical=LIMITS['shardBytes'],maximum_record=LIMITS['rangeBytes'])
        def record_observer(phase_name,row):
            if row.get('kind')=='owned-root-binding':bindings.need(row.get('command')==commands[phase_name],'actual traced root argv differs from closed SDK stage')
            if row.get('kind')=='kernel-syscall' and row.get('op')=='entry':
                policy=bindings.policy(row['arch']);classified={policy[key] for key in ['read','write','close','mmap','clone','clone3']}|policy['renameOps']|policy['exits']
                if row['nr'] not in classified:unclassified_entries.append((row['sequence'],'unclassified-kernel-operation:'+hex(row['arch'])+':'+str(row['nr'])))
            if row.get('kind')=='prepared-dependency-source-root':
                bindings.need(row['sequence'] not in dependency_registrations,'duplicate dependency raw registration sequence');dependency_registrations[row['sequence']]=row
            if row.get('kind')=='generated-mmap-unverified':uncovered.add('generated-input-mmap:'+row['path'])
        bindings.need({name for name in member.names if name.startswith('inner/toolchain-execution/captures/')}=={ref['path'] for ref in all_refs.values()},'capture original ZIP closed set differs')
        source_files=plan['sourceFiles']
        def capture_observer(row,digest):
            nonlocal dependency_originals
            if row['role']=='source-read' and row['path'].startswith('/opt/qlever-sdk/dependencies/'):
                dependency_originals=retain_dependency_read_capture(row,digest,dependency_registrations,dependency_reads,dependency_originals)
            elif row['role']=='source-read':
                expected=source_files.get(row['path'])
                if expected is None:unresolved_sources.add(row['path'])
                else:
                    bindings.need(isinstance(expected,dict) and digest==(expected.get('bytes'),expected.get('sha256')) and row['identity'][2]&0o7777==expected.get('mode',row['identity'][2]&0o7777),'actual source read snapshot differs from postpatch original');retain_postpatch_source_read_capture(row,digest,postpatch_reads)
        result=bindings.observe([(name,lines(name,refs)) for name,refs in phase_rows],read_original,plan['requiredInputs'],check,LIMITS,capture_observer,compact_tool_coverage=True,record_observer=record_observer)
        # Only the complete typed v5 entry/barrier/resume/exit/postbarrier/close
        # replay can discharge these exact operation sequences. Same nr outside
        # the verified active epoch remains unclassified, never an allowlist.
        private_wakes=set(result.get('verifiedPrivateWakeEntrySequences',[]))|set(result.get('verifiedPrivateWaitMismatchEntrySequences',[]))
        uncovered.update(label for sequence,label in unclassified_entries if sequence not in private_wakes)
        bindings.need(used_originals==set(all_refs),'capture inventory contains no corresponding actual FD observation')
        for phase,actual in zip(plan['phases'],result['phaseTracking']):
            declared=phase.get('trackingReceipt')
            if declared is not None:
                bindings.need(declared.get('schemaVersion')==1 and declared.get('kind')=='sdk-observer-tracked-phase-original' and declared.get('phase')==phase['name'],'fixed typed tracking receipt required')
                bindings.need(declared.get('actualTrackedWait') is True and declared.get('trackedProcessesClosed') is True and declared.get('command')==phase['actualCommand'],'typed tracking declaration differs')
                bindings.need(all(declared.get(key)==actual[key] for key in ['actualRootPid','actualRootReturnCode','waitReferences']),'actual kernel wait references differ from typed receipt')
        check();result['actualConfigureCompileTrackedWaitVerified']=len(plan['phases'])==2 and [phase['name'] for phase in plan['phases']]==['configure','compile'] and all('trackingReceipt' in phase for phase in plan['phases'])
        result['postpatchSourceReadSnapshotsMatched']=len(postpatch_reads);result['postpatchSourceReadCaptures']=sorted(postpatch_reads.values(),key=lambda row:row['path']);result['unresolvedSourceReadPaths']=sorted(unresolved_sources);result['uncoveredOperations']=sorted(uncovered)
        result['dependencySourceReadOriginals']=dependency_originals
        result['dependencySourceReadCaptures']=sorted(dependency_reads.values(),key=lambda row:row['path'])
        result['generatedInputIoClosureExceptDependencyOriginVerified']=result['selectedGeneratedConsumerByteCustodyVerified'] and not unresolved_sources and not uncovered
        result['generatedInputIoClosureVerified']=result['generatedInputIoClosureExceptDependencyOriginVerified'] and not dependency_reads
        return result
if __name__=='__main__':
    raw=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);bindings.need(len(raw)<=LIMITS['metadataBytes'] and len(sys.argv)==2,'bounded fixed observer plan required')
    print(json.dumps(observe(sys.argv[1],json.loads(raw)),separators=(',',':')))

"""Same-FD SDK ZIP execution-original scanner; never executes candidate code."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
GENERATED_PROJECTIONS=('verifiedGeneratedProducerInputs','verifiedGeneratedProducerWitness',
                       'verifiedGeneratedProducerGraph','verifiedRegularReadCustody',
                       'verifiedRegularReadSourceClass')

def emit_projection(result):
    """The ACTUAL emission projection: ship the transport, drop the duplicates.

    `observe()` in the bindings module returns the five generated tables for
    IN-PROCESS consumers and the closed versioned transport carries the SAME
    facts. Emitting both doubles the payload, so the scanner CLI strips exactly
    those five tables and ships the transport alone.

    The strip happens ONLY when a valid closed transport is present. Otherwise
    the legacy arrays stay and nothing is lost. A present-but-malformed transport
    fails closed instead of being shipped. Nothing but these five generated
    tables is removed, so every other proof/tool-coverage field survives.
    """
    transport=result.get('verifiedGeneratedProducerTransport')
    if transport is not None:
        bindings.need(isinstance(transport,dict) and transport.get('schemaVersion')==2
                      and transport.get('model')=='indexed-generated-producer-transport-v2',
                      'closed generated producer transport required')
        # decode() validates the transport's own schema/closure; a present but
        # malformed transport must fail closed rather than silently ship.
        generated_transport.decode(transport)
        for name in GENERATED_PROJECTIONS:
            bindings.need(name in result,'legacy generated projection must be present before stripping')
            del result[name]
    return result


wire_reader=load('sdk-raw-wire-reader');zip_originals=load('sdk-zip-originals');bindings=load('sdk-generation-multiprocess-bindings');originals_util=load('sdk-execution-originals-util');generated_transport=load('sdk-generated-producer-transport');LIMITS=zip_originals.LIMITS

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
        phase_rows=[];all_refs={};postpatch_reads={};unresolved_sources=set();uncovered=set();mmap_markers=[];unclassified_entries=[];used_originals=set();dependency_registrations={};dependency_reads={};dependency_originals=None
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
            if row.get('kind')=='generated-mmap-unverified':mmap_markers.append(row)
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
        # DERIVED credit: a marker is discharged ONLY when the same ordinary
        # replay validated the exact phase/pid/entry, actual mmap exit/address/
        # range/offset/prot/flags, matching held pre-use lease+identity, the whole
        # FD original and every VMA mapping original for that operation, under a
        # phase whose lifetime closed exactly. `verifiedFileMappedMmapEntries`
        # is a projection of that completed validation, never an input claim;
        # matching a path alone or any unvalidated row is never credited. Any
        # marker without such an entry stays uncovered (preserved on the wire).
        verified=result.get('verifiedFileMappedMmapKeys') or []
        bindings.need(isinstance(verified,list),'derived verified mmap key projection must be a list')
        # Each key is the exact (phase,pid,entrySequence,path) of an operation the
        # ordinary replay fully validated. Only the tuple is derived; the
        # per-operation address/range/offset/prot/flags/paths facts already live
        # in toolchainOperationCoverage and are NOT duplicated onto this wire.
        keys=set()
        for key in verified:
            bindings.need(isinstance(key,list) and len(key)==4 and isinstance(key[1],int) and isinstance(key[2],int)
                          and all(isinstance(key[i],str) for i in (0,3)),'malformed derived mmap key')
            keys.add((key[0],key[1],key[2],key[3]))
        # The intermediate key registry is a SECOND serialization of proof that
        # toolchainOperationCoverage already carries. It is consumed here and by
        # nothing downstream, so it must not reach the scanner payload at all.
        # Credits above are already applied; removing it loses no authority.
        bindings.need('verifiedFileMappedMmapKeys' in result,'derived key projection must be present before consumption')
        del result['verifiedFileMappedMmapKeys']
        for marker in mmap_markers:
            # No caller flag, no path-only credit: the exact four-field key of the
            # marker must be present.
            if (marker.get('phase'),marker.get('pid'),marker.get('entrySequence'),marker.get('path')) not in keys:
                uncovered.add('generated-input-mmap:'+marker['path'])
        bindings.need(used_originals==set(all_refs),'capture inventory contains no corresponding actual FD observation')
        for phase,actual in zip(plan['phases'],result['phaseTracking']):
            declared=phase.get('trackingReceipt')
            if declared is not None:
                bindings.need(declared.get('schemaVersion')==1 and declared.get('kind')=='sdk-observer-tracked-phase-original' and declared.get('phase')==phase['name'],'fixed typed tracking receipt required')
                bindings.need(declared.get('actualTrackedWait') is True and declared.get('trackedProcessesClosed') is True and declared.get('command')==phase['actualCommand'],'typed tracking declaration differs')
                bindings.need(all(declared.get(key)==actual[key] for key in ['actualRootPid','actualRootReturnCode','waitReferences']),'actual kernel wait references differ from typed receipt')
        check();result['actualConfigureCompileTrackedWaitVerified']=len(plan['phases'])==2 and [phase['name'] for phase in plan['phases']]==['configure','compile'] and all('trackingReceipt' in phase for phase in plan['phases'])
        result['postpatchSourceReadSnapshotsMatched']=len(postpatch_reads);result['postpatchSourceReadCaptures']=sorted(postpatch_reads.values(),key=lambda row:row['path']);result['unresolvedSourceReadPaths']=sorted(unresolved_sources);result['uncoveredOperations']=sorted(uncovered)
        # EMIT-SIDE PROJECTION: ONE production helper, shared by this CLI and by
        # the emit regression test.
        emit_projection(result)
        result['dependencySourceReadOriginals']=dependency_originals
        result['dependencySourceReadCaptures']=sorted(dependency_reads.values(),key=lambda row:row['path'])
        result['generatedInputIoClosureExceptDependencyOriginVerified']=result['selectedGeneratedConsumerByteCustodyVerified'] and not unresolved_sources and not uncovered
        result['generatedInputIoClosureVerified']=result['generatedInputIoClosureExceptDependencyOriginVerified'] and not dependency_reads
        return result
if __name__=='__main__':
    raw=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);bindings.need(len(raw)<=LIMITS['metadataBytes'] and len(sys.argv)==2,'bounded fixed observer plan required')
    print(json.dumps(observe(sys.argv[1],json.loads(raw)),separators=(',',':')))

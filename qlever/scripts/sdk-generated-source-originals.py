"""Same-FD SDK ZIP execution-original scanner; never executes candidate code."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
zip_originals=load('sdk-zip-originals');bindings=load('sdk-generation-multiprocess-bindings');originals_util=load('sdk-execution-originals-util');LIMITS=zip_originals.LIMITS

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
        phase_rows=[];all_refs={};source_matches=set();unresolved_sources=set();uncovered=set();used_originals=set()
        for phase in plan['phases']:
            local={}
            for ref in phase['captures']['indexes']:
                index=small(ref);bindings.need(index.get('schemaVersion')==1 and isinstance(index.get('files'),list),'capture index schema')
                for original in index['files']:
                    name=Path(original['path']).name;bindings.need(name not in local and original['path'].startswith('inner/toolchain-execution/captures/'),'unique registered capture role')
                    bindings.need(original['bytes']<=LIMITS['shardBytes'],'capture original bound');local[name]=original
                    if name in all_refs:bindings.need(all_refs[name]==original,'global capture basename ambiguity')
                    all_refs[name]=original
            bindings.need(len(local)==phase['captures']['files'] and sum(ref['bytes'] for ref in local.values())==phase['captures']['bytes'],'actual capture original inventory differs')
            phase_rows.append((phase['name'],phase['rawTraceShards']))
        bindings.need(sum(ref['bytes'] for ref in all_refs.values())+sum(ref['bytes'] for _,rows in phase_rows for ref in rows)<=LIMITS['sourceMaterialBytes'],'execution originals exceed shared source budget')
        def read_original(name,maximum):
            ref=all_refs.get(name);bindings.need(ref and ref['bytes']<=maximum,'same registered capture original required');used_originals.add(name);return stream(ref)
        commands={phase['name']:phase['actualCommand'] for phase in plan['phases']}
        def lines(phase_name,refs):
            pending=bytearray()
            for ref in refs:
                bindings.need(ref['bytes']<=LIMITS['shardBytes'],'raw shard bound')
                for block in stream(ref):
                    pending.extend(block)
                    while True:
                        at=pending.find(b'\n')
                        if at<0:break
                        bindings.need(at+1<=LIMITS['rangeBytes'],'raw record bound');line=bytes(pending[:at+1]);del pending[:at+1]
                        row=json.loads(line)
                        if row.get('kind')=='owned-root-binding':bindings.need(row.get('command')==commands[phase_name],'actual traced root argv differs from closed SDK stage')
                        if row.get('kind')=='kernel-syscall' and row.get('op')=='entry':
                            policy=bindings.policy(row['arch']);classified={policy[key] for key in ['read','write','close','mmap','clone','clone3']}|policy['renameOps']|policy['exits']
                            if row['nr'] not in classified:uncovered.add('unclassified-kernel-operation:'+hex(row['arch'])+':'+str(row['nr']))
                        if row.get('kind')=='generated-mmap-unverified':uncovered.add('generated-input-mmap:'+row['path'])
                        yield line
                    bindings.need(len(pending)<=LIMITS['rangeBytes'],'unfinished raw record bound')
            bindings.need(not pending,'raw JSONL final newline required')
        bindings.need({name for name in member.names if name.startswith('inner/toolchain-execution/captures/')}=={ref['path'] for ref in all_refs.values()},'capture original ZIP closed set differs')
        source_files=plan['sourceFiles']
        def capture_observer(row,digest):
            if row['role']=='source-read':
                expected=source_files.get(row['path'])
                if expected is None:unresolved_sources.add(row['path'])
                else:
                    bindings.need(digest==(expected['bytes'],expected['sha256']),'actual source read snapshot differs from postpatch original');source_matches.add(row['path'])
        result=bindings.observe([(name,lines(name,refs)) for name,refs in phase_rows],read_original,plan['requiredInputs'],check,LIMITS,capture_observer)
        bindings.need(used_originals==set(all_refs),'capture inventory contains no corresponding actual FD observation')
        for phase,actual in zip(plan['phases'],result['phaseTracking']):
            declared=phase.get('trackingReceipt')
            if declared is not None:
                bindings.need(declared.get('schemaVersion')==1 and declared.get('kind')=='sdk-observer-tracked-phase-original' and declared.get('phase')==phase['name'],'fixed typed tracking receipt required')
                bindings.need(declared.get('actualTrackedWait') is True and declared.get('trackedProcessesClosed') is True and declared.get('command')==phase['actualCommand'],'typed tracking declaration differs')
                bindings.need(all(declared.get(key)==actual[key] for key in ['actualRootPid','actualRootReturnCode','waitReferences']),'actual kernel wait references differ from typed receipt')
        check();result['actualConfigureCompileTrackedWaitVerified']=len(plan['phases'])==2 and [phase['name'] for phase in plan['phases']]==['configure','compile'] and all('trackingReceipt' in phase for phase in plan['phases'])
        result['postpatchSourceReadSnapshotsMatched']=len(source_matches);result['unresolvedSourceReadPaths']=sorted(unresolved_sources);result['uncoveredOperations']=sorted(uncovered)
        result['generatedInputIoClosureVerified']=result['selectedGeneratedConsumerByteCustodyVerified'] and not unresolved_sources and not uncovered
        return result
if __name__=='__main__':
    raw=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);bindings.need(len(raw)<=LIMITS['metadataBytes'] and len(sys.argv)==2,'bounded fixed observer plan required')
    print(json.dumps(observe(sys.argv[1],json.loads(raw)),separators=(',',':')))

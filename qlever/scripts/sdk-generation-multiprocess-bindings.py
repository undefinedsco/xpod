"""Pure all-stop generated-file byte relations from actual observer originals.

Not a capability. Controlled observer/TCB execution, Git inputs and upstream
runtime/toolchain authority remain independent of this mechanical axis.
"""
import hashlib
import json
import re
POLICIES={
 0xc00000b7:dict(read=63,write=64,close=57,mmap=222,clone=220,clone3=435,spawn={220,435},renameat=38,renameat2=276,renameOps={38,276},exits={93,94},forbidden={0,1,2,3,4,292,425,426,427,271,117,97,268}),
 0xc000003e:dict(read=0,write=1,close=3,mmap=9,clone=56,clone3=435,spawn={56,57,58,435},rename=82,renameat=264,renameat2=316,renameOps={82,264,316},exits={60,231},forbidden={206,207,208,209,210,333,425,426,427,311,101,272,308}),
}
def policy(arch):
    if arch not in POLICIES:raise ValueError('unsupported actual kernel architecture')
    return POLICIES[arch]

def need(value,reason):
    if not value:raise ValueError('multi-process generation originals: '+reason)
def observe(phase_lines,read_original,required_inputs=None,check=lambda:None,limits=None,capture_observer=None):
    maximum_raw=limits['sourceMaterialBytes'] if limits else 32*1024**2
    maximum_file=limits['shardBytes'] if limits else 1024**2
    maximum_total=limits['sourceMaterialBytes'] if limits else 16*1024**2
    original_cache={};retained_entries=set();phase_tracking=[]
    live=set();last=0;entries={};exits={};barriers={};caps={};paths={};renames=[];consumers=[];source_reads=[];total=0;capture_total=0;exclusive=None;root_codes={};clone_flags=set()
    prepared={};prepared_consumers=[];prepared_digest=hashlib.sha256();prepared_count=0;prepared_sealed=False;prepared_paths=set()
    def capture_data(ref):
        nonlocal capture_total
        need(re.fullmatch(r'capture-[0-9]{4,}\.original',ref['path']) and 0<=ref['bytes']<=maximum_file,'fixed capture role/byte bound')
        key=(ref['path'],ref['bytes'],ref['sha256'])
        if key not in original_cache:
            original=read_original(ref['path'],maximum_file);digest=hashlib.sha256();count=0
            if isinstance(original,bytes):need(len(original)<=1024**2,'legacy tiny byte reader bound')
            blocks=(original[offset:offset+65536] for offset in range(0,len(original),65536)) if isinstance(original,bytes) else original
            for block in blocks:
                check();need(isinstance(block,bytes) and len(block)<=65536,'bounded actual capture block required');count+=len(block);need(count<=ref['bytes'],'capture actual byte bound');digest.update(block)
            data=(count,digest.hexdigest());capture_total+=count;need(capture_total<=maximum_total and data==(ref['bytes'],ref['sha256']),'capture actual bytes/reference differs');original_cache[key]=data
        return original_cache[key]
    for phase,lines in phase_lines:
        need(not live,'prior actual process tree has not closed');roots=[];waits=[]
        for raw in lines:
            check();total+=len(raw);need(total<=maximum_raw and len(raw)<=65536,'tiny raw aggregate/record bound');row=json.loads(raw);need(row['sequence']==last+1 and row['phase']==phase,'phase/raw sequence differs');last=row['sequence'];kind=row['kind']
            if kind=='prepared-build-input-original':
                need(not live and not roots and not phase_tracking and not prepared_sealed,'prepared input must precede first actual process')
                need(row['path'].startswith('/') and row['path'] not in prepared_paths,'unique absolute prepared original path required')
                data=capture_data(row['original']);need(len(row['identity'])==6 and row['identity'][3]==data[0],'prepared identity/bytes differ');prepared[row['sequence']]=(row,data);prepared_count+=1;prepared_paths.add(row['path'])
                prepared_digest.update((json.dumps(dict(path=row['path'],identity=row['identity'],original=row['original']),sort_keys=True)+'\n').encode())
            elif kind=='prepared-build-input-seal':
                need(not live and not roots and not phase_tracking and not prepared_sealed and row['files']==prepared_count and row['inventorySha256']==prepared_digest.hexdigest(),'prepared closed-set byte seal differs');prepared_sealed=True
                need(all(value[0]['path'].startswith(row['buildRoot'].rstrip('/')+'/') for value in prepared.values()),'prepared original escapes actual build root')
            elif kind=='owned-root-binding':need(not live and not roots,'unique actual root required');live.add(row['pid']);roots.append(row['pid']);need(row['backend']=='ptrace-all-stop-process-v1','wrong observer backend')
            elif kind=='actual-child-binding':need(row['parentPid'] in live and row['childPid'] not in live,'unobserved actual child binding');live.add(row['childPid'])
            elif kind=='actual-wait-exit':need(row['pid'] in live,'wait on unknown process');live.remove(row['pid']);root_codes[row['pid']]=row['returnCode'];waits.append(dict(pid=row['pid'],sequence=row['sequence'],returnCode=row['returnCode'],phase=phase))
            elif kind=='all-stop-barrier':need(row['pids']==sorted(live) and row['osStates']==['t']*len(live),'potential writer not in actual complete tracing-stop barrier');barriers[row['sequence']]=row
            elif kind=='exclusive-captured-syscall-resume':
                need(exclusive is None and row['captureSequence'] in caps and caps[row['captureSequence']][0]['entrySequence']==row['entrySequence'],'exclusive capture resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='exclusive-captured-syscall-exit':
                need(exclusive==(row['pid'],row['entrySequence']) and row['entrySequence'] in exits,'exclusive read/close stop boundary differs');exclusive=None
            elif kind=='kernel-syscall':
                need(row['pid'] in live and row['arch'] in POLICIES,'unknown syscall process/architecture');need(exclusive is None or exclusive[0]==row['pid'],'another potential writer ran during captured syscall')
                if row['op']=='entry':
                    rules=policy(row['arch']);need(row['nr'] not in rules['forbidden'],'unsupported asynchronous/external writer syscall')
                    if row['nr']==rules['clone']:
                        flags=row['args'][0];need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared thread/FD clone')
                    if row['nr']==rules['mmap']:need(not(row['args'][2]&2 and row['args'][3]&1),'shared writable mapping')
                    entries[row['sequence']]=row
                elif row['op']=='exit':
                    if 'entrySequence' in row:
                        entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and row['entrySequence'] not in exits,'syscall exit binding differs')
                        if entry['nr']==435:need(row['entrySequence'] in clone_flags,'clone3 lacks actual flags original')
                        if row['entrySequence'] in retained_entries:exits[row['entrySequence']]=row
                        else:entries.pop(row['entrySequence']);clone_flags.discard(row['entrySequence'])
                else:need(False,'unknown syscall-info operation')
            elif kind=='kernel-clone-flags':
                entry=entries.get(row['entrySequence']);clone_flags.add(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr'] in [policy(entry['arch'])['clone'],435],'clone memory flags entry differs');flags=row['flags'];need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared writer/FD flags')
            elif kind=='kernel-path-arguments':need(row['entrySequence'] in entries and entries[row['entrySequence']]['pid']==row['pid'],'path original entry differs');paths[row['entrySequence']]=row['renamePaths'];retained_entries.add(row['entrySequence'])
            elif kind=='fd-capture':
                retained_entries.add(row['entrySequence']);entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and row['pid']==entry['pid'] and row['pid'] in barrier['pids'],'capture missing actual entry/all-stop relation')
                rules=POLICIES[entry['arch']];need(row['role'] in ['producer-close','consumer','source-read'],'unknown capture role')
                nr=entry['nr'];fd_index=4 if nr==rules['mmap'] else 0;need(row['fd']==entry['args'][fd_index],'capture actual FD differs')
                if row['role']=='producer-close':need(nr==rules['close'] and row['writers']==[dict(pid=row['pid'],fd=row['fd'])],'producer has another writable alias')
                else:need(nr==rules['read'] and row['writers']==[],'consumer/source has live writable alias')
                data=capture_data(row['original'])
                need(len(row['identity'])==6 and row['identity'][3]==data[0],'actual capture identity/size differs');caps[row['sequence']]=(row,data)
                if capture_observer:capture_observer(row,data)
                if row['role']=='source-read':source_reads.append(row)
            elif kind=='retained-fd-rename-binding':renames.append(row)
            elif kind=='generated-consumer-binding':consumers.append(row)
            elif kind=='prepared-consumer-binding':prepared_consumers.append(row)
            else:need(kind in ['ptrace-event','signal-delivery','generated-mmap-unverified'],'unknown raw observer event')
        need(len(roots)==1 and not live and root_codes.get(roots[0])==0 and exclusive is None,'actual root/descendant wait closure incomplete')
        phase_tracking.append(dict(phase=phase,actualRootPid=roots[0],actualRootReturnCode=root_codes[roots[0]],waitReferences=waits))
    need(all(seq in clone_flags for seq,entry in entries.items() if entry['nr']==435),'clone3 lacks actual flags original')
    successful={}
    for seq,(cap,data) in caps.items():
        entry=entries[cap['entrySequence']];exit=exits.get(cap['entrySequence']);rules=POLICIES[entry['arch']]
        if exit and not exit['isError'] and (exit['result']==0 if cap['role']=='producer-close' else exit['result']>0):successful[seq]=(cap,data)
    for rename in renames:
        producer=successful.get(rename['producerCaptureSequence']);entry=entries.get(rename['entrySequence']);exit=exits.get(rename['entrySequence'])
        need(producer and entry and entry['nr'] in POLICIES[entry['arch']]['renameOps'] and exit and not exit['isError'] and exit['result']==0,'rename lacks successful actual close/rename originals')
        need(paths.get(rename['entrySequence'])==[rename['fromPath'],rename['toPath']] and rename['identity']==rename['retainedIdentity'] and rename['identity'][:2]==producer[0]['identity'][:2],'temporary rename retained-FD/path originals differ')
    covered={};pending=[]
    for binding in consumers:
        consumer=successful.get(binding['captureSequence']);producer=successful.get(binding['producerCaptureSequence'])
        if consumer is None:continue # Interrupted read/mmap does not prove consumption.
        need(producer and producer[0]['role']=='producer-close' and consumer[0]['role']=='consumer','consumer actual producer close missing')
        cap,data=consumer;old,expected=producer;need(cap['identity']==binding['identity']==binding['retainedIdentity'] and cap['identity'][:2]==old['identity'][:2],'consumer retained FD inode differs')
        if cap['path']!=old['path']:need(any(r['producerCaptureSequence']==old['sequence'] and r['toPath']==cap['path'] for r in renames),'consumer lacks actual temporary-to-final rename')
        need(data==expected,'actual generated bytes changed between producer close and consumer read');covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],producerCaptureSequence=old['sequence'],consumerCaptureSequence=cap['sequence'])
    prepared_covered={}
    for binding in prepared_consumers:
        consumer=successful.get(binding['captureSequence']);original=prepared.get(binding['producerCaptureSequence'])
        if consumer is None:continue
        need(prepared_sealed and original and consumer[0]['role']=='consumer','prepared consumer has no actual sealed original')
        cap,data=consumer;prior,expected=original
        need(cap['path']==binding['path']==prior['path'] and cap['identity']==binding['identity']==binding['retainedIdentity'] and cap['identity'][:2]==prior['identity'][:2] and data==expected,'actual prepared consumer bytes/FD relation differs')
        prepared_covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],preparedCaptureSequence=prior['sequence'],consumerCaptureSequence=cap['sequence'])
    if required_inputs is None:
        for name in ['config.h','generated.h','custom.h']:
            if not any(path.endswith('/'+name) for path in covered):pending.append('actual-successful-generated-consumer-missing:'+name)
    else:
        for path,expected in required_inputs.items():
            actual=covered.get(path)
            if actual is None:pending.append('actual-successful-generated-consumer-missing:'+path)
            else:need(actual['bytes']==expected['bytes'] and actual['sha256']==expected['sha256'],'actual generated consumer differs from selected full-shard input')
    return dict(schemaVersion=1,kind='all-stop-CMake-generated-byte-mechanics',selectedGeneratedConsumerByteCustodyVerified=not pending,outputs=sorted(covered.values(),key=lambda row:row['path']),observedSourceReadCaptures=len(source_reads),pending=pending,overallSdkSourceVerified=False,
                preparedInputConsumers=list(prepared_covered.values()),preparedInputConsumerBytesVerified=bool(prepared_covered),phaseTracking=phase_tracking,scope='actual producer-close/rename/consumer bytes only; reviewed observer execution/Git/source/runtime authority independent')

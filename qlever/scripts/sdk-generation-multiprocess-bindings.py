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
def verify_write_bytes(before,buffer,after,before_size,offset,count,maximum,check=lambda:None):
    """Bounded sequential pure write(2) reconstruction; no metadata approval."""
    need(type(offset) is int and offset>=0 and type(count) is int and count>=0 and max(before_size,offset+count)<=maximum,'write reconstruction bound')
    class Reader:
        def __init__(self,blocks):self.blocks=iter(blocks);self.pending=b'';self.done=False
        def take(self,n):
            need(0<=n<=65536,'write comparison chunk bound');out=bytearray()
            while len(out)<n:
                check()
                if not self.pending:
                    try:self.pending=next(self.blocks);need(isinstance(self.pending,bytes) and 0<len(self.pending)<=65536,'bounded write original block')
                    except StopIteration:self.done=True;break
                take=min(n-len(out),len(self.pending));out.extend(self.pending[:take]);self.pending=self.pending[take:]
            return bytes(out)
        def skip(self,n):
            while n:
                part=self.take(min(n,65536));need(part,'short pre-write original');n-=len(part)
    pre=Reader(before);payload=Reader(buffer);post=Reader(after);pre_position=0;position=0
    expected_size=max(before_size,offset+count) if count else before_size
    while position<expected_size:
        size=min(65536,expected_size-position);expected=bytearray()
        while len(expected)<size:
            at=position+len(expected)
            if count and offset<=at<offset+count:
                n=min(size-len(expected),offset+count-at);part=payload.take(n);need(len(part)==n,'short actual write buffer');expected.extend(part)
            elif at<before_size:
                if pre_position<at:pre.skip(at-pre_position);pre_position=at
                n=min(size-len(expected),before_size-at,(offset-at if count and at<offset else size));part=pre.take(n);need(len(part)==n,'short pre-write image');pre_position+=n;expected.extend(part)
            else:
                n=min(size-len(expected),offset-at if count and at<offset else size);need(n>0,'invalid write gap');expected.extend(bytes(n))
        need(post.take(size)==bytes(expected),'actual post-write bytes differ from syscall buffer projection');position+=size
    need(post.take(1)==b'','actual post-write original has extra bytes')
    return expected_size

def observe(phase_lines,read_original,required_inputs=None,check=lambda:None,limits=None,capture_observer=None):
    maximum_raw=limits['sourceMaterialBytes'] if limits else 32*1024**2
    maximum_file=limits['shardBytes'] if limits else 1024**2
    maximum_total=limits['sourceMaterialBytes'] if limits else 16*1024**2
    original_cache={};retained_entries=set();phase_tracking=[]
    live=set();last=0;entries={};exits={};barriers={};caps={};paths={};renames=[];consumers=[];source_reads=[];total=0;capture_total=0;exclusive=None;root_codes={};clone_flags=set()
    mode_windows={};mode_transitions={};namespace_bindings=[]
    write_windows={};closed_write_windows=set();write_transitions={};write_consumers=[];write_read_exits={}
    empty_windows={};empty_eofs=set()
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
            elif kind=='actual-mode-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'],'actual chmod entry/barrier differs')
                modes={0xc000003e:{90:1,91:1,268:2},0xc00000b7:{52:1,53:2}}[entry['arch']]
                need(entry['nr'] in modes and entry['args'][modes[entry['nr']]]==row['requestedMode'] and len(row['beforeIdentity'])==6,'actual chmod syscall/mode differs');mode_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-mode-resume':
                window=mode_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual chmod exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-mode-transition':
                window=mode_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and not row['isError'] and row['result']==0,'actual chmod exit differs')
                before=window['beforeIdentity'];after=row['afterIdentity'];need(len(after)==6 and after[:2]==before[:2] and after[3:5]==before[3:5] and after[2]&0o170000==before[2]&0o170000 and after[2]&0o7777==window['requestedMode']&0o7777,'actual chmod changed byte identity or wrong mode');mode_transitions[row['sequence']]=(window,row)
            elif kind=='retained-fd-namespace-binding':namespace_bindings.append(row)
            elif kind=='write-original':capture_data(row['original'])
            elif kind=='actual-write-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'] and entry['nr']==policy(entry['arch'])['write'] and entry['args'][0]==row['fd'],'actual write entry/barrier differs')
                need(row['flags']&3==2 and row['writers']==[dict(pid=row['pid'],fd=row['fd'])] and row['offset']==(row['beforeIdentity'][3] if row['flags']&1024 else row['position']),'actual write has another alias or offset differs')
                before=capture_data(row['before']);buffer=capture_data(row['buffer']);need(before[0]==row['beforeIdentity'][3] and buffer[0]==entry['args'][2],'write originals differ from actual dimensions')
                baseline=row['baseline']
                if baseline=='empty':need(before[0]==0,'nonempty write preimage has no original authority')
                elif baseline in write_transitions:
                    prior=write_transitions[baseline];need(prior['afterIdentity']==row['beforeIdentity'] and capture_data(prior['after'])==before,'write preimage differs from previous actual transition')
                else:
                    prior=prepared.get(baseline) or caps.get(baseline);need(prior and prior[0]['identity']==row['beforeIdentity'] and prior[1]==before,'write preimage has no retained original')
                    if baseline in caps:
                        previous=exits.get(prior[0]['entrySequence']);need(prior[0]['role']=='producer-close' and previous and not previous['isError'] and previous['result']==0,'write baseline lacks actual producer close')
                write_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-write-resume':
                window=write_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual write exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-write-transition':
                window=write_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'],'actual write exit/window differs')
                need(not exit['isError'] and row['isError'] is False and row['result']==exit['result'] and 0<=row['result']<=window['buffer']['bytes'] and row['afterIdentity'][:3]==window['beforeIdentity'][:3],'actual write result/identity differs')
                after=capture_data(row['after']);need(after[0]==row['afterIdentity'][3],'actual write after identity/size differs')
                def blocks(ref):
                    value=read_original(ref['path'],maximum_file)
                    if isinstance(value,bytes):return (value[i:i+65536] for i in range(0,len(value),65536))
                    return value
                need(verify_write_bytes(blocks(window['before']),blocks(window['buffer']),blocks(row['after']),window['beforeIdentity'][3],window['offset'],row['result'],maximum_file,check)==after[0],'actual write size projection differs')
                need(window['sequence'] not in closed_write_windows,'duplicate actual write transition');closed_write_windows.add(window['sequence']);write_transitions[row['sequence']]=row
            elif kind=='actual-write-consumer-binding':write_consumers.append(row)
            elif kind=='actual-write-consumer-exit':
                cap=caps.get(row['captureSequence']);exit=exits.get(row['entrySequence'])
                need(cap and cap[0]['role']=='readwrite-consumer' and exclusive==(row['pid'],row['entrySequence']) and cap[0]['entrySequence']==row['entrySequence'] and exit and exit['sequence']==row['exitSequence'],'own-RW read actual exclusive exit differs')
                need(not exit['isError'] and not row['isError'] and row['result']==exit['result'] and 0<=row['result']<=entries[row['entrySequence']]['args'][2] and row['identity']==cap[0]['identity'] and (row['bytes'],row['sha256'])==cap[1],'own-RW read changed bytes or invalid result');need(type(row['readOffset']) is int and row['readOffset']>=0 and row['positionAfter']==row['readOffset']+row['result'] and row['result']<=max(0,cap[1][0]-row['readOffset']),'own-RW actual read range differs');write_read_exits[row['captureSequence']]=row
            elif kind=='empty-read-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence'])
                need(entry and barrier and entry['pid']==row['pid'] and row['pid'] in barrier['pids'] and entry['nr']==policy(entry['arch'])['read'] and entry['args'][0]==row['fd'] and entry['args'][2]>0,'empty read actual entry/barrier differs')
                need(len(row['identity'])==6 and row['identity'][3]==0 and row['flags']&3==2 and row['writers']==[dict(pid=row['pid'],fd=row['fd'],flags=row['flags'],accessMode=2)],'empty read has nonempty file or another writable alias')
                empty_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-empty-read-resume':
                window=empty_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'empty read exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='empty-read-eof':
                window=empty_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and window['sequence'] not in empty_eofs and exclusive==(row['pid'],row['entrySequence']) and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'empty read EOF window differs')
                need(exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and row['result']==0 and row['isError'] is False and row['identity']==window['identity'],'empty read did not retain identity and actual zero result');empty_eofs.add(window['sequence'])
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
                rules=POLICIES[entry['arch']];need(row['role'] in ['producer-close','consumer','source-read','readwrite-consumer'],'unknown capture role')
                nr=entry['nr'];fd_index=4 if nr==rules['mmap'] else 0;need(row['fd']==entry['args'][fd_index],'capture actual FD differs')
                if row['role']=='producer-close':need(nr==rules['close'] and row['writers']==[dict(pid=row['pid'],fd=row['fd'])],'producer has another writable alias')
                elif row['role']=='readwrite-consumer':
                    need(nr==rules['read'] and len(row['writers'])==1 and row['writers'][0]['pid']==row['pid'] and row['writers'][0]['fd']==row['fd'] and row['writers'][0]['accessMode']==2 and row['writers'][0]['flags']&3==2,'own-RW read has another writable alias')
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
    need(len(mode_windows)==len(mode_transitions),'actual chmod window missing actual exit')
    need(len(write_windows)==len(write_transitions),'actual write window missing exit transition')
    need({seq for seq,(row,_) in caps.items() if row['role']=='readwrite-consumer'}==set(write_read_exits),'own-RW read missing actual stable exit')
    need(set(empty_windows)==empty_eofs,'empty read missing actual EOF closure')
    need(all(seq in clone_flags for seq,entry in entries.items() if entry['nr']==435),'clone3 lacks actual flags original')
    successful={}
    for seq,(cap,data) in caps.items():
        entry=entries[cap['entrySequence']];exit=exits.get(cap['entrySequence']);rules=POLICIES[entry['arch']]
        if exit and not exit['isError'] and (exit['result']==0 if cap['role']=='producer-close' else exit['result']>0):successful[seq]=(cap,data)
    for rename in renames:
        producer=successful.get(rename['producerCaptureSequence']);entry=entries.get(rename['entrySequence']);exit=exits.get(rename['entrySequence'])
        need(producer and entry and entry['nr'] in POLICIES[entry['arch']]['renameOps'] and exit and not exit['isError'] and exit['result']==0,'rename lacks successful actual close/rename originals')
        need(paths.get(rename['entrySequence'])==[rename['fromPath'],rename['toPath']] and rename['identity']==rename['retainedIdentity'] and rename['identity'][:2]==producer[0]['identity'][:2],'temporary rename retained-FD/path originals differ')
    namespaces=set()
    for relation in namespace_bindings:
        producer=successful.get(relation['producerCaptureSequence']);consumer=caps.get(relation['consumerCaptureSequence'])
        need(producer and consumer and producer[0]['role']=='producer-close' and consumer[0]['role']=='consumer' and producer[0]['sequence']<consumer[0]['sequence']<relation['sequence'],'namespace binding lacks prior retained producer/current consumer')
        before=producer[0]['identity'];current=before
        for reference in relation['modeTransitions']:
            pair=mode_transitions.get(reference);need(pair and producer[0]['sequence']<reference<consumer[0]['sequence'] and pair[0]['beforeIdentity']==current,'namespace mode change has no actual chmod chain');current=pair[1]['afterIdentity']
        identity=consumer[0]['identity'];need(current[2]==identity[2] and identity[:2]==before[:2] and relation['path']==consumer[0]['path'] and relation['namedIdentity']==relation['retainedIdentity']==identity and producer[1]==consumer[1],'actual named path/retained FD byte identity differs');namespaces.add((producer[0]['sequence'],consumer[0]['sequence']))
    covered={};pending=[]
    for binding in consumers:
        consumer=successful.get(binding['captureSequence']);producer=successful.get(binding['producerCaptureSequence'])
        if consumer is None:continue # Interrupted read/mmap does not prove consumption.
        need(producer and producer[0]['role']=='producer-close' and consumer[0]['role']=='consumer','consumer actual producer close missing')
        cap,data=consumer;old,expected=producer;need(cap['identity']==binding['identity']==binding['retainedIdentity'] and cap['identity'][:2]==old['identity'][:2],'consumer retained FD inode differs')
        if cap['path']!=old['path']:need((old['sequence'],cap['sequence']) in namespaces or any(r['producerCaptureSequence']==old['sequence'] and r['toPath']==cap['path'] for r in renames),'consumer lacks actual temporary-to-final rename or named FD identity')
        need(data==expected,'actual generated bytes changed between producer close and consumer read');covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],producerCaptureSequence=old['sequence'],consumerCaptureSequence=cap['sequence'])
    for binding in write_consumers:
        consumer=successful.get(binding['captureSequence']);transition=write_transitions.get(binding['transitionSequence'])
        if consumer is None:continue
        need(transition and consumer[0]['role']=='readwrite-consumer' and consumer[0]['identity']==transition['afterIdentity']==binding['identity'] and consumer[1]==capture_data(transition['after']) and consumer[0]['path']==binding['path'],'own-RW read lacks exact actual write byte provenance')
        cap,data=consumer;need(binding['readOffset']==write_read_exits[cap['sequence']]['readOffset'],'own-RW read offset binding differs');covered[cap['path']]=dict(path=cap['path'],bytes=data[0],sha256=data[1],writeTransitionSequence=transition['sequence'],consumerCaptureSequence=cap['sequence'],origin='actual-exclusive-write-transition')
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
                observedActualModeTransitions=len(mode_transitions),observedNamedRetainedFdBindings=len(namespaces),observedActualWriteTransitions=len(write_transitions),observedEmptyReadEofWindows=len(empty_eofs),preparedInputConsumers=list(prepared_covered.values()),preparedInputConsumerBytesVerified=bool(prepared_covered),phaseTracking=phase_tracking,scope='actual producer-close/rename/consumer bytes only; reviewed observer execution/Git/source/runtime authority independent')

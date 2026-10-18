"""Pure all-stop generated-file byte relations from actual observer originals.

Not a capability. Controlled observer/TCB execution, Git inputs and upstream
runtime/toolchain authority remain independent of this mechanical axis.
"""
import hashlib
import json
import re
import struct
POLICIES={
 0xc00000b7:dict(exec={221,281},execveat=281,protect={226,288},read=63,write=64,close=57,mmap=222,clone=220,clone3=435,spawn={220,435},renameat=38,renameat2=276,renameOps={38,276},exits={93,94},forbidden={0,1,2,3,4,292,425,426,427,271,117,97,268}),
 0xc000003e:dict(exec={59,322},execveat=322,protect={10,329},read=0,write=1,close=3,mmap=9,clone=56,clone3=435,spawn={56,57,58,435},rename=82,renameat=264,renameat2=316,renameOps={82,264,316},exits={60,231},forbidden={206,207,208,209,210,333,425,426,427,311,101,272,308}),
}
def policy(arch):
    if arch not in POLICIES:raise ValueError('unsupported actual kernel architecture')
    return POLICIES[arch]

def need(value,reason):
    if not value:raise ValueError('multi-process generation originals: '+reason)
def append_boundary_syscall(arch,nr,args=None):
    rules=policy(arch)
    # open/openat allocate a descriptor; they do not consume file contents.
    # Only a fully decoded, non-truncating flags word may defer checkpoint to
    # the actual later read/mmap/exec/close. Unknown inputs stay fail-closed.
    flag_index={0xc000003e:{2:1,257:2},0xc00000b7:{56:2}}[arch].get(nr)
    if flag_index is not None:
        if not isinstance(args,(list,tuple)) or len(args)!=6 or not all(type(value) is int and 0<=value<(1<<64) for value in args):return True
        flags=args[flag_index]
        if type(flags) is not int or not 0<=flags<(1<<64):return True
        return bool(flags&0x200) # Linux O_TRUNC, on both reviewed ABIs.
    # Before exec, mapping, namespace/mode/size or descriptor replacement can
    # change what a retained append image denotes. Socket reads are not file
    # consumers and do not trigger a full checkpoint per network packet.
    extra={0xc000003e:{2,3,9,11,59,76,77,85,86,87,90,91,257,263,265,268,292,322,436,32,33,72},
           0xc00000b7:{23,24,25,35,36,45,46,49,52,53,56,57,215,221,222,281,436}}[arch]
    return nr in extra or nr in rules['renameOps']

def inspect_shared_clone_flags(flags):
    need(type(flags) is int and flags>=0,'actual clone flags required')
    allowed=0xff|0x100|0x200|0x400|0x800|0x4000|0x8000|0x10000|0x40000|0x80000|0x100000|0x200000|0x1000000|0x100000000
    need(flags&~allowed==0,'unknown clone ownership flags')
    need(not(flags&0x800) or flags&0x100,'CLONE_SIGHAND requires shared VM')
    need(not(flags&0x10000) or flags&0x100 and flags&0x800 and flags&0xff==0,'thread clone has invalid VM/signal ownership')
    return dict(sharedFdTable=bool(flags&0x400),sameThreadGroup=bool(flags&0x10000),sharedMemory=bool(flags&0x100))

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
def parse_proc_maps(raw):
    need(isinstance(raw,bytes) and len(raw)<=4*1024**2,'bounded maps original required')
    result=[];previous=0
    for number,line in enumerate(raw.splitlines(),1):
        need(len(line)<=65536,'maps line bound')
        match=re.fullmatch(rb'([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) ([0-9a-f]+) ([0-9a-f]+):([0-9a-f]+) ([0-9]+)(?: +(.*))?',line)
        need(match is not None,'actual proc maps syntax required')
        start,end=int(match[1],16),int(match[2],16);need(previous<=start<end,'ordered nonoverlapping actual VMA required');previous=end
        path=(match[8] or b'').decode('utf-8','strict')
        result.append(dict(startHex=format(start,'x'),endHex=format(end,'x'),permissions=match[3].decode(),fileOffset=int(match[4],16),deviceMajor=int(match[5],16),deviceMinor=int(match[6],16),inode=int(match[7]),path=path,mapsLineIndex=number))
    return result

def verify_vma_range(mappings,begin,length,protection):
    need(type(begin) is int and type(length) is int and 0<=begin<begin+length<=1<<64,'actual mapping range overflow')
    end=begin+length;cursor=begin;selected=[]
    for mapping in mappings:
        start,stop=int(mapping['startHex'],16),int(mapping['endHex'],16)
        if start>=end or stop<=begin:continue
        need(start<=cursor<stop,'actual mapping VMA range has a hole')
        need(all(not(protection&bit) or letter in mapping['permissions'] for bit,letter in [(1,'r'),(2,'w'),(4,'x')]),'actual VMA permissions differ from successful syscall')
        cursor=min(stop,end);selected.append(mapping)
    need(cursor==end,'actual mapping VMA does not cover successful returned range');return selected

def elf_interpreter(read,size):
    # Fixed supported SDK targets use little-endian ELF64. This function reads
    # the retained FD/capture bytes, never executes or follows PT_INTERP.
    header=read(0,min(size,64));need(len(header)>=64 and header[:6]==b'\x7fELF\x02\x01','supported actual ELF64 required')
    machine=struct.unpack_from('<H',header,18)[0];need(header[6]==1 and struct.unpack_from('<H',header,16)[0] in [2,3] and struct.unpack_from('<I',header,20)[0]==1 and struct.unpack_from('<H',header,52)[0]==64 and machine in [62,183],'supported ELF machine/header required')
    offset=struct.unpack_from('<Q',header,32)[0];stride,count=struct.unpack_from('<HH',header,54)
    need(stride==56 and 0<count<=4096 and offset+count*stride<=size,'bounded ELF program headers required')
    interpreter=None
    for index in range(count):
        row=read(offset+index*stride,stride);need(len(row)==stride,'truncated ELF program header')
        if struct.unpack_from('<I',row)[0]!=3:continue
        begin,length=struct.unpack_from('<Q',row,8)[0],struct.unpack_from('<Q',row,32)[0]
        need(interpreter is None and 1<length<=4096 and begin+length<=size,'unique bounded ELF PT_INTERP required')
        raw=read(begin,length);need(len(raw)==length and raw[-1:]==b'\0' and b'\0' not in raw[:-1],'actual interpreter encoding required')
        interpreter=raw[:-1].decode('utf-8','strict');need(interpreter.startswith('/') and '\n' not in interpreter,'absolute actual interpreter path required')
    return dict(machine=machine,interpreter=interpreter)

def write_segments(before,offset,count,buffer,maximum):
    """Immutable original slices, not full postimage copies. Zero gaps explicit."""
    need(type(maximum) is int and maximum>=0,'exact write projection maximum required')
    need(type(offset) is int and offset>=0 and type(count) is int and count>=0,'nonnegative exact write offset/count required')
    need(all(type(at) is int and at>=0 and type(n) is int and n>=0 and (ref is None or type(ref.get('bytes')) is int and 0<=at<=at+n<=ref['bytes']<=maximum) for ref,at,n in before),'bounded original delta segment required')
    size=sum(item[2] for item in before);need(size<=maximum and offset+count<=maximum and type(buffer.get('bytes')) is int and 0<=count<=buffer['bytes']<=maximum,'write projection size/range bound');result=[]
    def subset(start,end):
        position=0
        for ref,at,n in before:
            left=max(start,position);right=min(end,position+n)
            if right>left:result.append((ref,at+left-position,right-left))
            position+=n
    if not count:return list(before)
    subset(0,min(offset,size))
    if offset>size:result.append((None,0,offset-size))
    result.append((buffer,0,count));subset(offset+count,size)
    need(len(result)<=65536,'write delta segment count unsupported')
    return result

def segment_blocks(segments,read_blocks,check=lambda:None):
    for ref,start,length in segments:
        if ref is None:
            while length:check();n=min(length,65536);yield bytes(n);length-=n
            continue
        position=0
        for block in read_blocks(ref):
            check();need(isinstance(block,bytes) and 0<len(block)<=65536,'bounded delta original block')
            left=max(start,position);right=min(start+length,position+len(block))
            if right>left:yield block[left-position:right-position]
            position+=len(block)
            if position>=start+length:break
        need(position>=start+length,'short write delta original slice')

def digest_blocks(blocks,maximum,check=lambda:None):
    count=0;digest=hashlib.sha256()
    for block in blocks:
        check();need(isinstance(block,bytes) and len(block)<=65536,'bounded write digest chunk');count+=len(block);need(count<=maximum,'write digest byte bound');digest.update(block)
    return dict(bytes=count,sha256=digest.hexdigest())

def observe(phase_lines,read_original,required_inputs=None,check=lambda:None,limits=None,capture_observer=None):
    maximum_raw=limits['sourceMaterialBytes'] if limits else 32*1024**2
    maximum_file=limits['shardBytes'] if limits else 1024**2
    maximum_total=limits['sourceMaterialBytes'] if limits else 16*1024**2
    original_cache={};retained_entries=set();phase_tracking=[]
    shared_mode=False;owners={};exec_fd_events={};vfork_events={};vfork_holds={};child_bindings={};wait_rows={}
    live=set();last=0;entries={};exits={};barriers={};caps={};paths={};renames=[];consumers=[];source_reads=[];total=0;capture_total=0;exclusive=None;root_codes={};clone_flags=set();clone_flag_values={}
    alias_close_windows={};alias_close_exits=set()
    mode_windows={};mode_transitions={};namespace_bindings=[]
    append_obligations={};append_completed={};append_dirty={};append_checkpoints={};append_hashes={};write_projections={};write_windows={};closed_write_windows=set();write_transitions={};write_consumers=[];write_read_exits={}
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
    tool_originals={};tool_files={};tool_pending=set();tool_execs=0;tool_mappings=0;tool_core=None;exec_events={};tool_exec_paths={};tool_protect_before={};tool_digest=hashlib.sha256()
    def tool_ref(reference,kind=None):
        value=tool_originals.get(reference['path']);need(value and value['original']==reference and (kind is None or value['captureKind']==kind),'toolchain reference lacks actual complete original')
        return value
    def tool_maps(reference):
        tool_ref(reference,'maps');need(reference['bytes']<=4*1024**2,'bounded maps original')
        original=read_original(reference['path'],maximum_file);blocks=[original] if isinstance(original,bytes) else original;parts=[];count=0;digest=hashlib.sha256()
        for block in blocks:
            check();need(isinstance(block,bytes) and len(block)<=65536,'bounded maps block');count+=len(block);need(count<=reference['bytes'],'maps byte bound');digest.update(block);parts.append(block)
        need((count,digest.hexdigest())==(reference['bytes'],reference['sha256']),'maps original changed')
        return parse_proc_maps(b''.join(parts))
    def tool_barrier(row):
        value=barriers.get(row['barrierSequence']);need(value and value['pids']==sorted(live) and row['pid'] in live,'tool snapshot lacks complete actual stop barrier')
    def tool_elf(reference):
        original=read_original(reference['path'],maximum_file);iterator=iter([original] if isinstance(original,bytes) else original);prefix=bytearray()
        def read(offset,size):
            need(0<=offset and size<=65536 and offset+size<=min(reference['bytes'],4*1024**2),'ELF metadata window bound')
            while len(prefix)<offset+size:
                check();block=next(iterator,b'');need(block and isinstance(block,bytes) and len(block)<=65536,'truncated ELF original');prefix.extend(block);need(len(prefix)<=4*1024**2,'ELF metadata prefix bound')
            return bytes(prefix[offset:offset+size])
        try:return elf_interpreter(read,reference['bytes'])
        except ValueError as error:return dict(unresolved='actual-ELF-interpreter-unclassified:'+str(error)[:256])
        finally:
            if hasattr(original,'close'):original.close()
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
            elif kind=='owned-root-binding':
                need(not live and not roots,'unique actual root required');live.add(row['pid']);roots.append(row['pid']);need(row['backend']=='ptrace-all-stop-process-v1','wrong observer backend')
                need(row.get('taskOwnershipModel') in [None,'all-tracked-tids-shared-fd-v1'],'unknown task ownership model');shared_mode=row.get('taskOwnershipModel') is not None;owners={}
                if shared_mode:need(row['tgid']==row['fdTable']==row['pid'],'initial root ownership differs');owners[row['pid']]=dict(tgid=row['tgid'],fdTable=row['fdTable'])
            elif kind=='actual-child-binding':
                child_bindings[row['childPid']]=row
                need(row['parentPid'] in live and row['childPid'] not in live,'unobserved actual child binding')
                if shared_mode:
                    parent=owners[row['parentPid']];entry=entries.get(row['cloneEntrySequence']);need(entry and entry['pid']==row['parentPid'],'child ownership lacks actual clone entry');rules=policy(entry['arch'])
                    if entry['nr'] in [rules['clone'],435]:need(entry['sequence'] in clone_flags and clone_flag_values[entry['sequence']]==row['cloneFlags'],'child actual clone flags differ')
                    else:need(entry['arch']==0xc000003e and entry['nr'] in [57,58] and row['cloneFlags']==17|(0x4100 if entry['nr']==58 else 0),'unknown child fork operation')
                    ownership=inspect_shared_clone_flags(row['cloneFlags']);need(row['tgid']==(parent['tgid'] if ownership['sameThreadGroup'] else row['childPid']) and row['fdTable']==(parent['fdTable'] if ownership['sharedFdTable'] else row['childPid']),'child TGID/FD table differs from kernel clone flags');owners[row['childPid']]=dict(tgid=row['tgid'],fdTable=row['fdTable'])
                live.add(row['childPid'])
            elif kind=='actual-wait-exit':
                need(row['pid'] not in vfork_holds,'held vfork parent ended without child release');wait_rows[row['sequence']]=row
                need(row['pid'] in live,'wait on unknown process');live.remove(row['pid']);root_codes[row['pid']]=row['returnCode'];waits.append(dict(pid=row['pid'],sequence=row['sequence'],returnCode=row['returnCode'],phase=phase))
            elif kind=='all-stop-barrier':
                need(row['pids']==sorted(live) and row['osStates']==['t']*len(live),'potential writer not in actual complete tracing-stop barrier')
                if shared_mode:need(row['taskOwnership']==[dict(tid=pid,**owners[pid]) for pid in sorted(live)],'complete actual TID/TGID/shared-table ownership differs')
                barriers[row['sequence']]=row
            elif kind=='actual-exec-fd-table-unshare':
                event=exec_fd_events.get(row['eventSequence']);owner=owners.get(row['pid']);need(shared_mode and owner and event and event['pid']==row['pid'] and owner['tgid']==row['pid']==row['tgid'] and owner['fdTable']==row['priorFdTable'] and row['fdTable']==-event['sequence'],'exec FD-table unshare lacks actual leader exec event');owner['fdTable']=row['fdTable'];exec_fd_events.pop(row['eventSequence'])
            elif kind=='alias-close-window':
                entry=entries.get(row['entrySequence']);barrier=barriers.get(row['barrierSequence']);need(entry and barrier and row['pid']==entry['pid'] and entry['nr']==policy(entry['arch'])['close'] and entry['args'][0]==row['fd'],'alias close actual syscall differs')
                table_owners=sorted(pid for pid in live if owners[pid]['fdTable']==owners[row['pid']]['fdTable']) if shared_mode else [row['pid']]
                need(row['tableOwners']==table_owners and row['pid'] in barrier['pids'],'alias close table owner set differs');keys=set()
                for alias in row['aliases']:
                    need(alias['pid'] in barrier['pids'] and alias['flags']&3 in [1,2] and alias['accessMode']==alias['flags']&3,'alias close has no observed writable slot');keys.add((owners[alias['pid']]['fdTable'] if shared_mode else alias['pid'],alias['fd']))
                need(len(keys)>1 and (owners[row['pid']]['fdTable'] if shared_mode else row['pid'],row['fd']) in keys,'alias close does not refer to selected multi-alias slot');alias_close_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-alias-close-resume':
                window=alias_close_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'alias close exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='alias-close-exit':
                window=alias_close_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and window['sequence'] not in alias_close_exits and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'] and not exit['isError'] and exit['result']==0 and not row['isError'] and row['result']==0,'alias close missing actual successful exit')
                need(row['retainedIdentity'][:2]==window['identity'][:2] and row['slotAbsences']==[dict(tid=pid,fd=window['fd'],errorCode=2) for pid in window['tableOwners']],'alias close has no actual same-table slot absence');alias_close_exits.add(window['sequence'])
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
                need(all(type(row[key]) is int and 0<=row[key]<=maximum_file for key in ['position','offset']) and type(entry['args'][2]) is int and 0<=entry['args'][2]<=maximum_file and row['offset']+entry['args'][2]<=maximum_file,'exact bounded write position/offset/count required')
                need(row['flags']&3==2 and row['writers']==[dict(pid=row['pid'],fd=row['fd'])] and row['offset']==(row['beforeIdentity'][3] if row['flags']&1024 else row['position']),'actual write has another alias or offset differs')
                delta=row.get('format') in ['bounded-write-delta-v1','bounded-append-effect-v1'];need(row.get('format') in [None,'bounded-write-delta-v1','bounded-append-effect-v1'],'unknown write evidence format')
                before=(row['before']['bytes'],row['before']['sha256']) if delta else capture_data(row['before']);buffer=capture_data(row['buffer']);need(before[0]==row['beforeIdentity'][3] and buffer[0]==entry['args'][2],'write originals differ from actual dimensions')
                baseline=row['baseline']
                if baseline=='empty':need(before[0]==0,'nonempty write preimage has no original authority')
                elif baseline in write_transitions:
                    prior=write_transitions[baseline];need(prior['afterIdentity']==row['beforeIdentity'] and ((prior['after']['bytes'],prior['after']['sha256']) if 'path' not in prior['after'] else capture_data(prior['after']))==before,'write preimage differs from previous actual transition')
                else:
                    prior=prepared.get(baseline) or caps.get(baseline);need(prior and prior[0]['identity']==row['beforeIdentity'] and prior[1]==before,'write preimage has no retained original')
                    if baseline in caps:
                        previous=exits.get(prior[0]['entrySequence']);need(prior[0]['role']=='producer-close' and previous and not previous['isError'] and previous['result']==0,'write baseline lacks actual producer close')
                if delta:
                    key=tuple(row['beforeIdentity'][:2])
                    if baseline in write_transitions:
                        projection=write_projections.get(key);need(projection and projection[0]==baseline,'delta preimage is not latest actual transition');segments=projection[1]
                    else:
                        initial=row['initialBefore'];need(capture_data(initial)==before,'initial write delta preimage differs');segments=[(initial,0,before[0])] if before[0] else []
                    if row.get('format')=='bounded-append-effect-v1':
                        need(row['offset']==before[0],'append must begin at actual EOF')
                        if key not in append_hashes:
                            digest=hashlib.sha256()
                            # Use original reader streaming; never load a whole original.
                            def initial_blocks(ref):
                                value=read_original(ref['path'],maximum_file)
                                return (value[i:i+65536] for i in range(0,len(value),65536)) if isinstance(value,bytes) else value
                            for block in segment_blocks(segments,initial_blocks,check):digest.update(block)
                            need(digest.hexdigest()==before[1],'append baseline full digest differs');append_hashes[key]=digest
                    else:need(key not in append_dirty,'nonappend write before append full checkpoint')
                    write_projections[key]=(row['sequence'],segments)
                write_windows[row['sequence']]=row;retained_entries.add(row['entrySequence'])
            elif kind=='exclusive-write-resume':
                window=write_windows.get(row['captureSequence']);need(window and exclusive is None and window['pid']==row['pid'] and window['entrySequence']==row['entrySequence'],'actual write exclusive resume differs');exclusive=(row['pid'],row['entrySequence'])
            elif kind=='actual-write-transition':
                window=write_windows.get(row['windowSequence']);exit=exits.get(row['entrySequence'])
                need(window and exclusive==(row['pid'],row['entrySequence']) and window['entrySequence']==row['entrySequence'] and window['pid']==row['pid'] and exit and exit['sequence']==row['exitSequence'],'actual write exit/window differs')
                need(type(row['result']) is int and type(exit['result']) is int and not exit['isError'] and row['isError'] is False and row['result']==exit['result'] and 0<=row['result']<=window['buffer']['bytes'] and row['afterIdentity'][:3]==window['beforeIdentity'][:3],'actual write result/identity differs')
                def blocks(ref):
                    value=read_original(ref['path'],maximum_file)
                    return (value[i:i+65536] for i in range(0,len(value),65536)) if isinstance(value,bytes) else value
                if window.get('format') in ['bounded-write-delta-v1','bounded-append-effect-v1']:
                    need(set(row['after'])=={'bytes','sha256'},'delta after must be digest only')
                    key=tuple(window['beforeIdentity'][:2]);prior=write_projections.get(key);need(prior and prior[0]==window['sequence'],'delta window order differs')
                    if window.get('format')=='bounded-append-effect-v1':
                        need(row.get('afterObservation')=='uncheckpointed-append-projection','append effect is not an actual full snapshot')
                        segments=prior[1];digest=append_hashes[key];effect=hashlib.sha256();position=0
                        for block in blocks(window['buffer']):
                            check();chunk=block[:max(0,min(len(block),row['result']-position))]
                            if chunk:effect.update(chunk);digest.update(chunk);position+=len(chunk)
                            if position==row['result']:break
                        need(position==row['result'] and row.get('actualAppendEffect')==dict(bytes=position,sha256=effect.hexdigest()),'actual append range evidence differs')
                        if position:segments.append((window['buffer'],0,position))
                        expected=dict(bytes=window['beforeIdentity'][3]+position,sha256=digest.hexdigest())
                        need(expected==row['after'],'append projection digest differs');append_dirty[key]=row['sequence']
                    else:
                        segments=write_segments(prior[1],window['offset'],row['result'],window['buffer'],maximum_file)
                        expected=digest_blocks(segment_blocks(segments,blocks,check),maximum_file,check);need(expected==row['after'],'delta postimage does not reconstruct actual full SHA')
                    write_projections[key]=(row['sequence'],segments);after=(expected['bytes'],expected['sha256'])
                else:
                    after=capture_data(row['after'])
                    need(verify_write_bytes(blocks(window['before']),blocks(window['buffer']),blocks(row['after']),window['beforeIdentity'][3],window['offset'],row['result'],maximum_file,check)==after[0],'actual write size projection differs')
                need(after[0]==row['afterIdentity'][3],'actual write after identity/size differs')
                need(window['sequence'] not in closed_write_windows,'duplicate actual write transition');closed_write_windows.add(window['sequence']);write_transitions[row['sequence']]=row
            elif kind=='append-full-checkpoint':
                barrier=barriers.get(row['barrierSequence'])
                need((row['closedTrackedWaits'] is True and not live and row['barrierSequence'] is None) or (row['closedTrackedWaits'] is False and barrier and set(barrier['pids'])==live),'append checkpoint lacks actual all-stop/wait closure')
                transition=write_transitions.get(row['transitionSequence']);key=tuple(row['identity'][:2])
                need(transition and append_dirty.get(key)==transition['sequence'] and transition['afterIdentity']==row['identity'],'append checkpoint latest transition/identity differs')
                need(capture_data(row['original'])==(transition['after']['bytes'],transition['after']['sha256']),'append prefix/full checkpoint bytes differ')
                need(row['reason'] in ['nonappend-write','captured-access','syscall-boundary','toolchain-access','phase-final'],'unknown append checkpoint boundary')
                if row['entrySequence'] is not None:need(row['entrySequence'] in entries and row['entrySequence']<row['sequence'],'append checkpoint entry differs')
                append_checkpoints[transition['sequence']]=row;append_completed[key]=transition['sequence'];del append_dirty[key];del append_hashes[key]
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
                need(row['pid'] not in vfork_holds,'vfork parent resumed before actual child exec/terminal wait')
                need(row['pid'] in live and row['arch'] in POLICIES,'unknown syscall process/architecture');need(exclusive is None or exclusive[0]==row['pid'],'another potential writer ran during captured syscall')
                if row['op']=='entry':
                    if append_boundary_syscall(row['arch'],row['nr'],row['args']):append_obligations[row['sequence']]=dict(append_dirty)
                    rules=policy(row['arch']);need(row['nr'] not in rules['forbidden'],'unsupported asynchronous/external writer syscall')
                    if row['nr']==rules['clone']:
                        flags=row['args'][0]
                        if shared_mode:inspect_shared_clone_flags(flags)
                        else:need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared thread/FD clone')
                    if row['nr']==rules['mmap']:need(not(row['args'][2]&2 and row['args'][3]&1),'shared writable mapping')
                    if shared_mode:
                        need(not(row['nr']==436 and row['args'][2]&2),'unknown close_range UNSHARE table ownership')
                        if row['nr'] in ([59,322] if row['arch']==0xc000003e else [221,281]):need(row['pid']==owners[row['pid']]['tgid'],'nonleader exec TID replacement unsupported')
                    entries[row['sequence']]=row
                    if row['nr'] in rules['exec'] or row['nr'] in rules['protect'] and row['args'][2]&4 or row['nr']==rules['mmap'] and (not(row['args'][3]&0x20) or row['args'][2]&4):retained_entries.add(row['sequence'])
                elif row['op']=='exit':
                    if 'entrySequence' in row:
                        need(all(append_completed.get(key,0)>=sequence for key,sequence in append_obligations.pop(row['entrySequence'],{}).items()),'append checkpoint missing before actual syscall exit')
                        entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and row['entrySequence'] not in exits,'syscall exit binding differs')
                        if entry['nr']==435:need(row['entrySequence'] in clone_flags,'clone3 lacks actual flags original')
                        if row['isError'] and (entry['nr'] in policy(entry['arch'])['exec'] or entry['nr'] in policy(entry['arch'])['protect'] or entry['nr']==policy(entry['arch'])['mmap']):retained_entries.discard(row['entrySequence']);tool_protect_before.pop(row['entrySequence'],None)
                        if row['entrySequence'] in retained_entries:exits[row['entrySequence']]=row
                        else:entries.pop(row['entrySequence']);clone_flags.discard(row['entrySequence'])
                else:need(False,'unknown syscall-info operation')
            elif kind=='toolchain-original':
                need(not append_dirty,'tool/source output before mandatory append full checkpoint')
                need(bool(live) and row['captureKind'] in ['file','maps'],'actual tool original must be observed with live stopped tracees')
                data=capture_data(row['original']);need(row['original']['path'] not in tool_originals,'duplicate tool original')
                if row['captureKind']=='file':
                    need(len(row['identity'])==6 and row['identity'][3]==data[0],'tool FD identity/bytes differ');tool_files[row['original']['path']]=dict(observedPath=row['observedPath'],identity=row['identity'],original=row['original'])
                else:need(data[0]<=4*1024**2,'bounded maps metadata original')
                tool_originals[row['original']['path']]=row
            elif kind=='toolchain-exec-path-entry':
                tool_barrier(row);entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr']==row['syscall'] and entry['nr'] in policy(entry['arch'])['exec'] and isinstance(row['entryPath'],str) and len(row['entryPath'].encode())<=4096,'actual exec path entry differs');tool_exec_paths[row['sequence']]=row
            elif kind=='toolchain-exec-image-capture':
                tool_barrier(row);entry=entries.get(row['execEntrySequence']);event=exec_events.get(row['execEventSequence']);need(entry and event and entry['pid']==row['pid']==event['pid'] and entry['nr'] in policy(entry['arch'])['exec'],'actual exec entry/event relation differs');retained_entries.add(entry['sequence'])
                path_entry=tool_exec_paths.pop(row.get('execPathEntrySequence'),None)
                if path_entry:need(path_entry['entrySequence']==entry['sequence'] and path_entry['pid']==row['pid'] and path_entry['lexicalPath']==row['exe']['lexicalPath'],'actual exec path/executable snapshot differs')
                else:tool_pending.add('toolchain-exec-path-entry-original-unavailable')
                original=tool_ref(row['exe']['original'],'file');need(row['exe']['identity']==original['identity'] and row['elf']==tool_elf(original['original']),'actual exe FD/ELF bytes differ')
                tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=tool_maps(row['mapsOriginal']));tool_execs+=1;tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
                retained_entries.discard(entry['sequence']);exec_events.pop(row['execEventSequence'])
                if 'machine' in row['elf']:need(row['elf']['machine']=={0xc000003e:62,0xc00000b7:183}[entry['arch']],'actual executable ELF/kernel architecture differs')
                if 'unresolved' in row['elf']:tool_pending.add('toolchain-exec-ELF-interpreter-unclassified')
            elif kind=='toolchain-executable-protection-before':
                tool_barrier(row);entry=entries.get(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr'] in policy(entry['arch'])['protect'] and entry['args'][2]&4,'actual executable protection entry differs');retained_entries.add(entry['sequence']);tool_maps(row['mapsOriginal']);tool_protect_before[row['entrySequence']]=row['mapsOriginal']
            elif kind in ['toolchain-file-mapping-capture','toolchain-executable-protection-capture']:
                tool_barrier(row);entry=entries.get(row['entrySequence']);actual=exits.get(row['entrySequence']);need(entry and actual and actual['sequence']==row['exitSequence'] and entry['pid']==row['pid'] and not actual['isError'],'actual mapping/protection syscall result differs')
                args=entry['args']
                if kind=='toolchain-file-mapping-capture':
                    need(entry['nr']==policy(entry['arch'])['mmap'] and actual['result']>=0 and row['actualReturnedAddressHex']==format(actual['result'],'x') and row['requestedLength']==args[1] and row['fileOffset']==args[5] and row['flags']==args[3] and row['protection']==args[2],'actual mmap dimensions differ')
                    descriptor=row.get('actualFd')
                    if descriptor and 'original' in descriptor:need(descriptor['fd']==args[4] and tool_ref(descriptor['original'],'file')['identity']==descriptor['identity'],'actual mmap FD original differs')
                    maps=tool_maps(row['mapsOriginal']);selected=verify_vma_range(maps,actual['result'],args[1],args[2])
                    anonymous=bool(args[3]&0x20)
                    if anonymous:tool_pending.add('anonymous-or-JIT-mapping-source-unresolved');need(descriptor is None,'MAP_ANONYMOUS must not claim file descriptor authority')
                    tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=maps,mappingKind='mmap',begin=actual['result'],length=args[1],offset=args[5],anonymous=anonymous,descriptor=descriptor)
                else:
                    need(entry['nr'] in policy(entry['arch'])['protect'] and args[2]&4 and actual['result']==0 and row['actualSyscall']==entry['nr'] and row['requestedStartHex']==format(args[0],'x') and row['requestedLength']==args[1] and row['protection']==args[2] and row['beforeMapsOriginal']==tool_protect_before.get(entry['sequence']),'actual executable protection before/after relation differs')
                    if entry['nr'] in [329,288]:tool_pending.add('toolchain-protection-key-access-state-unverified')
                    maps=tool_maps(row['afterMapsOriginal']);actual_mappings=verify_vma_range(maps,args[0],args[1],args[2])
                    if any(mapping['inode']==0 or not mapping['path'].startswith('/') for mapping in actual_mappings):tool_pending.add('anonymous-or-JIT-mapping-source-unresolved')
                    tool_core=dict(sequence=row['sequence'],pid=row['pid'],maps=maps,mappingKind='protect',begin=args[0],length=args[1])
                entries.pop(entry['sequence']);exits.pop(entry['sequence']);retained_entries.discard(entry['sequence']);tool_protect_before.pop(entry['sequence'],None)
                tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
            elif kind=='toolchain-mapping-original':
                tool_barrier(row);need(tool_core and row['parentCaptureSequence']==tool_core['sequence'] and row['pid']==tool_core['pid'] and row['mapping'] in tool_core['maps'],'actual VMA snapshot relation differs')
                mapping=row['mapping'];need(mapping['inode']>0 and mapping['path'].startswith('/'),'anonymous/kernel VMA cannot claim file original authority');identity=row['identity'];need(len(identity)==6 and identity==tool_ref(row['original'],'file')['identity'],'mapped original FD/bytes differ')
                import os
                need((os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode']),'actual VMA inode/device differs from mapped FD')
                descriptor=row.get('actualFd')
                if tool_core.get('mappingKind')=='mmap':
                    need(not tool_core['anonymous'] and descriptor==tool_core['descriptor'] and descriptor is not None,'anonymous or different FD cannot claim mapped file original')
                    begin,end=tool_core['begin'],tool_core['begin']+tool_core['length'];start,stop=int(mapping['startHex'],16),int(mapping['endHex'],16)
                    need(start<end and stop>begin and mapping['fileOffset']+max(begin-start,0)==tool_core['offset']+max(start-begin,0),'actual mapped file offset/range differs')
                elif tool_core.get('mappingKind')=='protect':need(int(mapping['startHex'],16)<tool_core['begin']+tool_core['length'] and int(mapping['endHex'],16)>tool_core['begin'],'executable protection mapping outside actual requested range')
                if descriptor:need(descriptor['identity']==identity,'actual mapping process FD differs')
                tool_mappings+=1;tool_digest.update((json.dumps(row,sort_keys=True)+'\n').encode())
            elif kind=='toolchain-unresolved':tool_pending.add(row['reason'])
            elif kind=='kernel-clone-flags':
                entry=entries.get(row['entrySequence']);clone_flags.add(row['entrySequence']);need(entry and entry['pid']==row['pid'] and entry['nr'] in [policy(entry['arch'])['clone'],435],'clone memory flags entry differs');flags=row['flags'];clone_flag_values[row['entrySequence']]=flags
                if shared_mode:inspect_shared_clone_flags(flags)
                else:need(not flags&(0x10000|0x400) and flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown shared writer/FD flags')
                if flags&0x100:tool_pending.add('toolchain-shared-address-space-clone-unverified')
            elif kind=='kernel-path-arguments':need(row['entrySequence'] in entries and entries[row['entrySequence']]['pid']==row['pid'],'path original entry differs');paths[row['entrySequence']]=row['renamePaths'];retained_entries.add(row['entrySequence'])
            elif kind=='fd-capture':
                need(not append_dirty,'file capture before full append checkpoint')
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
            elif kind=='vfork-parent-held':
                parent=row['parentPid'];child=row['childPid'];event=vfork_events.get(row['eventSequence']);binding=child_bindings.get(child)
                need(parent in live and child in live and parent not in vfork_holds and event and event['pid']==parent and event['event']==2 and binding and binding['event']==2 and binding['parentPid']==parent,'VFORK hold lacks actual event/child binding')
                need(row['actualParentState']=='t' and row['entrySequence'] in entries and binding.get('cloneEntrySequence',row['entrySequence'])==row['entrySequence'],'VFORK hold lacks actual parent entry/stop')
                entry=entries[row['entrySequence']];need(entry['pid']==parent and (clone_flag_values.get(entry['sequence'],0)&0x4000 or entry['arch']==0xc000003e and entry['nr']==58),'VFORK hold actual flags differ');vfork_holds[parent]=row
            elif kind=='vfork-parent-release':
                parent=row['parentPid'];hold=vfork_holds.get(parent);event=vfork_events.get(row['releaseSequence']);wait=wait_rows.get(row['releaseSequence']);child=row['childPid']
                need(hold and parent in live and hold['childPid']==child and row['holdSequence']==hold['sequence'] and row['actualParentState']=='t','VFORK release wrong parent/child/stop')
                need((row['releaseKind']=='actual-exec' and child in live and event and event['pid']==child and event['event']==4) or (row['releaseKind']=='actual-terminal-wait' and child not in live and wait and wait['pid']==child),'VFORK release lacks actual child exec/terminal wait');del vfork_holds[parent]
            elif kind=='ptrace-event':
                need(row.get('event') in [1,2,3,4,5,6,128],'unknown actual ptrace event')
                if row['event'] in [2,4]:vfork_events[row['sequence']]=row
                if shared_mode and row['event']==4:exec_fd_events[row['sequence']]=row
                if row['event']==4:exec_events[row['sequence']]=row
            elif kind=='retained-fd-rename-binding':renames.append(row)
            elif kind=='generated-consumer-binding':consumers.append(row)
            elif kind=='prepared-consumer-binding':prepared_consumers.append(row)
            else:need(kind in ['ptrace-event','signal-delivery','generated-mmap-unverified'],'unknown raw observer event')
        need(not vfork_holds,'phase ended without vfork child release')
        need(not append_dirty,'phase ended without mandatory append full checkpoint')
        need(len(roots)==1 and not live and root_codes.get(roots[0])==0 and exclusive is None,'actual root/descendant wait closure incomplete')
        phase_tracking.append(dict(phase=phase,actualRootPid=roots[0],actualRootReturnCode=root_codes[roots[0]],waitReferences=waits))
    need(set(alias_close_windows)==alias_close_exits,'alias close missing actual close/slot closure')
    need(not exec_fd_events,'actual exec FD table change missing')
    need(len(mode_windows)==len(mode_transitions),'actual chmod window missing actual exit')
    need(len(write_windows)==len(write_transitions),'actual write window missing exit transition')
    need({seq for seq,(row,_) in caps.items() if row['role']=='readwrite-consumer'}==set(write_read_exits),'own-RW read missing actual stable exit')
    need(set(empty_windows)==empty_eofs,'empty read missing actual EOF closure')
    if exec_events:tool_pending.add('toolchain-actual-exec-image-original-unavailable')
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
        need(transition and consumer[0]['role']=='readwrite-consumer' and consumer[0]['identity']==transition['afterIdentity']==binding['identity'] and consumer[1]==((transition['after']['bytes'],transition['after']['sha256']) if 'path' not in transition['after'] else capture_data(transition['after'])) and consumer[0]['path']==binding['path'],'own-RW read lacks exact actual write byte provenance')
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
                observedAliasOnlyCloses=len(alias_close_exits),observedActualModeTransitions=len(mode_transitions),observedNamedRetainedFdBindings=len(namespaces),observedActualWriteTransitions=len(write_transitions),observedEmptyReadEofWindows=len(empty_eofs),toolchainFileSnapshots=list(tool_files.values()),toolchainActualExecImages=tool_execs,toolchainActualFileMappings=tool_mappings,toolchainObservationSha256=tool_digest.hexdigest(),toolchainPending=sorted(tool_pending|({'toolchain-executed-byte-immutability-and-full-source-authority-unverified'} if tool_execs else set())),toolchainSourceClosureVerified=False,preparedInputConsumers=list(prepared_covered.values()),preparedInputConsumerBytesVerified=bool(prepared_covered),phaseTracking=phase_tracking,scope='actual producer-close/rename/consumer bytes only; reviewed observer execution/Git/source/runtime authority independent')

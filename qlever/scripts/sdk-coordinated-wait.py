"""Bounded same-MM wait scheduling and independent interval replay."""
import json,os,stat,time

def side_wait_address(base,entry,active):
    base.need(base.operation(entry)=='wake','actual peer futex ABI required')
    args=entry['args'];base.need(isinstance(args,list) and len(args)==6 and all(type(value)is int and 0<=value<1<<64 for value in args),'canonical peer futex arguments required')
    base.need(args[2]<=0xffffffff and(args[1]==128 and args[3]==0 or args[1]==393 and args[3:]==[0,0,0xffffffff]),'only bounded private WAIT_BITSET peer mismatch supported')
    address=args[0];base.need(address>0 and address%4==0 and address+4<=1<<64 and (address+4<=active['address']or address>=active['address']+active['span']),'peer wait word overlaps generated mapping or is unaligned')
    return address

def side_wake_address(base,entry,active,primary):
    base.need(base.operation(entry)=='wake','actual peer futex ABI required')
    args=entry['args'];base.need(isinstance(args,list)and len(args)==6 and all(type(v)is int and 0<=v<1<<64 for v in args),'canonical peer futex arguments required')
    base.need(args[1]==129 and 0<args[2]<=0x7fffffff,'bounded private WAKE count required')
    address=args[0];base.need(address!=primary and address>0 and address%4==0 and address+4<=1<<64 and(address+4<=active['address']or address>=active['address']+active['span']),'side wake must address another private word outside generated mapping')
    return address

def side_wait_word(base,record,entry):
    word=base.raw_bytes(record);base.need(len(word)==4 and int.from_bytes(word,'little')!=entry['args'][2],'peer wait word must actually mismatch');return word

def runtime_type(core):
    base=core.generated_vma_module
    class CoordinatedRuntime(base.Runtime):
        round=None
        def note(self,kind,**fields):
            if self.model==base.PARKED_WAIT_MODEL and kind in ['window','quiescent','peer-stopped','wake-window','closed','side-wait-window','side-wait-closed','side-wait-deferred']:
                current=self.round;assert current is not None
                states=[]
                for pid in current['universe']:
                    if pid==current['owner']:continue
                    self.b.check();actual=core.state(pid);assert actual=='t','parked task escaped actual tracing stop'
                    states.append(dict(pid=pid,state=actual))
                fields.update(stoppedUniverse=current['universe'],stoppedTaskStates=states)
            return self.b.emit(dict(kind='generated-kernel-wait-'+kind,**fields))
        def record(self,row):
            current=self.round
            if current is None:
                result=super().record(row)
                if self.active is None:self.deferred={}
                return result
            self.b.check()
            self.charge_metadata(row)
            kind=row['kind']
            if kind=='ptrace-event':
                assert current['stage']=='peer-running' and row['pid']==current['peer'] and row['event']==128,'unexpected event during bounded peer trial'
                current['yieldEvent']=row;return
            if kind=='kernel-syscall':
                pid=row['pid']
                if row['op']=='entry':
                    assert current['stage']=='peer-running' and pid==current['peer'],'unexpected kernel entry during waiter quiescence'
                    self.peer_entry(row)
                else:
                    if current['stage']=='side-wait-running':
                        entry=current['sideEntry'];assert pid==current['peer'] and row['entrySequence']==entry['sequence'] and row['arch']==entry['arch'] and row['result']==(0 if current['sideWake']else -11)and row['isError']is(not current['sideWake']),'actual kernel-only peer exit differs'
                        current['sideExit']=row;return
                    expected=current['entry'] if pid==current['owner'] else current['wakeEntry'] if pid==current['peer'] else None
                    assert expected and row['entrySequence']==expected['sequence'] and row['isError'] is False
                    assert row['result']==(0 if pid==current['owner'] else 1),'actual wait/wake result differs'
                    assert pid not in current['exits'];current['exits'][pid]=row
                return
            if kind=='exclusive-captured-syscall-exit':
                if current['stage']=='side-wait-closing':
                    entry=current['sideEntry'];assert row['pid']==current['peer'] and row['entrySequence']==entry['sequence'] and row['result']==(0 if current['sideWake']else -11)and row['isError']is(not current['sideWake']),'kernel-only peer exclusive close differs'
                    for key in ['sideEntry','sideExit','sideWord','sideWake']:current.pop(key)
                    current['stage']='peer-ready';return
                assert row['pid'] in current['exits'] and row['entrySequence']==current['exits'][row['pid']]['entrySequence']
                current['closedExits'].add(row['pid'])
                if current['stage']=='closed' and len(current['closedExits'])==2:self.round=None
                return
            if kind=='exclusive-generated-vma-resume':
                assert row['pid']==current['owner'] and row['entrySequence']==current['entry']['sequence'];return
            if kind=='all-stop-barrier':
                assert current['stage']=='closing' and row['pids']==current['universe'] and row['osStates']==['t']*len(current['universe']);return
            if kind=='toolchain-original':
                assert current['stage'] in ['captured','wake-entry','closing'] and row['captureKind']=='maps' and row['observedPid'] in current['members'];return
            if kind=='write-original':
                assert current['stage'] in ['wake-entry','closing'];return
            assert kind.startswith('generated-kernel-wait-'),'unhandled event inside coordinated native prototype: '+kind
        def peer_entry(self,row):
            current=self.round;pid=row['pid']
            if self.model==base.PARKED_WAIT_MODEL and(row['args'][1]in [128,393] or row['args'][1]==129 and row['args'][0]!=current['entry']['args'][0]):
                side_wake=row['args'][1]==129
                address=side_wake_address(base,row,self.active,current['entry']['args'][0])if side_wake else side_wait_address(base,row,self.active);base.wait_word_mapping(current['initialMappings'],address,allow_heap=True)
                word=self.b.generated_wait_word(pid,address);assert len(word)==4
                stage='side-wait-deferred-entry'if not side_wake and int.from_bytes(word,'little')==row['args'][2]else 'side-wait-entry'
                current.update(stage=stage,sideEntry=row,sideWord=word,sideWake=side_wake)
            else:
                assert row['args'][0]==current['entry']['args'][0],'wake targets another word'
                base.private_wake_dimensions(row,self.active)
                current.update(stage='wake-entry',wakeEntry=row)
        def capture(self,pid):
            try:return super().capture(pid)
            except ValueError as failure:
                assert str(failure)=='generated VMA: actual complete uint32 must differ from expected value'
                pending=self.pending[pid];entry=self.b.tasks[pid]['entry'];address=base.private_wait_dimensions(entry,self.active,model=self.model)
                word=self.b.generated_wait_word(pid,address);assert word==entry['args'][2].to_bytes(4,'little')
                members=self.active['memoryDomainMembers'];assert 2<=len(members)<=128 and pid==self.active['pid']
                self.b.reserve_generated_bytes(4*len(members)*self.b.tool_metadata_bytes+2*self.active['origin']['identity'][3]+(4*256+16)*65536)
                barrier=self.b.barrier()
                universe=sorted(t for t,row in self.b.tasks.items() if not row['exited'])
                assert barrier['pids']==universe and 0<len(universe)<=128 and set(members)<=set(universe),'incomplete stopped task universe'
                if self.model==base.COORDINATED_WAIT_MODEL:assert universe==members,'v7 requires a cohort-only stopped universe'
                deferred=getattr(self,'deferred',{});assert all(p in members and p!=pid and self.b.tasks[p]['entry']==call and self.b.tasks[p]['stopped']and core.state(p)=='t'for p,call in deferred.items()),'queued peer entry escaped tracing stop'
                self.deferred=deferred
                self.round=dict(stage='captured',owner=pid,peer=None,candidates=[p for p in members if p!=pid and p not in deferred],members=members,universe=universe,entry=entry,lease=pending['lease'],exits={},closedExits=set(),baseline=pending['baselineReserved'])
                self.round['initialEntries']={p:self.b.tasks[p]['entry']for p in members if p!=pid and self.b.tasks[p]['entry']is not None};self.round['selectedInitial']=set()
                self.round['beforeGeometry']=self.geometry()
                row=self.note('window',pid=pid,entrySequence=entry['sequence'],members=members,barrierSequence=barrier['sequence'],wordOriginal=base.raw_record(word),procLease=pending['lease'].first,cohortMaps=self.last_samples,epochSequence=self.active['sequence'],originSequence=self.active['origin']['sequence'],qualification=False,**(dict(deferredPeerEntries=[dict(pid=p,entrySequence=call['sequence'])for p,call in sorted(self.deferred.items())],initialPeerEntries=[dict(pid=p,entrySequence=call['sequence'])for p,call in sorted(self.round['initialEntries'].items())])if self.model==base.PARKED_WAIT_MODEL else {}))
                pending['window']=row;return row
        def geometry(self):
            # One shared cohort primitive: full live validation brackets the
            # whole stopped-cohort sweep, while the pure-local projection only
            # pays the cheap deadline/stdio refusal per row.
            parsed_members=[];samples=[]
            for pid in self.round['members']:
                raw,parsed=self.maps(pid)
                if 'initialMappings'not in self.round:self.round['initialMappings']=parsed
                parsed_members.append(parsed);samples.append(dict(pid=pid,original=raw['original']))
            geometry=base.cohort_mapping_geometry(parsed_members,self.b.check,self.b.check_deadline)
            self.last_samples=samples;return geometry
        def kernel_state(self):
            current=self.round;lease=current['lease'];pid=current['owner'];entry=current['entry']
            directory=base.identity(os.fstat(lease.directory));held=base.identity(os.fstat(lease.stat))
            assert directory==lease.first['directoryIdentity']==base.identity(os.stat(lease.base,follow_symlinks=False))
            assert held==lease.first['statIdentity']==base.identity(os.stat('stat',dir_fd=lease.directory,follow_symlinks=False))
            first=os.pread(lease.stat,4097,0);parts=first[first.rfind(b')')+2:].split()
            assert len(first)<=4096 and first.startswith(str(pid).encode()+b' ') and parts[0]==b'S' and parts[19].decode()==lease.first['starttime']
            fd=os.open('syscall',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=lease.directory)
            try:
                identity=base.identity(os.fstat(fd));assert stat.S_ISREG(identity[2]) and identity==base.identity(os.stat('syscall',dir_fd=lease.directory,follow_symlinks=False))
                raw=os.pread(fd,513,0);assert 0<len(raw)<=512 and raw.endswith(b'\n');words=raw.split();assert len(words)==9
                numbers=[int(word,0) for word in words];assert numbers[:7]==[entry['nr'],*entry['args']] and all(value>0 for value in numbers[7:])
                after=os.pread(lease.stat,4097,0);after_parts=after[after.rfind(b')')+2:].split();assert after_parts[0]==b'S' and after_parts[19]==parts[19]
                assert identity==base.identity(os.fstat(fd))==base.identity(os.stat('syscall',dir_fd=lease.directory,follow_symlinks=False))
                assert directory==base.identity(os.fstat(lease.directory))==base.identity(os.stat(lease.base,follow_symlinks=False)) and held==base.identity(os.fstat(lease.stat))
                assert self.b.actual_tgid(pid)==self.b.tasks[pid]['tgid']
                return dict(pid=pid,entrySequence=entry['sequence'],directoryIdentity=directory,statIdentity=held,syscallIdentity=identity,beforeStat=base.raw_record(first),afterStat=base.raw_record(after),syscallOriginal=base.raw_record(raw),starttime=lease.first['starttime'])
            finally:os.close(fd)
        def classify(self,pid,entry,path_argument):
            if self.round is not None:
                assert self.round['stage']in ['wake-entry','side-wait-entry','side-wait-deferred-entry'] and pid==self.round['peer']
                if self.round['stage']=='side-wait-deferred-entry':return True
                self.pending[pid]=dict(op='coordinated-peer-wait-mismatch'if self.round['stage']=='side-wait-entry'else 'coordinated-peer-wake');return True
            return super().classify(pid,entry,path_argument)
        def drive(self):
            current=self.round
            if current['stage']=='captured':
                pid=current['owner'];assert self.b.tasks[pid]['stopped']
                self.note('waiter-resume',pid=pid,entrySequence=current['entry']['sequence'],request='PTRACE_SYSCALL',signal=0)
                core.single.trace(core.SYSCALL,pid,0,0);self.b.tasks[pid]['stopped']=False;self.b.exclusive=None
                while core.state(pid)!='S':self.b.check();time.sleep(0.0001)
                observation=self.kernel_state();assert all(core.state(p)=='t' for p in current['universe'] if p!=pid)
                self.note('quiescent',observation=observation,ownership=self.b.verify_task_ownership())
                self.drive_peers()
            elif current['stage']=='wake-entry':
                observation=self.kernel_state();assert core.state(current['peer'])=='t'
                assert self.geometry()==current['beforeGeometry'],'cohort mapping geometry changed during peer userspace'
                word=self.b.generated_wait_word(current['peer'],current['entry']['args'][0]);assert len(word)==4 and(word==b'\x01\x00\x00\x00'if self.model==base.COORDINATED_WAIT_MODEL else int.from_bytes(word,'little')!=current['entry']['args'][2])
                identity,original=self.snapshot(self.active['origin']['held']);assert base.same_object(identity,self.active['origin']['identity'])
                current['wakeWord']=word
                self.note('wake-window',observation=observation,wakeEntrySequence=current['wakeEntry']['sequence'],wordOriginal=base.raw_record(word),ownership=self.b.verify_task_ownership(),cohortMaps=self.last_samples,backingOriginal=original,backingIdentity=identity)
                self.note('waker-resume',pid=current['peer'],entrySequence=current['wakeEntry']['sequence'],request='PTRACE_SYSCALL',signal=0)
                current['stage']='wake-running';peer=current['peer'];core.single.trace(core.SYSCALL,peer,0,0);self.b.tasks[peer]['stopped']=False
            else:assert current['stage']=='wake-running','invalid coordinated scheduler state'
        def drive_peers(self):
            current=self.round
            for attempt in range(256):
                self.b.check();assert current['candidates'],'no runnable peer can wake the selected waiter'
                peer=current['candidates'][attempt%len(current['candidates'])]
                current.update(stage='peer-running',peer=peer)
                assert self.b.tasks[peer]['stopped'] and core.state(peer)=='t'
                prior=self.b.tasks[peer]['entry']
                if prior is not None:
                    assert self.model==base.PARKED_WAIT_MODEL and current['initialEntries'].get(peer)==prior and peer not in current['selectedInitial'],'peer trial has an unbound prior syscall entry'
                    current['selectedInitial'].add(peer)
                    self.note('peer-entry-selected',pid=peer,waiter=current['owner'],entrySequence=prior['sequence'],request=None,signal=0)
                    self.peer_entry(prior);self.classify(peer,prior,None)
                else:
                    self.note('peer-resume',pid=peer,waiter=current['owner'],request='PTRACE_SYSCALL',signal=0)
                    core.single.trace(core.SYSCALL,peer,0,0);self.b.tasks[peer]['stopped']=False
                    slice_end=min(time.monotonic()+0.002,self.b.waiter.deadline)
                    observed=None
                    while time.monotonic()<slice_end:
                        self.b.check();result=os.waitpid(-1,self.b.waiter.flags|os.WNOHANG)
                        if result[0]:observed=result;break
                        time.sleep(0.0001)
                    if observed is None:
                        core.single.trace(core.INTERRUPT,peer);observed=self.b.wait_one()
                    actual_pid,status=observed
                    assert actual_pid==peer,'another task ran during selected peer trial'
                    self.b.event(actual_pid,status,False)
                if current['stage']=='wake-entry':
                    self.drive();return
                if current['stage']=='side-wait-deferred-entry':
                    call=current['sideEntry'];assert self.b.tasks[peer]['entry']==call and core.state(peer)=='t'and peer not in self.pending and peer not in self.deferred
                    self.note('side-wait-deferred',pid=peer,entrySequence=call['sequence'],wordOriginal=base.raw_record(current['sideWord']),observation=self.kernel_state(),ownership=self.b.verify_task_ownership(),request=None,signal=0)
                    self.deferred[peer]=call;current['candidates'].remove(peer)
                    for key in ['sideEntry','sideWord','sideWake']:current.pop(key)
                    current['stage']='peer-ready';continue
                if current['stage']=='side-wait-entry':
                    self.drive_side_wait();continue
                assert prior is None and os.WIFSTOPPED(status) and status>>16==128 and os.WSTOPSIG(status)==5,'peer trial did not end at actual interrupt stop'
                event=current.pop('yieldEvent');observation=self.kernel_state()
                assert all(core.state(p)=='t' for p in current['universe'] if p!=current['owner'])
                self.note('peer-stopped',pid=peer,eventSequence=event['sequence'],waitStatus=status,observation=observation,ownership=self.b.verify_task_ownership())
            raise TimeoutError('bounded same-cohort peer scheduling attempts exhausted')
        def drive_side_wait(self):
            current=self.round;peer=current['peer'];entry=current['sideEntry']
            self.note('side-wait-window',operation='private-side-wake'if current['sideWake']else 'private-wait-mismatch',pid=peer,entrySequence=entry['sequence'],wordOriginal=base.raw_record(current['sideWord']),observation=self.kernel_state(),ownership=self.b.verify_task_ownership())
            self.note('side-wait-resume',pid=peer,entrySequence=entry['sequence'],request='PTRACE_SYSCALL',signal=0)
            current['stage']='side-wait-running';self.b.exclusive=(peer,entry['sequence']);core.single.trace(core.SYSCALL,peer,0,0);self.b.tasks[peer]['stopped']=False
            actual,status=self.b.wait_one();assert actual==peer,'another task ran during kernel-only peer mismatch'
            self.b.event(actual,status,False);assert current['stage']=='peer-ready','peer mismatch did not close before next trial'
        def finish(self,pid,entry,exit):
            current=self.round
            if current is None:return super().finish(pid,entry,exit)
            if current['stage']=='side-wait-running':
                assert pid==current['peer'] and current['sideExit']==exit
                word=self.b.generated_wait_word(pid,entry['args'][0]);assert word==current['sideWord'],'peer mismatch changed its full word'
                current['stage']='side-wait-closing'
                self.note('side-wait-closed',pid=pid,entrySequence=entry['sequence'],exitSequence=exit['sequence'],wordOriginal=base.raw_record(word),observation=self.kernel_state(),ownership=self.b.verify_task_ownership())
                del self.pending[pid];return
            assert current['stage']=='wake-running' and pid in current['exits']
            if len(current['exits'])<2:return
            current['stage']='closing';barrier=self.b.barrier();assert self.geometry()==current['beforeGeometry']
            after=current['lease'].sample();assert not current['lease'].close()
            word=self.b.generated_wait_word(current['owner'],current['entry']['args'][0]);assert word==current['wakeWord']
            identity,original=self.snapshot(self.active['origin']['held']);assert base.same_object(identity,self.active['origin']['identity'])
            assert self.reserved>=current['baseline'];self.reserved=current['baseline']
            for member in [current['owner'],current['peer']]:del self.pending[member]
            self.note('closed',waitEntrySequence=current['entry']['sequence'],wakeEntrySequence=current['wakeEntry']['sequence'],waitExitSequence=current['exits'][current['owner']]['sequence'],wakeExitSequence=current['exits'][current['peer']]['sequence'],barrierSequence=barrier['sequence'],procAfter=after,wordOriginal=base.raw_record(word),cohortMaps=self.last_samples,backingOriginal=original,backingIdentity=identity,qualification=False)
            current['stage']='closed'
    return CoordinatedRuntime


import hashlib,re

def verify_interval(rows,context,read_blocks,maps_data,base,maximum_file):
    need=base.need
    need(isinstance(rows,list) and len(rows)<10000,'finite prototype trace required')
    need([r['sequence']for r in rows]==list(range(rows[0]['sequence'],rows[0]['sequence']+len(rows))),'prototype sequence gap/duplicate')
    events=dict(context['events']);events.update({r['sequence']:r for r in rows})
    clocks=[int(r['observedMonotonicNs'])for r in rows];need(all(a<=b for a,b in zip(clocks,clocks[1:])),'prototype clock order')
    windows=[r for r in rows if r['kind']=='generated-kernel-wait-window'];need(len(windows)==1,'one native prototype interval required');window=windows[0];owner=window['pid'];members=window['members'];need(type(owner) is int and members==sorted(set(members)) and 2<=len(members)<=128 and owner in members,'exact same-MM native pair required');wake_windows=[r for r in rows if r['kind']=='generated-kernel-wait-wake-window'];need(len(wake_windows)==1,'one matching actual wake window required');peer=events[wake_windows[0]['wakeEntrySequence']]['pid'];need(peer in members and peer!=owner,'matching wake must come from same-MM peer')
    need(window['qualification'] is False,'prototype cannot grant qualification')
    need(all(row['phase']==window['phase']for row in rows),'scheduled interval crossed phase')
    entry=events[window['entrySequence']];epoch=events[window['epochSequence']];need(epoch['kind']=='generated-vma-operation-exit' and epoch['operation']=='map' and epoch['pid']==owner and events[epoch['windowSequence']]['originSequence']==window['originSequence'],'actual established mapping epoch required')
    mapped_window=events[epoch['windowSequence']];active=dict(address=epoch['result'],span=base.rounded_span(epoch['result'],epoch['identity'][3],mapped_window['pageBytes']));address=base.private_wait_dimensions(entry,active,model=context['model'])
    need(entry['kind']=='kernel-syscall' and entry['op']=='entry' and entry['pid']==owner and base.raw_bytes(window['wordOriginal'])==entry['args'][2].to_bytes(4,'little'),'actual equal private wait entry required')
    domain,actual_members=context['domain'],context['members'];need(actual_members==members and epoch['memoryDomain']==domain and epoch['memoryDomainMembers']==members,'actual CLONE_VM cohort differs')
    parked=context['model']==base.PARKED_WAIT_MODEL
    universe=window.get('stoppedUniverse') if parked else members
    need(isinstance(universe,list) and universe==sorted(set(universe)) and 0<len(universe)<=128 and set(members)<=set(universe),'bounded complete stopped universe required')
    stop=context['barrier'];need(window['barrierSequence']==stop['sequence'] and stop['pids']==universe and stop['osStates']==['t']*len(universe),'initial complete all-stop universe required');ownership=stop['taskOwnership'];need([x['tid']for x in ownership]==universe,'initial complete ownership required')
    def parked_states(row):
        if parked:
            need(row.get('stoppedUniverse')==universe and row.get('stoppedTaskStates')==[dict(pid=pid,state='t')for pid in universe if pid!=owner],'complete nonwaiter tracing-stop states differ')
        else:need('stoppedUniverse'not in row and 'stoppedTaskStates'not in row,'v8 parked universe cannot be relabelled v7')
    parked_states(window)
    lease=base.verify_proc_lease(window['procLease'],owner,canonical=True)
    def original(ref):
        need(isinstance(ref,dict) and (set(ref)=={'path','bytes','sha256'}or context['model']==base.PARKED_WAIT_MODEL and set(ref)=={'path','bytes','sha256','observationSequence'}and type(ref['observationSequence'])is int and ref['observationSequence']>0) and re.fullmatch(r'capture-[0-9]{4,8}\.original',ref['path']) and type(ref['bytes'])is int and 0<=ref['bytes']<=maximum_file,'bounded actual original reference')
        count=0;digest=hashlib.sha256()
        for block in read_blocks(ref):
            need(isinstance(block,bytes) and 0<len(block)<=65536,'bounded complete original blocks required');count+=len(block);need(count<=ref['bytes'],'original byte bound');digest.update(block)
        need(count==ref['bytes'] and digest.hexdigest()==ref['sha256'],'original complete bytes differ');return count,digest.hexdigest()
    def maps(row):
        samples=row['cohortMaps'];need([x['pid']for x in samples]==members,'complete ordered maps pair required');geometry=None;parsed_owner=None
        for sample in samples:
            ref=sample['original'];original(ref);parsed=maps_data(ref);current=base.numeric_mapping_geometry(parsed)
            need(any(e['kind']=='toolchain-original'and e.get('captureKind')=='maps'and e.get('observedPid')==sample['pid']and e.get('original')==ref and e['sequence']<row['sequence']for e in [*context['mapRecords'],*rows]),'maps raw owner/source missing')
            base.wait_word_mapping(parsed,address,allow_heap=parked);base.verify_established(parsed,epoch['result'],mapped_window['pageBytes'],epoch['identity'],epoch['identity'][3])
            need(geometry is None or geometry==current,'same-MM geometry differs');geometry=current
            if sample['pid']==owner:parsed_owner=parsed
        return geometry,parsed_owner
    initial_geometry,owner_maps=maps(window)
    def proc_raw(raw,allowed):
        data=base.raw_bytes(raw);end=data.rfind(b')');need(data.endswith(b'\n') and data.startswith(str(owner).encode()+b' ')and end>0,'complete actual proc PID required');fields=data[end+2:].split();need(len(fields)>=20 and fields[0]in allowed and fields[19].decode()==lease['starttime'],'actual proc state/lifetime differs');return data
    def kernel(observation):
        need(observation['pid']==owner and observation['entrySequence']==entry['sequence'] and observation['directoryIdentity']==lease['directoryIdentity'] and observation['statIdentity']==lease['statIdentity'] and observation['starttime']==lease['starttime'],'same held proc/kernel wait lifetime required')
        proc_raw(observation['beforeStat'],[b'S']);proc_raw(observation['afterStat'],[b'S']);identity=observation['syscallIdentity'];need(isinstance(identity,list)and len(identity)==6 and all(type(x)is int and x>=0 for x in identity)and stat.S_ISREG(identity[2]),'actual syscall proc identity required')
        raw=base.raw_bytes(observation['syscallOriginal']);words=raw.split();need(len(raw)<=512 and raw.endswith(b'\n')and len(words)==9 and all(re.fullmatch(rb'(?:0|[1-9][0-9]*|0x[0-9a-f]+)',word)for word in words),'bounded canonical kernel syscall raw required');values=[int(word,0)for word in words];need(values[:7]==[entry['nr'],*entry['args']]and all(0<v<1<<64 for v in values[-2:]),'exact observed kernel private wait differs')
        stack,pc=values[-2:];need(any(int(m['startHex'],16)<=pc<int(m['endHex'],16)and m['permissions']=='r-xp'for m in owner_maps),'kernel resume PC lacks executable mapping');need(any(int(m['startHex'],16)<=stack<int(m['endHex'],16)and m['permissions']=='rw-p'for m in owner_maps),'kernel stack lacks private writable mapping')
    queued=dict(context.get('deferred',{}))
    if parked:need(window.get('deferredPeerEntries')==[dict(pid=p,entrySequence=call['sequence'])for p,call in sorted(queued.items())],'prior queued peer entries differ')
    else:need(not queued and 'deferredPeerEntries'not in window,'queued peer entries require v8')
    need(all(p in members and p!=owner and call['pid']==p for p,call in queued.items()),'queued peer escaped original cohort')
    count=len(members);start=0;closed_at=next(i for i in range(start,len(rows)) if rows[i]['kind']=='generated-kernel-wait-closed')
    complete=rows[start:closed_at+2];interval=complete[:4];position=4;trials=[];side_mismatches=[];side_wakes=[];candidates=[p for p in members if p!=owner and p not in queued];initial_entries=context.get('initialEntries',{});selected_initial=set()
    while position<len(complete):
        trial=complete[position];need(trial['kind']in ['generated-kernel-wait-peer-resume','generated-kernel-wait-peer-entry-selected'] and len(trials)<256,'bounded selected peer trial required')
        initial=trial['kind']=='generated-kernel-wait-peer-entry-selected';selected=trial['pid'];need(bool(candidates)and selected==candidates[len(trials)%len(candidates)] and trial['waiter']==owner and trial['request']==(None if initial else 'PTRACE_SYSCALL') and trial['signal']==0,'canonical same-cohort round-robin trial required');trials.append(selected)
        if initial:
            need(parked and selected in initial_entries and selected not in selected_initial and trial['entrySequence']==initial_entries[selected]['sequence'],'selected prior peer entry differs');selected_initial.add(selected)
        following=initial_entries[selected]if initial else complete[position+1];next_position=position+1 if initial else position+2
        if following['kind']=='kernel-syscall':
            if next_position<len(complete)and complete[next_position]['kind']=='generated-kernel-wait-side-wait-deferred':
                need(parked,'queued peer requires explicit v8 model');call=following;held=complete[next_position]
                need(call['op']=='entry'and call['pid']==selected and call['arch']==entry['arch']and call.get('waitStatus')==34175,'actual queued syscall-entry stop differs')
                side_address=side_wait_address(base,call,active);base.wait_word_mapping(owner_maps,side_address,allow_heap=True)
                word=base.raw_bytes(held['wordOriginal']);need(len(word)==4 and int.from_bytes(word,'little')==call['args'][2],'queued peer requires actual equal full word')
                need(held['pid']==selected and held['entrySequence']==call['sequence']and held['ownership']==ownership and held['request']is None and held['signal']==0 and selected not in queued,'queued peer entry/ownership differs')
                parked_states(held);kernel(held['observation']);queued[selected]=call;candidates.remove(selected);position=next_position+1;continue
            if next_position<len(complete) and complete[next_position]['kind']=='generated-kernel-wait-side-wait-window':
                need(parked,'peer mismatch requires explicit v8 model');side=complete[next_position:next_position+5]
                need([row['kind']for row in side]==['generated-kernel-wait-side-wait-window','generated-kernel-wait-side-wait-resume','kernel-syscall','generated-kernel-wait-side-wait-closed','exclusive-captured-syscall-exit'],'strict kernel-only peer mismatch interval required')
                call=following;before,resume,actual,after,close=side
                need(call['op']=='entry'and call['pid']==selected and call['arch']==entry['arch'],'actual selected peer mismatch entry differs')
                is_wake=call['args'][1]==129
                need(before.get('operation')==('private-side-wake'if is_wake else 'private-wait-mismatch'),'kernel-only peer operation differs')
                side_address=side_wake_address(base,call,active,address)if is_wake else side_wait_address(base,call,active);base.wait_word_mapping(owner_maps,side_address,allow_heap=True)
                word=base.raw_bytes(before['wordOriginal'])if is_wake else side_wait_word(base,before['wordOriginal'],call);need(len(word)==4,'full kernel-only peer word required')
                expected_result=0 if is_wake else -11;expected_error=not is_wake
                for sample in [before,after]:
                    need(sample['pid']==selected and sample['entrySequence']==call['sequence']and sample['ownership']==ownership,'peer mismatch task/entry/ownership differs');parked_states(sample);kernel(sample['observation'])
                need(base.raw_bytes(after['wordOriginal'])==word,'peer mismatch changed full word')
                need(resume['pid']==selected and resume['entrySequence']==call['sequence']and resume['request']=='PTRACE_SYSCALL'and resume['signal']==0,'exact signal-free peer mismatch resume required')
                need(actual['op']=='exit'and actual['pid']==selected and actual['arch']==call['arch']and actual['entrySequence']==call['sequence']and actual['result']==expected_result and actual['isError']is expected_error,'actual kernel-only peer result differs')
                need(after['exitSequence']==actual['sequence']and close['pid']==selected and close['entrySequence']==call['sequence']and close['result']==expected_result and close['isError']is expected_error,'kernel-only peer actual close differs')
                (side_wakes if is_wake else side_mismatches).append(call['sequence']);position=next_position+5;continue
            need(not initial and selected==peer,'wake came from another running peer');interval.extend(complete[position:]);break
        need(not initial and following['kind']=='ptrace-event' and following['pid']==selected and following['event']==128,'actual selected interrupt event required')
        stopped=complete[position+2];status=stopped.get('waitStatus');need(stopped['kind']=='generated-kernel-wait-peer-stopped' and stopped['pid']==selected and stopped['eventSequence']==following['sequence'] and type(status)is int and status&255==127 and status>>16==128 and status>>8&255==5,'actual interrupt-stop wait status required')
        parked_states(stopped);kernel(stopped['observation']);need(stopped['ownership']==ownership,'complete ownership changed between peer trials')
        position+=3
    need(trials and interval[-1]['kind']=='exclusive-captured-syscall-exit','scheduled native interval did not close')
    expected=['generated-kernel-wait-window','exclusive-generated-vma-resume','generated-kernel-wait-waiter-resume','generated-kernel-wait-quiescent','generated-kernel-wait-peer-resume','kernel-syscall']+['toolchain-original']*count+['write-original','generated-kernel-wait-wake-window','generated-kernel-wait-waker-resume','kernel-syscall','exclusive-captured-syscall-exit','kernel-syscall','all-stop-barrier']+['toolchain-original']*count+['write-original','generated-kernel-wait-closed','exclusive-captured-syscall-exit']
    need([r['kind']for r in interval]==expected,'strict experimental interval order differs');need(all(r['phase']==entry['phase']for r in interval),'wait/wake crossed phase');need(int(epoch['observedMonotonicNs'])<=int(window['observedMonotonicNs'])and int(interval[-1]['observedMonotonicNs'])<int(epoch['windowDeadlineMonotonicNs'])<=int(epoch['parentDeadlineMonotonicNs']),'original finite mapping/parent deadline exceeded')
    resume=interval[1];need(resume['pid']==owner and resume['entrySequence']==entry['sequence']and resume['captureSequence']==window['sequence'],'wait window/resume differs')
    for row,pid,call in [(interval[2],owner,entry),(interval[4],peer,None),(interval[8+count],peer,interval[5])]:
        need(row['pid']==pid and row['request']=='PTRACE_SYSCALL'and row['signal']==0,'selected exact signal-free ptrace resume required')
        if call:need(row['entrySequence']==call['sequence'],'ptrace resume entry differs')
    quiescent=interval[3];wake_window=interval[7+count];closed=interval[14+2*count]
    for row in [quiescent,wake_window]:parked_states(row);kernel(row['observation']);need(row['ownership']==ownership,'same complete kernel-quiescent ownership required')
    need(interval[4]['waiter']==owner,'peer resumed under another waiter')
    wake=interval[5];need(wake['op']=='entry'and wake['pid']==peer and wake['arch']==entry['arch']and wake['args'][0]==address,'actual same-cohort matching wake entry required');base.private_wake_dimensions(wake,active);need(wake_window['wakeEntrySequence']==wake['sequence'],'wake window entry differs')
    before_geometry,_=maps(wake_window);after_geometry,_=maps(closed);need(before_geometry==after_geometry==initial_geometry,'unobserved cohort VMA geometry change')
    wake_word=base.raw_bytes(wake_window['wordOriginal']);need(len(wake_word)==4 and wake_word==base.raw_bytes(closed['wordOriginal'])and(wake_word==b'\x01\0\0\0'if not parked else int.from_bytes(wake_word,'little')!=entry['args'][2]),'complete before/after wake word differs')
    need(base.same_object(wake_window['backingIdentity'],epoch['identity'])and wake_window['backingIdentity']==closed['backingIdentity'],'backing object changed during wait/wake')
    need(original(wake_window['backingOriginal'])==original(closed['backingOriginal'])and wake_window['backingOriginal']['bytes']==epoch['identity'][3],'full backing body changed across kernel-only interval')
    proc=base.verify_proc_lease(closed['procAfter'],owner,canonical=True);need(proc['directoryIdentity']==lease['directoryIdentity']and proc['statIdentity']==lease['statIdentity']and proc['starttime']==lease['starttime'],'post-wait selected proc lifetime differs')
    exits=[interval[9+count],interval[11+count]];need({r['pid']for r in exits}=={owner,peer}and all(r['op']=='exit'and r['isError']is False for r in exits),'two actual distinct exit stops required')
    for row,close in zip(exits,[interval[10+count],interval[15+2*count]]):
        call=entry if row['pid']==owner else wake;result=0 if row['pid']==owner else 1;need(row['entrySequence']==call['sequence']and row['result']==result and close['pid']==row['pid']and close['entrySequence']==call['sequence']and close['result']==result and close['isError']is False,'exact actual wait/wake exits and closure required')
    parked_states(closed)
    need(closed['qualification']is False and closed['waitEntrySequence']==entry['sequence']and closed['wakeEntrySequence']==wake['sequence']and closed['waitExitSequence']==next(r['sequence']for r in exits if r['pid']==owner)and closed['wakeExitSequence']==next(r['sequence']for r in exits if r['pid']==peer),'composite closure differs')
    post=interval[12+count];need(post['sequence']==closed['barrierSequence']and post['pids']==universe and post['osStates']==['t']*len(universe)and post['taskOwnership']==ownership,'complete final actual all-stop ownership required')
    return {'mechanicalCompositeReplay':True,'qualification':False,'owner':owner,'peer':peer,'entrySequence':entry['sequence'],'closeSequence':closed['sequence'],'peerTrials':trials,'sideWaitMismatches':side_mismatches,'sideWakeEntries':side_wakes,'deferred':queued}


def verifier_type(base):
    class CoordinatedVerifier(base.Verifier):
        scheduled_rows=None
        coordinated_epoch=None
        @property
        def scheduled_active(self):return self.scheduled_rows is not None
        def audit_scheduled(self,row):
            need=base.need;seq=row['sequence'];clock=row.get('observedMonotonicNs')
            need(isinstance(clock,str) and clock.isdecimal(),'actual scheduled monotonic observation required');now=int(clock)
            need(self.last_observed_ns is None or now>=self.last_observed_ns,'scheduled monotonic clock moved backwards');self.last_observed_ns=now
            need(self.active and self.active['start']<=now<self.active['deadline'],'same finite mapping deadline expired')
            need(seq not in self.events,'duplicate scheduled raw sequence');self.events[seq]=row
            while len(self.events)>256:self.events.pop(next(iter(self.events)))
            self.charge_metadata(row)
            if row['kind']=='write-original':self.original_sequences[self.key(row['original'])]=seq
            if row['kind']=='toolchain-original' and row.get('captureKind')=='maps':
                need('observationSequence'not in row['original']or type(row['original']['observationSequence'])is int and row['original']['observationSequence']==seq,'scheduled maps actual observation sequence differs')
                key=self.map_key(row['original']);self.map_sequences[key]=seq;self.map_owners[key]=row['observedPid']
            for values in [self.original_sequences,self.map_sequences]:
                while len(values)>256:
                    key=next(iter(values));values.pop(key)
                    if values is self.map_sequences:self.map_owners.pop(key,None)
        def record(self,row,entries,exits,barriers,caps):
            need=base.need;kind=row['kind']
            if kind=='generated-kernel-wait-window':
                need(self.model in base.COORDINATED_WAIT_MODELS and not self.scheduled_active and self.transaction is None and self.pending_window is None and self.active and self.coordinated_epoch,'scheduled window outside actual established epoch')
                entry=entries.get(row.get('entrySequence'));barrier=barriers.get(row.get('barrierSequence'))
                need(entry and entry['pid']==row['pid']==self.active['pid'] and row['epochSequence']==self.active['sequence'] and row['originSequence']==self.active['originSequence'] and barrier,'scheduled window actual entry/epoch/barrier differs')
                domain,members=base.complete_memory_cohort(self.mm,row['pid'],barrier)
                need((domain,members)==(self.active['memoryDomain'],self.active['memoryDomainMembers']),'scheduled cohort differs from established epoch')
                epoch,window=self.coordinated_epoch
                records=[]
                for sample in row['cohortMaps']:
                    key=self.map_key(sample['original']);sequence=self.map_sequences.get(key);owner=self.map_owners.get(key)
                    need(sequence and owner==sample['pid'] and barrier['sequence']<sequence<row['sequence'],'initial scheduled maps source/order differs')
                    records.append(dict(kind='toolchain-original',captureKind='maps',observedPid=owner,original=sample['original'],sequence=sequence))
                initial_entries={}
                if self.model==base.PARKED_WAIT_MODEL:
                    for sequence,call in entries.items():
                        if call['pid']in members and call['pid']!=row['pid']and call['phase']==row['phase']and sequence not in exits:
                            need(call['pid']not in initial_entries,'multiple unclosed initial peer entries');initial_entries[call['pid']]=call
                    need(row.get('initialPeerEntries')==[dict(pid=p,entrySequence=call['sequence'])for p,call in sorted(initial_entries.items())],'complete initial peer entry vector differs')
                else:need('initialPeerEntries'not in row,'initial peer entry selection requires v8')
                self.scheduled_context=dict(initialEntries=initial_entries,deferred=dict(getattr(self,'deferred',{})),model=self.model,domain=domain,members=members,barrier=barrier,mapRecords=records,events={value['sequence']:value for value in [entry,epoch,window,*initial_entries.values()]})
                self.scheduled_rows=[]
            if self.scheduled_active:
                self.audit_scheduled(row);self.scheduled_rows.append(row)
                if len(self.scheduled_rows)>1 and self.scheduled_rows[-2]['kind']=='generated-kernel-wait-closed':
                    need(kind=='exclusive-captured-syscall-exit' and self.read_blocks is not None,'scheduled interval lacks final actual exclusive close')
                    summary=verify_interval(self.scheduled_rows,self.scheduled_context,self.read_blocks,self.maps_data,base,self.maximum_file)
                    if not hasattr(self,'coordinated_waits'):self.coordinated_waits=[]
                    self.deferred=summary['deferred']
                    self.coordinated_waits.append(dict(waitEntrySequence=summary['entrySequence'],closeSequence=summary['closeSequence'],waiter=summary['owner'],waker=summary['peer'],peerTrials=summary['peerTrials'],**(dict(sideWaitMismatches=summary['sideWaitMismatches'],sideWakeEntries=summary['sideWakeEntries'])if self.model==base.PARKED_WAIT_MODEL else {})))
                    self.scheduled_rows=None;self.scheduled_context=None
                return
            epoch_window=self.windows.get(row.get('windowSequence')) if kind=='generated-vma-operation-exit' and row.get('operation')=='map' else None
            super().record(row,entries,exits,barriers,caps)
            if epoch_window is not None:self.coordinated_epoch=(dict(row),dict(epoch_window))
            if self.active is None:self.coordinated_epoch=None;self.deferred={}
        def finish(self,caps,exits):
            base.need(not self.scheduled_active,'unclosed coordinated wait interval');return super().finish(caps,exits)
    return CoordinatedVerifier

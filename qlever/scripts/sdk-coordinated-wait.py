"""Bounded same-MM wait scheduling and independent interval replay."""
import json,os,stat,time

def runtime_type(core):
    base=core.generated_vma_module
    class CoordinatedRuntime(base.Runtime):
        round=None
        def note(self,kind,**fields):
            return self.b.emit(dict(kind='generated-kernel-wait-'+kind,**fields))
        def record(self,row):
            current=self.round
            if current is None:return super().record(row)
            self.b.check()
            self.metadata_bytes+=len(json.dumps(row,separators=(',',':')).encode());base.need(self.metadata_bytes<=4*1024**2,'shared generated metadata bound')
            kind=row['kind']
            if kind=='ptrace-event':
                assert current['stage']=='peer-running' and row['pid']==current['peer'] and row['event']==128,'unexpected event during bounded peer trial'
                current['yieldEvent']=row;return
            if kind=='kernel-syscall':
                pid=row['pid']
                if row['op']=='entry':
                    assert current['stage']=='peer-running' and pid==current['peer'],'unexpected kernel entry during waiter quiescence'
                    assert row['args'][0]==current['entry']['args'][0],'wake targets another word'
                    base.private_wake_dimensions(row,self.active)
                    current.update(stage='wake-entry',wakeEntry=row)
                else:
                    expected=current['entry'] if pid==current['owner'] else current['wakeEntry'] if pid==current['peer'] else None
                    assert expected and row['entrySequence']==expected['sequence'] and row['isError'] is False
                    assert row['result']==(0 if pid==current['owner'] else 1),'actual wait/wake result differs'
                    assert pid not in current['exits'];current['exits'][pid]=row
                return
            if kind=='exclusive-captured-syscall-exit':
                assert row['pid'] in current['exits'] and row['entrySequence']==current['exits'][row['pid']]['entrySequence']
                current['closedExits'].add(row['pid'])
                if current['stage']=='closed' and len(current['closedExits'])==2:self.round=None
                return
            if kind=='exclusive-generated-vma-resume':
                assert row['pid']==current['owner'] and row['entrySequence']==current['entry']['sequence'];return
            if kind=='all-stop-barrier':
                assert current['stage']=='closing' and row['pids']==current['members'] and row['osStates']==['t']*len(current['members']);return
            if kind=='toolchain-original':
                assert current['stage'] in ['captured','wake-entry','closing'] and row['captureKind']=='maps' and row['observedPid'] in current['members'];return
            if kind=='write-original':
                assert current['stage'] in ['wake-entry','closing'];return
            assert kind.startswith('generated-kernel-wait-'),'unhandled event inside coordinated native prototype: '+kind
        def capture(self,pid):
            try:return super().capture(pid)
            except ValueError as failure:
                assert str(failure)=='generated VMA: actual complete uint32 must differ from expected value'
                pending=self.pending[pid];entry=self.b.tasks[pid]['entry'];address=base.private_wait_dimensions(entry,self.active)
                word=self.b.generated_wait_word(pid,address);assert word==b'\x00'*4
                members=self.active['memoryDomainMembers'];assert 2<=len(members)<=128 and pid==self.active['pid']
                self.b.reserve_generated_bytes(4*len(members)*self.b.tool_metadata_bytes+2*self.active['origin']['identity'][3]+(4*256+16)*65536)
                barrier=self.b.barrier()
                assert sorted(t for t,row in self.b.tasks.items() if not row['exited'])==members
                self.round=dict(stage='captured',owner=pid,peer=None,candidates=[p for p in members if p!=pid],members=members,entry=entry,lease=pending['lease'],exits={},closedExits=set(),baseline=pending['baselineReserved'])
                self.round['beforeGeometry']=self.geometry()
                row=self.note('window',pid=pid,entrySequence=entry['sequence'],members=members,barrierSequence=barrier['sequence'],wordOriginal=base.raw_record(word),procLease=pending['lease'].first,cohortMaps=self.last_samples,epochSequence=self.active['sequence'],originSequence=self.active['origin']['sequence'],qualification=False)
                pending['window']=row;return row
        def geometry(self):
            values=[];samples=[]
            for pid in self.round['members']:
                raw,parsed=self.maps(pid);values.append(base.numeric_mapping_geometry(parsed,self.b.check));samples.append(dict(pid=pid,original=raw['original']))
            assert values[0]==values[1],'same-MM maps differ';self.last_samples=samples;return values[0]
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
                assert self.round['stage']=='wake-entry' and pid==self.round['peer']
                self.pending[pid]=dict(op='coordinated-peer-wake');return True
            return super().classify(pid,entry,path_argument)
        def drive(self):
            current=self.round
            if current['stage']=='captured':
                pid=current['owner'];assert self.b.tasks[pid]['stopped']
                self.note('waiter-resume',pid=pid,entrySequence=current['entry']['sequence'],request='PTRACE_SYSCALL',signal=0)
                core.single.trace(core.SYSCALL,pid,0,0);self.b.tasks[pid]['stopped']=False;self.b.exclusive=None
                while core.state(pid)!='S':self.b.check();time.sleep(0.0001)
                observation=self.kernel_state();assert all(core.state(p)=='t' for p in current['members'] if p!=pid)
                self.note('quiescent',observation=observation,ownership=self.b.verify_task_ownership())
                self.drive_peers()
            elif current['stage']=='wake-entry':
                observation=self.kernel_state();assert core.state(current['peer'])=='t'
                assert self.geometry()==current['beforeGeometry'],'cohort mapping geometry changed during peer userspace'
                word=self.b.generated_wait_word(current['peer'],current['entry']['args'][0]);assert word==b'\x01\x00\x00\x00'
                identity,original=self.snapshot(self.active['origin']['held']);assert base.same_object(identity,self.active['origin']['identity'])
                self.note('wake-window',observation=observation,wakeEntrySequence=current['wakeEntry']['sequence'],wordOriginal=base.raw_record(word),ownership=self.b.verify_task_ownership(),cohortMaps=self.last_samples,backingOriginal=original,backingIdentity=identity)
                self.note('waker-resume',pid=current['peer'],entrySequence=current['wakeEntry']['sequence'],request='PTRACE_SYSCALL',signal=0)
                current['stage']='wake-running';peer=current['peer'];core.single.trace(core.SYSCALL,peer,0,0);self.b.tasks[peer]['stopped']=False
            else:assert current['stage']=='wake-running','invalid coordinated scheduler state'
        def drive_peers(self):
            current=self.round
            assert all(self.b.tasks[peer]['entry'] is None for peer in current['candidates']),'peer trial requires all candidates at userspace boundaries'
            for attempt in range(256):
                self.b.check();peer=current['candidates'][attempt%len(current['candidates'])]
                current.update(stage='peer-running',peer=peer)
                assert self.b.tasks[peer]['stopped'] and core.state(peer)=='t'
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
                assert os.WIFSTOPPED(status) and status>>16==128 and os.WSTOPSIG(status)==5,'peer trial did not end at actual interrupt stop'
                event=current.pop('yieldEvent');observation=self.kernel_state()
                assert all(core.state(p)=='t' for p in current['members'] if p!=current['owner'])
                self.note('peer-stopped',pid=peer,eventSequence=event['sequence'],waitStatus=status,observation=observation,ownership=self.b.verify_task_ownership())
            raise TimeoutError('bounded same-cohort peer scheduling attempts exhausted')
        def finish(self,pid,entry,exit):
            current=self.round
            if current is None:return super().finish(pid,entry,exit)
            assert current['stage']=='wake-running' and pid in current['exits']
            if len(current['exits'])<2:return
            current['stage']='closing';barrier=self.b.barrier();assert self.geometry()==current['beforeGeometry']
            after=current['lease'].sample();assert not current['lease'].close()
            word=self.b.generated_wait_word(current['owner'],current['entry']['args'][0]);assert word==b'\x01\x00\x00\x00'
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
    windows=[r for r in rows if r['kind']=='generated-kernel-wait-window'];need(len(windows)==1,'one native prototype interval required');window=windows[0];owner=window['pid'];members=window['members'];need(type(owner) is int and members==sorted(set(members)) and 2<=len(members)<=128 and owner in members,'exact same-MM native pair required');peer=next(r['pid'] for r in rows[1:] if r['kind']=='kernel-syscall' and r['op']=='entry');need(peer in members and peer!=owner,'matching wake must come from same-MM peer')
    need(window['qualification'] is False,'prototype cannot grant qualification')
    entry=events[window['entrySequence']];epoch=events[window['epochSequence']];need(epoch['kind']=='generated-vma-operation-exit' and epoch['operation']=='map' and epoch['pid']==owner and events[epoch['windowSequence']]['originSequence']==window['originSequence'],'actual established mapping epoch required')
    mapped_window=events[epoch['windowSequence']];active=dict(address=epoch['result'],span=base.rounded_span(epoch['result'],epoch['identity'][3],mapped_window['pageBytes']));address=base.private_wait_dimensions(entry,active)
    need(entry['kind']=='kernel-syscall' and entry['op']=='entry' and entry['pid']==owner and base.raw_bytes(window['wordOriginal'])==b'\0'*4,'actual equal private wait entry required')
    domain,actual_members=context['domain'],context['members'];need(actual_members==members and epoch['memoryDomain']==domain and epoch['memoryDomainMembers']==members,'actual CLONE_VM cohort differs')
    stop=context['barrier'];need(window['barrierSequence']==stop['sequence'] and stop['pids']==members and stop['osStates']==['t']*len(members),'initial complete all-stop cohort required');ownership=stop['taskOwnership'];need([x['tid']for x in ownership]==members,'initial complete ownership required')
    lease=base.verify_proc_lease(window['procLease'],owner,canonical=True)
    def original(ref):
        need(isinstance(ref,dict) and set(ref)=={'path','bytes','sha256'} and re.fullmatch(r'capture-[0-9]{4,8}\.original',ref['path']) and type(ref['bytes'])is int and 0<=ref['bytes']<=maximum_file,'bounded actual original reference')
        count=0;digest=hashlib.sha256()
        for block in read_blocks(ref):
            need(isinstance(block,bytes) and 0<len(block)<=65536,'bounded complete original blocks required');count+=len(block);need(count<=ref['bytes'],'original byte bound');digest.update(block)
        need(count==ref['bytes'] and digest.hexdigest()==ref['sha256'],'original complete bytes differ');return count,digest.hexdigest()
    def maps(row):
        samples=row['cohortMaps'];need([x['pid']for x in samples]==members,'complete ordered maps pair required');geometry=None;parsed_owner=None
        for sample in samples:
            ref=sample['original'];original(ref);parsed=maps_data(ref);current=base.numeric_mapping_geometry(parsed)
            need(any(e['kind']=='toolchain-original'and e.get('captureKind')=='maps'and e.get('observedPid')==sample['pid']and e.get('original')==ref and e['sequence']<row['sequence']for e in [*context['mapRecords'],*rows]),'maps raw owner/source missing')
            base.wait_word_mapping(parsed,address);base.verify_established(parsed,epoch['result'],mapped_window['pageBytes'],epoch['identity'],epoch['identity'][3])
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
    count=len(members);start=0;closed_at=next(i for i in range(start,len(rows)) if rows[i]['kind']=='generated-kernel-wait-closed')
    complete=rows[start:closed_at+2];interval=complete[:4];position=4;trials=[];candidates=[p for p in members if p!=owner]
    while position<len(complete):
        trial=complete[position];need(trial['kind']=='generated-kernel-wait-peer-resume' and len(trials)<256,'bounded selected peer trial required')
        selected=trial['pid'];need(selected==candidates[len(trials)%len(candidates)] and trial['waiter']==owner and trial['request']=='PTRACE_SYSCALL' and trial['signal']==0,'canonical same-cohort round-robin trial required');trials.append(selected)
        following=complete[position+1]
        if following['kind']=='kernel-syscall':
            need(selected==peer,'wake came from another running peer');interval.extend(complete[position:]);break
        need(following['kind']=='ptrace-event' and following['pid']==selected and following['event']==128,'actual selected interrupt event required')
        stopped=complete[position+2];status=stopped.get('waitStatus');need(stopped['kind']=='generated-kernel-wait-peer-stopped' and stopped['pid']==selected and stopped['eventSequence']==following['sequence'] and type(status)is int and status&255==127 and status>>16==128 and status>>8&255==5,'actual interrupt-stop wait status required')
        kernel(stopped['observation']);need(stopped['ownership']==ownership,'complete ownership changed between peer trials')
        position+=3
    need(trials and interval[-1]['kind']=='exclusive-captured-syscall-exit','scheduled native interval did not close')
    expected=['generated-kernel-wait-window','exclusive-generated-vma-resume','generated-kernel-wait-waiter-resume','generated-kernel-wait-quiescent','generated-kernel-wait-peer-resume','kernel-syscall']+['toolchain-original']*count+['write-original','generated-kernel-wait-wake-window','generated-kernel-wait-waker-resume','kernel-syscall','exclusive-captured-syscall-exit','kernel-syscall','all-stop-barrier']+['toolchain-original']*count+['write-original','generated-kernel-wait-closed','exclusive-captured-syscall-exit']
    need([r['kind']for r in interval]==expected,'strict experimental interval order differs');need(all(r['phase']==entry['phase']for r in interval),'wait/wake crossed phase');need(int(epoch['observedMonotonicNs'])<=int(window['observedMonotonicNs'])and int(interval[-1]['observedMonotonicNs'])<int(epoch['windowDeadlineMonotonicNs'])<=int(epoch['parentDeadlineMonotonicNs']),'original finite mapping/parent deadline exceeded')
    resume=interval[1];need(resume['pid']==owner and resume['entrySequence']==entry['sequence']and resume['captureSequence']==window['sequence'],'wait window/resume differs')
    for row,pid,call in [(interval[2],owner,entry),(interval[4],peer,None),(interval[8+count],peer,interval[5])]:
        need(row['pid']==pid and row['request']=='PTRACE_SYSCALL'and row['signal']==0,'selected exact signal-free ptrace resume required')
        if call:need(row['entrySequence']==call['sequence'],'ptrace resume entry differs')
    quiescent=interval[3];wake_window=interval[7+count];closed=interval[14+2*count]
    for row in [quiescent,wake_window]:kernel(row['observation']);need(row['ownership']==ownership,'same complete kernel-quiescent ownership required')
    need(interval[4]['waiter']==owner,'peer resumed under another waiter')
    wake=interval[5];need(wake['op']=='entry'and wake['pid']==peer and wake['arch']==entry['arch']and wake['args'][0]==address,'actual same-cohort matching wake entry required');base.private_wake_dimensions(wake,active);need(wake_window['wakeEntrySequence']==wake['sequence'],'wake window entry differs')
    before_geometry,_=maps(wake_window);after_geometry,_=maps(closed);need(before_geometry==after_geometry==initial_geometry,'unobserved cohort VMA geometry change')
    need(base.raw_bytes(wake_window['wordOriginal'])==base.raw_bytes(closed['wordOriginal'])==b'\x01\0\0\0','complete before/after wake word differs')
    need(base.same_object(wake_window['backingIdentity'],epoch['identity'])and wake_window['backingIdentity']==closed['backingIdentity'],'backing object changed during wait/wake')
    need(original(wake_window['backingOriginal'])==original(closed['backingOriginal'])and wake_window['backingOriginal']['bytes']==epoch['identity'][3],'full backing body changed across kernel-only interval')
    proc=base.verify_proc_lease(closed['procAfter'],owner,canonical=True);need(proc['directoryIdentity']==lease['directoryIdentity']and proc['statIdentity']==lease['statIdentity']and proc['starttime']==lease['starttime'],'post-wait selected proc lifetime differs')
    exits=[interval[9+count],interval[11+count]];need({r['pid']for r in exits}=={owner,peer}and all(r['op']=='exit'and r['isError']is False for r in exits),'two actual distinct exit stops required')
    for row,close in zip(exits,[interval[10+count],interval[15+2*count]]):
        call=entry if row['pid']==owner else wake;result=0 if row['pid']==owner else 1;need(row['entrySequence']==call['sequence']and row['result']==result and close['pid']==row['pid']and close['entrySequence']==call['sequence']and close['result']==result and close['isError']is False,'exact actual wait/wake exits and closure required')
    need(closed['qualification']is False and closed['waitEntrySequence']==entry['sequence']and closed['wakeEntrySequence']==wake['sequence']and closed['waitExitSequence']==next(r['sequence']for r in exits if r['pid']==owner)and closed['wakeExitSequence']==next(r['sequence']for r in exits if r['pid']==peer),'composite closure differs')
    post=interval[12+count];need(post['sequence']==closed['barrierSequence']and post['pids']==members and post['osStates']==['t']*len(members)and post['taskOwnership']==ownership,'complete final actual all-stop ownership required')
    return {'mechanicalCompositeReplay':True,'qualification':False,'owner':owner,'peer':peer,'entrySequence':entry['sequence'],'closeSequence':closed['sequence'],'peerTrials':trials}


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
            self.metadata_bytes+=len(json.dumps(row,separators=(',',':')).encode());need(self.metadata_bytes<=4*1024**2,'shared scheduled metadata bound')
            if row['kind']=='write-original':self.original_sequences[self.key(row['original'])]=seq
            if row['kind']=='toolchain-original' and row.get('captureKind')=='maps':
                key=self.key(row['original']);self.map_sequences[key]=seq;self.map_owners[key]=row['observedPid']
            for values in [self.original_sequences,self.map_sequences]:
                while len(values)>256:
                    key=next(iter(values));values.pop(key)
                    if values is self.map_sequences:self.map_owners.pop(key,None)
        def record(self,row,entries,exits,barriers,caps):
            need=base.need;kind=row['kind']
            if kind=='generated-kernel-wait-window':
                need(self.model==base.COORDINATED_WAIT_MODEL and not self.scheduled_active and self.transaction is None and self.pending_window is None and self.active and self.coordinated_epoch,'scheduled window outside actual established epoch')
                entry=entries.get(row.get('entrySequence'));barrier=barriers.get(row.get('barrierSequence'))
                need(entry and entry['pid']==row['pid']==self.active['pid'] and row['epochSequence']==self.active['sequence'] and row['originSequence']==self.active['originSequence'] and barrier,'scheduled window actual entry/epoch/barrier differs')
                domain,members=base.complete_memory_cohort(self.mm,row['pid'],barrier)
                need((domain,members)==(self.active['memoryDomain'],self.active['memoryDomainMembers']),'scheduled cohort differs from established epoch')
                epoch,window=self.coordinated_epoch
                records=[]
                for sample in row['cohortMaps']:
                    key=self.key(sample['original']);sequence=self.map_sequences.get(key);owner=self.map_owners.get(key)
                    need(sequence and owner==sample['pid'] and barrier['sequence']<sequence<row['sequence'],'initial scheduled maps source/order differs')
                    records.append(dict(kind='toolchain-original',captureKind='maps',observedPid=owner,original=sample['original'],sequence=sequence))
                self.scheduled_context=dict(domain=domain,members=members,barrier=barrier,mapRecords=records,events={value['sequence']:value for value in [entry,epoch,window]})
                self.scheduled_rows=[]
            if self.scheduled_active:
                self.audit_scheduled(row);self.scheduled_rows.append(row)
                if len(self.scheduled_rows)>1 and self.scheduled_rows[-2]['kind']=='generated-kernel-wait-closed':
                    need(kind=='exclusive-captured-syscall-exit' and self.read_blocks is not None,'scheduled interval lacks final actual exclusive close')
                    summary=verify_interval(self.scheduled_rows,self.scheduled_context,self.read_blocks,self.maps_data,base,self.maximum_file)
                    if not hasattr(self,'coordinated_waits'):self.coordinated_waits=[]
                    self.coordinated_waits.append(dict(waitEntrySequence=summary['entrySequence'],closeSequence=summary['closeSequence'],waiter=summary['owner'],waker=summary['peer'],peerTrials=summary['peerTrials']))
                    self.scheduled_rows=None;self.scheduled_context=None
                return
            epoch_window=self.windows.get(row.get('windowSequence')) if kind=='generated-vma-operation-exit' and row.get('operation')=='map' else None
            super().record(row,entries,exits,barriers,caps)
            if epoch_window is not None:self.coordinated_epoch=(dict(row),dict(epoch_window))
            if self.active is None:self.coordinated_epoch=None
        def finish(self,caps,exits):
            base.need(not self.scheduled_active,'unclosed coordinated wait interval');return super().finish(caps,exits)
    return CoordinatedVerifier

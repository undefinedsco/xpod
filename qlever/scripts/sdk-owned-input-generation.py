"""Owned generated-input generations, scoped to exact observed byte custody.

Read leases remain continuous for every credited consumer. Between generations,
only a successful retained producer may authorize an observed synchronous writer.
This proves consumed bytes, not global host-writer absence during a no-consumer
mutation interval. Existing complete write projections remain authoritative.
"""
import hashlib
import os
import stat

MODEL = 'actual-owned-generated-input-byte-generations-v1'
OPEN = {0xc000003e: {2: (None, 0, 1), 257: (0, 1, 2)},
        0xc00000b7: {56: (0, 1, 2)}}
FD_REPLACEMENT = {0xc000003e: {32, 33, 292, 436},
                  0xc00000b7: {23, 24, 436}}
FCNTL = {0xc000003e:72,0xc00000b7:25}
def fd_replacement(entry):
    return entry['nr'] in FD_REPLACEMENT[entry['arch']] or (entry['nr']==FCNTL[entry['arch']] and entry['args'][1] in (0,2,4,1030))
TRUNCATE = {0xc000003e: 77, 0xc00000b7: 46}

def open_shape(entry):
    form = OPEN.get(entry['arch'], {}).get(entry['nr'])
    if form is None:
        return None
    directory, address, flags = form
    args = entry['args']
    return (-100 if directory is None else args[directory], args[address], args[flags])

def writable(flags):
    return flags & os.O_ACCMODE in (os.O_WRONLY, os.O_RDWR) or bool(flags & os.O_TRUNC)

def truncated_segments(segments,length):
    result=[];position=0
    for ref,offset,count in segments:
        keep=min(count,max(0,length-position))
        if keep:result.append((ref,offset,keep))
        position+=count
    if length>position:result.append((None,0,length-position))
    return result

def same_inode(mapping, identity):
    return (mapping['deviceMajor'], mapping['deviceMinor'], mapping['inode']) == (
        os.major(identity[0]), os.minor(identity[0]), identity[1])

class Runtime:
    def __init__(self, owner, api):
        self.owner = owner
        self.api = api
        self.active = {}
        self.roles = {}
        # Source identity outlives phase leases and every build hardlink alias.
        self.protected_sources = set()
        self.producer_entries = {}
        self.completed_producers = set()
        self.reads = {}
        self.retired_tokens = set()

    def reset_phase(self):
        assert not self.active, 'unclosed generated input generation at phase boundary'
        self.roles.clear()
        self.reads.clear()
        self.retired_tokens.clear()

    def record(self, row):
        kind = row['kind']
        if kind == 'fd-capture' and row.get('role') == 'source-read':
            self.protected_sources.add(tuple(row['identity'][:2]))
        if kind in ('toolchain-lease-acquired', 'toolchain-lease-reused'):
            self.roles.setdefault(tuple(row['identity'][:2]), set()).add(row['role'])
        if kind == 'fd-capture' and row['role'] == 'producer-close':
            self.producer_entries[row['entrySequence']] = row['sequence']
        if kind == 'regular-input-observation':
            key = tuple(row['identity'][:2])
            assert key not in self.active, 'consumer during unleased generated mutation'
            self.reads[row['entrySequence']] = key
        if kind == 'kernel-syscall' and row['op'] == 'exit':
            self.reads.pop(row.get('entrySequence'), None)
            producer = self.producer_entries.get(row.get('entrySequence'))
            if producer and not row['isError'] and row['result'] == 0:
                self.completed_producers.add(producer)
        if kind == 'actual-write-window':
            item = self.active.get(tuple(row['beforeIdentity'][:2]))
            if item is not None:
                assert row['pid'] == item['pid'] and row['fd'] == item['fd'], 'different generated writer FD'
                assert row['beforeIdentity'] == item['identity'], 'generated writer preimage identity changed'
                assert (row['before']['bytes'], row['before']['sha256']) == item['data'], 'unexplained bytes before generated write'
        if kind == 'actual-write-transition':
            item = self.active.get(tuple(row['afterIdentity'][:2]))
            if item is not None:
                assert row['pid'] == item['pid'], 'different generated writer PID'
                item.update(identity=list(row['afterIdentity']), data=(row['after']['bytes'], row['after']['sha256']), lastWrite=row['sequence'])
        if kind == 'fd-capture' and row['role'] == 'producer-close':
            item = self.active.get(tuple(row['identity'][:2]))
            if item is not None:
                assert row['pid'] == item['pid'] and row['fd'] == item['fd'], 'generation producer FD replaced'
                assert row['identity'] == item['identity'] and (row['original']['bytes'], row['original']['sha256']) == item['data'], 'generation producer contains unexplained bytes'
                item['producer'] = row

    def classify(self, pid, entry):
        owner = self.owner
        shape = open_shape(entry)
        if shape is not None and writable(shape[2]):
            owner.tasks[pid]['generationOpenPending'] = entry['sequence'];owner._pending_add(pid,'generationOpen')
        for item in self.active.values():
            if owner.tasks[pid]['fdTable'] == item['table']:
                assert not fd_replacement(entry), 'FD replacement during generated mutation'
            descriptor = self.api.memory_policy.write_descriptor(entry['arch'], entry['nr'], entry['args'])
            if descriptor is not None:
                try:
                    identity = self.api.probe.identity(os.stat('/proc/%d/fd/%d' % (pid, descriptor)))
                except FileNotFoundError:
                    identity = None
                if identity and identity[:2] == item['identity'][:2]:
                    assert pid == item['pid'] and descriptor == item['fd'] and entry['nr'] == self.api.profile(entry['arch'])['write'], 'unsupported generated mutation operation'
            if entry['nr'] == TRUNCATE[entry['arch']] and entry['args'][0] == item.get('fd') and pid == item['pid']:
                owner.tasks[pid]['generationTruncatePending']=entry['sequence'];owner._pending_add(pid,'generationTruncate')

    def pending(self):
        owner = self.owner
        if owner.exclusive is not None:
            return False
        if not (owner.pending['generationOpen'] or owner.pending['generationTruncate']):
            return False
        truncating=next(((pid,task) for pid,task in owner.tasks.items() if not task['exited'] and task.get('generationTruncatePending')),None)
        if truncating is not None:
            pid,task=truncating;pending=task.pop('generationTruncatePending');owner._pending_discard(pid,'generationTruncate');entry=task.get('entry')
            # The syscall exit may already have closed this task's entry before a
            # later pending_captures() drain observed the queued trigger. There is
            # no live truncate entry left to bind in that case; never index None.
            if entry is None or entry['sequence']!=pending:raise ValueError('owned input truncate trigger lacks exact live syscall entry')
            item=next(value for value in self.active.values() if value['pid']==pid and value['fd']==entry['args'][0])
            barrier=owner.barrier();owner.checkpoint_appends('generated-input-truncate',entry['sequence'])
            identity=self.api.probe.identity(os.fstat(item['held']))
            assert identity==item['identity'] and owner.bindings_digest_fd(item['held'],identity)==item['data'],'truncate contains unexplained preimage'
            assert self.api.probe.identity(os.stat('/proc/%d/fd/%d'%(pid,item['fd'])))==identity and self.api.descriptor_flags(pid,item['fd'])==item['flags'],'truncate writer FD replaced'
            length=entry['args'][1];assert 0<=length<=owner.maximum_file_bytes,'bounded generated truncate required'
            aliases=owner.stopped_write_alias_inventory(pid,item['fd'],identity)
            before=owner.snapshot_write_original(item['held'],identity[3])
            window=owner.emit(dict(kind='owned-input-generation-truncate-window',model=MODEL,pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],retirementSequence=item['begin']['sequence'],fd=item['fd'],flags=item['flags'],beforeIdentity=identity,beforeOriginal=before,length=length,stoppedAliasInventory=aliases))
            item['truncateWindow']=window;task['generationTruncating']=tuple(identity[:2]);owner.exclusive=(pid,entry['sequence'])
            owner.emit(dict(kind='exclusive-owned-input-truncate-resume',model=MODEL,pid=pid,entrySequence=entry['sequence'],captureSequence=window['sequence']))
            return True
        selected = next(((pid, task) for pid, task in owner.tasks.items()
                         if not task['exited'] and task.get('generationOpenPending')), None)
        if selected is None:
            return False
        pid, task = selected
        pending = task.pop('generationOpenPending');owner._pending_discard(pid,'generationOpen')
        entry = task.get('entry')
        # The matching exit may have cleared task['entry'] before this drain.
        # A queued trigger without its exact live entry is stale; do not turn a
        # closed syscall into a NoneType failure or a synthetic generation.
        if entry is None or entry['sequence']!=pending:raise ValueError('owned input open trigger lacks exact live syscall entry')
        barrier = owner.barrier()
        owner.checkpoint_appends('generated-input-open', entry['sequence'])
        directory, address, flags = open_shape(entry)
        path = self.api.path_argument(pid, directory, address)
        metadata = None
        held = None
        try:
            # Metadata-only O_PATH probe through the same bound tracee root and
            # openat2 RESOLVE_IN_ROOT|NO_MAGICLINKS. It never invokes a device
            # open, so headless /dev/tty stays an ordinary non-regular target.
            try:
                metadata = owner.lifetime_open(pid, path, metadata_only=True)
            except FileNotFoundError:
                return False
            metadata_value = os.fstat(metadata)
            identity = self.api.probe.identity(metadata_value)
            key = tuple(identity[:2])
            if not stat.S_ISREG(metadata_value.st_mode):
                return False
            assert key not in self.active, 'overlapping generated writer open'
            acquired = owner.lifetime_acquired.get(key)
            if acquired is None:
                return False
            # A real leased regular candidate keeps the existing read-open
            # handoff. Re-open only after the probe and require the full sampled
            # identity to be unchanged; both local FDs are closed by finally.
            os.close(metadata)
            metadata = None
            held = owner.lifetime_open(pid, path)
            assert self.api.probe.identity(os.fstat(held)) == identity, 'generated input changed between metadata and read open'
            assert key not in self.protected_sources, 'source/dependency inode cannot become mutable through a build alias'
            assert path.startswith(owner.build + '/'), 'source/dependency input mutation refused'
            producer = owner.producers.get(key)
            assert producer is not None and producer[0]['sequence'] in self.completed_producers, 'input mutation lacks a successful actual producer close'
            produced, retained, data = producer
            assert self.api.probe.identity(os.fstat(retained)) == identity, 'producer retained FD changed'
            owner.bindings_retained_generation(produced, identity,path)
            cached = owner.input_read_cache.get(tuple(identity))
            assert cached and data == (cached['reference']['bytes'], cached['reference']['sha256']), 'producer and protected generation bytes differ'
            assert acquired['identity'] == identity, 'protected input generation changed'
            assert not owner.writable_aliases(identity), 'preexisting writable alias at generation handoff'
            assert key not in self.reads.values(), 'active read consumer at generation handoff'
            # Check EVERY live address space, including peers of the writer.
            maps = []
            for peer, peer_task in sorted(owner.tasks.items()):
                if peer_task['exited']:
                    continue
                original, mappings = owner.tool_maps(peer)
                assert not any(same_inode(mapping, identity) for mapping in mappings), 'live mapping at generation handoff'
                active = peer_task.get('entry')
                descriptors=[]
                for slot in owner.bounded_fd_slots(peer):
                    actual=self.api.probe.identity(os.stat('/proc/%d/fd/%s' % (peer,slot)))
                    if actual[:2]==identity[:2]:
                        descriptor=int(slot);mode=self.api.descriptor_flags(peer,descriptor)
                        assert mode&os.O_ACCMODE==os.O_RDONLY,'generation peer has writable alias'
                        assert len(descriptors)<64,'generation peer descriptor bound'
                        descriptors.append(dict(fd=descriptor,identity=actual,flags=mode))
                inventory=owner.emit(dict(kind='owned-input-generation-peer',model=MODEL,pid=peer,
                    entrySequence=active['sequence'] if active else None,barrierSequence=barrier['sequence'],
                    openingEntrySequence=entry['sequence'],mapsSequence=original['sequence'],
                    identity=identity,fdTable=peer_task['fdTable'],targetFds=descriptors))
                maps.append(dict(pid=peer,captureSequence=original['sequence'],inventorySequence=inventory['sequence']))
                if active and self.api.bindings.read_form(active['arch'], active['nr']):
                    try:
                        value = os.stat('/proc/%d/fd/%d' % (peer, active['args'][0]))
                    except FileNotFoundError:
                        continue
                    assert (value.st_dev, value.st_ino) != key, 'pending read consumer at generation handoff'
            # mmap/executable backing leases remain phase-continuous even after
            # munmap/exec closure; current empty maps never reclassify that inode.
            assert self.roles.get(key) == {'input-read'}, 'phase-continuous executable or mmap lease cannot become mutable'
            owner.lifetime_leases.retire(acquired['token'])
            del owner.lifetime_acquired[key]
            owner.lifetime_by_identity.pop(tuple(identity), None)
            for cached_identity in list(owner.input_read_cache):
                if cached_identity[:2]==key:del owner.input_read_cache[cached_identity]
            for descriptor,generation in list(owner.input_generation.items()):
                if tuple(generation['identity'][:2])==key:del owner.input_generation[descriptor]
            self.retired_tokens.add(acquired['token']['leaseId'])
            retired = owner.emit(dict(kind='owned-input-generation-retired', model=MODEL, pid=pid,
                entrySequence=entry['sequence'], barrierSequence=barrier['sequence'],
                oldLeaseId=acquired['token']['leaseId'], acquisitionSequence=acquired['sequence'],
                beforeIdentity=identity, beforeOriginal=cached['reference'], producerCaptureSequence=produced['sequence'],
                flags=flags, path=path, maps=maps, writableAliases=[], activeReads=[]))
            item = dict(pid=pid, table=task['fdTable'], entry=entry, begin=retired,
                held=held, identity=identity, data=data, fd=None, lastWrite=None, producer=None)
            self.active[key] = item
            owner.retained.add(held)
            held = None
            task['generationOpening'] = key
            owner.exclusive = (pid, entry['sequence'])
            owner.emit(dict(kind='exclusive-owned-input-generation-resume', model=MODEL, pid=pid,
                entrySequence=entry['sequence'], captureSequence=retired['sequence']))
            return True
        finally:
            if metadata is not None:
                os.close(metadata)
            if held is not None:
                os.close(held)

    def exit(self, pid, entry, exit):
        owner = self.owner
        truncating=owner.tasks[pid].pop('generationTruncating',None)
        if truncating is not None:
            item=self.active[truncating];window=item.pop('truncateWindow')
            assert owner.exclusive==(pid,entry['sequence']) and not exit['isError'] and exit['result']==0,'truncate lacks exclusive successful kernel exit'
            identity=self.api.probe.identity(os.fstat(item['held']))
            assert identity==self.api.probe.identity(os.stat('/proc/%d/fd/%d'%(pid,item['fd']))) and identity[:3]==window['beforeIdentity'][:3] and identity[3]==window['length'] and self.api.descriptor_flags(pid,item['fd'])==window['flags'],'truncate FD/identity differs'
            segments=truncated_segments([(window['beforeOriginal'],0,window['beforeIdentity'][3])],window['length'])
            expected=self.api.bindings.digest_blocks(self.api.bindings.segment_blocks(segments,owner.original_blocks,owner.check),owner.maximum_file_bytes,owner.check)
            actual=owner.bindings_digest_fd(item['held'],identity);assert actual==(expected['bytes'],expected['sha256']),'actual truncate bytes differ from exact prefix/zero extension'
            aliases=owner.stopped_write_alias_inventory(pid,item['fd'],identity)
            prior=window['stoppedAliasInventory'];assert aliases['taskOwnership']==prior['taskOwnership'] and [{**alias,'identity':window['beforeIdentity']} for alias in aliases['aliases']]==prior['aliases'],'truncate writer alias changed'
            transition=owner.emit(dict(kind='owned-input-generation-truncated',model=MODEL,pid=pid,entrySequence=entry['sequence'],exitSequence=exit['sequence'],windowSequence=window['sequence'],retirementSequence=item['begin']['sequence'],afterIdentity=identity,after=expected,result=exit['result'],isError=exit['isError'],stoppedAliasInventoryAfter=aliases))
            item.update(identity=identity,data=actual,lastWrite=transition['sequence'])
            owner.write_states[truncating]=transition;owner.write_projections[truncating]=segments
            return
        key = owner.tasks[pid].pop('generationOpening', None)
        if key is not None:
            item = self.active[key]
            assert owner.exclusive == (pid, entry['sequence']), 'generation open lost exclusive ownership'
            assert not exit['isError'] and type(exit['result']) is int and exit['result'] >= 0, 'generation write-open did not succeed'
            fd = exit['result']
            identity = self.api.probe.identity(os.fstat(item['held']))
            assert identity == self.api.probe.identity(os.stat('/proc/%d/fd/%d' % (pid, fd))) and identity[:3] == item['identity'][:3], 'opened writer FD differs from retained generation'
            flags = self.api.descriptor_flags(pid, fd)
            assert flags & os.O_ACCMODE == item['begin']['flags'] & os.O_ACCMODE, 'writer open flags differ'
            data = owner.bindings_digest_fd(item['held'], identity)
            expected = (0, hashlib.sha256(b'').hexdigest()) if item['begin']['flags'] & os.O_TRUNC else item['data']
            assert data == expected, 'write-open has unexplained content effect'
            item.update(fd=fd, flags=flags, identity=identity, data=data)
            row = owner.emit(dict(kind='owned-input-generation-opened', model=MODEL, pid=pid,
                retirementSequence=item['begin']['sequence'], entrySequence=entry['sequence'], exitSequence=exit['sequence'],
                fd=fd, flags=flags, afterIdentity=identity, after=dict(bytes=data[0], sha256=data[1])))
            item['opened'] = row
            if item['begin']['flags'] & os.O_TRUNC:
                owner.write_states.pop(key, None)
                owner.write_projections.pop(key, None)
            return
        item = next((value for value in self.active.values()
                     if value['pid'] == pid and value['fd'] is not None and entry['nr'] == self.api.profile(entry['arch'])['close'] and entry['args'][0] == value['fd']), None)
        if item is None:
            return
        assert owner.exclusive == (pid, entry['sequence']) and not exit['isError'] and exit['result'] == 0, 'generation close failed or not exclusive'
        assert item['producer'] is not None, 'generation lacks actual producer-close capture'
        barrier = owner.barrier()
        identity = self.api.probe.identity(os.fstat(item['held']))
        assert identity == item['identity'] and owner.bindings_digest_fd(item['held'], identity) == item['data'], 'generation close contains unexplained content or identity'
        assert not owner.writable_aliases(identity), 'generation close has live writer alias'
        acquired = owner.lifetime_ensure(pid, item['held'], identity, item['begin']['path'], 'input-read', entry['sequence'], barrier['sequence'], source=MODEL, depth=0)
        # Capture only AFTER reacquiring the new generation's real read lease.
        name=owner.next_capture_name();digest=hashlib.sha256();count=0
        with (owner.capture_dir/name).open('xb') as output:
            for block in owner.fd_blocks(item['held'],identity[3]):
                owner.check();owner.claim(len(block),category='capture-body',context=dict(role='generation-postimage',pid=pid))
                output.write(block);digest.update(block);count+=len(block)
            output.flush();os.fsync(output.fileno())
        assert (count,digest.hexdigest())==item['data'] and self.api.probe.identity(os.fstat(item['held']))==identity,'postimage differs from complete observed write projection'
        original=dict(path=name,bytes=count,sha256=digest.hexdigest());entity=owner.register_capture_entity(original);owner.capture_bytes+=count
        captured = owner.emit(dict(kind='toolchain-original', captureKind='input-read', observedPath=item['begin']['path'], identity=identity, original=original, originalEntityIdentity=entity, regularInputOriginalModel=MODEL))
        owner.append_capture(captured)
        owner.input_read_cache[tuple(identity)] = dict(reference=original, sequence=captured['sequence'], entity=entity, leaseSequence=acquired['sequence'], leaseId=acquired['leaseId'])
        owner.emit(dict(kind='owned-input-generation-acquired', model=MODEL, pid=pid,
            retirementSequence=item['begin']['sequence'], openedSequence=item['opened']['sequence'],
            entrySequence=entry['sequence'], exitSequence=exit['sequence'], barrierSequence=barrier['sequence'],
            producerCaptureSequence=item['producer']['sequence'], fd=item['fd'], flags=item['flags'],
            lastWriteTransitionSequence=item['lastWrite'], afterIdentity=identity, postimageOriginal=original,
            originalSequence=captured['sequence'], leaseId=acquired['leaseId'], acquisitionSequence=acquired['sequence'],
            scope='exact consumed generation bytes; no global writer-absence claim between generations'))
        del self.active[tuple(identity[:2])]
        os.close(item['held'])
        owner.retained.remove(item['held'])

    def finish(self):
        assert not self.active, 'unclosed owned generated-input mutation interval'

class Replay:
    """Additional typed state; ordinary replay still validates every cited row.

    No token is deleted: retired IDs remain reserved for the complete phase.
    Only the explicitly declared model permits early, witnessed retirement.
    """
    def __init__(self, api, capture_data, original_bytes, metadata_chain, maximum):
        self.api=api;self.capture_data=capture_data;self.original_bytes=original_bytes
        self.metadata_chain=metadata_chain;self.maximum=maximum
        self.caps={};self.completed=set();self.cap_entries={}
        self.protected_sources=set() # Derived source captures persist across phases.
        self.current={};self.leases={};self.roles={};self.maps={};self.peers={}
        self.active={};self.retired=set();self.mode=None;self.open_resumes=set()
        self.barriers={};self.latest_barrier=None;self.originals={};self.acquisitions={}
        self.reads={};self.count=0;self.total_completed=0

    def fail(self,condition,why):
        self.api.need(condition,'owned input generation: '+why)

    def phase(self):
        self.fail(not self.active,'mutation crosses phase boundary')
        self.current.clear();self.leases.clear();self.roles.clear();self.maps.clear();self.peers.clear()
        self.retired.clear();self.mode=None;self.open_resumes.clear();self.barriers.clear()
        self.originals.clear();self.acquisitions.clear();self.reads.clear();self.count=0

    def record(self,row):
        kind=row['kind'];seq=row['sequence'];pid=row.get('pid')
        if kind=='owned-root-binding':
            self.mode=row.get('ownedInputGenerationModel')
            self.fail(self.mode in (None,MODEL),'unknown model')
        if kind.startswith('owned-input-generation-') or kind in ('exclusive-owned-input-generation-resume','exclusive-owned-input-truncate-resume'):
            self.fail(self.mode==MODEL and row.get('model')==MODEL,'undeclared transition')
        if kind=='all-stop-barrier':
            self.barriers[seq]=row;self.latest_barrier=row
        if kind=='toolchain-original':
            if row.get('captureKind')=='maps':self.maps[seq]=row
            if row.get('captureKind')=='input-read':self.originals[seq]=row
        if kind=='fd-capture' and row.get('role')=='source-read':
            self.protected_sources.add(tuple(row['identity'][:2]))
        if kind=='fd-capture' and row['role']=='producer-close':
            self.caps[seq]=row;self.cap_entries[row['entrySequence']]=seq
            item=self.active.get(tuple(row['identity'][:2]))
            if item:
                self.fail(pid==item['pid'] and row['fd']==item['fd'] and row['identity']==item['identity'] and self.capture_data(row['original'])==item['data'],'close producer is not observed generation postimage')
                item['producer']=row
        if kind in ('toolchain-lease-acquired','toolchain-lease-reused'):
            self.roles.setdefault(tuple(row['identity'][:2]),set()).add(row['role'])
            if kind=='toolchain-lease-acquired':
                self.leases[row['leaseId']]=row;self.acquisitions[seq]=row
        if kind=='regular-input-observation':
            key=tuple(row['identity'][:2]);self.fail(key not in self.active and row['readLeaseId'] not in self.retired,'consumer cites an unprotected generation')
            self.reads[row['entrySequence']]=key
        if kind=='kernel-syscall':
            if row['op']=='entry':
                self.current[pid]=row
                for item in self.active.values():
                    if self.api.owner_table(pid)==item['table']:
                        self.fail(not fd_replacement(row),'FD replacement during mutation')
            else:
                entry=self.current.pop(pid,None)
                self.reads.pop(row.get('entrySequence'),None)
                cap=self.cap_entries.get(row.get('entrySequence'))
                if cap and not row['isError'] and row['result']==0:self.completed.add(cap)
                for item in self.active.values():
                    if pid==item['pid'] and item.get('truncateWindow') and entry and entry['sequence']==item['truncateWindow']['entrySequence']:item['truncateExit']=row
                    if pid==item['pid'] and entry and entry['sequence']==item['begin']['entrySequence']:
                        self.fail(row.get('entrySequence')==entry['sequence'] and seq>item['begin']['sequence'] and entry['sequence'] in self.open_resumes,'write-open exit lacks exclusive real entry')
                        item['openExit']=row
                    if pid==item['pid'] and entry and entry['nr']==self.api.policy(entry['arch'])['close'] and entry['args'][0]==item.get('fd'):
                        self.fail(row.get('entrySequence')==entry['sequence'] and not row['isError'] and row['result']==0,'generation close failed')
                        item['closeExit']=row;item['closeEntry']=entry
        if kind=='owned-input-generation-peer':
            self.peers[seq]=row
        if kind=='owned-input-generation-retired':
            self.count+=1;self.fail(self.count<=self.maximum,'generation count exceeds existing member bound')
            entry=self.current.get(pid);barrier=self.barriers.get(row['barrierSequence']);old=self.leases.get(row['oldLeaseId'])
            self.fail(entry and entry['sequence']==row['entrySequence'] and barrier and entry['sequence']<barrier['sequence']<seq and self.latest_barrier is barrier,'retirement lacks fresh exact entry/all-stop')
            shape=open_shape(entry)
            self.fail(shape and writable(shape[2]) and shape[2]==row['flags'],'retirement open ABI/flags differ')
            identity=row['beforeIdentity'];key=tuple(identity[:2])
            self.fail(old and old['leaseId'] not in self.retired and old['identity']==identity and old['sequence']==row['acquisitionSequence'] and self.roles.get(key)=={'input-read'},'retirement lacks exact phase-continuous input-only held token')
            self.fail(key not in self.protected_sources,'source/dependency inode cannot become mutable through a build alias')
            producer=self.caps.get(row['producerCaptureSequence'])
            self.fail(row['path'].startswith(self.api.build_root+'/'),'source or dependency cannot be a generated mutation')
            self.fail(producer and producer['sequence'] in self.completed and producer['sequence']<seq and producer['identity'][:2]==identity[:2],'no successful retained generation producer')
            self.metadata_chain(producer,dict(sequence=seq,identity=identity,path=row['path']))
            data=self.capture_data(row['beforeOriginal'])
            self.fail(data==self.capture_data(producer['original']) and data[0]==identity[3],'protected preimage differs from producer bytes')
            self.fail(key not in self.active and key not in self.reads.values() and row['writableAliases']==[] and row['activeReads']==[],'overlapping writer or active consumer')
            self.fail([value['pid'] for value in row['maps']]==barrier['pids'],'peer maps universe differs from all-stop')
            for value in row['maps']:
                peer=self.peers.get(value['inventorySequence']);maps=self.maps.get(value['captureSequence'])
                self.fail(peer and maps and maps['observedPid']==value['pid']==peer['pid'] and peer['mapsSequence']==maps['sequence'] and peer['openingEntrySequence']==entry['sequence'] and peer['barrierSequence']==barrier['sequence'] and barrier['sequence']<maps['sequence']<peer['sequence']<seq and peer['identity']==identity,'peer inventory not from this all-stop')
                self.fail(peer['fdTable']==self.api.owner_table(peer['pid']) and len(peer['targetFds'])<=64 and len({value['fd'] for value in peer['targetFds']})==len(peer['targetFds']),'peer FD table or descriptor census differs')
                pending=self.current.get(peer['pid'])
                self.fail(peer['entrySequence']==(pending['sequence'] if pending else None),'peer inventory pending syscall differs')
                self.fail(all(fd['identity']==identity and fd['flags']&os.O_ACCMODE==os.O_RDONLY for fd in peer['targetFds']),'writable peer alias')
                if pending and self.api.read_form(pending['arch'],pending['nr']):
                    self.fail(not any(fd['fd']==pending['args'][0] for fd in peer['targetFds']),'pending read consumer')
                parsed=self.api.parse_proc_maps(self.original_bytes(maps['original']))
                self.fail(not any(same_inode(mapping,identity) for mapping in parsed),'live mapped consumer')
            self.retired.add(old['leaseId'])
            self.active[key]=dict(pid=pid,table=self.api.owner_table(pid),begin=row,identity=identity,data=data,fd=None,lastWrite=None,producer=None)
        if kind=='exclusive-owned-input-generation-resume':
            item=next((value for value in self.active.values() if value['begin']['sequence']==row['captureSequence']),None)
            self.fail(item and pid==item['pid'] and row['entrySequence']==item['begin']['entrySequence'] and seq==item['begin']['sequence']+1,'missing immediate exact exclusive write-open resume')
            self.open_resumes.add(row['entrySequence'])
        if kind=='owned-input-generation-opened':
            item=next((value for value in self.active.values() if value['begin']['sequence']==row['retirementSequence']),None)
            self.fail(item and pid==item['pid'],'opened generation lacks retirement')
            exit=item.get('openExit');self.fail(exit and exit['sequence']==row['exitSequence'] and exit['entrySequence']==row['entrySequence'] and not exit['isError'] and exit['result']==row['fd'] and row['fd']>=0,'opened generation lacks successful exact kernel exit/FD')
            expected=(0,hashlib.sha256(b'').hexdigest()) if item['begin']['flags']&os.O_TRUNC else item['data']
            self.fail(row['afterIdentity'][:3]==item['identity'][:3] and row['afterIdentity'][3]==expected[0] and (row['after']['bytes'],row['after']['sha256'])==expected and row['flags']&os.O_ACCMODE==item['begin']['flags']&os.O_ACCMODE,'open effect or writer flags differ')
            item.update(fd=row['fd'],flags=row['flags'],identity=row['afterIdentity'],data=expected,opened=row)
        if kind=='owned-input-generation-truncate-window':
            item=self.active.get(tuple(row['beforeIdentity'][:2]));entry=self.current.get(pid);barrier=self.barriers.get(row['barrierSequence'])
            self.fail(item and entry and entry['sequence']==row['entrySequence'] and entry['nr']==TRUNCATE[entry['arch']] and entry['args'][0]==row['fd']==item['fd'] and entry['args'][1]==row['length'] and 0<=row['length']<=self.api.maximum_file and barrier and entry['sequence']<barrier['sequence']<seq,'truncate window lacks exact entry/barrier/FD')
            self.fail(row['retirementSequence']==item['begin']['sequence'] and pid==item['pid'] and row['flags']==item['flags'] and row['beforeIdentity']==item['identity'] and self.capture_data(row['beforeOriginal'])==item['data'],'truncate preimage differs from generation')
            self.api.write_alias_inventory(row['stoppedAliasInventory'],row['beforeIdentity'],pid,row['fd'])
            item['truncateWindow']=row
        if kind=='exclusive-owned-input-truncate-resume':
            item=next((value for value in self.active.values() if value.get('truncateWindow',{}).get('sequence')==row['captureSequence']),None)
            self.fail(item and pid==item['pid'] and row['entrySequence']==item['truncateWindow']['entrySequence'] and seq==item['truncateWindow']['sequence']+1,'truncate lacks immediate exclusive resume')
            item['truncateResumed']=True
        if kind=='owned-input-generation-truncated':
            item=self.active.get(tuple(row['afterIdentity'][:2]));window=item.get('truncateWindow') if item else None;exit=item.get('truncateExit') if item else None
            self.fail(item and window and exit and item.pop('truncateResumed',False) and pid==item['pid'] and row['windowSequence']==window['sequence'] and row['entrySequence']==window['entrySequence']==exit['entrySequence'] and row['exitSequence']==exit['sequence'] and not exit['isError'] and exit['result']==row['result']==0 and row['isError'] is False,'truncate lacks actual exclusive successful exit')
            self.fail(row['afterIdentity'][:3]==window['beforeIdentity'][:3] and row['afterIdentity'][3]==window['length'],'truncate changed inode/type or wrong size')
            segments=truncated_segments([(window['beforeOriginal'],0,window['beforeIdentity'][3])],window['length'])
            after=self.api.digest_blocks(self.api.segment_blocks(segments,self.api.original_blocks),self.api.maximum_file)
            self.fail(row['after']==after,'truncate projection differs')
            aliases=self.api.write_alias_inventory(row['stoppedAliasInventoryAfter'],row['afterIdentity'],pid,window['fd'])
            self.fail([{**alias,'identity':window['beforeIdentity']} for alias in aliases]==window['stoppedAliasInventory']['aliases'],'truncate alias bindings changed')
            item.update(identity=row['afterIdentity'],data=(after['bytes'],after['sha256']),lastWrite=seq)
            item['truncateSegments']=segments;item.pop('truncateWindow')
        if kind=='actual-write-window':
            item=self.active.get(tuple(row['beforeIdentity'][:2]))
            if item:
                self.fail(pid==item['pid'] and row['fd']==item['fd'] and row['flags']==item['flags'] and row['beforeIdentity']==item['identity'] and (row['before']['bytes'],row['before']['sha256'])==item['data'],'write preimage/FD differs from generation')
                item['window']=row
        if kind=='actual-write-transition':
            item=self.active.get(tuple(row['afterIdentity'][:2]))
            if item:
                self.fail(item.get('window') and item['window']['sequence']==row['windowSequence'] and pid==item['pid'],'write transition lacks exact generation window')
                item.update(identity=row['afterIdentity'],data=(row['after']['bytes'],row['after']['sha256']),lastWrite=seq)
        if kind=='owned-input-generation-acquired':
            item=next((value for value in self.active.values() if value['begin']['sequence']==row['retirementSequence']),None)
            self.fail(item and pid==item['pid'] and item.get('opened') and item['opened']['sequence']==row['openedSequence'],'new generation lacks exact retired/opened chain')
            close=item.get('closeExit');entry=item.get('closeEntry');barrier=self.barriers.get(row['barrierSequence']);producer=item.get('producer')
            self.fail(close and entry and close['sequence']==row['exitSequence'] and entry['sequence']==row['entrySequence'] and producer and producer['sequence']==row['producerCaptureSequence'] and producer['entrySequence']==entry['sequence'] and barrier and close['sequence']<barrier['sequence']<seq,'new generation lacks actual producer close/exit/all-stop')
            lease=self.acquisitions.get(row['acquisitionSequence']);original=self.originals.get(row['originalSequence'])
            self.fail(lease and original and lease['leaseId']==row['leaseId'] and lease['leaseId']>item['begin']['oldLeaseId'] and lease['role']=='input-read' and lease['identity']==row['afterIdentity']==item['identity']==original['identity'] and lease['entrySequence']==entry['sequence'] and lease['barrierSequence']==barrier['sequence'] and close['sequence']<lease['sequence']<original['sequence']<seq,'new generation lacks exact fresh held lease/postimage')
            self.fail(row['fd']==item['fd'] and row['flags']==item['flags'] and row['lastWriteTransitionSequence']==item['lastWrite'] and row['postimageOriginal']==original['original'] and self.capture_data(row['postimageOriginal'])==item['data'],'new generation bytes not fully explained by observed writes')
            self.total_completed+=1
            del self.active[tuple(item['identity'][:2])]

    def finish(self):
        self.fail(not self.active,'unclosed mutation at phase end')

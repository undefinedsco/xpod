"""Single all-stop Linux execution backend shared by diagnostics and SDK capture.

The caller owns the absolute phase deadline and the outer SDK owner lifecycle.
No strace tracer may be attached concurrently. This library emits observations;
it never issues source/SDK/native authority.
"""
import ctypes
import errno
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import stat
import sys
import time
import threading
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
probe=load('sdk_execution_originals_util',ROOT/'qlever/scripts/sdk-execution-originals-util.py')
bindings=load('multi_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py')
single=load('sdk_ptrace_kernel',ROOT/'qlever/scripts/sdk-ptrace-kernel.py')
owned_wait=load('owned_wait',ROOT/'qlever/scripts/sdk-blocking-owned-wait.py')
SEIZE=0x4206;INTERRUPT=0x4207;GETEVENTMSG=0x4201;SYSCALL=24;WALL=0x40000000
OPTIONS=1|2|4|8|16|32|64|0x00100000
MAX=16*1024**2
SELECTED={'config.h','generated.h','custom.h'}
def profile(arch):return bindings.policy(arch)
def fdpath(pid,fd):
    try:return os.readlink('/proc/'+str(pid)+'/fd/'+str(fd))
    except FileNotFoundError:return None

def descriptor_flags(pid,fd):
    text=Path('/proc',str(pid),'fdinfo',str(fd)).read_text();rows=[x.split()[1] for x in text.splitlines() if x.startswith('flags:')];assert len(rows)==1;return int(rows[0],8)
def descriptor_position(pid,fd):
    rows=[line.split()[1] for line in Path('/proc',str(pid),'fdinfo',str(fd)).read_text().splitlines() if line.startswith('pos:')];assert len(rows)==1;return int(rows[0])
def state(pid):
    fields=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split();return fields[0]

def path_argument(pid,dirfd,address):
    value=single.cstring(pid,address)
    if value.startswith('/'):return os.path.normpath(value)
    base=os.readlink('/proc/'+str(pid)+'/cwd') if dirfd in [0xffffffffffffff9c,0xffffff9c,-100] else fdpath(pid,dirfd)
    assert base and base.startswith('/');return os.path.normpath(base+'/'+value)

class ShardedRaw:
    def __init__(self,out,name,maximum):
        self.out=out;self.name_prefix=name;self.maximum=maximum;self.total=0;self.paths=[];self.file=None;self.open_next()
    def open_next(self):
        path=self.out/(self.name_prefix+'.trace-'+str(len(self.paths)).zfill(4)+'.jsonl');self.file=path.open('xb');self.paths.append(path)
    def write(self,data):
        assert len(data)<=65536 and len(data)<=self.maximum,'raw record/shard bound'
        if self.file.tell()+len(data)>self.maximum:self.file.flush();os.fsync(self.file.fileno());self.file.close();self.open_next()
        self.file.write(data);self.total+=len(data)
    def flush(self):self.file.flush()
    def tell(self):return self.total
    def close(self):self.file.flush();os.fsync(self.file.fileno());self.file.close()

def actual_executable(command):
    assert isinstance(command,list) and command,'actual argv required'
    executable='/usr/bin/bash' if command[0]=='bash' else command[0]
    assert os.path.isabs(executable),'fixed absolute executable required'
    return executable

class BoundedPipePump:
    """One owned pipe, bounded before writing any bytes to its original file."""
    def __init__(self,descriptor,path,maximum,claim,errors):
        self.descriptor=descriptor;self.path=Path(path);self.maximum=maximum;self.claim=claim;self.errors=errors
        self.bytes=0;self.sha256=None;self.thread=threading.Thread(target=self.run,daemon=True)
    def run(self):
        digest=hashlib.sha256()
        try:
            with self.path.open('xb') as output:
                while True:
                    block=os.read(self.descriptor,65536)
                    if not block:break
                    assert self.bytes+len(block)<=self.maximum,'actual stdio single-stream byte bound'
                    self.claim(len(block));output.write(block);self.bytes+=len(block);digest.update(block)
                output.flush();os.fsync(output.fileno());self.sha256=digest.hexdigest()
        except BaseException as error:self.errors.append(str(error))
        finally:os.close(self.descriptor)
    def start(self):self.thread.start()
    def finish(self,check):
        while self.thread.is_alive():check();self.thread.join(.05)
        check();assert self.sha256 is not None,'actual stdio pipe did not close'

class Observer:
    def __init__(self,out,source,build,*,deadline_monotonic=None,check_budget=lambda:None,maximum_bytes=32*1024**2,maximum_file_bytes=1024**2,selected_names=SELECTED,maximum_processes=128,shard_bytes=None,require_success=True,maximum_stdio_bytes=None):
        self.prepared_inputs={};self.prepared_sealed=False;self.domain_bytes=0;self.domain_lock=threading.Lock();self.pump_errors=[];self.maximum_stdio_bytes=maximum_stdio_bytes if maximum_stdio_bytes is not None else maximum_file_bytes
        self.require_success=require_success;self.raw_bytes_completed=0;self.maximum_processes=maximum_processes;self.shard_bytes=shard_bytes
        self.deadline_monotonic=deadline_monotonic;self.check_budget=check_budget;self.maximum_bytes=maximum_bytes;self.maximum_file_bytes=maximum_file_bytes;self.selected_names=selected_names
        self.out=Path(out);self.capture_dir=self.out;self.source=str(source);self.build=str(build);self.tasks={};self.seq=0;self.records=[];self.captures=[];self.retained=set();self.producers={};self.write_states={};self.metadata_states=[];self.rename_records=[];self.consumers=[];self.raw=None;self.deadline=0;self.pausing=False;self.root=None;self.root_code=None;self.failures=[];self.current_phase=None;self.unknown_stops={};self.capture_bytes=0;self.exclusive=None;self.wait_references=[]
    def tighten_remaining(self,remaining_bytes):
        # External source domains supply only their remaining allowance. The
        # existing observer ledger remains private and is clipped under the
        # same lock used by capture and both stdio pumps; never reset charges.
        self.check_budget()
        assert type(remaining_bytes) is int and remaining_bytes>=0,'nonnegative actual remaining source bytes required'
        with self.domain_lock:
            self.maximum_bytes=min(self.maximum_bytes,self.domain_bytes+remaining_bytes)
            return self.maximum_bytes
    def claim(self,count):
        self.check_budget()
        with self.domain_lock:
            assert count>=0 and self.domain_bytes+count<=self.maximum_bytes,'shared execution original byte bound'
            self.domain_bytes+=count
    def emit(self,row):
        self.check();self.seq+=1;row=dict(row,sequence=self.seq,phase=self.current_phase,observedUnixNs=str(time.time_ns()));data=(json.dumps(row,sort_keys=True)+'\n').encode()
        self.claim(len(data));self.raw.write(data);self.raw.flush();return row
    def wait_one(self):
        return self.waiter.wait_one()
    def check(self):
        self.check_budget();assert not self.pump_errors,'actual bounded stdio failed: '+str(self.pump_errors);assert time.monotonic()<self.deadline,'all-stop observer deadline'
    def barrier(self):
        self.pausing=True
        try:
            for pid,row in list(self.tasks.items()):
                if not row['stopped'] and not row['exited']:
                    try:single.trace(INTERRUPT,pid)
                    except OSError as error:
                        if error.errno not in [errno.EIO,errno.ESRCH]:raise
            while self.unknown_stops or any(not r['stopped'] and not r['exited'] for r in self.tasks.values()):
                pid,status=self.wait_one();self.event(pid,status,False)
            known=[]
            for pid,row in self.tasks.items():
                if row['exited']:continue
                assert row['stopped'] and state(pid)=='t','potential writer not in OS tracing-stop'
                assert os.listdir('/proc/'+str(pid)+'/task')==[str(pid)],'unknown shared writer thread'
                known.append(pid)
            return self.emit(dict(kind='all-stop-barrier',pids=sorted(known),osStates=['t']*len(known)))
        finally:self.pausing=False
    def sole_writer(self,target_pid,target_fd,identity):
        writers=[]
        for pid,row in self.tasks.items():
            if row['exited']:continue
            for value in os.listdir('/proc/'+str(pid)+'/fd'):
                fd=int(value)
                try:
                    item=os.stat('/proc/'+str(pid)+'/fd/'+value)
                    if (item.st_dev,item.st_ino)==tuple(identity[:2]) and descriptor_flags(pid,fd)&os.O_ACCMODE in [os.O_WRONLY,os.O_RDWR]:writers.append(dict(pid=pid,fd=fd))
                except FileNotFoundError:raise ValueError('descriptor changed during all-stop')
        assert writers==[dict(pid=target_pid,fd=target_fd)],'another writable FD aliases selected output inode'
        return writers
    def seal_prepared_build_inputs(self):
        # This runs once, before the first tracee is forked. Existing build
        # inputs have a different origin from a close observed by this tracer.
        assert not self.tasks and not self.prepared_sealed,'prepared input snapshot must precede the first actual root'
        root=Path(self.build);assert not self.out.resolve().is_relative_to(root.resolve()),'observer originals must not be inside the input build root'
        def entries():
            result=[]
            if not root.exists():return result
            for directory,dirs,files in os.walk(root,followlinks=False):
                self.check()
                for name in dirs:
                    assert not Path(directory,name).is_symlink(),'prepared build directory symlink requires separate source binding'
                for name in files:
                    path=Path(directory,name);item=path.lstat()
                    assert stat.S_ISREG(item.st_mode),'prepared build input must be a regular no-follow original: '+str(path)
                    result.append((str(path.absolute()),probe.identity(item)))
                    assert len(result)<=self.maximum_processes,'prepared build original member bound'
            return sorted(result)
        root_identity=probe.identity(root.lstat()) if root.exists() else None
        before=entries();inventory=hashlib.sha256()
        for path,identity in before:
            self.check();reader=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                assert identity==probe.identity(os.fstat(reader)) and identity[3]<=self.maximum_file_bytes,'prepared FD identity/size differs'
                name='capture-'+str(len(self.captures)).zfill(4)+'.original';offset=0;digest=hashlib.sha256()
                with (self.capture_dir/name).open('xb') as output:
                    while True:
                        self.check();block=os.pread(reader,65536,offset)
                        if not block:break
                        offset+=len(block);assert offset<=identity[3] and offset<=self.maximum_file_bytes,'prepared original grew during capture'
                        self.claim(len(block));output.write(block);digest.update(block)
                    output.flush();os.fsync(output.fileno())
                assert offset==identity[3] and identity==probe.identity(os.fstat(reader))==probe.identity(os.stat(path,follow_symlinks=False)),'prepared original changed during capture'
                original=dict(path=name,bytes=offset,sha256=digest.hexdigest())
                row=self.emit(dict(kind='prepared-build-input-original',path=path,identity=identity,original=original))
                inventory.update((json.dumps(dict(path=path,identity=identity,original=original),sort_keys=True)+'\n').encode())
                self.captures.append(row);self.capture_bytes+=offset;self.retained.add(reader);self.prepared_inputs[path]=(row,reader,(offset,digest.hexdigest()));reader=None
            finally:
                if reader is not None:os.close(reader)
        assert before==entries() and root_identity==(probe.identity(root.lstat()) if root.exists() else None),'prepared build input root/closed set or identity changed during snapshot'
        self.emit(dict(kind='prepared-build-input-seal',buildRoot=self.build,files=len(before),inventorySha256=inventory.hexdigest(),scope='actual pre-first-root bytes only; source-prepare causality independent'))
        self.prepared_sealed=True
    def capture_metadata(self,pid):
        barrier=self.barrier();task=self.tasks[pid];path,access,mode=task.pop('metadataPath');held=os.open(access,os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(held));assert stat.S_ISREG(identity[2])
            row=self.emit(dict(kind='actual-mode-window',pid=pid,path=path,entrySequence=task['entry']['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,requestedMode=mode))
            task['metadataWindow']=(row,held,access);self.retained.add(held);held=None;return row
        finally:
            if held is not None:os.close(held)
    def complete_metadata(self,pid,entry,exit):
        row,held,access=self.tasks[pid].pop('metadataWindow')
        try:
            identity=probe.identity(os.fstat(held));assert not exit['isError'] and exit['result']==0 and self.exclusive==(pid,entry['sequence']),'actual chmod did not complete exclusively'
            before=row['beforeIdentity'];assert identity[:2]==before[:2] and identity[3:5]==before[3:5] and stat.S_IFMT(identity[2])==stat.S_IFMT(before[2]) and stat.S_IMODE(identity[2])==row['requestedMode']&0o7777,'actual chmod changed file bytes/identity or wrong mode'
            assert probe.identity(os.stat(access,follow_symlinks=access.startswith('/proc/')))==identity,'actual chmod access path changed'
            change=self.emit(dict(kind='actual-mode-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,result=exit['result'],isError=exit['isError']))
            self.metadata_states.append((row,change))
        finally:os.close(held);self.retained.remove(held)
    def snapshot_write_original(self,reader,size,*,offset=0):
        assert 0<=size<=self.maximum_file_bytes,'write original byte bound'
        name='capture-'+str(len(self.captures)).zfill(4)+'.original';count=0;digest=hashlib.sha256()
        with (self.capture_dir/name).open('xb') as output:
            while count<size:
                self.check();block=os.pread(reader,min(65536,size-count),offset+count);assert block,'short actual write original'
                self.claim(len(block));output.write(block);count+=len(block);digest.update(block)
            output.flush();os.fsync(output.fileno())
        row=self.emit(dict(kind='write-original',original=dict(path=name,bytes=count,sha256=digest.hexdigest())))
        self.captures.append(row);self.capture_bytes+=count;return row['original']
    def original_blocks(self,ref):
        with (self.capture_dir/ref['path']).open('rb') as stream:
            while True:
                self.check();block=stream.read(65536)
                if not block:break
                yield block
    def capture_write(self,pid,fd):
        barrier=self.barrier();entry=self.tasks[pid]['entry'];path=fdpath(pid,fd);reader=os.open('/proc/'+str(pid)+'/fd/'+str(fd),os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(reader));assert stat.S_ISREG(identity[2]) and identity[3]<=self.maximum_file_bytes
            writers=self.sole_writer(pid,fd,identity);flags=descriptor_flags(pid,fd);assert flags&os.O_ACCMODE==os.O_RDWR
            position=descriptor_position(pid,fd);offset=identity[3] if flags&os.O_APPEND else position;count=entry['args'][2]
            assert count<=self.maximum_file_bytes and offset+count<=self.maximum_file_bytes,'bounded actual write range'
            before=self.snapshot_write_original(reader,identity[3]);assert identity==probe.identity(os.fstat(reader))
            prior=self.write_states.get(tuple(identity[:2]));baseline='empty'
            if identity[3]:
                if prior:
                    assert prior['afterIdentity']==identity and (prior['after']['bytes'],prior['after']['sha256'])==(before['bytes'],before['sha256']),'write preimage differs from previous actual write'
                    baseline=prior['sequence']
                else:
                    original=self.producers.get(tuple(identity[:2])) or self.prepared_inputs.get(path)
                    assert original,'nonempty writable preimage lacks retained actual original'
                    row,held,data=original;assert probe.identity(os.fstat(held))==identity and data==(before['bytes'],before['sha256']),'write preimage differs from actual retained original';baseline=row['sequence']
            memory=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
            try:buffer=self.snapshot_write_original(memory,count,offset=entry['args'][1])
            finally:os.close(memory)
            row=self.emit(dict(kind='actual-write-window',pid=pid,fd=fd,path=path,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,before=before,buffer=buffer,offset=offset,position=position,flags=flags,writers=writers,baseline=baseline))
            self.tasks[pid]['writeWindow']=(row,reader);self.retained.add(reader);reader=None;return row
        finally:
            if reader is not None:os.close(reader)
    def complete_write(self,pid,entry,exit):
        row,held=self.tasks[pid].pop('writeWindow')
        try:
            assert self.exclusive==(pid,entry['sequence']) and not exit['isError'] and 0<=exit['result']<=entry['args'][2],'actual write failed or returned invalid count'
            identity=probe.identity(os.fstat(held));assert identity==probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(row['fd']))) and identity[:3]==row['beforeIdentity'][:3] and descriptor_flags(pid,row['fd'])==row['flags'],'actual writer FD changed'
            self.sole_writer(pid,row['fd'],identity);after=self.snapshot_write_original(held,identity[3]);assert identity==probe.identity(os.fstat(held))
            bindings.verify_write_bytes(self.original_blocks(row['before']),self.original_blocks(row['buffer']),self.original_blocks(after),row['beforeIdentity'][3],row['offset'],exit['result'],self.maximum_file_bytes,self.check)
            transition=self.emit(dict(kind='actual-write-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,after=after,result=exit['result'],isError=exit['isError']))
            self.write_states[tuple(identity[:2])]=transition
        finally:os.close(held);self.retained.remove(held)
    def capture(self,pid,fd,role):
        barrier=self.barrier();self.check();target=fdpath(pid,fd);path='/proc/'+str(pid)+'/fd/'+str(fd);before=os.stat(path);reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
        try:
            ident=probe.identity(os.fstat(reader));assert ident==probe.identity(before) and stat.S_ISREG(ident[2]) and ident[3]<=self.maximum_file_bytes,'bounded regular capture required'
            writers=self.sole_writer(pid,fd,ident) if role=='producer-close' else [];rw_read=False
            # A stopped writer is still a writer: diagnose, never silently accept it.
            if role!='producer-close':
                aliases=[];alias_count=0;alias_digest=hashlib.sha256()
                for other,task in sorted(self.tasks.items()):
                    if task['exited']:continue
                    for value in sorted(os.listdir('/proc/'+str(other)+'/fd'),key=int):
                        self.check();item=os.stat('/proc/'+str(other)+'/fd/'+value)
                        if (item.st_dev,item.st_ino)!=tuple(ident[:2]):continue
                        flags=descriptor_flags(other,int(value))
                        if flags&os.O_ACCMODE==os.O_RDONLY:continue
                        alias=dict(pid=other,fd=int(value),flags=flags,accessMode=flags&os.O_ACCMODE)
                        alias_count+=1;alias_digest.update((json.dumps(alias,sort_keys=True)+'\n').encode())
                        if len(aliases)<32:aliases.append(alias)
                if alias_count==1 and aliases==[dict(pid=pid,fd=fd,flags=descriptor_flags(pid,fd),accessMode=os.O_RDWR)] and role=='consumer' and ident[3]==0:
                    entry=self.tasks[pid]['entry'];rules=profile(entry['arch'])
                    assert entry['nr']==rules['read'] and entry['args'][0]==fd and entry['args'][2]>0,'empty window requires actual read entry'
                    row=self.emit(dict(kind='empty-read-window',pid=pid,fd=fd,path=target,identity=ident,
                        flags=descriptor_flags(pid,fd),entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],writers=aliases))
                    self.tasks[pid]['emptyReadWindow']=(row,reader);self.retained.add(reader);reader=None
                    return row
                if alias_count==1 and aliases==[dict(pid=pid,fd=fd,flags=descriptor_flags(pid,fd),accessMode=os.O_RDWR)] and role=='consumer' and ident[3]>0:
                    transition=self.write_states.get(tuple(ident[:2]))
                    assert transition and transition['afterIdentity']==ident,'nonempty own-RW read lacks actual write transition'
                    rw_read=True;writers=aliases;alias_count=0
                if alias_count:
                    # No environment, payload, unrelated paths, or complete fdinfo is exported.
                    diagnostic=dict(kind='capture-writable-alias-conflict',path=target[:4096],pathTruncated=len(target)>4096,
                        pathSha256=hashlib.sha256(os.fsencode(target)).hexdigest(),identity=ident,role=role,
                        selectedPid=pid,selectedFd=fd,selectedFlags=descriptor_flags(pid,fd),
                        entrySequence=self.tasks[pid]['entry']['sequence'],barrierSequence=barrier['sequence'],
                        aliasCount=alias_count,aliases=aliases,aliasesTruncated=alias_count>len(aliases),aliasInventorySha256=alias_digest.hexdigest())
                    encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=16384,'bounded conflict diagnostic'
                    row=self.emit(diagnostic)
                    print('SDK_INPUT_CAPTURE_CONFLICT '+encoded,file=sys.stderr,flush=True)
                    raise AssertionError('live writable alias before consumer; diagnostic sequence '+str(row['sequence']))
            name='capture-'+str(len(self.captures)).zfill(4)+'.original';offset=0;digest=hashlib.sha256()
            with (self.capture_dir/name).open('xb') as output:
                while True:
                    block=os.pread(reader,65536,offset)
                    if not block:break
                    offset+=len(block);assert offset<=self.maximum_file_bytes
                    self.claim(len(block));output.write(block);digest.update(block);self.check()
                output.flush();os.fsync(output.fileno())
            assert ident==probe.identity(os.fstat(reader))==probe.identity(os.stat(path))
            data=(offset,digest.hexdigest());self.capture_bytes+=offset;ref=dict(path=name,bytes=offset,sha256=data[1])
            row=self.emit(dict(kind='fd-capture',role='readwrite-consumer' if rw_read else role,pid=pid,fd=fd,entrySequence=self.tasks[pid]['entry']['sequence'],path=target,identity=ident,original=ref,barrierSequence=barrier['sequence'],writers=writers))
            self.captures.append(row);capture_fd=reader;self.retained.add(reader);reader=None
            if role!='producer-close':self.tasks[pid]['releaseCaptureFd']=capture_fd
            if role=='producer-close':
                previous=self.producers.get(tuple(ident[:2]))
                if previous:os.close(previous[1]);self.retained.remove(previous[1])
                self.producers[tuple(ident[:2])]=(row,capture_fd,data)
            if rw_read:
                assert (ref['bytes'],ref['sha256'])==(transition['after']['bytes'],transition['after']['sha256']),'own-RW read bytes differ from actual write transition'
                self.tasks[pid]['rwReadWindow']=(row,capture_fd,data,descriptor_position(pid,fd))
                self.emit(dict(kind='actual-write-consumer-binding',captureSequence=row['sequence'],transitionSequence=transition['sequence'],path=target,identity=ident,readOffset=descriptor_position(pid,fd)))
            if role=='consumer' and not rw_read:
                original=self.producers.get(tuple(ident[:2]));prepared=False
                if original is None:
                    original=self.prepared_inputs.get(target);prepared=original is not None
                assert original,'build consumer lacks actual producer or sealed prepared FD: '+str(dict(path=target,dev=ident[0],ino=ident[1]))
                old,held,expected=original;now=probe.identity(os.fstat(held));held_hash=hashlib.sha256();held_bytes=0
                while True:
                    block=os.pread(held,65536,held_bytes)
                    if not block:break
                    held_bytes+=len(block);assert held_bytes<=self.maximum_file_bytes;held_hash.update(block);self.check()
                held_data=(held_bytes,held_hash.hexdigest())
                assert now==probe.identity(os.fstat(held))
                assert data==expected==held_data and now==ident,'actual prepared/generated bytes changed before consumer: '+str(dict(path=target,dev=ident[0],ino=ident[1]))
                if target!=old['path']:
                    named_identity=probe.identity(os.stat(target,follow_symlinks=False));assert named_identity==ident==probe.identity(os.fstat(held)),'actual named path does not refer to retained producer FD'
                    mode_refs=[];current=old['identity']
                    for mode_window,change in self.metadata_states:
                        if mode_window['beforeIdentity']==current and change['sequence']>old['sequence']:
                            mode_refs.append(change['sequence']);current=change['afterIdentity']
                    assert current[2]==ident[2],'retained producer mode changed without observed chmod'
                    self.emit(dict(kind='retained-fd-namespace-binding',producerCaptureSequence=old['sequence'],consumerCaptureSequence=row['sequence'],path=target,namedIdentity=named_identity,retainedIdentity=now,modeTransitions=mode_refs))
                self.consumers.append(self.emit(dict(kind='prepared-consumer-binding' if prepared else 'generated-consumer-binding',captureSequence=row['sequence'],producerCaptureSequence=old['sequence'],path=target,identity=ident,retainedIdentity=now,actualBytesEqual=True)))
            return row
        finally:
            if reader is not None:os.close(reader)
    def resume(self):
        for pid,row in list(self.tasks.items()):
            if self.exclusive and pid!=self.exclusive[0]:continue
            if row['stopped'] and not row['exited']:
                single.trace(SYSCALL,pid,0,row.pop('signal',0));row['stopped']=False
    def pending_captures(self):
        if self.exclusive:return
        # All candidate entries encountered while stopping peers are preserved;
        # process each before resuming any potential writer.
        while True:
            candidate=next(((pid,r) for pid,r in self.tasks.items() if r.get('capture') and not r['exited']),None)
            if not candidate:break
            pid,task=candidate;fd,role=task.pop('capture');capture=self.capture_metadata(pid) if role=='metadata-before' else (self.capture_write(pid,fd) if role=='writer-before' else self.capture(pid,fd,role));task['entry']['captureSequence']=capture['sequence'];self.exclusive=(pid,task['entry']['sequence']);self.emit(dict(kind={'actual-write-window':'exclusive-write-resume','actual-mode-window':'exclusive-mode-resume','empty-read-window':'exclusive-empty-read-resume'}.get(capture['kind'],'exclusive-captured-syscall-resume'),pid=pid,entrySequence=task['entry']['sequence'],captureSequence=capture['sequence']));break
    def event(self,pid,status,allow_capture=True):
        if pid not in self.tasks:
            assert os.WIFSTOPPED(status) and status>>16==128,'unregistered non-child tracee event'
            tracer=[line.split()[1] for line in Path('/proc',str(pid),'status').read_text().splitlines() if line.startswith('TracerPid:')]
            assert tracer==[str(os.getpid())] and pid not in self.unknown_stops,'unknown observer-owned stop identity'
            self.unknown_stops[pid]=status;return
        task=self.tasks[pid]
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            task.update(exited=True,stopped=False);code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
            wait=self.emit(dict(kind='actual-wait-exit',pid=pid,returnCode=code));self.wait_references.append(dict(pid=pid,sequence=wait['sequence'],returnCode=code,phase=self.current_phase))
            if pid==self.root:self.root_code=code
            return
        assert os.WIFSTOPPED(status);task['stopped']=True;event=status>>16;sig=os.WSTOPSIG(status)
        if event:
            self.emit(dict(kind='ptrace-event',pid=pid,event=event))
            if event in [1,2,3]:
                child=ctypes.c_ulong();single.trace(GETEVENTMSG,pid,0,ctypes.byref(child));new=int(child.value);assert new not in self.tasks and len(self.tasks)<self.maximum_processes,'actual child/PID bound'
                self.tasks[new]=dict(stopped=False,exited=False,entry=None,initial=True);self.emit(dict(kind='actual-child-binding',parentPid=pid,childPid=new,event=event))
                if new in self.unknown_stops:self.event(new,self.unknown_stops.pop(new),False)
            elif event not in [4,5,6,128]:raise ValueError('unsupported ptrace event')
            return
        if sig!=(signal.SIGTRAP|0x80):
            # SIGCHLD delivery is recorded then suppressed; actual wait syscalls
            # still report every child. Other signals are fail-closed.
            assert sig==signal.SIGCHLD,'unexpected tracee signal';task['signal']=sig;self.emit(dict(kind='signal-delivery',pid=pid,signal=sig));return
        kernel,_=single.syscall(pid);policy=profile(kernel['arch'])
        if kernel['op']=='exit' and task['entry'] is not None:kernel['entrySequence']=task['entry']['sequence']
        record=self.emit(dict(kind='kernel-syscall',pid=pid,**kernel))
        if record['op']=='entry':
            assert task['entry'] is None,'syscall entry missing prior exit';task['initial']=False;task['entry']=record;nr=record['nr'];args=record['args']
            assert nr not in policy['forbidden'],'unsupported asynchronous/external writer syscall'
            if nr in [policy['clone'],policy['clone3']]:
                flags=args[0] if nr==policy['clone'] else single.trace(2,pid,args[0])&((1<<64)-1)
                assert not flags&(0x10000|0x400),'shared thread/FD-table clone refused before resume'
                assert flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown clone flags refused'
                self.emit(dict(kind='kernel-clone-flags',pid=pid,entrySequence=record['sequence'],flags=flags))
            if nr==policy['mmap']:assert not (args[2]&2 and args[3]&1),'shared writable mapping refused before resume'
            selected=None;fd=None
            if nr in [policy['read'],policy['write'],policy['close']]:fd=args[0];selected=fdpath(pid,fd)
            if nr==policy['mmap'] and args[4]<(1<<31):fd=args[4];selected=fdpath(pid,fd)
            if selected:
                try:item=os.stat('/proc/'+str(pid)+'/fd/'+str(fd))
                except FileNotFoundError:item=None
                if item and stat.S_ISREG(item.st_mode):
                    if nr==policy['write'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE==os.O_RDWR:task['capture']=(fd,'writer-before')
                    elif nr==policy['close'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE in [os.O_WRONLY,os.O_RDWR]:task['capture']=(fd,'producer-close')
                    elif nr==policy['read'] and selected.startswith(self.build+'/') and (self.selected_names is None or Path(selected).name in self.selected_names):task['capture']=(fd,'consumer')
                    elif nr==policy['mmap'] and selected.startswith(self.build+'/') and (self.selected_names is None or Path(selected).name in self.selected_names):self.emit(dict(kind='generated-mmap-unverified',pid=pid,path=selected,entrySequence=record['sequence']))
                    elif nr==policy['read'] and selected.startswith(self.source+'/'):task['capture']=(fd,'source-read')
            mode_ops={0xc000003e:{90:'path',91:'fd',268:'at'},0xc00000b7:{52:'fd',53:'at'}}[kernel['arch']]
            if nr in mode_ops:
                form=mode_ops[nr]
                if form=='fd':target=fdpath(pid,args[0]);access='/proc/'+str(pid)+'/fd/'+str(args[0]);mode=args[1]
                elif form=='path':target=path_argument(pid,-100,args[0]);access=target;mode=args[1]
                else:target=path_argument(pid,args[0],args[1]);access=target;mode=args[2]
                if target and target.startswith(self.build+'/'):
                    try:item=os.stat(access,follow_symlinks=access.startswith('/proc/'))
                    except FileNotFoundError:item=None
                    if item and stat.S_ISREG(item.st_mode):task['metadataPath']=(target,access,mode);task['capture']=(None,'metadata-before')
            if nr in [policy.get('rename'),policy.get('renameat'),policy.get('renameat2')]:
                if nr==policy.get('rename'):old=path_argument(pid,-100,args[0]);new=path_argument(pid,-100,args[1])
                else:old=path_argument(pid,args[0],args[1]);new=path_argument(pid,args[2],args[3])
                task['rename']=(old,new);self.emit(dict(kind='kernel-path-arguments',pid=pid,entrySequence=record['sequence'],renamePaths=[old,new]))
        else:
            old=task['entry']
            if old is None:assert task['initial'],'orphan syscall exit';task['initial']=False;return
            record['entrySequence']=old['sequence'];task['entry']=None
            if task.get('metadataWindow'):self.complete_metadata(pid,old,record)
            if task.get('writeWindow'):self.complete_write(pid,old,record)
            rw_read=task.pop('rwReadWindow',None)
            if rw_read is not None:
                window,held,data,read_offset=rw_read;assert self.exclusive==(pid,old['sequence']) and not record['isError'] and 0<=record['result']<=old['args'][2],'own-RW read exit differs'
                assert probe.identity(os.fstat(held))==window['identity']==probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(window['fd']))),'own-RW read identity changed'
                digest=hashlib.sha256();count=0
                while True:
                    self.check();block=os.pread(held,65536,count)
                    if not block:break
                    count+=len(block);assert count<=self.maximum_file_bytes;digest.update(block)
                assert data==(count,digest.hexdigest()) and probe.identity(os.fstat(held))==window['identity'] and descriptor_flags(pid,window['fd'])==window['writers'][0]['flags'] and descriptor_position(pid,window['fd'])==read_offset+record['result'],'own-RW read actual bytes/FD changed during exclusive window'
                self.emit(dict(kind='actual-write-consumer-exit',pid=pid,entrySequence=old['sequence'],captureSequence=window['sequence'],exitSequence=record['sequence'],identity=window['identity'],bytes=count,sha256=digest.hexdigest(),readOffset=read_offset,positionAfter=descriptor_position(pid,window['fd']),result=record['result'],isError=record['isError']))
            empty=task.pop('emptyReadWindow',None)
            if empty is not None:
                window,held=empty
                try:
                    assert self.exclusive==(pid,old['sequence']) and not record['isError'] and record['result']==0,'empty read did not return actual EOF'
                    current=probe.identity(os.fstat(held));selected=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(window['fd'])))
                    assert current==selected==window['identity'] and current[3]==0 and descriptor_flags(pid,window['fd'])==window['flags'],'empty read FD identity/flags changed'
                    self.emit(dict(kind='empty-read-eof',pid=pid,entrySequence=old['sequence'],windowSequence=window['sequence'],exitSequence=record['sequence'],identity=current,result=record['result'],isError=record['isError']))
                finally:os.close(held);self.retained.remove(held)
            if self.exclusive==(pid,old['sequence']):self.emit(dict(kind='exclusive-captured-syscall-exit',pid=pid,entrySequence=old['sequence'],result=record['result'],isError=record['isError']));self.exclusive=None
            release_fd=task.pop('releaseCaptureFd',None)
            if release_fd is not None:os.close(release_fd);self.retained.remove(release_fd)
            if task.get('rename'):
                old_path,new_path=task.pop('rename')
                if record['result']==0:
                    try:item=os.stat(new_path,follow_symlinks=False)
                    except FileNotFoundError:item=None
                    if item and (item.st_dev,item.st_ino) in self.producers:
                        produced,held,data=self.producers[(item.st_dev,item.st_ino)];self.rename_records.append(self.emit(dict(kind='retained-fd-rename-binding',pid=pid,fromPath=old_path,toPath=new_path,producerCaptureSequence=produced['sequence'],entrySequence=old['sequence'],identity=probe.identity(item),retainedIdentity=probe.identity(os.fstat(held)))))
        if allow_capture and task.get('capture'):self.pending_captures()
    def phase(self,name,command,deadline_monotonic=None,*,cwd=None,env=None,stdoutPath=None,stderrPath=None):
        self.deadline=deadline_monotonic if deadline_monotonic is not None else self.deadline_monotonic
        if self.deadline is None:self.deadline=time.monotonic()+90
        self.check()
        with owned_wait.BlockingOwnedWait(self.deadline,WALL) as waiter:
            self.waiter=waiter
            return self.phase_armed(name,command,cwd,env,stdoutPath,stderrPath)
    def phase_armed(self,name,command,cwd,env,stdoutPath,stderrPath):
        capture_start=len(self.captures);started_ns=time.time_ns();stdout_path=Path(stdoutPath) if stdoutPath is not None else self.out/(name+'.stdout.raw');stderr_path=Path(stderrPath) if stderrPath is not None else self.out/(name+'.stderr.raw')
        self.wait_references=[];self.tasks={};self.unknown_stops={};self.root_code=None;self.current_phase=name;self.raw=ShardedRaw(self.out,name,self.shard_bytes) if self.shard_bytes else open(self.out/(name+'.syscalls.original.jsonl'),'xb')
        if not self.prepared_sealed:
            try:self.seal_prepared_build_inputs()
            except BaseException:
                self.raw_bytes_completed+=self.raw.tell();self.raw.close();self.close();raise
        read_fd,write_fd=os.pipe();stdout_read,stdout_write=os.pipe();stderr_read,stderr_write=os.pipe();child=os.fork()
        if child==0:
            try:
                os.close(write_fd);os.close(stdout_read);os.close(stderr_read);assert os.read(read_fd,1)==b'x';os.close(read_fd)
                os.dup2(stdout_write,1);os.dup2(stderr_write,2);os.close(stdout_write);os.close(stderr_write)
                os.chdir(cwd if cwd is not None else self.source);os.execve(actual_executable(command),command,env if env is not None else {'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':str(self.out),'TMPDIR':str(self.out)})
            except BaseException:os._exit(70)
        os.close(stdout_write);os.close(stderr_write);self.pump_errors=[]
        pumps=[BoundedPipePump(stdout_read,stdout_path,self.maximum_stdio_bytes,self.claim,self.pump_errors),BoundedPipePump(stderr_read,stderr_path,self.maximum_stdio_bytes,self.claim,self.pump_errors)]
        root_pgid=os.getpgid(child);self.root=child;self.tasks[child]=dict(stopped=False,exited=False,entry=None,initial=True)
        try:
            os.close(read_fd)
            for pump in pumps:pump.start()
            self.emit(dict(kind='owned-root-binding',pid=child,command=command,backend='ptrace-all-stop-process-v1'));single.trace(SEIZE,child,0,OPTIONS);single.trace(INTERRUPT,child);pid,status=self.wait_one();self.event(pid,status,False);os.write(write_fd,b'x');os.close(write_fd);write_fd=None;self.resume()
            while any(not r['exited'] for r in self.tasks.values()):
                pid,status=self.wait_one();self.event(pid,status);self.pending_captures();self.resume()
            for pump in pumps:pump.finish(self.check)
            if self.require_success:assert self.root_code==0,'actual observed root did not exit successfully'
            completed_ns=time.time_ns()
            summary=dict(schemaVersion=1,kind='owned-multiprocess-all-stop-CMake-diagnostic',command=command,actualRootPid=child,actualRootReturnCode=self.root_code,actualTrackedPids=sorted(self.tasks),allTrackedWaitsClosed=all(r['exited'] for r in self.tasks.values()),backend='ptrace-all-stop-process-v1',scope='tracked process wait/FD-byte observations only; shared threads/FD tables/async writers unsupported')
            probe.jsonfile(self.out/(name+'.receipt.json'),summary)
            self.raw.flush()
            def original(path):
                digest=hashlib.sha256();size=0;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                try:
                    identity=probe.identity(os.fstat(fd));maximum=self.maximum_stdio_bytes if path in [stdout_path,stderr_path] else self.maximum_bytes
                    assert identity[3]<=maximum,'bounded original size required'
                    while True:
                        block=os.read(fd,65536)
                        if not block:break
                        size+=len(block);assert size<=maximum,'original grew beyond bounded size';digest.update(block);self.check()
                    assert identity==probe.identity(os.fstat(fd))==probe.identity(os.stat(path,follow_symlinks=False))
                    actual_hash=digest.hexdigest()
                    for pump in pumps:
                        if pump.path==path:assert (size,actual_hash)==(pump.bytes,pump.sha256),'actual stdio original differs from owned pipe'
                    return dict(path=str(path),bytes=size,sha256=actual_hash)
                finally:os.close(fd)
            return dict(commandReceipt=dict(schemaVersion=1,command=command,actualExecutable=actual_executable(command),pid=child,pgid=root_pgid,actualWait=True,exit=self.root_code if self.root_code>=0 else None,signal=-self.root_code if self.root_code<0 else None,startedUnixNs=str(started_ns),completedUnixNs=str(completed_ns),rawClosedBeforeHash=True,stdout=dict(original(stdout_path),path=stdout_path.name),stderr=dict(original(stderr_path),path=stderr_path.name)),
                trackingReceipt=dict(schemaVersion=1,kind='sdk-observer-tracked-phase-original',phase=name,observerPid=os.getpid(),command=command,actualRootPid=child,actualRootReturnCode=self.root_code,actualTrackedWait=True,trackedProcessesClosed=all(row['exited'] for row in self.tasks.values()),deadlineMonotonic=self.deadline,startedUnixNs=str(started_ns),completedUnixNs=str(completed_ns),waitReferences=self.wait_references),
                rawTraceShards=[original(path) for path in self.raw.paths] if isinstance(self.raw,ShardedRaw) else [original(Path(self.raw.name))],
                captureFiles=[dict(row['original'],path=str(self.capture_dir/row['original']['path'])) for row in self.captures[capture_start:]])
        finally:
            if write_fd is not None:os.close(write_fd)
            for pid,row in self.tasks.items():
                if not row['exited']:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
            self.raw_bytes_completed+=self.raw.tell();self.raw.close()
    def close(self):
        for fd in list(self.retained):os.close(fd);self.retained.remove(fd)
    def abort(self):
        # Never claim whole-kernel ownership from this traced PID registry. The
        # producer must propagate failure to its existing PID1 owner, whose
        # actual wait/ECHILD cleanup closes descendants outside this registry.
        for pid,row in self.tasks.items():
            if not row['exited']:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
        self.close()


class SdkExecutionObserver(Observer):
    """Production API: one instance per actual inner build owner.

    The caller supplies the existing ExecutionBudget.end and remaining *shared*
    source-domain bytes. Per-phase deadlines may shorten it, never extend it.
    .phase returns real command/tracked receipts; it does not claim a closed
    process group while this long-lived observer still retains descriptors.
    """
    def __init__(self,out,source,build,*,deadline_monotonic,check_budget,maximum_bytes,maximum_stdio_bytes):
        limits=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())
        assert isinstance(maximum_bytes,int) and 0<maximum_bytes<=limits['sourceMaterialBytes'],'canonical shared execution byte bound required'
        assert isinstance(maximum_stdio_bytes,int) and 0<maximum_stdio_bytes<=min(maximum_bytes,limits['shardBytes']),'existing bounded command raw limit required'
        assert Path(source)==Path('/opt/qlever-sdk/source') and Path(build)==Path('/opt/qlever-sdk/build'),'fixed SDK source/build roots required'
        assert isinstance(deadline_monotonic,(float,int)) and math.isfinite(deadline_monotonic) and time.monotonic()<deadline_monotonic,'existing live SDK deadline required'
        super().__init__(out,source,build,deadline_monotonic=deadline_monotonic,check_budget=check_budget,maximum_bytes=maximum_bytes,
            maximum_file_bytes=limits['shardBytes'],selected_names=None,maximum_processes=limits['sourceMembers'],shard_bytes=limits['shardBytes'],require_success=False,maximum_stdio_bytes=maximum_stdio_bytes)
        self.capture_dir=self.out/'captures';self.capture_dir.mkdir(exist_ok=False);self.sdk_phase_index=0;self.sdk_failed=False
        mounts=Path('/proc/self/mountinfo').read_bytes();assert len(mounts)<=limits['metadataBytes'],'source provider metadata bound'
        self.source_provider=probe.effective_readonly(source,mounts);self.source_provider_originals=dict(mountinfo=probe.put(self.out/'source-provider.mountinfo.raw',mounts));self.claim(len(mounts))
    def phase(self,name,command,deadline_monotonic,*,cwd,env,stdoutPath,stderrPath):
        assert not self.sdk_failed and self.sdk_phase_index<2 and name==['configure','compile'][self.sdk_phase_index] and deadline_monotonic<=self.deadline_monotonic,'fixed phase within existing SDK deadline required'
        expected=['bash','/components/qlever/scripts/build-qlever-runtime-sdk.sh','configure-prepared' if name=='configure' else 'build-prepared']
        assert command==expected,'fixed actual SDK phase argv required'
        result=super().phase(name,command,deadline_monotonic,cwd=cwd,env=env,stdoutPath=stdoutPath,stderrPath=stderrPath)
        self.sdk_failed=result['trackingReceipt']['actualRootReturnCode']!=0;self.sdk_phase_index+=1;return result

"""Single all-stop Linux execution backend shared by diagnostics and SDK capture.

The caller owns the absolute phase deadline and the outer SDK owner lifecycle.
No strace tracer may be attached concurrently. This library emits observations;
it never issues source/SDK/native authority.
"""
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import math
import re
import select
import os
from pathlib import Path
import signal
import stat
import sys
import time
import threading
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
probe=load('sdk_execution_originals_util',ROOT/'qlever/scripts/sdk-execution-originals-util.py')
bindings=load('multi_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py')
single=load('sdk_ptrace_kernel',ROOT/'qlever/scripts/sdk-ptrace-kernel.py')
owned_wait=load('owned_wait',ROOT/'qlever/scripts/sdk-blocking-owned-wait.py')
tool_providers=load('tool_providers',ROOT/'qlever/scripts/sdk-tool-provider-originals.py')
generated_vma_module=load('generated_vma_originals',ROOT/'qlever/scripts/sdk-generated-vma-originals.py')
chunk_store=load('sdk_chunk_originals',ROOT/'qlever/scripts/sdk-original-chunk-store.py')
lifetime_leases=load('sdk_tool_lifetime_leases',ROOT/'qlever/scripts/sdk-tool-lifetime-leases.py')
raw_wire_codec=load('sdk_raw_wire_codec',ROOT/'qlever/scripts/sdk-raw-wire-codec.py')
memory_policy=load('sdk_executable_memory_policy',ROOT/'qlever/scripts/sdk-executable-memory-policy.py')
LIFETIME_MODEL='kernel-held-read-lease-v1'
LIFETIME_MAXIMUM_DEPTH=8
PHASE_PROGRESS_INTERVAL=60.0
PHASE_PROGRESS_MAXIMUM_SNAPSHOTS=32
PHASE_PROGRESS_MAXIMUM_BYTES=8192
PHASE_PROGRESS_BUCKETS=('wait_one','event','pending_captures','resume','barrier','verify_task_ownership','emit','lifetime_lease_check')
# Every branch of pending_captures_original that can hold one long span.
# Closed constant: an unknown name is never recorded, so the snapshot cannot
# grow with observed data.
PENDING_CAPTURE_SUBSTEPS=('capture','capture_write','capture_rename','capture_metadata','capture_link_metadata',
                         'generated_vma_capture','capture_process_authority',
                         'capture_queued_identity','checkpoint_append_boundaries',
                         'checkpoint_appends','observe_tool_stop','capture_bti_pending',
                         'capture_clone3_pending','close_terminal_authorities',
                         'barrier_before_capture',
                         'generated_vma_finish','generated_vma_finish_emit',
                         'generated_vma_snapshot','generated_vma_remap')
PHASE_PROGRESS_MAXIMUM_SPANS=8
PHASE_PROGRESS_PREFIX='SDK_OBSERVER_PHASE_PROGRESS '

# Bounded syscall-stop histogram model.
#
# bindings.POLICIES lists only SELECTED policy operations; it is NOT a full
# syscall name table and deliberately omits openat/fstat/fcntl/statx/newfstatat,
# which are exactly the hot metadata operations we need to tell apart. So the
# histogram buckets by NUMERIC (arch, nr) identity over a finite closed domain
# per arch: 0..max(every numeric value the existing policy declares for that
# arch, including the `forbidden` set). Numbers inside that closed range are
# counted individually; anything outside collapses into ONE aggregate. Policy
# role strings are attached only as an OPTIONAL label where the policy already
# names that exact number - no second hand-written syscall name table.
#
# This does NOT claim coverage of the whole Linux ABI: the reported
# coveredNumericRange makes the boundary explicit.
def _phase_syscall_domains():
    domains = {}
    labels = {}
    for arch, rules in sorted(bindings.__dict__.get('POLICIES', {}).items()):
        maximum = -1
        for role, value in sorted(rules.items()):
            numbers = value if isinstance(value, (set, frozenset)) else {value}
            for nr in numbers:
                if type(nr) is not int or nr < 0:
                    continue
                maximum = max(maximum, nr)
                labels.setdefault((arch, nr), role)
        if maximum >= 0:
            domains[arch] = maximum
    return domains, labels

PHASE_SYSCALL_DOMAINS, PHASE_SYSCALL_ROLE_LABELS = _phase_syscall_domains()
PHASE_SYSCALL_OTHER = 'other'
PHASE_SYSCALL_TOP = 8



def held_owned_window_state(waiter):
    """Pure held-state read. Callers retain their own original fault boundary."""
    if waiter is None:return (False,None,None)
    deadline=getattr(waiter,'deadline',None);parent=getattr(waiter,'parent_deadline',None)
    active=bool(getattr(waiter,'active',False))
    def ns(value):return None if value is None else int(value*1e9)
    return (active,ns(deadline),ns(parent))

def held_outer_lease_context_matches(observer,waiter,claim,active,deadline,parent):
    """One pure comparison shared by policy and optional diagnostic projection."""
    if not active or deadline is None or parent is None:return False
    if deadline>=parent or claim is None:return False
    return (claim['waiter'] is waiter
            and claim['thread']==threading.get_ident()
            and claim['phase']==getattr(observer,'current_phase',None)
            and claim['parent']==parent
            and claim['local']==deadline)

# Diagnostic roles are a closed set; no observed name can grow a table.
AUDIT_BODY_ROLES=('writable_aliases','snapshot_raw','read_capture_fd','tool_original','legacy_tool_maps')
AUDIT_BODY_CALLBACKS=('Observer.writable_aliases.<locals>.read_aliases','Observer.snapshot_write_original.<locals>.body','Observer.read_capture_fd.<locals>.body','Observer.tool_original.<locals>.body','Observer.tool_maps.<locals>.body')
AUDIT_SNAPSHOT_SITES=('observer-leading','scan','check','publish-chunks','stage-manifest','cleanup','manifest-read')
AUDIT_SITE_PREFIX='SDK_OWNED_WINDOW_AUDIT_SITES '
AUDIT_SITE_MAXIMUM_BYTES=6144
AUDIT_COUNTER_MAXIMUM=(1<<63)-1

class OwnedWindowAuditSites:
    """Optional attribution only: never consulted by an acceptance decision."""
    def __init__(self,observer,deadline,parent):
        self.phase=observer.current_phase;self.deadline=deadline;self.parent=parent
        self.arm=observer._window_diag;self.waiter=observer.waiter
        self.window=getattr(self.waiter,'window',None)
        self.arm_events=min(AUDIT_COUNTER_MAXIMUM,max(0,self.arm['armedSeq']))
        self.thread=threading.get_ident();self.tag=None;self.active=None;self.first_failed=None
        self.bodies=[[0]*10 for _ in AUDIT_BODY_ROLES]
        self.snapshots=[[0]*4 for _ in AUDIT_SNAPSHOT_SITES]
        self.other=[0]*3;self.crossed=[0]*3;self.clock_misses=0
    @staticmethod
    def add(row,index,value=1):row[index]=min(AUDIT_COUNTER_MAXIMUM,row[index]+max(0,value))
    def valid(self,observer):
        if self.thread!=threading.get_ident() or observer.current_phase!=self.phase:return False
        if getattr(observer,'_window_diag',None) is not self.arm or observer.waiter is not self.waiter:return False
        if self.window is None or getattr(self.waiter,'window',None) is not self.window:return False
        active,deadline,parent=held_owned_window_state(observer.waiter)
        return active and deadline==self.deadline and parent==self.parent and deadline<parent
    def ticket(self,kind,index):return [self,kind,index,None,self.tag,False]
    def body_ticket(self,observer,body):
        if not self.valid(observer):return None
        # Names of these five observer-owned closures only; not a stack walk or
        # an authorization label. Unknown callbacks remain the fixed other bucket.
        name=getattr(body,'__qualname__',None)
        index=AUDIT_BODY_CALLBACKS.index(name) if name in AUDIT_BODY_CALLBACKS else -1
        return self.ticket('body',index)
    def snapshot_ticket(self,observer):
        if not self.valid(observer):return None
        return self.ticket('snapshot',0)
    def install(self,observer,ticket):
        if ticket is None or ticket[0] is not self or not self.valid(observer):return
        if ticket[1]=='body' and ticket[2]>=0:
            row=self.bodies[ticket[2]];self.add(row,0)
            if held_outer_lease_context_matches(observer,observer.waiter,getattr(observer,'_outer_lease_coalesce',None),*held_owned_window_state(observer.waiter)):self.add(row,1)
        self.tag=ticket
    def bind_claim(self,observer,ticket,claim):
        if ticket is not None and ticket[0] is self:ticket[3]=claim
    def body_finished(self,observer,ticket):
        if ticket is not None and ticket[0] is self:ticket[5]=True
    def snapshot_stage(self,observer,ticket,telemetry):
        self.snapshot_site(observer,ticket,telemetry.get('stage'))
    def snapshot_site(self,observer,ticket,site):
        if ticket is None or self.tag is not ticket or not self.valid(observer):return
        ticket[2]=AUDIT_SNAPSHOT_SITES.index(site) if site in AUDIT_SNAPSHOT_SITES else -1
        if ticket[2]>=0:self.add(self.snapshots[ticket[2]],0)
    def remove(self,observer,ticket,started=False,returned=False):
        if ticket is None or ticket[0] is not self:return
        if ticket[1]=='body' and ticket[2]>=0 and started and self.valid(observer):
            self.add(self.bodies[ticket[2]],2 if returned else 3)
        if self.tag is ticket:self.tag=ticket[4]
    def native_begin(self,observer,started):
        if not self.valid(observer):return None
        tag=self.tag;kind='other';index=-1;boundary=-1
        if tag is not None and tag[0] is self:
            kind,index=tag[1:3]
            if kind=='body':
                boundary=0 if tag[3] is None else 2 if tag[5] else 1
        value=[self,kind,index,boundary,started,self.active]
        self.active=value;return value
    def native_end(self,observer,ticket,ended,error):
        if ticket is None or ticket[0] is not self:return
        try:
            current=getattr(observer,'_audit_sites',None)
            same=current is self and self.valid(observer)
            target=self if same else current
            if target is None or target.thread!=threading.get_ident():return
            started=ticket[4]
            if type(started) is int and type(ended) is int and ended>=started:elapsed=ended-started
            else:elapsed=0;target.clock_misses=min(AUDIT_COUNTER_MAXIMUM,target.clock_misses+1)
            if not same:
                self.add(target.crossed,0);self.add(target.crossed,1,int(error is not None));self.add(target.crossed,2,elapsed)
            elif ticket[1]=='body' and 0<=ticket[2]<len(self.bodies):
                row=self.bodies[ticket[2]];at=4+2*ticket[3];self.add(row,at);self.add(row,at+1,elapsed)
            elif ticket[1]=='snapshot' and 0<=ticket[2]<len(self.snapshots):
                row=self.snapshots[ticket[2]];self.add(row,1);self.add(row,2,int(error is not None));self.add(row,3,elapsed)
            else:
                self.add(self.other,0);self.add(self.other,1,int(error is not None));self.add(self.other,2,elapsed)
            if error is not None and target.first_failed is None:
                target.first_failed=(ticket[1],ticket[2],ticket[3],started,True)
        finally:
            if self.active is ticket:self.active=ticket[5]
    @staticmethod
    def slot(value):
        if value is None:return None
        kind,index,boundary,started,failed=value
        return [kind,index,boundary,None if type(started) is not int else min(AUDIT_COUNTER_MAXIMUM,max(0,started)),failed]
    def summary(self,observer):
        if not self.valid(observer):return None
        active=None if self.active is None else (*self.active[1:5],False)
        result=dict(model='owned-window-audit-sites-v1',authorityVerified=False,phase=self.phase,armedEventCount=self.arm_events,windowDeadlineNs=str(min(AUDIT_COUNTER_MAXIMUM,self.deadline)),parentDeadlineNs=str(min(AUDIT_COUNTER_MAXIMUM,self.parent)),
            bodyColumns=['entries','exactOuterEligibleEntries','bodyReturns','bodyErrors','entryLeaseAttempts','entryLeaseNs','innerLeaseAttempts','innerLeaseNs','closingLeaseAttempts','closingLeaseNs'],
            readBodies={role:list(row) for role,row in zip(AUDIT_BODY_ROLES,self.bodies)},
            snapshotColumns=['checkCallbacks','leaseAttempts','leaseErrors','leaseNs'],
            regularSnapshot={site:list(row) for site,row in zip(AUDIT_SNAPSHOT_SITES,self.snapshots)},
            otherNative=list(self.other),crossedWindowNative=list(self.crossed),clockMisses=self.clock_misses,
            active=self.slot(active),firstFailed=self.slot(self.first_failed),
            semantics='lease-attempt wall time only; failed attempts can be partial; crossed-window time separate; never add to inclusive parent buckets')
        return result if len((AUDIT_SITE_PREFIX+json.dumps(result,separators=(',',':'))+'\n').encode())<=AUDIT_SITE_MAXIMUM_BYTES else None


class PhaseProgress:
    """Bounded in-memory progress counters for one phase; diagnostics only.

    Every value is read from state this observer already holds. Nothing here
    issues authority, extends a deadline, or retains event arrays.
    """
    __slots__=('phase','started','deadline','now','buckets','active','active_started','failed','failed_started','last_snapshot','snapshots','failure_snapshots','ticks','events','waits','last_boundary','last_wait',
               'substeps','substep_last','spans','spans_dropped','maps_bytes_last','maps_bytes_max','maps_bodies','syscall_stops','syscall_entries','syscall_exits')
    def __init__(self,phase,deadline,now=time.monotonic):
        self.phase=phase;self.started=now();self.deadline=deadline;self.now=now
        self.buckets={name:[0,0,0] for name in PHASE_PROGRESS_BUCKETS}
        self.active=None;self.active_started=None;self.failed=None;self.failed_started=None
        self.last_snapshot=self.started;self.snapshots=0;self.failure_snapshots=0
        self.ticks=0;self.events=0;self.waits=0;self.last_boundary=None;self.last_wait=None
        # Bounded per-substep counters plus a short ring of tagged spans. Both
        # are fixed-size: no observed value ever becomes a key or an index.
        self.substeps={name:[0,0,0] for name in PENDING_CAPTURE_SUBSTEPS}
        self.substep_last=None;self.spans=[];self.spans_dropped=0
        self.maps_bytes_last=0;self.maps_bytes_max=0;self.maps_bodies=0
        # Bounded syscall-STOP histogram. Only the fixed key set above plus one
        # aggregate is ever stored; unknown numbers cannot grow it.
        self.syscall_stops={}
        self.syscall_entries=0
        self.syscall_exits=0
    def record(self,name,elapsed_ns):
        try:
            bucket=self.buckets[name];bucket[0]+=1;bucket[1]+=elapsed_ns;bucket[2]=max(bucket[2],elapsed_ns)
        except BaseException:pass
    def record_substep(self,name,elapsed_ns):
        """Inclusive duration of one already-existing pending_captures sub-step.

        Only whitelisted names are stored; the mapping size never grows. Nothing
        is written to any stream and no new syscall is issued.
        """
        try:
            bucket=self.substeps[name];bucket[0]+=1;bucket[1]+=elapsed_ns;bucket[2]=max(bucket[2],elapsed_ns)
            self.substep_last=name
        except BaseException:pass
    def observe_maps_body(self,count):
        """Record a maps body length this observer already read and hashed."""
        try:
            if type(count) is int and count>=0:
                self.maps_bytes_last=count;self.maps_bytes_max=max(self.maps_bytes_max,count);self.maps_bodies+=1
        except BaseException:pass
    def record_span(self,span):
        """Retain one bounded tagged span; drop the oldest past the fixed cap."""
        try:
            if len(self.spans)>=PHASE_PROGRESS_MAXIMUM_SPANS:
                del self.spans[0];self.spans_dropped+=1
            self.spans.append(span)
        except BaseException:pass
    def observe_syscall(self,row):
        """Count one already-decoded kernel-syscall stop.

        Ownership/control-flow rule: this hook must NEVER convert an owned
        timeout or interrupt into silence. `self.check()` and the surrounding
        observer can raise the caller's own SIGALRM TimeoutError while we are
        running; that object has to propagate unchanged so the primary
        exception identity is preserved.

        Only THIS counter's own data problems are tolerated, and only by explicit
        type/shape validation - never a blanket catch. We read nothing but plain
        ints and a str from the observer's own TCB dict, and we never execute a
        caller-supplied method.
        """
        if not isinstance(row, dict) or row.get('kind') != 'kernel-syscall':
            return
        op = row.get('op')
        if op == 'entry':
            pass
        elif op == 'exit':
            pass
        else:
            return
        arch = row.get('arch')
        nr = row.get('nr')
        if type(arch) is not int or type(nr) is not int:
            return
        maximum = PHASE_SYSCALL_DOMAINS.get(arch)
        if maximum is not None and 0 <= nr <= maximum:
            key = (arch, nr)
        else:
            key = PHASE_SYSCALL_OTHER
        bucket = self.syscall_stops.get(key)
        if bucket is None:
            bucket = self.syscall_stops[key] = [0, 0]
        bucket[0] += 1
        if op == 'entry':
            self.syscall_entries += 1
            bucket[1] += 1
        else:
            self.syscall_exits += 1

    def syscall_summary(self):
        """Top-N bounded projection plus totals. No untrusted text is emitted."""
        records = []
        for key, value in self.syscall_stops.items():
            if key == PHASE_SYSCALL_OTHER:
                records.append((1, 0, 0, dict(name=PHASE_SYSCALL_OTHER,
                                              stops=value[0], entries=value[1])))
                continue
            arch, nr = key
            record = dict(arch=arch, nr=nr, stops=value[0], entries=value[1])
            role = PHASE_SYSCALL_ROLE_LABELS.get(key)
            if role is not None:
                record['policyRole'] = role
            # per-arch numeric ordering keeps the tail deterministic
            records.append((0, -value[0], arch * 100000 + nr, record))
        # highest stop count first; the single aggregate always sorts last
        records.sort(key=lambda item: (item[0], item[1], item[2]))
        top = [record for _, _, _, record in records[:PHASE_SYSCALL_TOP]]
        return dict(top=top,
                    distinctKeys=len(self.syscall_stops),
                    entries=self.syscall_entries,
                    exits=self.syscall_exits,
                    totalStops=self.syscall_entries + self.syscall_exits,
                    topLimit=PHASE_SYSCALL_TOP,
                    coveredNumericRange={str(arch): [0, maximum]
                                         for arch, maximum in sorted(PHASE_SYSCALL_DOMAINS.items())},
                    unknownAggregate=PHASE_SYSCALL_OTHER,
                    keyModel='bounded-arch-numeric-domain-v2',
                    scope='stop COUNTS only; not wall time; domain is NOT the whole Linux ABI')

    def observe_boundary(self,row):
        try:self.last_boundary=dict(kind=row.get('kind'),pid=row.get('pid'),entrySequence=row.get('entrySequence'),barrierSequence=row.get('barrierSequence'))
        except BaseException:pass
    def observe_wait(self,pid,status):
        try:self.last_wait=dict(pid=pid,status=status,atNs=str(int(self.now()*1e9)))
        except BaseException:pass

LIFETIME_OPEN_ERRORS=frozenset([errno.EACCES,errno.EPERM,errno.ENOENT,errno.ENOTDIR,errno.ELOOP,errno.ENAMETOOLONG,errno.ESTALE,errno.ENXIO,errno.ESRCH])

class CaptureReservation:
    """One snapshot reservation in the observer's existing source-byte ledger."""
    def __init__(self,observer):self.observer=observer;self.reserved=0;self.active=False;self.committed_bytes=0
    def reserve(self,count):
        b=self.observer;b.check_budget()
        with b.domain_lock:
            assert not self.active and type(count) is int and count>=0
            generated=getattr(b,'generated_vma',None)
            assert b.domain_bytes+getattr(b,'chunk_reserved',0)+(generated.reserved if generated else 0)+count<=b.maximum_bytes,'shared capture reservation bound'
            b.chunk_reserved=getattr(b,'chunk_reserved',0)+count;self.reserved=count;self.active=True
    def commit(self,count):
        b=self.observer
        with b.domain_lock:
            assert self.active and type(count) is int and 0<=count<=self.reserved
            b.domain_bytes+=count;b.claim_bytes['capture-body']+=count;self.committed_bytes+=count
            b.chunk_reserved-=count;self.reserved-=count
    def release(self):
        b=self.observer
        with b.domain_lock:
            assert self.active
            b.chunk_reserved-=self.reserved;self.reserved=0;self.active=False
SEIZE=0x4206;INTERRUPT=0x4207;GETEVENTMSG=0x4201;SYSCALL=24;WALL=0x40000000
OPTIONS=1|2|4|8|16|32|64|0x00100000

def expected_oserror(error,errnos):
    """True only for a named kernel errno; an interrupted syscall re-raises.

    A caller-owned SIGALRM raises ``TimeoutError`` (``errno is None``) from
    inside these syscalls. Treating it as an expected open/stat failure would
    hide the actual observation deadline; only real kernel codes are absorbed.
    """
    return isinstance(error,OSError) and error.errno in errnos
MAX=16*1024**2
SDK_LIMITS_PATH=ROOT/'scripts/lib/module-artifact-limits.json'


def load_sdk_execution_limits():
    """The ONE canonical load of the published execution-profile limits.

    Both the production SDK observer and the canonical fixtures read the exact
    same JSON through this function, so a fixture can never carry its own copy of
    a production limit (e.g. a hardcoded 2 MiB tool-FD bound that the real
    profile sets to `shardBytes`). It is a profile-source centralisation, not a
    fallback: a missing or malformed file still raises.
    """
    limits=json.loads(SDK_LIMITS_PATH.read_text())
    assert isinstance(limits,dict) and type(limits.get('shardBytes')) is int and limits['shardBytes']>0,'canonical execution limit requires positive shardBytes'
    assert type(limits.get('sourceMaterialBytes')) is int and type(limits.get('metadataBytes')) is int,'canonical execution limit requires sourceMaterialBytes/metadataBytes'
    return limits


def close_child_observer_retained(descriptors):
    """Drop observer-only fork copies before the initial authority barrier.

    These private read leases remain held by the parent. CLOEXEC would close
    them only after exec, which is later than the initial stopped-root census.
    """
    values=tuple(descriptors)
    assert all(type(fd) is int and fd>2 and not os.get_inheritable(fd) for fd in values),'private close-on-exec observer descriptors required'
    for fd in values:os.close(fd)

def retained_mode_difference_diagnostic(pid,fd,path,producer,current,actual,mode_refs,metadata_states):
    """Explain an existing rejection using already captured identities only."""
    try:
        candidates=[]
        for window,change in metadata_states[-64:]:
            before=window['beforeIdentity'];after=change['afterIdentity']
            if before[:2]==actual[:2] or after[:2]==actual[:2]:
                candidates.append(dict(windowSequence=window['sequence'],transitionSequence=change['sequence'],beforeIdentity=before,afterIdentity=after))
        value=dict(kind='retained-producer-mode-difference',pid=pid,fd=fd,
                   path=path[:128],pathTruncated=len(path)>128,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),
                   producerCaptureSequence=producer['sequence'],producerIdentity=producer['identity'],
                   observedChainIdentity=current,actualRetainedIdentity=actual,
                   modeTransitionSequences=mode_refs[-8:],modeTransitionCount=len(mode_refs),
                   recentModeCandidates=candidates[-4:],candidateCountInLast64=len(candidates),
                   candidateScanTruncated=len(metadata_states)>64 or len(candidates)>4,
                   authorityVerified=False,scope='rejection diagnostic only; held producer bytes already checked; no inferred chmod or source authority')
        line='SDK_RETAINED_PRODUCER_MODE_CHANGED '+json.dumps(value,sort_keys=True,separators=(',',':'))+'\n'
        if len(line.encode())<=4096:sys.stderr.write(line)
    except BaseException:
        pass  # Never replace the existing mode-chain rejection.
def retained_rename_path_absent(path):
    try:os.lstat(path)
    except FileNotFoundError:return True
    return False
SELECTED={'config.h','generated.h','custom.h'}
def profile(arch):return bindings.policy(arch)
def fdpath(pid,fd):
    try:return os.readlink('/proc/'+str(pid)+'/fd/'+str(fd))
    except FileNotFoundError:return None
def read_capture_role(selected,item,source,build):
    """Return the role for ONE read-family entry, or None outside the family.

    The read-family predicate is `nr in policy['reads']`, which CONTAINS
    `policy['read']` (and every other reviewed read form) on both architectures,
    so this helper is the single place that decides what a read means. It must be
    consulted for every read-family entry, not only for the `read` syscall,
    otherwise regular source/build reads collapse to the `input-read` fallback.

    * regular file under the prepared source or dependency roots -> source-read
    * regular file under the build root                          -> consumer
    * anything else (ordinary regular input, non-regular object,
      unresolvable descriptor, symlinked /proc view)              -> input-read

    The `input-read` answer is also the completeness answer: the dedicated
    capture path records real bytes or an exact declared disposition for it, so
    no read-family entry is ever silently dropped.
    """
    if selected and item is not None and stat.S_ISREG(item.st_mode):
        if selected.startswith(source+'/') or selected.startswith('/opt/qlever-sdk/dependencies/'):
            return 'source-read'
        if selected.startswith(build+'/'):
            return 'consumer'
    return 'input-read'

REFUSED_CALLER_MAX_PATH=512
REFUSED_CALLER_MAPS_LIMIT=65536

def refused_caller_snapshot(pid,record,check=None):
    """Bounded diagnostic provenance for an executable-memory refusal.

    Everything here is PROVENANCE ONLY, captured at the fatal stop. It is never
    authority for held bytes, and it is never evidence that a mapping permission
    holds: the maps line is a single non-atomic sample that may overlap the target
    range, may cover only part of it, and may already be stale.

    Bounded by construction: six integer args already present on the record, one
    readlink plus one stat of /proc/<pid>/exe, and ONE maps read capped at
    REFUSED_CALLER_MAPS_LIMIT bytes returning at most one overlapping line.

    Unreadable optional inputs become an explicit 'unavailable' tag; they never
    permit resume and never mask the caller's ValueError.
    """
    def clipped(value):
        if not isinstance(value,str):return None
        raw=value.encode('utf-8','surrogatepass')
        return value if len(raw)<=REFUSED_CALLER_MAX_PATH else raw[:REFUSED_CALLER_MAX_PATH].decode('utf-8','replace')+'...'

    args=record.get('args')
    snapshot=dict(arch=int(record['arch']),nr=int(record['nr']),
                  syscallArgs=[int(a) for a in args[:6]] if isinstance(args,(list,tuple)) else None,
                  syscallArgsComplete=isinstance(args,(list,tuple)) and len(args)>=6,
                  executable=None,executableIdentity=None,
                  executableSource='unavailable',mappingSample=None,mappingSampleSource='unavailable',
                  mappingSampleIsPermissionProof=False,mappingSampleIsAtomic=False)
    directory=None
    try:
        if check is not None:check()
        directory=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        raw=os.readlink('exe',dir_fd=directory)
        info=os.stat('exe',dir_fd=directory,follow_symlinks=True)
        snapshot.update(executable=clipped(raw),
                        executableIdentity=[info.st_dev,info.st_ino,info.st_mode,
                                            info.st_size,info.st_mtime_ns,info.st_ctime_ns],
                        executableSource='stop-time /proc executable read+stat; diagnostic provenance, not held-byte authority')
    except TimeoutError:
        raise                       # a real owned deadline must never be swallowed
    except OSError:
        snapshot['executableSource']='unavailable'
    finally:
        if directory is not None:
            try:os.close(directory)
            except TimeoutError:raise
            except OSError:pass
    address=None
    length=None
    if snapshot['syscallArgsComplete']:
        address=snapshot['syscallArgs'][0];length=snapshot['syscallArgs'][1]
    try:
        if check is not None:check()
        source=os.open('/proc/'+str(pid)+'/maps',os.O_RDONLY|os.O_CLOEXEC)
        try:raw=os.read(source,REFUSED_CALLER_MAPS_LIMIT)
        finally:os.close(source)
        snapshot.update(mappingSample=_overlapping_maps_line(raw,address,length),
                        mappingSampleSource='single bounded /proc/<pid>/maps prefix; overlapping line only, NOT a range permission proof')
    except TimeoutError:
        raise                       # a real owned deadline must never be swallowed
    except OSError:
        snapshot['mappingSampleSource']='unavailable'
    return snapshot

def _overlapping_maps_line(raw,address,length):
    """At most ONE maps line that overlaps [address,address+length).

    Explicitly non-atomic and explicitly not a permission proof: the caller may
    have already been refused, the sample may cover only part of the range, and a
    truncated prefix may hide the true mapping entirely.
    """
    if address is None:return None
    end=address+(length or 0)
    for line in raw.split(b'\n'):
        parts=line.split(None,5)
        if len(parts)<2 or b'-' not in parts[0]:continue
        try:low,high=[int(x,16) for x in parts[0].split(b'-',1)]
        except ValueError:continue
        if low<=address<high or (end and low<end and address<high):
            path=parts[5].decode('utf-8','replace').strip() if len(parts)>5 else ''
            return dict(range=parts[0].decode('ascii','replace'),
                        permissions=parts[1].decode('ascii','replace'),
                        path=(path.encode('utf-8')[:REFUSED_CALLER_MAX_PATH].decode('utf-8','replace') if path else None),
                        overlap='contains-address' if low<=address<high else 'overlaps-range-only')
    return None

def descriptor_fields(pid,fd,*,flags=True,position=True):
    """One actual /proc/<pid>/fdinfo/<fd> read for the requested numeric fields.

    Coalesces the flags:/pos: extraction onto a SINGLE kernel view of the same
    stopped descriptor. Field parsing, octal/decimal decoding and the
    exactly-one-row refusal are unchanged; only the number of reads changes.
    Requesting one field keeps the other field's absence irrelevant, so the
    standalone wrappers below stay compatible where only one is needed.
    """
    text=Path('/proc',str(pid),'fdinfo',str(fd)).read_text()
    lines=text.splitlines()
    value=[]
    if flags:
        rows=[x.split()[1] for x in lines if x.startswith('flags:')];assert len(rows)==1;value.append(int(rows[0],8))
    if position:
        rows=[line.split()[1] for line in lines if line.startswith('pos:')];assert len(rows)==1;value.append(int(rows[0]))
    return (value[0],value[1]) if flags and position else value[0]
def descriptor_flags(pid,fd):return descriptor_fields(pid,fd,flags=True,position=False)
def descriptor_position(pid,fd):return descriptor_fields(pid,fd,flags=False,position=True)
def bounded_fd_slot_names(pid,local,maximum=1024):
    """Read one bounded actual FD slot-name table; the caller owns the bracket.

    ``local`` is the caller's cheap per-entry deadline/stdio refusal. The caller
    is responsible for the live entry/finally validation around the read: a
    standalone call brackets this primitive with its full ``check``; a caller
    that already bracketed a whole read-only cohort sweep passes its cheap
    checker here. Exact slot/stat/flags/position checks stay in the caller, and
    every discovered name is still returned in canonical order.
    """
    assert type(pid) is int and pid>0 and type(maximum) is int and 0<maximum<=1024,'bounded actual FD owner required'
    values=[]
    with os.scandir('/proc/'+str(pid)+'/fd') as entries:
        for entry in entries:
            local();assert len(values)<maximum,'actual FD table slots unsupported above 1024'
            values.append(entry.name)
    return sorted(values,key=int)
def state(pid):
    fields=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split();return fields[0]

# ---- v4 timestamp metadata support (scratch candidate) -------------------
# Same proof boundary as chmod: raw argument observation at a fresh all-stop,
# a held descriptor whose fstat proves the inode identity, a successful exit,
# and a post-stat transition. Raw operand ADDRESSES are recorded so replay can
# bind the captured bytes to the actual entry arguments.
TIMESPEC_ABI_BYTES=32
TIMESTAMP_MODEL='actual-utimensat-timespec-v6'
TIMESTAMP_CHAIN_MODEL='actual-rename-mode-timestamp-chain-v6'
UTIME_NOW_NS=1073741823
UTIME_OMIT_NS=1073741822
TIMESTAMP_SYSCALLS={0xc000003e:280,0xc00000b7:88}  # utimensat; futimens = NULL pathname

class _Timespec64(ctypes.Structure):
    _fields_=[('tv_sec',ctypes.c_int64),('tv_nsec',ctypes.c_int64)]

def read_stopped_bytes(pid,address,size):
    """Exact bytes from a STOPPED tracee; caller guarantees the all-stop."""
    assert type(size) is int and 0<size<=4096,'bounded stopped read size'
    assert type(address) is int and 0<address<1<<64 and address+size<1<<64,'bounded stopped range'
    descriptor=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
    try:data=os.pread(descriptor,size,address)
    finally:os.close(descriptor)
    assert len(data)==size,'stopped read incomplete'
    return data

def read_stopped_cstring(pid,address,maximum=4096):
    assert type(address) is int and 0<address<1<<64,'bounded pathname address'
    descriptor=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
    data=bytearray()
    try:
        while len(data)<maximum:
            block=os.pread(descriptor,min(256,maximum-len(data)),address+len(data))
            assert block,'pathname read ended without NUL'
            if b'\0' in block:data.extend(block.split(b'\0',1)[0]);return bytes(data)
            data.extend(block)
    finally:os.close(descriptor)
    raise ValueError('tracee pathname bound')

# ONE decoder: the shared binder implementation (imported above), so the observer,
# retained chain and raw replay cannot drift on ABI width or nsec validation.
decode_timespec=bindings.decode_timespec

# ---- v8 link/unlink inode-metadata effect support (scratch candidate) ----
# link/unlink change nlink and therefore ctime on a regular file. They are
# recorded through the SAME window/transition interface as chmod/timestamp so the
# retained chain sees an actual operation endpoint instead of an unexplained gap.
LINK_MODEL='actual-link-inode-effect-v8'
LINK_SYSCALLS={0xc000003e:dict(link=86,linkat=265,unlink=87,unlinkat=263),
               0xc00000b7:dict(linkat=37,unlinkat=35)}

def link_metadata_form(arch,nr):
    table=LINK_SYSCALLS.get(arch) or {}
    for name,number in table.items():
        if number==nr:return name
    return None

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

class EncodedShardedRaw:
    def __init__(self,observer,name,maximum):
        self.observer=observer;self.name_prefix=name;self.maximum=maximum;self.paths=[];self.references={};self.writer=None;self.current_logical=0;self.total=0;self.finished=False;self.open_next()
    def charge(self,count):
        self.observer.claim(count,category='raw-wire');self.total+=count
    def open_next(self):
        path=self.observer.out/(self.name_prefix+'.trace-'+str(len(self.paths)).zfill(4)+'.jsonl.gz');self.paths.append(path)
        self.writer=raw_wire_codec.RawWriter(path,claim=self.charge,check=self.observer.check,record_check=getattr(self.observer,'check_deadline',None),maximum_logical=self.maximum,maximum_encoded=self.maximum)
        self.current_logical=0
    def finish_current(self):
        self.references[str(self.paths[-1])]=self.writer.finish()
    def write(self,data,*,bracketed=False):
        assert not self.finished,'raw stream already closed'
        if self.current_logical+len(data)>self.maximum:self.finish_current();self.open_next()
        if bracketed and getattr(self.observer,'check_deadline',None) is not None:
            self.writer.write_record(data,bracketed=True)
        else:self.writer.write_record(data)
        self.current_logical+=len(data)
    def flush(self):pass  # gzip buffering is bounded; finish owns the trailer/fsync.
    def tell(self):return self.total
    def finish(self):
        if not self.finished:self.finish_current();self.finished=True
    def close(self):
        if not self.finished:self.writer.abort()


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

def completed_capture_storage_census(rows,phase):
    """Bounded failure-only lower bound from existing complete raw references."""
    seen={};buckets={};visited=0;matched=0;truncated=False;invalid=False
    for row in reversed(rows):
        if visited>=8192:truncated=True;break
        visited+=1
        if not isinstance(row,dict) or row.get('phase')!=phase:continue
        matched+=1
        ref=row.get('original',{});name=ref.get('path');size=ref.get('bytes');digest=ref.get('sha256')
        if not isinstance(name,str) or not re.fullmatch(r'capture-[0-9]{4,}\.original',name) or type(size) is not int or size<0 or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):invalid=True;continue
        key=(size,digest)
        if name in seen:
            if seen[name]!=key:invalid=True
            continue
        if len(seen)>=4096:truncated=True;continue
        seen[name]=key;bucket=buckets.setdefault(key,dict(physicalEntities=0,consumerEntities=0));bucket['physicalEntities']+=1
        if row.get('kind')=='fd-capture' and row.get('role')=='consumer':bucket['consumerEntities']+=1
    duplicates=[dict(bytes=size,sha256=digest,**value,potentialDuplicatePhysicalBytes=(value['physicalEntities']-1)*size) for (size,digest),value in buckets.items() if value['physicalEntities']>1]
    duplicates.sort(key=lambda row:(-row['potentialDuplicatePhysicalBytes'],row['sha256']))
    return dict(kind='same-phase-physical-content-census',phase=phase,scanOrder='newest-first',availableObservations=len(rows),matchedPhaseObservations=matched,visitedObservations=visited,distinctPhysicalReferences=len(seen),maximumVisitedObservations=8192,maximumPhysicalReferences=4096,truncated=truncated,invalidReferenceMetadata=invalid,topBuckets=duplicates[:4],duplicateBucketCount=len(duplicates),potentialDuplicatePhysicalBytesLowerBound=sum(row['potentialDuplicatePhysicalBytes'] for row in duplicates),scope='same complete bytes/SHA storage only; no source identity, actual reuse eligibility, or IO saving proven')

_ABSENT=object()


_MREMAP_DEFERRED=object()   # explicit "queued, not yet proved" outcome


class CapturesMixin:
    """Append-only capture index. Pure lookup acceleration over captured rows."""

    def capture_index_key(self, reference):
        """Immutable, full-fidelity key preserving every field `==` distinguishes.

        Covers the required reference fields plus any extra metadata (e.g.
        `observationSequence`) and nested `storage`. Absent vs explicit None is
        distinguished. Unsupported types raise rather than weakening the key.
        """
        if type(reference) is not dict:
            raise TypeError('capture reference must be a dict')
        return self._freeze(reference)

    @staticmethod
    def _freeze(value):
        """Type-tagged recursive snapshot. NEVER a substitute for equality.

        The key is only a bucket selector: every hit is re-checked with full
        `==` against the stored reference. Tuple and list are tagged separately
        (Python dict equality distinguishes them), and bool is tagged apart from
        int even though `True == 1`, because a differing key costs only a bucket
        miss, after which the exact old scan decides.
        """
        if value is _ABSENT:
            return ('absent',)
        if value is None:
            return ('none',)
        if type(value) is bool:
            return ('bool', value)
        if type(value) is int:
            return ('int', value)
        if type(value) is float:
            return ('float', value)
        if type(value) is str:
            return ('str', value)
        if type(value) is bytes:
            return ('bytes', value)
        if type(value) is dict:
            # dict equality ignores key order, so sort to mirror `==` exactly.
            return ('dict', tuple(sorted((k, CapturesMixin._freeze(v))
                                        for k, v in value.items())))
        if type(value) is list:
            return ('list', tuple(CapturesMixin._freeze(item) for item in value))
        if type(value) is tuple:
            return ('tuple', tuple(CapturesMixin._freeze(item) for item in value))
        # Any other runtime type: a fresh opaque marker guarantees a bucket miss,
        # so the exact old ordered scan decides. This never fails where the old
        # oracle would have allowed a comparison.
        return ('opaque', id(value), type(value).__name__)

    def initialize_capture_state(self):
        """Initialise the ONE capture resource: ordered list + membership index.

        Single initialisation point for the capture state. Production
        `Observer.__init__` calls it once; fixtures built with `Observer.__new__`
        must call it explicitly instead of assigning `captures` (or the index)
        ad hoc, so the list and its index can never drift apart.
        """
        self.captures=[]
        self.capture_buckets={}

    def append_capture(self, row):
        """Single append point: ordered list and bucket index stay in lockstep.

        The bucket stores the ROW, not a frozen key, so a later in-place mutation
        of the stored reference is observed by the full-equality re-check.
        """
        self.captures.append(row)
        self.capture_buckets.setdefault(
            self.capture_index_key(row['original']), []).append(row)

    def capture_present(self, reference):
        """Exactly the old predicate: key narrows, FULL `==` decides.

        Equivalent to ``any(c['original']==reference for c in captures[-64:]) or
        any(c['original']==reference for c in captures)``. A bucket hit is only a
        candidate: it must pass full dict equality against the CURRENT stored
        reference. Any miss (including a stored-in-place mutation that staled the
        bucket key) falls back to the exact old ordered scan, so the result can
        never be stronger than the original predicate.
        """
        for row in self.capture_buckets.get(self.capture_index_key(reference), ()):
            if row['original'] == reference:
                return True
        return any(capture['original'] == reference for capture in self.captures)


class Observer(CapturesMixin):
    # Base host observer: pure-Python lease checking, exactly as before.
    lifetime_leases_class = lifetime_leases.LeaseSet
    def __init__(self,out,source,build,*,deadline_monotonic=None,check_budget=lambda:None,maximum_bytes=32*1024**2,maximum_file_bytes=1024**2,selected_names=SELECTED,maximum_processes=128,shard_bytes=None,require_success=True,maximum_stdio_bytes=None,shared_tasks=False,capture_toolchain=False,deny_optional_io_uring=False,verified_setresuid_noop=False,verified_identity_noop=False,terminal_exit_evidence=False,generated_vma_output=False,generated_vma_shared_mm=False,generated_vma_private_wake=False,generated_vma_private_wait_mismatch=False,capture_content_entities=False,queued_identity_noop=False,stopped_writer_aliases=False,generated_vma_coordinated_wait=False,generated_vma_parked_wait=False,io_uring_enosys_v2=False,serialize_terminal_syscalls=False,capture_maps_content_entities=False,retained_generated_metadata=False,indexed_raw_records=False,compressed_raw=False,generated_build_root=generated_vma_module.BUILD_ROOT):
        assert type(indexed_raw_records) is bool
        self.indexed_raw_records=indexed_raw_records
        self.prepared_dependency_plan=None;self.dependency_roots={};self.dependency_cache=None
        self.shared_tasks=shared_tasks
        assert type(deny_optional_io_uring) is bool
        self.deny_optional_io_uring=deny_optional_io_uring
        assert type(verified_setresuid_noop) is bool
        assert type(verified_identity_noop) is bool and not (verified_identity_noop and verified_setresuid_noop),'one explicit identity transition model required'
        self.verified_setresuid_noop=verified_setresuid_noop
        self.verified_identity_noop=verified_identity_noop
        assert type(queued_identity_noop) is bool and (not queued_identity_noop or verified_identity_noop and capture_toolchain),'queued identity requires actual identity/authority observation'
        self.queued_identity_noop=queued_identity_noop
        assert type(stopped_writer_aliases) is bool and (not stopped_writer_aliases or shared_tasks and capture_toolchain),'stopped alias writes require tracked authority and FD tables'
        self.stopped_writer_aliases=stopped_writer_aliases
        assert type(generated_vma_coordinated_wait) is bool and (not generated_vma_coordinated_wait or generated_vma_private_wait_mismatch and generated_vma_shared_mm),'coordinated wait requires existing stopped-MM private wait model'
        self.generated_vma_coordinated_wait=generated_vma_coordinated_wait
        assert type(generated_vma_parked_wait) is bool and (not generated_vma_parked_wait or generated_vma_coordinated_wait),'parked wait requires coordinated same-MM wait model'
        self.generated_vma_parked_wait=generated_vma_parked_wait
        assert type(io_uring_enosys_v2) is bool and (not io_uring_enosys_v2 or deny_optional_io_uring),'v2 ENOSYS requires explicit optional syscall denial'
        self.io_uring_enosys_v2=io_uring_enosys_v2
        assert type(terminal_exit_evidence) is bool
        self.terminal_exit_evidence=terminal_exit_evidence
        assert type(serialize_terminal_syscalls)is bool and(not serialize_terminal_syscalls or terminal_exit_evidence and shared_tasks),'serialized terminal syscalls require shared strict exit evidence'
        self.serialize_terminal_syscalls=serialize_terminal_syscalls;self.terminal_focus=None
        assert type(capture_content_entities) is bool,'explicit content storage model flag required'
        self.capture_content_entities=capture_content_entities
        assert type(capture_maps_content_entities)is bool and(not capture_maps_content_entities or capture_content_entities and capture_toolchain),'maps storage reuse requires complete tool/content observation'
        self.capture_maps_content_entities=capture_maps_content_entities
        assert type(retained_generated_metadata)is bool and(not retained_generated_metadata or generated_vma_output and generated_vma_parked_wait),'retained generated metadata requires complete parked-wait observer'
        self.retained_generated_metadata=retained_generated_metadata
        self.capture_toolchain=capture_toolchain;self.process_authority=bool(capture_toolchain);self.authority_handles=tool_providers.ProcessAuthorityHandles();self.tool_original_cache={};self.tool_provider_cache={};# REGULAR INPUT-READ state. One canonical captured original per stable
        # protected inode (dev,ino,mode,size,mtime,ctime), plus the exact
        # FD-generation proof that authorised reading it. Nothing here is
        # authority by itself; every entry is a projection of a verified
        # stopped-FD observation and is re-validated before reuse.
        self.input_read_cache={};self.input_generation={};self.current_gate=None;self.tool_metadata_bytes=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['metadataBytes']
        self.prepared_inputs={};self.prepared_sealed=False;self.domain_bytes=0;self.claim_bytes=dict.fromkeys(('raw-wire','capture-body','stdio','provider-other'),0);self.domain_lock=threading.Lock();self.pump_errors=[];self.maximum_stdio_bytes=maximum_stdio_bytes if maximum_stdio_bytes is not None else maximum_file_bytes
        self.compressed_raw=compressed_raw;self.logical_raw_bytes=0;self.raw_logical_limit=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['sourceMaterialBytes'];self.require_success=require_success;self.raw_bytes_completed=0;self.maximum_processes=maximum_processes;self.shard_bytes=shard_bytes
        self.deadline_monotonic=deadline_monotonic;self.check_budget=check_budget;self.maximum_bytes=maximum_bytes;self.maximum_file_bytes=maximum_file_bytes;self.selected_names=selected_names
        self.out=Path(out);self.capture_dir=self.out;self.source=str(source);self.build=str(build);self.tasks={};self.seq=0;self.records=[];self.initialize_capture_state();self.retained=set();self.producers={};self.write_states={};self.write_projections={};self.append_chains={};self.budget_context={};self.metadata_states=[];self.timespec_originals={};self.rename_records=[];self.consumers=[];self.raw=None;self.deadline=0;self.pausing=False;self.root=None;self.root_code=None;self.failures=[];self.current_phase=None;self.unknown_stops={};self.capture_bytes=0;self.capture_entities={};self.content_capture_pool={};self.snapshot_telemetry=None;self.snapshot_telemetry_completed=None;self.snapshot_telemetry_failure=None;self.mremap_proof_active=False;self.mremap_barriers=0;self.mremapDeferred=None;self.exclusive=None;self.wait_references=[]
        self.lifetime_leases=None;self.lifetime_phase=None;self.lifetime_acquired={};self.lifetime_by_identity={};self.authority_observed=set()
        assert type(generated_vma_output) is bool and (not generated_vma_output or shared_tasks and capture_toolchain),'generated VMA requires existing actual shared-task/tool observation'
        self.generated_build_root=generated_vma_module.validated_build_root(generated_build_root)
        assert not generated_vma_output or self.build==self.generated_build_root,'caller-owned generated output build root differs'
        assert type(generated_vma_shared_mm) is bool and (not generated_vma_shared_mm or generated_vma_output and shared_tasks and capture_toolchain),'shared-MM VMA requires existing generated/all-task/tool observation'
        assert type(generated_vma_private_wake) is bool and (not generated_vma_private_wake or generated_vma_shared_mm),'private wake requires actual stopped-MM cohort model'
        self.generated_vma_private_wake=generated_vma_private_wake
        assert type(generated_vma_private_wait_mismatch) is bool and (not generated_vma_private_wait_mismatch or generated_vma_private_wake),'wait mismatch requires complete private-wake cohort model'
        self.generated_vma_private_wait_mismatch=generated_vma_private_wait_mismatch
        self.generated_vma_shared_mm=generated_vma_shared_mm
        self.generated_vma_output=generated_vma_output;self.generated_vma=generated_vma_module.create_runtime(self,SimpleNamespace(generated_vma_module=generated_vma_module,single=single,SYSCALL=SYSCALL,INTERRUPT=INTERRUPT,state=state)) if generated_vma_output else None
    def dependency_mountinfo(self):
        with open('/proc/self/mountinfo','rb') as stream:data=stream.read(self.tool_metadata_bytes+1)
        assert len(data)<=self.tool_metadata_bytes,'dependency actual mountinfo byte bound';return data
    def load_prepared_dependencies(self,argument):
        assert not self.tasks and self.prepared_dependency_plan is None,'dependency source binding must precede actual child'
        assert isinstance(argument,dict) and set(argument)=={'collection','mountinfo'},'fixed prepared dependency originals required'
        material_root=self.out.parent.resolve(strict=True)
        def read(path,reference=None,actual_source=False):
            path=Path(path);assert path.is_absolute() and not path.is_symlink() and (path.resolve(strict=True).is_relative_to(material_root) or actual_source and str(path) in [self.source+'/CMakeLists.txt','/opt/qlever-sdk/dependencies/sources.cmake'] and path.resolve(strict=True)==path),'dependency original escapes actual materials'
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                identity=probe.identity(os.fstat(fd));assert stat.S_ISREG(identity[2]) and identity[3]<=self.tool_metadata_bytes,'dependency metadata byte bound'
                data=bytearray()
                while True:
                    self.check();block=os.read(fd,65536)
                    if not block:break
                    data.extend(block);assert len(data)<=self.tool_metadata_bytes,'dependency metadata grew'
                assert identity==probe.identity(os.fstat(fd))==probe.identity(os.stat(path,follow_symlinks=False)),'dependency metadata identity changed'
                ref=dict(path=str(path),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
                if reference is not None:assert ref==reference,'dependency metadata original reference differs'
                return bytes(data),ref
            finally:os.close(fd)
        collection_path=material_root/'fetchcontent/materials.json';assert argument['collection']['path']==str(collection_path),'fixed dependency collection path required'
        data,collection_ref=read(collection_path,argument['collection']);collection=json.loads(data)
        prepared_data,prepared_ref=read(material_root/'source-prepared.json');prepared=json.loads(prepared_data)
        declared=bindings.dependency_collection_contract(prepared,collection)
        assert prepared['dependencyCollection']==dict(path='fetchcontent/materials.json',bytes=collection_ref['bytes'],sha256=collection_ref['sha256']),'same source-prepared collection bytes required'
        mounts,mount_ref=read(argument['mountinfo']['path'],argument['mountinfo']);assert mounts==self.dependency_mountinfo(),'dependency raw mountinfo differs from actual kernel'
        def member(ref):
            name=ref['path'];assert isinstance(name,str) and name.startswith('fetchcontent/') and not name.startswith('/') and all(part not in ['', '.', '..'] for part in name.split('/')) and '\\' not in name,'canonical dependency materials reference required'
            raw,actual=read(material_root/name);assert (actual['bytes'],actual['sha256'])==(ref['bytes'],ref['sha256']),'dependency materials member differs';return raw,actual
        declaration=collection.get('declarationSource',{});assert declaration.get('sourcePath')==self.source+'/CMakeLists.txt','fixed actual CMake declaration source required'
        declaration_data,declaration_ref=member(declaration['file']);actual_declaration,unused=read(Path(self.source)/'CMakeLists.txt',actual_source=True)
        assert actual_declaration==declaration_data,'prepared declaration differs from current source bytes'
        expected_cache=bindings.dependency_declaration_projection(collection,declaration_data)
        cache_data,cache_ref=member(collection['cmakeCache']);assert collection.get('cmakeCachePath')=='/opt/qlever-sdk/dependencies/sources.cmake' and cache_data==expected_cache,'fixed dependency cache projection differs'
        actual_cache=Path(collection['cmakeCachePath']);assert not actual_cache.is_symlink() and read(actual_cache,actual_source=True)[0]==cache_data and stat.S_IMODE(actual_cache.stat().st_mode)==0o644,'actual readonly dependency cache bytes differ';probe.effective_readonly(actual_cache,mounts)
        roots=[]
        for name,row in declared.items():
            assert sum(len(item['files']) for item in roots)<=self.maximum_processes,'dependency aggregate member bound'
            root=Path(row['sourceRoot']);assert not root.is_symlink() and str(root.resolve(strict=True))==str(root),'dependency root alias forbidden'
            provider=probe.effective_readonly(root,mounts);index_data,index_ref=member(row['sourceInventory']);index=json.loads(index_data)
            shard_data=[member(ref) for ref in index['shards']];files=bindings.dependency_inventory_rows(index,[json.loads(raw) for raw,_ in shard_data],json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())['sourceMembers'],self.check)
            assert sum(len(item['files']) for item in roots)+len(files)<=self.maximum_processes,'dependency aggregate member bound'
            actual=set()
            def fail_walk(error):raise error
            for directory,dirs,names in os.walk(root,followlinks=False,onerror=fail_walk):
                self.check()
                for child in list(dirs)+names:
                    path=Path(directory)/child;relative=str(path.relative_to(root));item=os.lstat(path)
                    if stat.S_ISDIR(item.st_mode):continue
                    assert len(actual)<250000 and relative not in actual,'dependency actual closed-set member bound';actual.add(relative);expected=files.get(relative);assert expected,'unregistered dependency physical member'
                    assert stat.S_IMODE(item.st_mode)==expected['mode'],'dependency prepared mode differs'
                    if stat.S_ISLNK(item.st_mode):
                        target=os.readlink(path);assert expected['kind']=='symlink' and target==expected['target'] and str(path.resolve(strict=True)).startswith(str(root)+'/'),'dependency symlink target differs or escapes'
                    else:assert stat.S_ISREG(item.st_mode) and expected['kind']=='file' and item.st_size==expected['bytes'],'dependency physical member shape differs'
            assert actual==set(files),'dependency physical closed set differs'
            roots.append(dict(name=name,sourceRoot=str(root),provider=provider,files=files,indexRef=index_ref,indexReference=row['sourceInventory'],shardData=shard_data,shardReferences=index['shards']))
        self.prepared_dependency_plan=dict(preparedRef=prepared_ref,collectionRef=collection_ref,mountRef=mount_ref,mounts=mounts,roots=roots,declarationRef=declaration_ref,declarationReference=declaration['file'],cacheRef=cache_ref,cacheReference=collection['cmakeCache'])
    def seal_prepared_dependency_sources(self):
        plan=self.prepared_dependency_plan
        if plan is None or self.dependency_roots:return
        assert not self.tasks,'dependency source registration must precede first actual root'
        assert plan['mounts']==self.dependency_mountinfo(),'dependency mount provider changed before first actual child'
        originals={}
        def snapshot(ref):
            if ref['path'] in originals:return originals[ref['path']]
            fd=os.open(ref['path'],os.O_RDONLY|os.O_NOFOLLOW)
            try:
                before=probe.identity(os.fstat(fd));actual=self.snapshot_write_original(fd,ref['bytes']);assert before==probe.identity(os.fstat(fd)) and (actual['bytes'],actual['sha256'])==(ref['bytes'],ref['sha256']),'dependency metadata changed before actual source registration';originals[ref['path']]=actual;return actual
            finally:os.close(fd)
        for root in plan['roots']:
            row=self.emit(dict(kind='prepared-dependency-source-root',name=root['name'],sourceRoot=root['sourceRoot'],provider=root['provider'],declarationOriginal=snapshot(plan['declarationRef']),declarationReference=plan['declarationReference'],cmakeCacheOriginal=snapshot(plan['cacheRef']),cmakeCacheReference=plan['cacheReference'],sourcePreparedOriginal=snapshot(plan['preparedRef']),collectionOriginal=snapshot(plan['collectionRef']),mountinfoOriginal=snapshot(plan['mountRef']),inventoryIndexOriginal=snapshot(root['indexRef']),inventoryReference=root['indexReference'],inventoryShardReferences=root['shardReferences'],inventoryShardOriginals=[snapshot(ref) for _,ref in root['shardData']]))
            if self.dependency_cache is None:self.dependency_cache=dict(path='/opt/qlever-sdk/dependencies/sources.cmake',registrationSequence=row['sequence'],original=plan['cacheRef'])
            self.dependency_roots[root['name']]=dict(root,registrationSequence=row['sequence'],mounts=plan['mounts'])
    def dependency_source(self,path):
        if self.dependency_cache and path==self.dependency_cache['path']:
            assert self.prepared_dependency_plan['mounts']==self.dependency_mountinfo(),'dependency cache provider changed';probe.effective_readonly(path,self.prepared_dependency_plan['mounts'])
            ref=self.dependency_cache['original'];return dict(name='@cmake-cache',relativePath='sources.cmake',registrationSequence=self.dependency_cache['registrationSequence']),dict(bytes=ref['bytes'],sha256=ref['sha256'],mode=0o644)
        for name,root in self.dependency_roots.items():
            if path.startswith(root['sourceRoot']+'/'):
                relative=path[len(root['sourceRoot'])+1:];entry=root['files'].get(relative);assert entry and entry['kind']=='file','dependency actual read lacks prepared physical original'
                assert root['mounts']==self.dependency_mountinfo(),'dependency mount provider changed during actual execution'
                probe.effective_readonly(path,root['mounts'])
                return dict(name=name,relativePath=relative,registrationSequence=root['registrationSequence']),entry
        assert not path.startswith('/opt/qlever-sdk/dependencies/'),'unregistered dependency source read'
        return None
    def tighten_remaining(self,remaining_bytes):
        # External source domains supply only their remaining allowance. The
        # existing observer ledger remains private and is clipped under the
        # same lock used by capture and both stdio pumps; never reset charges.
        self.check_budget()
        assert type(remaining_bytes) is int and remaining_bytes>=0,'nonnegative actual remaining source bytes required'
        with self.domain_lock:
            self.maximum_bytes=min(self.maximum_bytes,self.domain_bytes+remaining_bytes)
            return self.maximum_bytes
    def claim(self,count,*,context=None,category='provider-other'):
        self.check_budget()
        with self.domain_lock:
            generated=getattr(self,'generated_vma',None);reserved=generated.reserved if generated else 0;spend=min(count,reserved) if generated and generated.spending_thread==threading.get_ident() else 0
            if count<0 or self.domain_bytes+getattr(self,'chunk_reserved',0)+reserved+count-spend>self.maximum_bytes:
                try:
                    # Failure-only aggregation of already retained metadata. No new
                    # payload/proc reads, authority, reservation or byte-limit change.
                    completed={key:dict(count=0,bytes=0) for key in ('source-read','consumer','readwrite-consumer','producer-close','prepared-build-input-original','write-original','toolchain-original','other')}
                    for row in self.captures:
                        key=row.get('role') if row.get('kind')=='fd-capture' else row.get('kind')
                        key=key if key in completed else 'other'
                        completed[key]['count']+=1
                        completed[key]['bytes']+=row['original']['bytes']
                    diagnostic=dict(kind='execution-byte-bound',chargedBytes=self.domain_bytes,requestedBytes=count,maximumBytes=self.maximum_bytes,projectedBytes=self.domain_bytes+count,generatedReservedBytes=reserved,completedRetainedEntityBytes=self.capture_bytes,completedObservationReferencedBytes=sum(bucket['bytes'] for bucket in completed.values()),completedObservationReferences=completed,**(context or dict(role='other-execution-original')))
                    diagnostic['successfulClaimBytes']=dict(self.claim_bytes)
                    diagnostic['rawBytesCompleted']=getattr(self,'raw_bytes_completed',0)
                    raw=getattr(self,'raw',None)
                    if raw is not None and hasattr(raw,'paths') and hasattr(raw,'total'):diagnostic['currentRawShards']=dict(count=len(raw.paths),bytes=raw.total)
                    diagnostic['completedStorageCensus']=completed_capture_storage_census(self.captures,getattr(self,'current_phase',None))
                    encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=4096,'bounded execution storage diagnostic'
                    print('SDK_EXECUTION_BYTE_BOUND '+encoded,file=sys.stderr,flush=True)
                except BaseException:
                    pass  # Diagnostic failure must never replace the original bound.
                raise AssertionError('shared execution original byte bound')
            self.domain_bytes+=count
            self.claim_bytes[category if category in self.claim_bytes else 'provider-other']+=count
            if generated:generated.reserved-=spend
    def reserve_generated_bytes(self,count):
        self.check_budget()
        with self.domain_lock:
            if not (self.generated_vma and type(count) is int and count>=0 and self.domain_bytes+getattr(self,'chunk_reserved',0)+self.generated_vma.reserved+count<=self.maximum_bytes):
                try:
                    context=getattr(self,'budget_context',{})
                    detail={key:context[key] for key in ('role','pid','fd','identity','writeCount','writeOffset','pathSha256') if key in context}
                    if 'path' in context:detail.update(path=context['path'][:128],pathTruncated=context.get('pathTruncated',False) or len(context['path'])>128)
                    identity=context.get('identity',[])
                    origin=getattr(self.generated_vma,'origins',{}).get(tuple(identity[:2]))
                    if origin is not None:detail['originSequence']=origin['sequence']
                    value=dict(kind='generated-reservation-bound',phase=self.current_phase,requestedBytes=count,chargedBytes=self.domain_bytes,maximumBytes=self.maximum_bytes,generatedReservedBytes=self.generated_vma.reserved if self.generated_vma else 0,successfulClaimBytes=dict(self.claim_bytes),context=detail,authorityVerified=False)
                    encoded=json.dumps(value,sort_keys=True);assert len(encoded.encode())<=4000
                    print('SDK_GENERATED_RESERVATION_BOUND '+encoded,file=sys.stderr,flush=True)
                except BaseException:
                    pass  # Preserve the same rejection even if diagnostics fail.
                raise AssertionError('same remaining execution ledger cannot reserve generated checkpoint')
            self.generated_vma.reserved+=count
    def generated_fd_flags(self,pid,fd):return descriptor_flags(pid,fd)
    def generated_fd_path(self,pid,fd):return fdpath(pid,fd)
    def emit(self,row):
        progress=self.phase_progress()
        if progress is None:return self.emit_original(row)
        return self.instrument('emit',self.emit_original,row)
    def emit_original(self,row):
        assert not self.read_frame_any(),'record publication is forbidden inside an owned read-only body'
        assert getattr(self,'owned_maps_frame',None) is None,'record publication is forbidden inside a maps body'
        assert getattr(self,'owned_emit_record_frame',None) is None,'record publication is forbidden inside a record callback'
        # One complete live validation brackets this single record publication.
        # Encoding/compression/write of this same already-captured row is pure
        # local work: it pays only the cheap deadline/stdio refusal per
        # iteration (record_check). The trailing check runs on success AND on
        # every exception, so an altered lease/source/ownership state can never
        # let a row escape; no validated state is reused across records.
        # Inside ONE owned outer window the redundant per-record native lease
        # sweep is coalesced (every non-lease check still runs per record); the
        # mandatory full sweep at the closing/acceptance boundary is unchanged.
        self.check_emit()
        primary=None
        try:
            self.seq+=1;row=dict(row,sequence=self.seq,phase=self.current_phase,observedUnixNs=str(time.time_ns()),**(dict(observedMonotonicNs=str(time.monotonic_ns())) if getattr(self,'generated_vma_output',False) else {}));data=None
            if row.get('original',{}).get('storage'):
                if row['kind']=='write-original':row['storageIdentity']=self.chunk_identity(row['original'])
                else:
                    # Membership only. Producers append the row and return that same original,
                    # but maps/peer captures can append more rows before the final emit, so the
                    # live reference sits a few positions from the tail. Search a small fixed
                    # recent window first, then fall back to the unchanged full forward scan.
                    # 64 is a performance heuristic, not an admission/capture/role/maps bound.
                    original=row['original']
                    # Membership only. The index answers the exact same equality
                    # predicate; a transient miss falls back to the full forward
                    # scan, so admission strength and the assert text are identical.
                    assert self.capture_present(original),'chunk reference lacks earlier write snapshot'
            elif getattr(self,'capture_content_entities',False) and row.get('kind') in ['fd-capture','prepared-build-input-original','write-original','toolchain-original'] and 'original' in row:
                entity=self.register_capture_entity(row['original']);assert row.get('originalEntityIdentity',entity)==entity,'physical storage identity differs';row['originalEntityIdentity']=entity
            parts=self.raw_encoder.encode(row) if getattr(self,'indexed_raw_records',False) else [(json.dumps(row,sort_keys=True)+'\n').encode()]
            size=sum(map(len,parts));assert size<=65536,'actual raw record exceeds fixed range bound'
            assert self.logical_raw_bytes+size<=self.raw_logical_limit,'cumulative logical raw wire bound'
            self.logical_raw_bytes+=size
            if not self.compressed_raw:self.claim(size,category='raw-wire',context=dict(role='raw-record',rawKind=row['kind']))
            for data in parts:
                if isinstance(self.raw,EncodedShardedRaw):self.raw.write(data,bracketed=True)
                else:self.raw.write(data)
            self.raw.flush()
            if self.generated_vma:
                owner=self.generated_vma;claim=None
                # This claim can only be installed INSIDE this already-armed
                # complete emit finally. No separate callable wrapper can return
                # a coalesced callback result without the full closing audit.
                if self.outer_lease_window_owned() and getattr(owner,'active',None) is not None:
                    claim=self.new_emit_record_claim(owner,row)
                try:
                    if claim is not None:self.install_emit_record_claim(claim)
                    owner.record(row)
                    if claim is not None:
                        assert getattr(self,'owned_emit_record_frame',None) is claim,'record callback claim ownership changed'
                finally:
                    if claim is not None:self.clear_own_emit_record_claim(claim)
            if getattr(self,'capture_content_entities',False) and row.get('kind') in ['fd-capture','prepared-build-input-original','write-original','toolchain-original'] and 'original' in row and 'originalReuse' not in row and 'storage' not in row['original']:
                ref=row['original'];scope=('maps',)if getattr(self,'capture_maps_content_entities',False)and row.get('captureKind')=='maps'else ()
                self.content_capture_pool.setdefault((self.current_phase,*scope,ref['bytes'],ref['sha256']),row)
            progress=self.phase_progress()
            if progress is not None:progress.observe_boundary(row)
        except BaseException as error:
            primary=error
            raise
        finally:
            # This COMPLETE per-record trailing audit is never coalesced.
            # A closing failure must not replace an earlier body/callback error.
            try:self.check()
            except BaseException:
                if primary is None:raise
        return row
    def wait_one(self):
        progress=self.phase_progress()
        if progress is None:return self.wait_one_original()
        result=self.instrument('wait_one',self.wait_one_original)
        try:
            progress.waits+=1;progress.observe_wait(result[0],result[1])
        except BaseException:pass
        return result
    def wait_one_original(self):
        return self.waiter.wait_one()
    def check_lifetime_leases(self):
        if self.lifetime_leases is not None:
            self.instrument('lifetime_lease_check',self.lifetime_leases.check)
    def check_full(self):
        """A complete closing audit that no diagnostic frame can suppress."""
        self.check_nonlease()
        self.check_lifetime_leases()
    def check(self):
        self.check_nonlease()
        if self.lifetime_leases is not None and not (self.owned_maps_frame_active() or self.read_body_frame_active()):
            self.check_lifetime_leases()
    def emit_record_frame_active(self,owner,row):
        """Only the exact synchronous callback of this one owned emitted row."""
        frame=getattr(self,'owned_emit_record_frame',None)
        if frame is None:return False
        if frame['owner'] is not owner or frame['row'] is not row:return False
        if getattr(self,'generated_vma',None) is not owner:return False
        if frame['sequence']!=self.seq or row.get('sequence')!=frame['sequence']:return False
        if frame['outer'] is not getattr(self,'_outer_lease_coalesce',None):return False
        if frame['active'] is not getattr(owner,'active',None):return False
        if frame['round'] is not getattr(owner,'round',None):return False
        if not self.outer_lease_window_owned():return False
        # Use the existing context factory as the sole declaration of axes.
        # Waiter equality is deliberately NEVER substituted for object identity.
        before=frame['context'];now=self.new_read_body_claim()
        return (before.keys()==now.keys() and before['waiter'] is now['waiter']
                and all(before[key]==now[key] for key in before if key!='waiter'))
    def check_record(self,owner,row):
        """Callback entry check; every direct/unmatched invocation stays FULL.

        Coalescing applies only during the core emitter's exact owned call.
        The mandatory full emit closing check runs after its claim is cleared.
        Generic check() does not recognize this frame and is never weakened.
        """
        if getattr(self,'owned_emit_record_frame',None) is not None and self.emit_record_frame_active(owner,row):self.check_nonlease()
        else:self.check()
    def new_emit_record_claim(self,owner,row):
        return dict(owner=owner,row=row,sequence=self.seq,
            context=self.new_read_body_claim(),outer=self._outer_lease_coalesce,
            active=owner.active,round=getattr(owner,'round',None))
    def install_emit_record_claim(self,claim):
        assert getattr(self,'owned_emit_record_frame',None) is None,'record callback is not re-entrant'
        assert not self.read_frame_any(),'record callback cannot open inside a read body'
        assert getattr(self,'owned_maps_frame',None) is None,'record callback cannot open inside a maps body'
        self.owned_emit_record_frame=claim
    def clear_own_emit_record_claim(self,claim):
        if getattr(self,'owned_emit_record_frame',None) is claim:self.owned_emit_record_frame=None
    def check_nonlease(self):
        """Every non-lease check of `check()`, in the same order.

        Split out so the EMIT fast path can coalesce ONLY the redundant
        per-record native lease sweep inside one owned outer VMA window, while
        still performing every budget/waiter/SIGIO-safe stdio/deadline check on
        every single record. `check()` keeps its exact previous semantics: it
        calls this and then the full lease sweep, so no existing caller of
        `check()` changes behaviour.
        """
        self.check_budget()
        if hasattr(self,'waiter') and self.waiter.active:self.waiter.check()
        assert not self.pump_errors,'actual bounded stdio failed: '+str(self.pump_errors);assert time.monotonic()<self.deadline,'all-stop observer deadline'
    def outer_lease_window_owned(self):
        """True only for the EXACT one owned window that armed the claim.

        The claim records the exact LOCAL clamped deadline plus the identity of
        the concrete waiter object that was clamped, together with thread, phase
        and parent deadline. A nested/local re-clamp under the same parent (even
        on the same thread and phase) therefore CANNOT inherit coalescing,
        because either the local deadline or the waiter identity differs.
        Reuses the existing waiter authority; there is no parallel registry.
        """
        waiter=getattr(self,'waiter',None)
        if waiter is None or not getattr(waiter,'active',False):return False
        claim=getattr(self,'_outer_lease_coalesce',None)
        if claim is None:return False
        try:
            active,deadline,parent=self.owned_window_state()
        except BaseException:
            return False
        return held_outer_lease_context_matches(self,waiter,claim,active,deadline,parent)
    def open_outer_lease_window(self):
        """Claim the ONE owned outer window; refuse re-entrancy and non-clamped.

        Verifies a REAL clamp is armed (local deadline strictly before parent),
        an active waiter exists and a phase is set, then records the exact
        local deadline plus the concrete waiter identity.
        """
        if getattr(self,'_outer_lease_coalesce',None) is not None:
            raise AssertionError('outer lease window is not re-entrant')
        waiter=getattr(self,'waiter',None)
        if waiter is None or not getattr(waiter,'active',False):
            raise AssertionError('active owned waiter required before claiming')
        if getattr(self,'current_phase',None) is None:
            raise AssertionError('observer phase required before claiming')
        active,deadline,parent=self.owned_window_state()
        if not active or deadline is None or parent is None:
            raise AssertionError('owned waiter window required before claiming')
        if deadline>=parent:
            raise AssertionError('real local clamp required before claiming')
        self._outer_lease_coalesce=dict(waiter=waiter,thread=threading.get_ident(),
            phase=getattr(self,'current_phase',None),parent=parent,local=deadline)
    def close_outer_lease_window(self):
        """UNCONDITIONAL reset; safe on any path and idempotent."""
        self._outer_lease_coalesce=None
        self._audit_sites=None
    def check_owned_entry(self):
        """Leading check of one body with an unconditional full closing audit.

        Only the exact existing outer window may omit this leading native sweep.
        Every budget/waiter/stdio/deadline refusal still runs. Callers must arm
        their own complete closing check before any result can escape; generic
        check() and all closing checks remain unchanged.
        """
        assert not self.read_frame_any(),'owned entry cannot inherit a read body'
        assert getattr(self,'owned_maps_frame',None) is None,'owned entry cannot inherit a maps body'
        assert getattr(self,'owned_emit_record_frame',None) is None,'owned entry cannot inherit a record callback'
        if self.outer_lease_window_owned():
            self.check_nonlease()
            return
        self.check()
    def check_emit(self):
        """The emitted record retains its complete per-record closing audit."""
        self.check_owned_entry()
    def owned_maps_frame_active(self):
        """True only on the exact thread/phase that opened the private maps frame.

        Deliberately not a general nesting API: the frame is owned by one
        ``content_tool_maps`` call, is not re-entrant, and cannot be adopted by
        another thread or a later phase.
        """
        frame=getattr(self,'owned_maps_frame',None)
        return frame is not None and frame[0]==threading.get_ident() and frame[1]==self.current_phase
    def install_owned_maps_frame(self,frame):
        """Install one preallocated maps claim; refuse every nested frame."""
        assert getattr(self,'owned_maps_frame',None) is None,'owned maps frame is not re-entrant'
        assert getattr(self,'owned_read_body_frame',None) is None,'maps frame cannot open inside a read body'
        assert getattr(self,'owned_emit_record_frame',None) is None,'maps frame cannot open inside a record callback'
        self.owned_maps_frame=frame
    def open_owned_maps_frame(self):
        """Open the single private maps frame; refuse if ANY frame already exists."""
        self.install_owned_maps_frame((threading.get_ident(),self.current_phase))
    def clear_own_maps_frame(self,frame):
        """Drop only this invocation's claim, including an interrupted install."""
        if getattr(self,'owned_maps_frame',None) is frame:self.owned_maps_frame=None
    def close_owned_maps_frame(self):
        """Unconditionally drop the frame, whatever the caller observed."""
        self.owned_maps_frame=None
    def reset_owned_frames(self):
        """Idempotent global reset of observer-owned diagnostic frames.

        Used on explicit destruction (close/abort) and at phase entry, so a
        claim abandoned by an interrupted arm can never coalesce a later phase.
        Deliberately does NOT touch foreign state: these private attributes are
        owned by this observer alone.
        """
        self.owned_read_body_frame=None
        self.owned_maps_frame=None
        self.owned_emit_record_frame=None
        self._audit_sites=None
    def read_frame_any(self):
        """True if ANY read-body frame exists, regardless of who owns it."""
        return getattr(self,'owned_read_body_frame',None) is not None
    def read_body_frame_active(self):
        """True only for the EXACT context that opened this read body.

        Bound to the concrete waiter OBJECT, the observer deadline, the thread,
        the phase and (when a window is armed) the exact local/parent deadlines.
        Two distinct waiters with identical numeric deadlines therefore CANNOT
        inherit each other's claim, and a swapped/None waiter fails closed.
        """
        frame=getattr(self,'owned_read_body_frame',None)
        if frame is None:return False
        if frame['thread']!=threading.get_ident():return False
        if frame['phase']!=self.current_phase:return False
        if frame['observerDeadline']!=getattr(self,'deadline',None):return False
        if frame['waiter'] is not getattr(self,'waiter',None):return False
        active,deadline,parent=self.owned_window_state()
        if frame['windowActive']:
            if not active:return False
            if deadline!=frame['windowDeadline'] or parent!=frame['windowParent']:return False
        elif active:
            return False
        return True
    def new_read_body_claim(self):
        """Allocate an UNINSTALLED claim describing this exact context.

        Allocation never touches `owned_read_body_frame`, so a caller that is
        interrupted before installing it leaves no trace for anyone to clear.
        """
        active,deadline,parent=self.owned_window_state()
        return dict(thread=threading.get_ident(),
            phase=self.current_phase,waiter=getattr(self,'waiter',None),
            observerDeadline=getattr(self,'deadline',None),
            windowActive=bool(active),
            windowDeadline=None if deadline is None else int(deadline),
            windowParent=None if parent is None else int(parent))
    def install_read_body_claim(self,claim):
        """Install a preallocated claim; refuse nesting in EITHER direction."""
        assert isinstance(claim,dict),'preallocated read body claim required'
        assert getattr(self,'owned_emit_record_frame',None) is None,'read body cannot open inside a record callback'
        assert getattr(self,'owned_read_body_frame',None) is None,'owned read body is not re-entrant'
        assert getattr(self,'owned_maps_frame',None) is None,'read body cannot nest inside an owned maps frame'
        self.owned_read_body_frame=claim
    def open_read_body_frame(self):
        """Claim the ONE private read body; refuse nesting in EITHER direction."""
        self.install_read_body_claim(self.new_read_body_claim())
    def close_read_body_frame(self):
        """UNCONDITIONAL reset of THIS read frame; safe and idempotent."""
        self.owned_read_body_frame=None
    def clear_own_read_body_claim(self,claim):
        """Reset ONLY the claim we installed; never a foreign or pre-existing one."""
        if getattr(self,'owned_read_body_frame',None) is claim:
            self.owned_read_body_frame=None
    def read_body(self,body):
        """Run ONE pure synchronous read-only body with a COMPLETE closing audit.

        Contract (STRENGTHENS the previous behaviour):

          * the ORIGINAL `self.check()` runs at entry and at the closing boundary,
            so every non-lease check (budget, waiter, SIGIO-safe stdio, deadline)
            still runs there in the original order, and a wrong thread/phase/
            waiter/window context falls back to the FULL native lease audit;
          * only the redundant PER-BLOCK inner lease sweep is suppressed, by
            letting `check()` detect this frame -- the converted loops keep
            calling `self.check()`, never `check_deadline()`;
          * a pre-existing read OR maps frame is refused BEFORE entry, and this
            invocation closes only the frame it actually opened;
          * the FIRST primary exception (entry/open/body) wins; the closing audit
            runs only for a body that actually started, and can never replace an
            already-raised primary object;
          * `emit_original`/`resume_original` fail closed whenever ANY read frame
            exists, so the trailing audit cannot become a no-op.

        The body MUST be a plain synchronous function. It may write budgeted
        observer-private capture originals, but it must not mutate tracee state,
        publish a record, resume a tracee, or accept a result; those entry points
        fail closed while any read frame exists. Retained writes are not accepted
        until the closing audit succeeds.
        """
        assert not self.read_frame_any(),'owned read body is not re-entrant'
        assert getattr(self,'owned_emit_record_frame',None) is None,'read body cannot open inside a record callback'
        assert getattr(self,'owned_maps_frame',None) is None,'read body cannot nest inside an owned maps frame'
        claim=None
        primary=None
        started=False;returned=False;ticket=None
        try:
            sites=getattr(self,'_audit_sites',None)
            if sites is not None:
                ticket=self.audit_site(sites,'body_ticket',body)
                self.audit_site(sites,'install',ticket)
            self.check()
            # Preallocate BEFORE installing: if this raises, nothing was claimed.
            claim=self.new_read_body_claim()
            if ticket is not None:self.audit_site(ticket[0],'bind_claim',ticket,claim)
            self.install_read_body_claim(claim)
            started=True
            try:
                result=body();returned=True
                if ticket is not None:self.audit_site(ticket[0],'body_finished',ticket)
                return result
            except BaseException as error:
                primary=error
                if ticket is not None:self.audit_site(ticket[0],'body_finished',ticket,primary=error)
                raise
        except BaseException as error:
            if primary is None:primary=error
            raise
        finally:
            # Identity-owned reset: clears the claim ONLY if it is still ours,
            # so an interrupted arm or a foreign owner is never stolen, and a
            # successful arm is always released even if install raised midway.
            try:
                if claim is not None:self.clear_own_read_body_claim(claim)
                if started:
                    try:
                        self.check()
                    except BaseException:
                        if primary is None:raise
            finally:
                if ticket is not None:self.audit_site(ticket[0],'remove',ticket,started,returned,primary=sys.exc_info()[1])
    def check_deadline(self):
        """Per-iteration fast refusal: deadline/stdio/budget only, no lease sweep.

        The full lease validation is bracketed around each read-only body, so a
        transient loss inside the body is still caught before the result escapes.
        """
        assert not self.pump_errors,'actual bounded stdio failed: '+str(self.pump_errors);assert time.monotonic()<self.deadline,'all-stop observer deadline'
    def actual_tgid(self,pid):
        with open('/proc/'+str(pid)+'/status','rb') as source:data=source.read(65537)
        assert len(data)<=65536,'bounded actual task status'
        values={line.split(b':',1)[0]:line.split(b':',1)[1].strip() for line in data.splitlines() if b':' in line}
        assert int(values[b'Pid'])==pid and int(values[b'TracerPid'])==os.getpid(),'task is not actually owned by observer'
        return int(values[b'Tgid'])
    def verify_task_ownership(self,terminal_peers=()):
        return self.instrument('verify_task_ownership',self.verify_task_ownership_original,terminal_peers)
    def verify_task_ownership_original(self,terminal_peers=()):
        excluded=set(terminal_peers);live={pid:row for pid,row in self.tasks.items() if not row['exited']and pid not in excluded};groups={};tables={};ownership=[]
        # Declared-table multiplicity over the EXACT filtered live set. A single
        # owner cannot demonstrate CLONE_FILES equality with itself, so its
        # descriptor values are never compared; the bounded slot ENUMERATION and
        # its 1024-slot cap still run for every owner below, at the original point.
        counts={}
        for row in live.values():counts[row['fdTable']]=counts.get(row['fdTable'],0)+1
        self.check_owned_entry()
        primary=None
        try:
            for pid,row in sorted(live.items()):
                self.check_deadline();tgid=self.actual_tgid(pid);assert tgid==row['tgid'],'actual TGID differs from kernel clone binding';groups.setdefault(tgid,[]).append(pid)
                # Enumerated ONCE per owner for every live owner: keeps the real
                # 1024-slot bound and the cheap deadline refusal at the original
                # point. Only a shared declared table needs the per-owner
                # descriptor snapshot that the equality assertion consumes.
                shared=counts[row['fdTable']]>1
                descriptors=[] if shared else None
                # This whole live cohort is already bracketed by the entry and
                # finally self.check_full() below, so each member's read-only FD name
                # scan pays only the cheap deadline/stdio refusal. Standalone
                # bounded_fd_slots keeps its full entry/finally guards.
                for value in bounded_fd_slot_names(pid,self.check_deadline):
                    if not shared:continue
                    self.check_deadline();fd=int(value);item=os.stat('/proc/'+str(pid)+'/fd/'+value);flags,position=descriptor_fields(pid,fd);descriptors.append([fd,probe.identity(item),flags,position])
                table=row['fdTable']
                if shared:
                    prior=tables.setdefault(table,descriptors);assert prior==descriptors,'CLONE_FILES table differs between stopped owners'
                ownership.append(dict(tid=pid,tgid=tgid,fdTable=table))
        except BaseException as error:
            primary=error
            raise
        finally:
            try:self.check_full()
            except BaseException:
                if primary is None:raise
        for tgid,tids in groups.items():assert sorted(int(value) for value in os.listdir('/proc/'+str(tgid)+'/task'))==sorted(tids+[pid for pid in excluded if self.tasks[pid]['tgid']==tgid]),'unregistered or missing actual TGID task'
        return ownership
    def bounded_fd_slots(self,pid):
        self.check()
        try:
            return bounded_fd_slot_names(pid,self.check_deadline)
        finally:
            self.check()
    def writable_aliases(self,identity,target_pid=None,target_fd=None):
        result={}
        def read_aliases():
            for pid,row in sorted(self.tasks.items()):
                if row['exited']:continue
                for value in self.bounded_fd_slots(pid):
                    self.check_deadline();fd=int(value);item=os.stat('/proc/'+str(pid)+'/fd/'+value)
                    if (item.st_dev,item.st_ino)!=tuple(identity[:2]):continue
                    flags=descriptor_flags(pid,fd)
                    if flags&os.O_ACCMODE==os.O_RDONLY:continue
                    table=row['fdTable'] if self.shared_tasks else pid;key=(table,fd)
                    assert key in result or len(result)<64,'writable alias keys unsupported above 64'
                    actual=dict(pid=pid,fd=fd,flags=flags,accessMode=flags&os.O_ACCMODE)
                    if pid==target_pid and fd==target_fd:result[key]=actual
                    else:result.setdefault(key,actual)
            return list(result.values())
        return self.read_body(read_aliases)
    def barrier(self):
        return self.instrument('barrier',self.barrier_original)
    def barrier_original(self):
        self.pausing=True
        try:
            for pid,row in list(self.tasks.items()):
                if not row['stopped'] and not row['exited']:
                    try:single.trace(INTERRUPT,pid)
                    except OSError as error:
                        if not expected_oserror(error,[errno.EIO,errno.ESRCH]):raise
            def terminal_peer(pid,row):
                terminal=row.get('terminalAuthority')
                return getattr(self,'serialize_terminal_syscalls',False)and terminal and terminal['closed']and terminal.get('resumed')and state(pid)=='Z'
            while self.unknown_stops or any(not row['stopped']and not row['exited']and not terminal_peer(pid,row)for pid,row in self.tasks.items()):
                pid,status=self.wait_one();self.event(pid,status,False)
            for pid,row in list(self.tasks.items()):
                terminal=row.get('terminalAuthority')
                if not row['exited'] and terminal and state(pid)=='Z':self.reap_terminal_task(pid,allow_pending=getattr(self,'serialize_terminal_syscalls',False))
            known=[];terminal_peers=[]
            for pid,row in self.tasks.items():
                if row['exited']:continue
                if terminal_peer(pid,row):
                    terminal=row['terminalAuthority'];sample=terminal['lease'].terminal_peer_original();sample.update(originalSequence=terminal['original']['sequence'],closeSequence=terminal['closedRow']['sequence'],resumeSequence=terminal['resumed']['sequence']);terminal_peers.append(sample);continue
                assert row['stopped'] and state(pid)=='t','potential writer not in OS tracing-stop'
                if not self.shared_tasks:assert os.listdir('/proc/'+str(pid)+'/task')==[str(pid)],'unknown shared writer thread'
                known.append(pid)
            barrier=self.emit(dict(kind='all-stop-barrier',pids=sorted(known),osStates=['t']*len(known),**({'taskOwnership':self.verify_task_ownership([row['pid']for row in terminal_peers])} if self.shared_tasks else {}),**(dict(terminalPeers=sorted(terminal_peers,key=lambda row:row['pid']))if terminal_peers else {})))
            self.close_terminal_authorities(barrier)
            return barrier
        finally:self.pausing=False
    def sole_writer(self,target_pid,target_fd,identity):
        aliases=self.writable_aliases(identity,target_pid,target_fd)
        assert len(aliases)==1 and aliases[0]['pid']==target_pid and aliases[0]['fd']==target_fd,'another writable FD aliases selected output inode'
        return [dict(pid=target_pid,fd=target_fd)]
    def stopped_write_alias_inventory(self,pid,fd,identity):
        assert self.shared_tasks and self.process_authority and not self.pausing,'stopped write aliases require initialized complete ownership'
        ownership=self.verify_task_ownership()
        assert all(task['stopped'] and state(other)=='t' for other,task in self.tasks.items() if not task['exited']),'write alias owner is not stopped'
        aliases=self.writable_aliases(identity,pid,fd)
        assert aliases and any(value['pid']==pid and value['fd']==fd for value in aliases),'selected writable FD missing from actual alias scan'
        result=[]
        for alias in aliases:
            owner=alias['pid'];slot=alias['fd'];actual=probe.identity(os.stat('/proc/'+str(owner)+'/fd/'+str(slot)))
            assert actual==identity and descriptor_flags(owner,slot)==alias['flags'],'write alias changed during all-stop inventory'
            result.append(dict(**alias,identity=actual,fdTable=self.tasks[owner]['fdTable']))
        tables=[]
        for owner,task in sorted(self.tasks.items()):
            if task['exited']:continue
            descriptors=[]
            for value in self.bounded_fd_slots(owner):
                self.check();slot=int(value);actual=probe.identity(os.stat('/proc/'+str(owner)+'/fd/'+value));flags=descriptor_flags(owner,slot)
                descriptors.append([slot,actual,flags])
            tables.append(dict(pid=owner,fdTable=task['fdTable'],descriptors=descriptors))
        inventory=dict(aliases=result,taskOwnership=ownership,descriptorTables=tables,scope='all live stopped tracked FD tables; only selected syscall resumes')
        assert len(json.dumps(inventory,separators=(',',':')).encode())<=32768,'bounded complete stopped FD inventory exceeds raw-record budget'
        return inventory
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
                name=self.next_capture_name();offset=0;digest=hashlib.sha256()
                with (self.capture_dir/name).open('xb') as output:
                    while True:
                        self.check();block=os.pread(reader,65536,offset)
                        if not block:break
                        offset+=len(block);assert offset<=identity[3] and offset<=self.maximum_file_bytes,'prepared original grew during capture'
                        self.claim(len(block),category='capture-body');output.write(block);digest.update(block)
                    output.flush();os.fsync(output.fileno())
                assert offset==identity[3] and identity==probe.identity(os.fstat(reader))==probe.identity(os.stat(path,follow_symlinks=False)),'prepared original changed during capture'
                original=dict(path=name,bytes=offset,sha256=digest.hexdigest())
                row=self.emit(dict(kind='prepared-build-input-original',path=path,identity=identity,original=original,originalEntityIdentity=self.register_capture_entity(original)))
                inventory.update((json.dumps(dict(path=path,identity=identity,original=original),sort_keys=True)+'\n').encode())
                self.append_capture(row);self.capture_bytes+=offset;self.retained.add(reader);self.prepared_inputs[path]=(row,reader,(offset,digest.hexdigest()));reader=None
            finally:
                if reader is not None:os.close(reader)
        assert before==entries() and root_identity==(probe.identity(root.lstat()) if root.exists() else None),'prepared build input root/closed set or identity changed during snapshot'
        self.emit(dict(kind='prepared-build-input-seal',buildRoot=self.build,files=len(before),inventorySha256=inventory.hexdigest(),scope='actual pre-first-root bytes only; source-prepare causality independent'))
        self.prepared_sealed=True
    def retained_metadata_chain(self,producer,consumer):
        return bindings.retained_metadata_chain(producer,consumer,self.metadata_states)
    def capture_metadata(self,pid):
        # Fresh all-stop BEFORE any namespace/memory read; the build-scope decision
        # and target resolution both happen here, never at the entry stop.
        barrier=self.barrier();task=self.tasks[pid];meta=task.pop('metadataPath')
        assert self.exclusive is None
        if 'model' not in meta:
            path,access,mode=meta
            held=os.open(access,os.O_RDONLY|os.O_CLOEXEC)
            try:
                identity=probe.identity(os.fstat(held));assert stat.S_ISREG(identity[2])
                row=self.emit(dict(kind='actual-mode-window',pid=pid,path=path,entrySequence=task['entry']['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,requestedMode=mode))
                task['metadataWindow']=(row,held,access,meta);self.retained.add(held);held=None;return row
            finally:
                if held is not None:os.close(held)
        raw_path=b'';namespace_hex=None;named=None
        if meta['form']=='path':
            raw_path=read_stopped_cstring(pid,meta['pathAddress'])
            if raw_path.startswith(b'/'):namespace_hex=None;named=os.fsdecode(raw_path)
            else:
                base=os.readlink('/proc/'+str(pid)+'/cwd') if meta['dirfd'] in [0xffffffffffffff9c,0xffffff9c,-100] else fdpath(pid,meta['dirfd'])
                assert base,'timestamp namespace base unavailable'
                namespace_hex=base.encode().hex()
                named=os.path.normpath(base+'/'+os.fsdecode(raw_path))
            access=named
        else:
            # fd form: follow the /proc/<pid>/fd/N magic link, exactly like the
            # existing chmod fd path does (follow_symlinks=True for /proc paths).
            named=fdpath(pid,meta['dirfd'])
            assert named,'timestamp fd target unavailable at all-stop'
            namespace_hex=named.encode().hex()
            access='/proc/'+str(pid)+'/fd/'+str(meta['dirfd'])
        if not (named and named.startswith(self.build+'/')):
            # Honest fail-closed record: outside the observed build root, so no
            # window is claimed. Not a product restriction, just scope.
            self.emit(dict(kind='timestamp-target-unobserved',pid=pid,entrySequence=task['entry']['sequence'],
                           form=meta['form'],resolved=bool(named),
                           underBuild=bool(named and named.startswith(self.build+'/')),
                           reason='resolved target is absent or outside the observed generated build root'))
            return None
        times_hex=None
        if meta['timesAddress']!=0:
            times_hex=read_stopped_bytes(pid,meta['timesAddress'],TIMESPEC_ABI_BYTES).hex()
        # utimensat(2) with flags==0 FOLLOWS: a symlink operand mutates its regular
        # target, so the followed stat decides. A directory or other non-regular
        # operand mutates no regular inode and is honestly out of this contract.
        followed=probe.identity(os.stat(access,follow_symlinks=True))
        if not stat.S_ISREG(followed[2]):
            self.emit(dict(kind='timestamp-target-unobserved',pid=pid,entrySequence=task['entry']['sequence'],
                           form=meta['form'],resolved=True,regular=False,
                           reason='followed utimensat target is not a regular file'))
            return None
        held=os.open(access,os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(held));assert stat.S_ISREG(identity[2])
            assert followed==identity,'named target does not resolve to the held inode'
        except BaseException:
            os.close(held);raise
        payload=dict(model=TIMESTAMP_MODEL,arch=meta['entryArch'],syscall=meta['entryNr'],form=meta['form'],
                     pathAddress=meta['pathAddress'],timesAddress=meta['timesAddress'],
                     dirfd=meta['dirfd'],flags=meta['flags'],pathHex=raw_path.hex(),
                     namespaceHex=namespace_hex,timesHex=times_hex)
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        operand=self.emit(dict(kind='kernel-metadata-args-original',pid=pid,entrySequence=task['entry']['sequence'],
                               barrierSequence=barrier['sequence'],operandSha256=digest,**payload))
        decoded=None if times_hex is None else [list(p) for p in decode_timespec(bytes.fromhex(times_hex))]
        row=self.emit(dict(kind='actual-timestamp-window',model=TIMESTAMP_MODEL,pid=pid,path=named,
                           entrySequence=task['entry']['sequence'],barrierSequence=barrier['sequence'],
                           beforeIdentity=identity,argsOriginalSequence=operand['sequence'],
                           timesAbsent=times_hex is None,times=decoded,
                           entryArch=meta['entryArch'],entryNr=meta['entryNr']))
        self.timespec_originals[operand['sequence']]=operand
        task['metadataWindow']=(row,held,access,meta);self.retained.add(held);held=None;return row
    def settle_absent_link_operand(self,pid,absent,entry,exit):
        """Settle an entry-observed absent link/unlink operand against a real exit.

        Absence at the entry stop only OBSERVES that the name was missing; peers may
        run while the tracee is stopped (metadata ops hold no exclusive lease), so a
        later SUCCESS proves the kernel changed an inode whose entry state we never
        captured. Only a matching, genuinely FAILING exit with a negative Linux errno
        can prove that no successful effect happened. Nothing is mutated here.
        """
        # The exit must be the SAME syscall entry, dispatched from the real event
        # path, with the real declared architecture. A wrong-architecture row or a
        # stale entry cannot settle an absent-operand observation.
        assert entry is not None and exit.get('op')=='exit','absent operand exit is not an actual syscall exit'
        assert exit.get('arch')==entry['arch'] and exit.get('entrySequence')==entry['sequence'], \
            'absent operand exit does not match the actual entry arch/sequence'
        assert absent['entrySequence']==entry['sequence'] and absent['arch']==entry['arch'] \
            and absent['nr']==entry['nr'] \
            and absent['form']==link_metadata_form(entry['arch'],entry['nr']), \
            'absent-operand binding does not match the actual exit'
        assert exit['isError'] is True,'absent operand exit was not an actual kernel error'
        result=exit['result']
        assert type(result) is int and -4095<=result<=-1,'absent operand exit lacks a genuine negative Linux errno'
        return self.emit(dict(kind='link-metadata-absent-confirmed',pid=pid,
                              entrySequence=entry['sequence'],exitSequence=exit['sequence'],
                              form=absent['form'],errnoValue=result,
                              newPathHex=absent['newPathHex'],oldPathHex=absent['oldPathHex'],
                              scope='actual matching exit returned a negative Linux errno; no inode changed and no successful effect is claimed'))

    def complete_metadata(self,pid,entry,exit):
        if self.tasks[pid].get('metadataWindow') is None:
            # unobserved/out-of-scope target: no window was claimed
            self.tasks[pid].pop('metadataWindow',None);return
        row,held,access,meta=self.tasks[pid].pop('metadataWindow')
        try:
            identity=probe.identity(os.fstat(held))
            assert not exit['isError'] and exit['result']==0 and self.exclusive==(pid,entry['sequence']),'actual metadata operation did not complete exclusively'
            before=row['beforeIdentity']
            if row['kind']=='actual-link-window':
                # Unchanged dev/ino/mode/size/mtime; ctime and nlink are the effects.
                assert identity[:4]==before[:4] and identity[4]==before[4],'actual link changed inode/mode/size/mtime'
                before_links=row['beforeLinks']
                operand=self.args_original(row)
                if meta['form'] in ('link','linkat'):
                    want=before_links+1
                    assert os.fstat(held).st_nlink==want,'actual link nlink effect differs'
                    # NOW the destination must exist and resolve to the SAME inode.
                    destination=os.fsdecode(bytes.fromhex(operand['newPathHex']))
                    if operand['newNamespaceHex']:
                        destination=os.path.normpath(os.fsdecode(bytes.fromhex(operand['newNamespaceHex']))+'/'+destination)
                    destination_identity=probe.identity(os.stat(destination,follow_symlinks=False))
                    assert destination_identity==identity,'actual link destination does not resolve to the held inode'
                else:
                    want=before_links-1
                    assert os.fstat(held).st_nlink==want,'actual unlink nlink effect differs'
                    # The removed pathname is expected to be absent; its absence is the
                    # evidence, never a requirement that it still exist.
                    try:os.stat(row.get('removedPath') or os.fsdecode(bytes.fromhex(operand['newPathHex'])))
                    except FileNotFoundError:pass
                    else:raise AssertionError('actual unlink left the removed pathname present')
                    # Carry a held READ LEASE across a witnessed UNLINK of the same
                    # inode, BEFORE the transition row is emitted (every emit sweeps).
                    # `identity` was already proven above to be this inode with only
                    # ctime/nlink moved, and the nlink effect was checked against the
                    # real held FD, so this is the same strictly-witnessed class as the
                    # rename path: not a path or filename warrant.
                    if meta['form'] not in ('link','linkat') and getattr(self,'lifetime_leases',None) is not None:
                        self.advance_witnessed_lease(before,identity,'owned-temp-unlink')
                change=self.emit(dict(kind='actual-link-transition',model=LINK_MODEL,pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,afterLinks=want,result=exit['result'],isError=exit['isError']))
                self.metadata_states.append((row,change));return
            if 'model' not in meta:
                assert identity[:2]==before[:2] and identity[3:5]==before[3:5] and stat.S_IFMT(identity[2])==stat.S_IFMT(before[2]) and stat.S_IMODE(identity[2])==row['requestedMode']&0o7777,'actual chmod changed file bytes/identity or wrong mode'
                assert probe.identity(os.stat(access,follow_symlinks=access.startswith('/proc/')))==identity,'actual chmod access path changed'
                change=self.emit(dict(kind='actual-mode-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,result=exit['result'],isError=exit['isError']))
            else:
                assert identity[:4]==before[:4] and stat.S_IMODE(identity[2])==stat.S_IMODE(before[2]),'actual timestamp changed inode/mode/size'
                if not row['timesAbsent']:
                    bindings.timestamp_effect(before,identity,decode_timespec(bytes.fromhex(self.args_original(row)['timesHex'])))
                # utimensat with flags==0 follows, so the post-check must follow too.
                assert probe.identity(os.stat(access,follow_symlinks=True))==identity,'actual timestamp access path changed'
                change=self.emit(dict(kind='actual-timestamp-transition',model=TIMESTAMP_MODEL,pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,result=exit['result'],isError=exit['isError']))
            self.metadata_states.append((row,change))
        finally:os.close(held);self.retained.remove(held)
    def capture_link_metadata(self,pid):
        """Entry all-stop: hold the EXISTING inode the operation acts on.

        For link/linkat the destination does not exist yet, so it is NOT stat'ed
        here; only the actual existing SOURCE is held and identity-proven. For
        unlink/unlinkat the target exists and is held. Destination resolution and
        its post-exit existence are checked after the exclusive successful exit.
        """
        barrier=self.barrier();task=self.tasks[pid];meta=task.pop('linkMetadata')
        assert self.exclusive is None
        def resolve(dirfd,address):
            raw=read_stopped_cstring(pid,address)
            if raw.startswith(b'/'):target=raw.decode();namespace=None
            else:
                relative_to_cwd=dirfd is None or dirfd in [0xffffffffffffff9c,0xffffff9c,-100]
                base=os.readlink('/proc/'+str(pid)+'/cwd') if relative_to_cwd else fdpath(pid,dirfd)
                assert base,'link namespace base unavailable'
                target=os.path.normpath(base+'/'+raw.decode());namespace=base.encode().hex()
            return target,raw.hex(),namespace
        follow=bool(meta['flags']&0x400)
        new_target,new_path_hex,new_ns_hex=resolve(meta['newDirfd'],meta['newPathAddress'])
        old_target=old_path_hex=old_ns_hex=None
        if meta['oldPathAddress'] is not None:
            old_target,old_path_hex,old_ns_hex=resolve(meta['oldDirfd'],meta['oldPathAddress'])
        # The inode acted upon: the SOURCE for link, the TARGET for unlink.
        if meta['form'] in ('link','linkat'):
            assert old_target,'link requires a source operand'
            held_path=old_target
        else:
            held_path=new_target
        external_held_identity=None
        if not (held_path and held_path.startswith(self.build+'/')):
            # Outside the generated build root, this operand is witnessable only
            # when it already resolves to an inode this observer holds a read
            # lease on. The preliminary probe must use the SAME follow semantics
            # as the real operation below, or linkat AT_SYMLINK_FOLLOW and unlink
            # would be evaluated against a different inode.
            probe_follow=bool(meta['flags']&0x400) if meta['form'] in ('link','linkat') else False
            already_held=False
            if held_path:
                try:
                    # Absence is the only expected outcome here; any other errno,
                    # and a caller-owned SIGALRM (errno None, a TimeoutError),
                    # must propagate unchanged rather than be absorbed as absent.
                    candidate_identity=probe.identity(os.stat(held_path,follow_symlinks=probe_follow))
                except OSError as error:
                    if not expected_oserror(error,[errno.ENOENT]):raise
                else:
                    already_held=self.lifetime_by_identity.get(tuple(candidate_identity)) is not None
            if not already_held:
                self.emit(dict(kind='link-metadata-unobserved',pid=pid,entrySequence=task['entry']['sequence'],
                               form=meta['form'],resolved=bool(held_path),underBuild=False,
                               reason='operand inode is absent, outside the observed generated build root, or not an already-held read lease'))
                return None
            external_held_identity=tuple(candidate_identity)
        # link/linkat name the SOURCE inode (followed only under AT_SYMLINK_FOLLOW);
        # unlink/unlinkat remove the NAMED inode - never the symlink target. A
        # non-regular operand (directory removal, symlink unlink) changes no
        # retained regular inode, so it is honestly unobserved rather than asserted.
        operand_follow=follow if meta['form'] in ('link','linkat') else False
        # An ABSENT operand is a real, expected kernel outcome for ALL FOUR forms:
        # a missing unlink/unlinkat target yields ENOENT, and a missing link/linkat
        # SOURCE also yields a failed kernel ENOENT (it cannot succeed). Build
        # systems such as CMake legitimately probe that way. Only FileNotFoundError
        # is tolerated, and it never proves a successful effect: the marker is
        # settled strictly against the matching real exit below. Every other
        # unexpected OSError still propagates.
        try:operand=probe.identity(os.stat(held_path,follow_symlinks=operand_follow))
        except FileNotFoundError:
            # Absence at the ENTRY stop is an OBSERVATION only. Peers may run while
            # the tracee is stopped (exclusive is None for metadata ops), so a peer
            # could create the name and the real syscall could then SUCCEED. Nothing
            # may be concluded here: record a marker bound to this exact entry and
            # settle it only against the matching real exit below.
            entry=task['entry']
            self.emit(dict(kind='link-metadata-absent-entry',pid=pid,entrySequence=entry['sequence'],
                           form=meta['form'],arch=meta['entryArch'],nr=meta['entryNr'],
                           resolved=False,regular=None,
                           reason='operand name is absent at the entry stop; absence alone proves no successful effect'))
            task['absentLinkOperand']=dict(entrySequence=entry['sequence'],arch=meta['entryArch'],
                                           nr=meta['entryNr'],form=meta['form'],
                                           newPathHex=new_path_hex,oldPathHex=old_path_hex)
            return None
        if not stat.S_ISREG(operand[2]):
            self.emit(dict(kind='link-metadata-unobserved',pid=pid,entrySequence=task['entry']['sequence'],
                           form=meta['form'],resolved=True,regular=False,
                           reason='operand inode is not a regular file'))
            return None
        held=os.open(held_path,os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(held));assert stat.S_ISREG(identity[2])
            assert operand==identity,'held operand path does not resolve to the held inode'
            assert external_held_identity is None or tuple(identity)==external_held_identity,'external operand differs from the already-held read lease'
            links=os.fstat(held).st_nlink
        except BaseException:
            os.close(held);raise
        payload=dict(model=LINK_MODEL,arch=meta['entryArch'],syscall=meta['entryNr'],form=meta['form'],
                     newDirfd=meta['newDirfd'],newPathAddress=meta['newPathAddress'],
                     oldDirfd=meta['oldDirfd'],oldPathAddress=meta['oldPathAddress'],
                     flags=meta['flags'],newPathHex=new_path_hex,newNamespaceHex=new_ns_hex,
                     oldPathHex=old_path_hex,oldNamespaceHex=old_ns_hex,
                     heldPathHex=os.fsencode(held_path).hex(),heldRole=('source' if meta['form'] in ('link','linkat') else 'target'))
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        operand=self.emit(dict(kind='kernel-link-args-original',pid=pid,entrySequence=task['entry']['sequence'],
                               barrierSequence=barrier['sequence'],operandSha256=digest,**payload))
        row=self.emit(dict(kind='actual-link-window',model=LINK_MODEL,pid=pid,path=held_path,form=meta['form'],
                           entrySequence=task['entry']['sequence'],barrierSequence=barrier['sequence'],
                           beforeIdentity=identity,beforeLinks=links,argsOriginalSequence=operand['sequence'],
                           entryArch=meta['entryArch'],entryNr=meta['entryNr']))
        self.timespec_originals[operand['sequence']]=operand
        task['metadataWindow']=(row,held,held_path,meta);self.retained.add(held);held=None;return row
    def args_original(self,row):
        original=self.timespec_originals.get(row['argsOriginalSequence'])
        assert original is not None,'timestamp argument original unavailable'
        return original
    def close_rename_leases(self,*descriptors):
        primary=sys.exc_info()[1];failure=None
        for fd in descriptors:
            if fd is None:continue
            try:os.close(fd)
            except BaseException as error:
                if failure is None:failure=error
                continue # Still owned: outer cleanup can retry this descriptor.
            try:self.retained.discard(fd)
            except BaseException as error:
                if failure is None:failure=error
        if primary is None and failure is not None:raise failure
    def capture_rename(self,pid):
        barrier=self.barrier()
        if barrier['sequence']!=self.seq:barrier=self.barrier()
        assert barrier['sequence']==self.seq,'retained rename requires fresh final all-stop barrier'
        task=self.tasks[pid];old,new=task['rename'];entry=task['entry']
        assert old!=new and all(path.startswith(self.build+'/') and str(Path(path).resolve(strict=path==old))==path for path in [old,new]),'rename requires distinct canonical build paths'
        destination_absent=retained_rename_path_absent(new)
        source=probe.identity(os.stat(old,follow_symlinks=False));assert stat.S_ISREG(source[2])
        key=tuple(source[:2]);generated=getattr(self,'generated_vma',None)
        if key in self.producers:
            producer,retained,expected=self.producers[key];producer_reference=dict(producerCaptureSequence=producer['sequence'])
        else:
            assert generated and generated.model==generated_vma_module.PARKED_WAIT_MODEL and generated.active is None and key in generated.checkpoints,'rename lacks a verified producer'
            producer=generated.checkpoints[key];origin=generated.origins[key];retained=origin['held'];expected=(producer['original']['bytes'],producer['original']['sha256']);producer_reference=dict(generatedCheckpointSequence=producer['sequence'])
        held=os.dup(retained);self.retained.add(held)
        destination=None
        try:
            before=probe.identity(os.fstat(held));assert before==source,'rename source differs from retained producer FD'
            bindings.retained_metadata_chain(producer,dict(sequence=self.seq+1,path=old,identity=before),self.metadata_states)
            original=self.snapshot_write_original(held,before[3]);assert (original['bytes'],original['sha256'])==expected,'rename preimage bytes differ from producer'
            destination_row=None
            if not destination_absent:
                named_destination=os.stat(new,follow_symlinks=False)
                assert stat.S_ISREG(named_destination.st_mode) and named_destination.st_nlink==1,'rename replacement requires single-link regular named target'
                destination=os.open(new,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC);self.retained.add(destination)
                destination_stat=os.fstat(destination);destination_identity=probe.identity(destination_stat)
                assert stat.S_ISREG(destination_identity[2]) and destination_stat.st_nlink==1 and destination_identity[:2]!=before[:2],'rename replacement requires distinct single-link regular target'
                assert destination_identity==probe.identity(named_destination)==probe.identity(os.stat(new,follow_symlinks=False)),'rename replacement target changed before capture'
                destination_original=self.snapshot_write_original(destination,destination_identity[3])
                assert destination_identity==probe.identity(os.fstat(destination))==probe.identity(os.stat(new,follow_symlinks=False)) and os.fstat(destination).st_nlink==1,'rename replacement preimage changed during capture'
                destination_row=dict(identity=destination_identity,namedIdentity=destination_identity,links=1,original=destination_original)
            assert before==probe.identity(os.fstat(held))==probe.identity(os.stat(old,follow_symlinks=False)) and (retained_rename_path_absent(new) if destination_absent else destination_row['identity']==probe.identity(os.stat(new,follow_symlinks=False))),'rename preimage changed during all-stop capture'
            row=self.emit(dict(kind='actual-rename-window',pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],**producer_reference,fromPath=old,toPath=new,beforeIdentity=before,namedIdentity=before,beforeOriginal=original,leaseSequence=self.seq+1,**({'destinationAbsenceErrno':errno.ENOENT} if destination_row is None else {'replacementBefore':destination_row})))
            task['renameWindow']=(row,held,expected,destination);held=None;destination=None;return row
        finally:self.close_rename_leases(held,destination)
    def complete_rename(self,pid,entry,exit):
        row,held,expected,destination=self.tasks[pid].pop('renameWindow')
        try:
            assert self.exclusive==(pid,entry['sequence']) and exit['result']==0 and exit['isError'] is False,'retained rename lacks actual exclusive successful exit'
            after=probe.identity(os.fstat(held));assert after[:5]==row['beforeIdentity'][:5] and after==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'retained rename post namespace/identity differs'
            # ADVANCE BEFORE ANY FURTHER EMIT. Every emit() runs a full lease sweep,
            # and by now the owned rename has already moved ctime, so the frozen PRE
            # token would be rejected by the FIRST emit below (the source snapshot's
            # `write-original`, and equally the displaced destination's). `after` is
            # already proven here against BOTH the retained FD and the new pathname,
            # so this is the earliest correct point: the transition is carried
            # across using the very endpoints this rename just verified.
            # (already advanced at the witnessed exit, before any emit)
            # GATHER the displaced destination's REAL post-state before any emitting
            # snapshot below, and advance its token first. Overwriting dropped this
            # inode's last link, so its ctime moved; if it was already leased from an
            # earlier read, its frozen PRE token would be rejected by the very first
            # emit. Endpoints are validated against the held destination FD and the
            # window's own prior identity/links, so this is the same witnessed-
            # endpoint discipline as the source -- not a waiver, and never merged
            # into the source's advance: the destination is a DIFFERENT inode.
            replacement_after=None
            displaced_identity=None
            if destination is not None:
                displaced=os.fstat(destination);displaced_identity=probe.identity(displaced);prior=row['replacementBefore']
                assert displaced.st_nlink==0 and displaced_identity[:5]==prior['identity'][:5],'rename replacement displaced target identity/link changed'
                # (already advanced at the witnessed exit, before any emit)
            original=self.snapshot_write_original(held,after[3]);assert (original['bytes'],original['sha256'])==expected,'retained rename changed producer bytes'
            assert after==probe.identity(os.fstat(held))==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'retained rename postimage changed during capture'
            if displaced_identity is not None:
                displaced_original=self.snapshot_write_original(destination,displaced_identity[3])
                assert (displaced_original['bytes'],displaced_original['sha256'])==(prior['original']['bytes'],prior['original']['sha256']) and displaced_identity==probe.identity(os.fstat(destination)) and os.fstat(destination).st_nlink==0,'rename replacement displaced bytes changed'
                assert after==probe.identity(os.fstat(held))==probe.identity(os.stat(row['toPath'],follow_symlinks=False)) and retained_rename_path_absent(row['fromPath']),'rename replacement namespace changed during displaced capture'
                replacement_after=dict(identity=displaced_identity,links=0,original=displaced_original)
            change=self.emit(dict(kind='actual-rename-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],leaseSequence=row['leaseSequence'],exitSequence=exit['sequence'],afterIdentity=after,namedIdentity=after,afterOriginal=original,oldPathAbsent=True,oldPathAbsenceErrno=errno.ENOENT,result=exit['result'],isError=exit['isError'],**({} if replacement_after is None else {'replacementAfter':replacement_after})))
            self.metadata_states.append((row,change))
        finally:self.close_rename_leases(held,destination)
    FATAL_WINDOW_KINDS=('actual-mode-window','actual-timestamp-window','actual-link-window','actual-rename-window')
    FATAL_WINDOW_FORMS=('link','linkat','unlink','unlinkat','path','fd')
    def record_failed_kernel_stop(self,pid,kernel,task=None):
        """Snapshot the failed kernel stop without claiming whether it was written.

        Fatal path only, and only after the row already failed, so it can never
        change admission or create authority. Every value is an exact int inside
        a per-field range, an exact bool, or a fixed whitelisted enum; anything
        else becomes the fixed string 'unavailable'. No paths, argv, env, bodies
        or key material are ever copied.
        """
        def unsigned(value,bits):
            return value if type(value) is int and 0<=value<(1<<bits) else 'unavailable'
        def signed(value,bits):
            low=-(1<<(bits-1))
            return value if type(value) is int and low<=value<(1<<(bits-1)) else 'unavailable'
        try:
            if type(kernel) is not dict:
                # Not a kernel stop at all: record nothing rather than a frame
                # composed entirely of 'unavailable'.
                self.fatal_stop=None
                return
            row=kernel
            task=task if type(task) is dict else {}
            entry=task.get('entry') or {}
            op=row.get('op')
            stop=dict(pid=unsigned(pid,31),
                      op=op if op in ('entry','exit') else 'unavailable',
                      # an EXIT row carries no nr/arch: fall back to the
                      # authoritative SAME-TASK entry the observer recorded.
                      nr=unsigned(row.get('nr'),32),
                      arch=unsigned(row.get('arch'),32))
            if stop['nr']=='unavailable':stop['nr']=unsigned(entry.get('nr'),32)
            if stop['arch']=='unavailable':stop['arch']=unsigned(entry.get('arch'),32)
            seq=row.get('entrySequence')
            if type(seq) is not int:seq=entry.get('sequence')
            stop['entrySequence']=unsigned(seq,32)
            stop['result']=signed(row.get('result'),64)
            is_error=row.get('isError')
            stop['isError']=is_error if type(is_error) is bool else 'unavailable'
            pending=[]
            for name in ('metadataWindow','renameWindow'):
                window=task.get(name)
                if window is None:continue
                window_row=window[0] if isinstance(window,(tuple,list)) and window else {}
                if type(window_row) is not dict:continue
                kind=window_row.get('kind')
                form=window_row.get('form')
                pending.append(dict(
                    kind=kind if kind in self.FATAL_WINDOW_KINDS else 'unavailable',
                    form=form if form in self.FATAL_WINDOW_FORMS else 'unavailable',
                    sequence=unsigned(window_row.get('sequence'),32)))
            # exclusive ownership needs BOTH the pid AND the live task entry
            exclusive=self.exclusive
            stop_sequence=stop['entrySequence']
            owned=bool(exclusive is not None and len(exclusive)==2
                       and exclusive[0]==pid
                       and type(exclusive[1]) is int
                       and stop_sequence!='unavailable'
                       and exclusive[1]==stop_sequence)
            # Target token identity ONLY from already-held own state.
            target=None
            try:
                held=getattr(self,'lifetime_by_identity',None)
                if held is not None:
                    for name in ('metadataWindow','renameWindow'):
                        window=task.get(name)
                        if window is None:continue
                        window_row=window[0] if isinstance(window,(tuple,list)) and window else {}
                        before=window_row.get('beforeIdentity') if type(window_row) is dict else None
                        if type(before) is not list or len(before)!=6:continue
                        found=held.get(tuple(before))
                        if found is None:continue
                        candidate=[signed(v,64) for v in (found.get('token') or {}).get('identity') or []]
                        if len(candidate)==6 and signed(candidate[0],64)!='unavailable':target=candidate
                        break
            except BaseException:
                target=None
            # A trailing check can fail after the raw row was written. Report
            # rejection without claiming that the raw stream was untouched.
            self.fatal_stop=dict(kind='failed-kernel-stop',accepted=False,stop=stop,
                                 pendingWindows=pending[:2],exclusiveOwned=owned,
                                 pendingTargetIdentity=target)
        except BaseException:
            self.fatal_stop=None
    def advance_pending_owned_transitions(self,pid,kernel):
        """Advance every legitimately affected held inode for a witnessed owned op.

        Called at the raw syscall EXIT of a successful owned operation, BEFORE the
        kernel row is emitted. The kernel has already applied the effect, so every
        retained FD here reports its real post-state. Endpoints are read from the
        observer's own retained FDs (never from a path), and each inode is advanced
        on its own tuple: an unrelated token is never touched, and a missing lease
        is a no-op. A refused advance propagates -- it is never absorbed.
        """
        # EXACT kernel contract, matching what the downstream handlers require.
        # `complete_rename` demands `result==0 and isError is False`; accepting a
        # MISSING/None isError, or `result=False`/a bool, would let this API claim a
        # refusal it did not actually make. Only an exact successful exit advances.
        if type(kernel) is not dict or kernel.get('op')!='exit':
            return
        if not (type(kernel.get('result')) is int and kernel['result']==0):
            return
        if kernel.get('isError') is not False:
            return
        task=self.tasks.get(pid,{})
        metadata=task.get('metadataWindow')
        if metadata is not None:
            # Only the EXISTING supported link/unlink inode-effect model is advanced
            # here -- never a mode/timestamp/unknown window. Those carry different
            # shapes entirely (a mode window's `meta` is a plain tuple), so keying on
            # the emitted window kind is both safer and the actual contract.
            m_row,m_held,_m_access,m_meta=metadata
            if m_row.get('kind')=='actual-link-window' and m_row.get('model')==LINK_MODEL:
                form=m_row.get('form')
                if form in ('link','linkat','unlink','unlinkat'):
                    m_before=m_row['beforeIdentity']
                    m_after=probe.identity(os.fstat(m_held))
                    if m_after[:5]==m_before[:5] and m_after!=m_before:
                        operation=('owned-rename-over-destination' if form in ('link','linkat')
                                   else 'owned-temp-unlink')
                        self.advance_witnessed_lease(m_before,m_after,operation)
        window=task.get('renameWindow')
        if window is None:
            return
        row,held,expected,destination=window
        before_source=row['beforeIdentity']
        after_source=probe.identity(os.fstat(held))
        # Only a real same-inode ctime move is advanced here; anything else is left
        # for `complete_rename` to reject with its own precise message.
        if after_source[:5]==before_source[:5] and after_source!=before_source:
            self.advance_witnessed_lease(before_source,after_source,'owned-rename-over-destination')
        replacement=row.get('replacementBefore')
        if destination is not None and replacement is not None:
            before_target=replacement['identity']
            after_target=probe.identity(os.fstat(destination))
            if after_target[:5]==before_target[:5] and after_target!=before_target:
                self.advance_witnessed_lease(before_target,after_target,'owned-rename-over-destination')

    def advance_witnessed_lease(self,before,after,operation='owned-rename-over-destination'):
        """Advance a held lease token across an ALREADY-VALIDATED owned transition.

        Looks the token up by the PRE-transition identity (the key `acquire`
        fixed), calls the guarded `LeaseSet.advance`, then rekeys the observer's
        own identity maps so later lookups use the advanced tuple. Absent lease
        is a no-op: such an inode is simply not leased.
        """
        if self.lifetime_leases is None:
            return
        key=tuple(before)
        held=self.lifetime_by_identity.get(key)
        if held is None:
            return
        token=held['token']
        try:
            self.lifetime_leases.advance(token,list(before),list(after),operation)
        except BaseException:
            # A refused advance is a REAL failure (stale baseline, replaced inode,
            # foreign move). It must propagate: never absorb it here.
            raise
        advanced=dict(token,identity=list(after))
        sequence=held['sequence']
        del self.lifetime_by_identity[key]
        self.lifetime_by_identity[tuple(after)]=dict(token=advanced,sequence=sequence)
        slot=self.lifetime_acquired.get(tuple(before[:2]))
        if slot is not None:
            slot['identity']=list(after)
            slot['token']=dict(advanced)
    def chunk_identity(self,reference):
        storage=reference['storage'];assert storage['model']=='chunk-original-v1'
        ref=storage['manifest'];value=os.stat(self.capture_dir/ref['path'],follow_symlinks=False)
        assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_size==ref['bytes']
        return [*probe.identity(value),value.st_nlink]
    def snapshot_write_original(self,reader,size,*,offset=0):
        assert 0<=size<=self.maximum_file_bytes,'write original byte bound'
        source=os.fstat(reader)
        if getattr(self,'capture_content_entities',False) and offset==0 and stat.S_ISREG(source.st_mode) and source.st_size==size:
            sites=getattr(self,'_audit_sites',None);ticket=None
            try:
                if sites is not None:
                    ticket=self.audit_site(sites,'snapshot_ticket')
                    self.audit_site(sites,'install',ticket)
                self.audit_site(sites,'snapshot_site',ticket,'observer-leading') if ticket is not None else None
                self.check();number=len(self.captures);ledger=CaptureReservation(self)
                # Out-of-band counter sink. It is updated in place by the chunk store
                # BEFORE each fsync it counts, so a deadline raised inside the manifest
                # fsync still leaves the exact counters at the failure point in
                # self.snapshot_telemetry for the existing phase-failure diagnostic.
                # It is never a proof field, never in the manifest or the receipt.
                telemetry=dict();self.snapshot_telemetry=telemetry
                try:
                    check=self.check if ticket is None else lambda:self.audit_snapshot_check(ticket,telemetry)
                    manifest=chunk_store.snapshot(self.capture_dir,reader,number,ledger,check,telemetry=telemetry)
                except BaseException:
                    self.snapshot_telemetry_failure=chunk_store.bounded_snapshot_telemetry(telemetry)
                    raise
                self.audit_site(sites,'snapshot_site',ticket,'manifest-read') if ticket is not None else None
                data=chunk_store.read_manifest(self.capture_dir,manifest,self.check)
                reference=dict(path='capture-'+str(number).zfill(4)+'.original',bytes=data['bytes'],sha256=data['sha256'],storage=dict(model='chunk-original-v1',manifest=manifest))
                physical_bytes=ledger.committed_bytes
                self.audit_site(sites,'snapshot_site',ticket,None) if ticket is not None else None
                row=self.emit(dict(kind='write-original',original=reference))
                self.append_capture(row);self.capture_bytes+=physical_bytes
                self.snapshot_telemetry_completed=chunk_store.bounded_snapshot_telemetry(telemetry)
                return reference
            finally:
                if ticket is not None:self.audit_site(ticket[0],'remove',ticket,primary=sys.exc_info()[1])
        name=self.next_capture_name();count=0;digest=hashlib.sha256()
        def body():
            nonlocal count
            with (self.capture_dir/name).open('xb') as output:
                while count<size:
                    self.check();block=os.pread(reader,min(65536,size-count),offset+count);assert block,'short actual write original'
                    self.claim(len(block),category='capture-body',context=self.budget_context);output.write(block);count+=len(block);digest.update(block)
                output.flush();os.fsync(output.fileno())
            return count
        self.read_body(body)
        row=self.emit(dict(kind='write-original',original=dict(path=name,bytes=count,sha256=digest.hexdigest())))
        self.append_capture(row);self.capture_bytes+=count;return row['original']
    def fd_blocks(self,reader,size):
        # Streamed blocks stay a true boundary: callers bracket the full read
        # and full digest. Iterations only pay the cheap deadline/stdio check.
        offset=0
        while offset<size:
            self.check_deadline();block=os.pread(reader,min(65536,size-offset),offset);assert block,'short held write image'
            offset+=len(block);yield block
    def original_blocks(self,ref):
        if ref.get('storage'):
            yield from chunk_store.blocks(self.capture_dir,ref['storage']['manifest'],self.check_deadline)
            return
        with (self.capture_dir/ref['path']).open('rb') as stream:
            while True:
                self.check_deadline();block=stream.read(65536)
                if not block:break
                yield block
    def capture_write(self,pid,fd):
        barrier=self.barrier();entry=self.tasks[pid]['entry'];path=fdpath(pid,fd);reader=os.open('/proc/'+str(pid)+'/fd/'+str(fd),os.O_RDONLY|os.O_CLOEXEC)
        try:
            identity=probe.identity(os.fstat(reader));assert stat.S_ISREG(identity[2]) and identity[3]<=self.maximum_file_bytes
            alias_inventory=self.stopped_write_alias_inventory(pid,fd,identity) if getattr(self,'stopped_writer_aliases',False) else None
            writers=[dict(pid=pid,fd=fd)] if alias_inventory else self.sole_writer(pid,fd,identity);flags=descriptor_flags(pid,fd);assert flags&os.O_ACCMODE==os.O_RDWR
            position=descriptor_position(pid,fd);offset=identity[3] if flags&os.O_APPEND else position;count=entry['args'][2]
            assert count<=self.maximum_file_bytes and offset+count<=self.maximum_file_bytes,'bounded actual write range'
            self.budget_context=dict(path=path[:4096],pathTruncated=len(path)>4096,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),role='write-before',pid=pid,fd=fd,identity=identity,writeCount=count,writeOffset=offset)
            generated_origin=self.generated_vma.write_baseline(pid,fd,identity,identity[3],offset) if self.generated_vma else None
            key=tuple(identity[:2]);chain=self.append_chains.get(key)
            append=offset==identity[3] and generated_origin is None
            if chain and not append:self.checkpoint_appends('nonappend-write',entry['sequence']);chain=None
            if chain:
                assert chain['identity']==identity,'append FD preimage identity changed'
                before=dict(bytes=identity[3],sha256=chain['digest'].hexdigest())
            else:
                before=bindings.digest_blocks(self.fd_blocks(reader,identity[3]),self.maximum_file_bytes,self.check);assert identity==probe.identity(os.fstat(reader))
            if generated_origin is not None:assert generated_origin['data']==(before['bytes'],before['sha256']),'generated write entire before bytes differ from retained origin'
            initial=None
            if generated_origin is not None or tuple(identity[:2]) not in self.write_states:
                initial=self.snapshot_write_original(reader,identity[3]);assert identity==probe.identity(os.fstat(reader))
            prior=None if generated_origin is not None else self.write_states.get(tuple(identity[:2]));baseline=generated_origin['sequence'] if generated_origin is not None else 'empty'
            if identity[3] and generated_origin is None:
                if prior:
                    assert prior['afterIdentity']==identity and (prior['after']['bytes'],prior['after']['sha256'])==(before['bytes'],before['sha256']),'write preimage differs from previous actual write'
                    baseline=prior['sequence']
                else:
                    original=self.producers.get(tuple(identity[:2])) or self.prepared_inputs.get(path)
                    assert original,'nonempty writable preimage lacks retained actual original'
                    row,held,data=original;assert probe.identity(os.fstat(held))==identity and data==(before['bytes'],before['sha256']),'write preimage differs from actual retained original';baseline=row['sequence']
            memory=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
            try:
                self.budget_context['role']='actual-write-buffer';buffer=self.snapshot_write_original(memory,count,offset=entry['args'][1])
            finally:os.close(memory)
            row=self.emit(dict(kind='actual-write-window',pid=pid,fd=fd,path=path,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],beforeIdentity=identity,format='bounded-append-effect-v1' if append else 'bounded-write-delta-v1',initialBefore=initial,before=before,buffer=buffer,offset=offset,position=position,flags=flags,writers=writers,baseline=baseline,**(dict(stoppedAliasInventory=alias_inventory) if alias_inventory else {})))
            self.budget_context={}
            if generated_origin is not None:self.tasks[pid]['generatedWriteOrigin']=generated_origin
            if append and chain is None:
                digest=hashlib.sha256()
                for block in self.fd_blocks(reader,identity[3]):digest.update(block)
                assert digest.hexdigest()==before['sha256'] and identity==probe.identity(os.fstat(reader))
                retained=os.dup(reader);self.retained.add(retained)
                chain=dict(identity=identity,digest=digest,held=retained,dirty=False,transition=None)
                self.append_chains[key]=chain
            self.tasks[pid]['writeWindow']=(row,reader);self.retained.add(reader);reader=None;return row
        finally:
            if reader is not None:os.close(reader)
    def complete_write(self,pid,entry,exit):
        row,held=self.tasks[pid].pop('writeWindow')
        try:
            assert self.exclusive==(pid,entry['sequence']) and not exit['isError'] and 0<=exit['result']<=entry['args'][2],'actual write failed or returned invalid count'
            identity=probe.identity(os.fstat(held));assert identity==probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(row['fd']))) and identity[:3]==row['beforeIdentity'][:3] and descriptor_flags(pid,row['fd'])==row['flags'],'actual writer FD changed'
            alias_after=self.stopped_write_alias_inventory(pid,row['fd'],identity) if 'stoppedAliasInventory' in row else None
            if alias_after:
                expected=row['stoppedAliasInventory'];assert alias_after['taskOwnership']==expected['taskOwnership'],'write alias ownership changed'
                assert [{**alias,'identity':row['beforeIdentity']} for alias in alias_after['aliases']]==expected['aliases'],'write alias descriptor binding changed'
            else:self.sole_writer(pid,row['fd'],identity)
            key=tuple(identity[:2]);segments=self.write_projections.get(key)
            if row['initialBefore'] is not None:segments=[(row['initialBefore'],0,row['beforeIdentity'][3])] if row['beforeIdentity'][3] else []
            assert segments is not None,'write delta baseline projection missing'
            if row['format']=='bounded-append-effect-v1':
                chain=self.append_chains[key];assert chain['identity']==row['beforeIdentity'] and row['offset']==row['beforeIdentity'][3]
                assert identity[3]==row['offset']+exit['result'] if exit['result'] else identity[3]==row['beforeIdentity'][3]
                effect=hashlib.sha256();position=0
                for block in self.original_blocks(row['buffer']):
                    chunk=block[:max(0,min(len(block),exit['result']-position))]
                    if chunk:
                        actual=os.pread(held,len(chunk),row['offset']+position);assert actual==chunk,'actual append range differs from returned syscall buffer'
                        effect.update(actual);chain['digest'].update(actual);position+=len(actual)
                    if position==exit['result']:break
                assert position==exit['result'] and identity==probe.identity(os.fstat(held))
                # O(1) metadata append; the prefix is NOT re-read or certified here.
                if exit['result']:segments.append((row['buffer'],0,exit['result']))
                after=dict(bytes=identity[3],sha256=chain['digest'].hexdigest())
                extra=dict(afterObservation='uncheckpointed-append-projection',actualAppendEffect=dict(bytes=position,sha256=effect.hexdigest()))
                chain.update(identity=identity,dirty=True)
            else:
                segments=bindings.write_segments(segments,row['offset'],exit['result'],row['buffer'],self.maximum_file_bytes)
                after=bindings.digest_blocks(self.fd_blocks(held,identity[3]),self.maximum_file_bytes,self.check)
                expected=bindings.digest_blocks(bindings.segment_blocks(segments,self.original_blocks,self.check),self.maximum_file_bytes,self.check)
                assert after==expected and identity==probe.identity(os.fstat(held)),'actual post-write bytes differ from syscall buffer projection';extra={}
            self.write_projections[key]=segments
            transition=self.emit(dict(kind='actual-write-transition',pid=pid,entrySequence=entry['sequence'],windowSequence=row['sequence'],exitSequence=exit['sequence'],afterIdentity=identity,after=after,result=exit['result'],isError=exit['isError'],**(dict(stoppedAliasInventoryAfter=alias_after) if alias_after else {}),**extra))
            if row['format']=='bounded-append-effect-v1':chain['transition']=transition
            self.write_states[tuple(identity[:2])]=transition
            generated_origin=self.tasks[pid].pop('generatedWriteOrigin',None)
            if generated_origin is not None:self.generated_vma.complete_write_bridge(generated_origin,row,transition,held)
        finally:
            primary=sys.exc_info()[1]
            try:os.close(held)
            except BaseException as cleanup:
                if self.generated_vma:self.generated_vma.cleanup_errors.append(cleanup)
                if primary is None:raise
            else:self.retained.remove(held)
    def checkpoint_appends(self,reason,entry_sequence=None):
        # Called only while every registered live task is stopped, or after all
        # actual waits. A held FD survives close/rename; no pathname re-open.
        assert all(row['stopped'] or row['exited'] for row in self.tasks.values()),'append checkpoint requires all-task stop'
        if not self.append_chains:return []
        barrier=self.barrier() if any(not row['exited'] for row in self.tasks.values()) else None
        checked=[]
        for key,chain in list(self.append_chains.items()):
            held=chain['held'];identity=probe.identity(os.fstat(held))
            assert identity==chain['identity'],'append checkpoint FD identity changed'
            if chain['dirty']:
                self.budget_context=dict(role='append-full-checkpoint',identity=identity,reason=reason)
                original=self.snapshot_write_original(held,identity[3])
                assert identity==probe.identity(os.fstat(held)) and (original['bytes'],original['sha256'])==(identity[3],chain['digest'].hexdigest()),'append prefix changed before full checkpoint'
                row=self.emit(dict(kind='append-full-checkpoint',transitionSequence=chain['transition']['sequence'],identity=identity,original=original,reason=reason,entrySequence=entry_sequence,barrierSequence=barrier['sequence'] if barrier else None,closedTrackedWaits=barrier is None))
                checked.append(row['sequence']);chain['dirty']=False
            os.close(held);self.retained.remove(held);del self.append_chains[key]
        self.budget_context={}
        return checked
    def capture_entity_identity(self,reference):
        name=reference['path'];assert re.fullmatch(r'capture-[0-9]{4,}\.original',name),'fixed retained capture entity required'
        value=os.stat(self.capture_dir/name,follow_symlinks=False)
        assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_size==reference['bytes'],'same single-link retained capture entity required'
        return [*probe.identity(value),value.st_nlink]
    def next_capture_name(self):
        """Allocate ONE free canonical capture entity name.

        Every capture role shares this allocator. Deriving the name from
        ``len(self.captures)`` alone is wrong whenever a role reserves an entity
        before appending its row (or a phase aborts after a partial write): the
        next role would reuse a live name and overwrite a registered entity.
        Existence is therefore checked, and the counter only advances.
        """
        index=len(self.captures)
        while True:
            name='capture-'+str(index).zfill(4)+'.original'
            if not (self.capture_dir/name).exists():return name
            index+=1

    def register_capture_entity(self,reference):
        reference=bindings.physical_original_reference(reference)
        identity=self.capture_entity_identity(reference);prior=self.capture_entities.get(reference['path'])
        assert prior is None or prior==(reference,identity),'capture entity path reused with different bytes or identity'
        self.capture_entities[reference['path']]=(dict(reference),identity)
        return identity
    def verify_capture_entity(self,reference):
        reference=bindings.physical_original_reference(reference)
        registered=self.capture_entities.get(reference['path']);assert registered and registered[0]==reference,'same registered capture entity required'
        reader=os.open(self.capture_dir/reference['path'],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK);self.retained.add(reader)
        try:
            value=os.fstat(reader);identity=[*probe.identity(value),value.st_nlink]
            assert stat.S_ISREG(value.st_mode) and value.st_nlink==1 and identity==registered[1] and identity==self.capture_entity_identity(reference),'retained capture entity changed before read'
            offset=0;digest=hashlib.sha256()
            while True:
                self.check();block=os.pread(reader,65536,offset)
                if not block:break
                offset+=len(block);assert offset<=reference['bytes'];digest.update(block)
            value=os.fstat(reader)
            assert identity==[*probe.identity(value),value.st_nlink]==self.capture_entity_identity(reference) and (offset,digest.hexdigest())==(reference['bytes'],reference['sha256']),'retained capture entity bytes or identity changed'
            return identity
        finally:
            primary=sys.exc_info()[1]
            try:os.close(reader)
            except BaseException:
                if primary is None:raise
            else:self.retained.remove(reader)
    def read_capture_fd(self,reader,output,*,context=None):
        def body():
            offset=0;digest=hashlib.sha256()
            while True:
                self.check();block=os.pread(reader,65536,offset)
                if not block:break
                offset+=len(block);assert offset<=self.maximum_file_bytes,'bounded actual capture FD required'
                if output is not None:self.claim(len(block),category='capture-body',context=dict(context or {},captureOffset=offset-len(block),capturePrefixSHA256=digest.copy().hexdigest()));output.write(block)
                digest.update(block)
            return offset,digest.hexdigest()
        return self.read_body(body)
    def prior_content_entity(self,data,*,scope=()):
        prior=self.content_capture_pool.get((self.current_phase,*scope,*data))
        if prior is None:return None
        assert prior['phase']==self.current_phase and prior['sequence']<=self.seq and prior['original']['path']in self.capture_entities,'actual prior samephase canonical required'
        ref=bindings.physical_original_reference(prior['original']);entity=self.verify_capture_entity(ref)
        assert data==(ref['bytes'],ref['sha256'])and entity==prior['originalEntityIdentity'],'actual body differs from canonical retained entity'
        return prior,ref,entity
    def content_capture_original(self,reader,target,ident,name,context):
        # Lookup follows a fresh complete FD read. The pool is physical storage,
        # never a substitute for this window's FD/source/operation provenance.
        value=os.fstat(reader);before=[*probe.identity(value),value.st_nlink];assert before[:6]==ident,'actual FD changed before content observation'
        def named():
            value=os.stat(target,follow_symlinks=False);return [*probe.identity(value),value.st_nlink]
        try:initial_named=named()
        except (FileNotFoundError,NotADirectoryError,PermissionError):initial_named=None
        eligible=initial_named==before and stat.S_ISREG(before[2])
        data=self.read_capture_fd(reader,None)
        current=os.fstat(reader);assert before==[*probe.identity(current),current.st_nlink],'actual complete content FD changed'
        if eligible:assert named()==before,'actual named content FD changed'
        reused=self.prior_content_entity(data)if eligible else None
        if reused is not None:
            prior,ref,entity=reused
            value=os.fstat(reader);assert before==[*probe.identity(value),value.st_nlink]==named(),'FD/named identity changed during canonical verification'
            return ref,entity,dict(originalReuse=dict(model='same-phase-content-entity-v2',originCaptureSequence=prior['sequence']),captureWindowIdentity=before,captureWindowAfterIdentity=[*probe.identity(value),value.st_nlink],namedWindowIdentity=initial_named,namedWindowAfterIdentity=named()),data
        # Unknown contents incur a second actual held-FD pass, not a refunded
        # speculative body. Charge each output block before writing it.
        with (self.capture_dir/name).open('xb') as output:
            actual=self.read_capture_fd(reader,output,context=context);output.flush();os.fsync(output.fileno())
        value=os.fstat(reader);assert actual==data and before==[*probe.identity(value),value.st_nlink],'fresh physical content pass changed actual FD/body'
        if eligible:assert named()==before,'actual named source changed during physical capture'
        ref=dict(path=name,bytes=data[0],sha256=data[1]);self.capture_bytes+=data[0];entity=self.register_capture_entity(ref)
        return ref,entity,dict(captureWindowIdentity=before,captureWindowAfterIdentity=[*probe.identity(value),value.st_nlink],**(dict(namedWindowIdentity=initial_named,namedWindowAfterIdentity=named()) if eligible else {})),data
    def phase_capture_files(self,capture_start):
        # Raw observations stay one-per-window; each physical body appears once.
        references={}
        for row in self.captures[capture_start:]:
            original=row['original']
            if original.get('storage'):
                manifest=original['storage']['manifest'];data=chunk_store.read_manifest(self.capture_dir,manifest,self.check)
                assert (data['bytes'],data['sha256'])==(original['bytes'],original['sha256'])
                physical=[manifest]+[dict(path='chunks/'+chunk['sha256'],bytes=chunk['bytes'],sha256=chunk['sha256']) for chunk in data['chunks']]
            else:physical=[bindings.physical_original_reference(original)]
            for reference in physical:
                prior=references.get(reference['path'])
                assert prior is None or prior==reference,'conflicting same-phase capture entity reference'
                references[reference['path']]=reference
        return [dict(reference,path=str(self.capture_dir/reference['path'])) for reference in references.values()]
    def capture(self,pid,fd,role):
        barrier=self.barrier();self.check();target=fdpath(pid,fd);path='/proc/'+str(pid)+'/fd/'+str(fd);before=os.stat(path);reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
        try:
            ident=probe.identity(os.fstat(reader));assert ident==probe.identity(before) and stat.S_ISREG(ident[2]) and ident[3]<=self.maximum_file_bytes,'bounded regular capture required'
            if role=='producer-close':
                aliases=self.writable_aliases(ident,pid,fd)
                if len(aliases)!=1 or aliases[0]['pid']!=pid or aliases[0]['fd']!=fd:
                    assert len(aliases)>1 and any(alias['pid']==pid and alias['fd']==fd for alias in aliases),'selected close FD changed before exclusive window'
                    table_owners=sorted(other for other,task in self.tasks.items() if not task['exited'] and (task['fdTable']==self.tasks[pid]['fdTable'] if self.shared_tasks else other==pid))
                    row=self.emit(dict(kind='alias-close-window',pid=pid,fd=fd,path=target,entrySequence=self.tasks[pid]['entry']['sequence'],barrierSequence=barrier['sequence'],identity=ident,aliases=aliases,tableOwners=table_owners,scope='descriptor close only; no producer or input byte authority'))
                    self.tasks[pid]['aliasCloseWindow']=(row,reader);self.retained.add(reader);reader=None;return row
            writers=self.sole_writer(pid,fd,ident) if role=='producer-close' else [];rw_read=False
            # A stopped writer is still a writer: diagnose, never silently accept it.
            if role!='producer-close':
                aliases=[];alias_count=0;alias_digest=hashlib.sha256()
                for alias in self.writable_aliases(ident,pid,fd):
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
            reusable=None
            if role=='consumer' and not rw_read:
                candidate=self.producers.get(tuple(ident[:2])) or self.prepared_inputs.get(target)
                if candidate and candidate[0].get('phase')==self.current_phase and candidate[0]['original']['path'] in self.capture_entities:
                    prior,held,expected=candidate
                    if prior.get('originalEntityIdentity')==self.capture_entities[prior['original']['path']][1] and expected==(prior['original']['bytes'],prior['original']['sha256']):reusable=prior
            name=self.next_capture_name()
            if self.capture_content_entities:
                context=dict(role='fd-capture',captureRole=role,pid=pid,fd=fd,fileBytes=ident[3],captureIdentity=ident,capturePathPrefix=os.fsencode(target)[:128].decode('utf-8','backslashreplace'),capturePathSHA256=hashlib.sha256(os.fsencode(target)).hexdigest(),captureObservationComplete=False)
                ref,entity_identity,storage,data=self.content_capture_original(reader,target,ident,name,context)
                offset=data[0]
            else:
                offset=0;digest=hashlib.sha256();output=None
                try:
                    if reusable is None:output=(self.capture_dir/name).open('xb')
                    while True:
                        block=os.pread(reader,65536,offset)
                        if not block:break
                        offset+=len(block);assert offset<=self.maximum_file_bytes
                        if output is not None:self.claim(len(block),category='capture-body',context=dict(role='fd-capture',captureRole=role,pid=pid,fd=fd,fileBytes=ident[3],captureOffset=offset-len(block),captureIdentity=ident,capturePathPrefix=os.fsencode(target)[:128].decode('utf-8','backslashreplace'),capturePathSHA256=hashlib.sha256(os.fsencode(target)).hexdigest(),captureObservationComplete=False,capturePrefixSHA256=digest.copy().hexdigest()));output.write(block)
                        digest.update(block);self.check()
                    if output is not None:output.flush();os.fsync(output.fileno())
                finally:
                    if output is not None:
                        primary=sys.exc_info()[1]
                        try:output.close()
                        except BaseException:
                            if primary is None:raise
                assert ident==probe.identity(os.fstat(reader))==probe.identity(os.stat(path))
                data=(offset,digest.hexdigest())
                if reusable is None:
                    self.capture_bytes+=offset;ref=dict(path=name,bytes=offset,sha256=data[1]);entity_identity=self.register_capture_entity(ref);storage={}
                else:
                    ref=dict(reusable['original']);assert data==(ref['bytes'],ref['sha256']),'actual consumer bytes differ from retained original entity'
                    entity_identity=self.verify_capture_entity(ref);storage=dict(originalReuse=dict(model='same-phase-producer-original-v1',originCaptureSequence=reusable['sequence']))
            dependency=self.dependency_source(target) if role=='source-read' and target.startswith('/opt/qlever-sdk/dependencies/') else None
            if dependency:
                binding,expected=dependency;assert expected['mode']==stat.S_IMODE(ident[2]) and (expected['bytes'],expected['sha256'])==data,'dependency actual held FD bytes differ from prepared snapshot'
            row=self.emit(dict(**({'dependency':dependency[0]} if dependency else {}),**storage,originalEntityIdentity=entity_identity,kind='fd-capture',role='readwrite-consumer' if rw_read else role,pid=pid,fd=fd,entrySequence=self.tasks[pid]['entry']['sequence'],path=target,identity=ident,original=ref,barrierSequence=barrier['sequence'],writers=writers))
            self.append_capture(row);capture_fd=reader;self.retained.add(reader);reader=None
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
                if self.generated_vma and self.generated_vma.consumer(row,data,ident):return row
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
                timestamp_for_producer=any(window['kind'] in ('actual-timestamp-window','actual-link-window') and old['sequence']<change['sequence']<row['sequence'] for window,change in self.metadata_states)
                if target!=old['path'] or timestamp_for_producer or any(window['kind']=='actual-rename-window' and window.get('producerCaptureSequence')==old['sequence'] for window,change in self.metadata_states):
                    named_identity=probe.identity(os.stat(target,follow_symlinks=False));assert named_identity==ident==probe.identity(os.fstat(held)),'actual named path does not refer to retained producer FD'
                    try:
                        mode_refs=bindings.retained_metadata_chain(old,row,self.metadata_states)
                    except BaseException:
                        # Close the framed raw shard before propagating so the
                        # failure record itself stays decodable (no partial gzip).
                        try:
                            if isinstance(self.raw,EncodedShardedRaw):self.raw.finish()
                            else:self.raw.close()
                        except BaseException:pass
                        raise
                    has_timestamp=any(window['kind'] in ('actual-timestamp-window','actual-link-window') for window,_ in self.metadata_states)
                    model=TIMESTAMP_CHAIN_MODEL if has_timestamp else 'actual-rename-mode-chain-v1'
                    self.emit(dict(kind='retained-fd-namespace-binding',producerCaptureSequence=old['sequence'],consumerCaptureSequence=row['sequence'],path=target,namedIdentity=named_identity,retainedIdentity=now,modeTransitions=mode_refs,metadataChainModel=model))
                self.consumers.append(self.emit(dict(kind='prepared-consumer-binding' if prepared else 'generated-consumer-binding',captureSequence=row['sequence'],producerCaptureSequence=old['sequence'],path=target,identity=ident,retainedIdentity=now,actualBytesEqual=True)))
            return row
        finally:
            if reader is not None:os.close(reader)
    def enforce_executable_memory(self,pid,record):
        reason=memory_policy.decision(record['arch'],record['nr'],record['args'])
        # Existing controlled ENOSYS substitution prevents setup from executing;
        # enter/register and all unmediated asynchronous submissions stay refused.
        if record['nr']==425 and self.deny_optional_io_uring:reason=None
        descriptor=memory_policy.write_descriptor(record['arch'],record['nr'],record['args'])
        if descriptor is not None:
            target=fdpath(pid,descriptor)
            if memory_policy.memory_fd(target):reason='proc-memory-write-descriptor'
            self.emit(dict(kind='executable-memory-write-fd',model=memory_policy.MODEL,pid=pid,entrySequence=record['sequence'],fd=descriptor,target=target))
        # Bounded private-anonymous mremap capability. `decision()` still refuses
        # every remap; this branch can only CLEAR that one reason, and only when
        # the whole source range is proved under a real all-stop. Every failure
        # path returns the original reason unchanged.
        if reason=='memory-remap-outside-fixed-executable-mapping-scope':
            proof=self.prove_private_anonymous_remap(pid,record)
            if proof is _MREMAP_DEFERRED:
                # Queued: the entry stays stopped and resume is blocked. This is
                # NOT an admission and NOT a refusal; return without raising and
                # without emitting an allow row.
                return _MREMAP_DEFERRED
            if proof is not None:
                self.emit(dict(kind='executable-memory-remap-allowed',model=memory_policy.REMAP_MODEL,pid=pid,entrySequence=record['sequence'],**proof))
                self.tasks[pid]['mremapPending']=dict(entrySequence=record['sequence'],**proof)
                # Hold the exclusive slot and let ONLY this owner resume. Every
                # same-MM peer stays in its tracing stop until the verified exit.
                self.exclusive=(pid,record['sequence'])
                self.emit(dict(kind='exclusive-remap-resume',model=memory_policy.REMAP_MODEL,pid=pid,
                               entrySequence=record['sequence'],barrierSequence=proof['barrierSequence'],
                               request='PTRACE_SYSCALL',signal=0))
                reason=None
        if reason:
            self.emit(dict(kind='executable-memory-refused',model=memory_policy.MODEL,pid=pid,entrySequence=record['sequence'],reason=reason))
            # Diagnostic provenance ONLY on the existing fatal refusal branch. The
            # retained raw event row above and the raised error below are unchanged.
            refusedCaller=refused_caller_snapshot(pid,record,self.check)
            print('SDK_EXECUTABLE_MEMORY_REFUSED '+json.dumps(dict(arch=record['arch'],nr=record['nr'],pid=pid,entrySequence=record['sequence'],reason=reason,refusedCaller=refusedCaller),sort_keys=True,separators=(',',':')),file=sys.stderr,flush=True)
            raise ValueError('executable memory policy refused before resume: '+reason)

    def prove_private_anonymous_remap(self,pid,record,*,phase='entry'):
        """Prove + retain one mremap as an exclusive private-anonymous resize.

        Returns the proof dict when EVERY precondition holds, else None. Never
        raises for a failed proof: the caller keeps the original refusal.

        The all-stop is taken ONCE here, but the transaction is not released at
        the syscall entry: the caller installs `exclusive=(pid, entrySequence)`
        and only clears it after the actual syscall EXIT maps are verified, so
        every same-MM peer stays in its tracing stop for the whole kernel call.
        """
        maximum=getattr(self,'maximum_file_bytes',None)
        candidate,reason,geometry=memory_policy.remap_shape(record['arch'],record['nr'],record['args'],maximum)
        if not candidate:return None
        interval=memory_policy.remap_range(geometry['oldAddress'],geometry['oldSize'])
        if interval is None:return None
        low,high=interval
        # A nested enforcement while a barrier is already settling must not
        # re-enter it; the outer pass owns the stop universe. DEFER instead of
        # declining: the entry stays stopped, the barrier completes, and the
        # proof runs unchanged from the quiescent dispatcher. A failed deferred
        # proof still surfaces the ORIGINAL reason, so no admission is gained.
        if getattr(self,'pausing',False):
            # Only an eligible entry may be deferred; if it cannot be queued the
            # caller must fail closed with the ORIGINAL reason.
            if self.defer_mremap_proof(pid,record):return _MREMAP_DEFERRED
            return None
        if getattr(self,'mremap_proof_active',False):return None
        generated=getattr(self,'generated_vma',None)
        if generated is None or getattr(generated,'mm',None) is None:return None
        if getattr(self,'exclusive',None) is not None:return None
        self.mremap_proof_active=True
        try:
            barrier=self.barrier()
            domain,members=generated.mapping_domain(pid,barrier)
            # Unknown peers: every cohort TGID must expose exactly the tracked
            # stopped task set, so no untracked thread can mutate this MM.
            if not self.mremap_cohort_closed(pid,members,barrier):return None
            owner_maps=None;peers=[]
            for member in members:
                captured,mappings=self.tool_maps(member)
                ok,why,covered,executable=memory_policy.cover_nonexec_range(mappings,low,high)
                if not ok:return None
                if member==pid:owner_maps=captured['original']
                else:peers.append(dict(pid=member,original=captured['original']))
            if owner_maps is None:return None
            return dict(phase=phase,barrierSequence=barrier['sequence'],memoryDomain=domain,
                        memoryDomainMembers=members,range=[low,high],oldSize=geometry['oldSize'],
                        newSize=geometry['newSize'],flags=geometry['flags'],
                        mayMove=geometry['mayMove'],coverageComplete=True,executableBytes=0,
                        ownerMaps=owner_maps,cohortMaps=peers)
        finally:
            self.mremap_proof_active=False

    def defer_mremap_proof(self,pid,record):
        """Queue one ELIGIBLE potential mremap for proof after the barrier settles.

        Returns True only when the entry was actually queued. Returns False for
        every ineligible case, and the caller then refuses with the original
        reason (fail closed).

        ORDERING FACT (verified at the call site): `enforce_executable_memory`
        runs at :2777 BEFORE `task['entry']=record` at :2778, so during a barrier
        settle the task's `entry` is still None. The candidate therefore comes
        from `record`, not from `task['entry']`, and the queue pins that exact
        record object plus its sequence. At proof time the two must agree.
        """
        if not self.mremap_proof_eligible(record):return False
        task=self.tasks.get(pid)
        if task is None or task.get('exited') or not task.get('stopped'):return False
        if task.get('entry') is not None and task['entry'].get('sequence')!=record.get('sequence'):return False
        if getattr(self,'mremapDeferred',None) is None:self.mremapDeferred={}
        existing=self.mremapDeferred.get(pid)
        if existing is not None:
            assert existing['entrySequence']==record['sequence'],'two distinct deferred mremap entries for one task'
            return True
        self.mremapDeferred[pid]=dict(entrySequence=record['sequence'],record=record)
        return True

    def mremap_proof_eligible(self,record):
        """Cheap, side-effect-free eligibility gate shared by both paths."""
        maximum=getattr(self,'maximum_file_bytes',None)
        candidate,_reason,_geometry=memory_policy.remap_shape(record['arch'],record['nr'],record['args'],maximum)
        if not candidate:return False
        if memory_policy.remap_range(record['args'][0],record['args'][1]) is None:return False
        generated=getattr(self,'generated_vma',None)
        if generated is None or getattr(generated,'mm',None) is None:return False
        if getattr(self,'exclusive',None) is not None:return False
        return True

    def capture_deferred_mremap(self):
        """Prove one queued entry from the quiescent dispatcher.

        A queue entry that no longer matches the stopped syscall entry is a
        FAIL-CLOSED condition, never a silent drop: dropping could resume an
        unproved mremap entry.
        """
        if not getattr(self,'mremapDeferred',None):return False
        if self.pausing or self.exclusive is not None or getattr(self,'mremap_proof_active',False):return False
        for pid in sorted(self.mremapDeferred):
            pending=self.mremapDeferred[pid]
            task=self.tasks.get(pid)
            if task is None or task.get('exited'):
                del self.mremapDeferred[pid]
                raise ValueError('deferred mremap task vanished before proof')
            if not task.get('stopped'):
                del self.mremapDeferred[pid]
                raise ValueError('deferred mremap task is not stopped before proof')
            entry=task.get('entry')
            record=pending['record']
            if entry is None or entry.get('sequence')!=pending['entrySequence'] or record.get('sequence')!=pending['entrySequence']:
                del self.mremapDeferred[pid]
                raise ValueError('deferred mremap entry changed before proof')
            del self.mremapDeferred[pid]
            proof=self.prove_private_anonymous_remap(pid,record,phase='deferred')
            if proof is None:
                self.emit(dict(kind='executable-memory-refused',model=memory_policy.MODEL,pid=pid,
                               entrySequence=record['sequence'],
                               reason='memory-remap-outside-fixed-executable-mapping-scope'))
                raise ValueError('executable memory policy refused before resume: '
                                 'memory-remap-outside-fixed-executable-mapping-scope')
            self.emit(dict(kind='executable-memory-remap-allowed',model=memory_policy.REMAP_MODEL,
                           pid=pid,entrySequence=record['sequence'],deferred=True,**proof))
            self.tasks[pid]['mremapPending']=dict(entrySequence=record['sequence'],**proof)
            self.exclusive=(pid,record['sequence'])
            self.emit(dict(kind='exclusive-remap-resume',model=memory_policy.REMAP_MODEL,pid=pid,
                           entrySequence=record['sequence'],barrierSequence=proof['barrierSequence'],
                           request='PTRACE_SYSCALL',signal=0))
            return True
        return False

    def mremap_cohort_closed(self,pid,members,barrier):
        """Global all-stop closure PLUS exact same-MM peer ownership.

        `members` is the generated-VMA memory-domain cohort (same CLONE_VM
        domain), NOT every live process: an independent Ninja/clang process has
        its own address space and cannot mutate this MM. The global barrier must
        still cover every live task and every live task must be in a stopped 't'
        state, so no independent process can fork/exec or change mappings while
        we act either.
        """
        if not isinstance(members,(list,tuple)) or not members:return False
        ownership=barrier.get('taskOwnership') or []
        if [row['tid'] for row in ownership]!=list(barrier.get('pids') or []):return False
        live=sorted(p for p,row in self.tasks.items() if not row.get('exited'))
        # Global closure: the barrier covers the entire tracked live universe.
        if list(barrier.get('pids') or [])!=live:return False
        generated=getattr(self,'generated_vma',None);mm=getattr(generated,'mm',None)
        if mm is None:return False
        # Every live task must have a real memory-domain record (cloneVM tracking),
        # so an unmodelled process can never hide inside this phase.
        if sorted(mm.domains)!=live:return False
        domain=mm.domains.get(pid)
        if domain is None:return False
        same=sorted(p for p,value in mm.domains.items() if value==domain)
        if same!=sorted(members):return False
        for member in members:
            row=self.tasks.get(member)
            if row is None or not row.get('stopped') or row.get('exited'):return False
            tgid=row.get('tgid',member)
            try:threads=sorted(int(name) for name in os.listdir('/proc/'+str(tgid)+'/task'))
            except OSError:return False
            known=sorted(p for p,other in self.tasks.items() if not other.get('exited') and other.get('tgid',p)==tgid)
            if threads!=known:return False
        return True

    def mremap_maps(self,pid):
        """One bounded complete /proc/<pid>/maps read, parsed; None on failure."""
        try:
            with open('/proc/'+str(pid)+'/maps','rb') as source:raw=source.read(4*1024**2+1)
        except OSError:return None
        if len(raw)>4*1024**2:return None
        try:return bindings.parse_proc_maps(raw)
        except (ValueError,AssertionError):return None

    def verify_private_anonymous_remap(self,pid,entry,record):
        """Verify the ACTUAL kernel result, then close the exclusive transaction.

        Runs only while every same-MM peer is still stopped: the entry barrier
        plus `exclusive` held them across the whole kernel call. On any doubt the
        assertion fires BEFORE the exclusive slot is released, so the phase ends
        unclosed instead of silently accepted.
        """
        pending=self.tasks[pid].pop('mremapPending',None)
        if pending is None:return None
        assert self.exclusive==(pid,entry['sequence']),'remap exit lacks its exclusive owner'
        assert record['entrySequence']==pending['entrySequence'],'remap exit/entry sequence differs'
        if record['isError'] or not isinstance(record['result'],int) or record['result']<0:
            self.emit(dict(kind='executable-memory-remap-closed',model=memory_policy.REMAP_MODEL,
                           pid=pid,entrySequence=entry['sequence'],exitSequence=record['sequence'],
                           memoryDomain=pending['memoryDomain'],kernelError=record['result']))
            self.exclusive=None
            return None
        low,high=pending['range'];base=record['result']
        assert base>0 and base%4096==0,'remap returned an unaligned base'
        new_high=base+pending['newSize']
        assert new_high<=1<<64,'remap result range overflow'
        barrier=self.barrier()
        owner_maps=None;peers=[]
        for member in pending['memoryDomainMembers']:
            captured,mappings=self.tool_maps(member)
            ok,reason,covered,executable=memory_policy.cover_nonexec_range(mappings,base,new_high)
            assert ok,'remap post-exit destination is not private anonymous non-executable: '+str(reason)
            assert executable==0,'remap post-exit destination contains executable bytes'
            if member==pid:owner_maps=captured['original']
            else:peers.append(dict(pid=member,original=captured['original']))
        assert owner_maps is not None,'remap owner maps missing'
        self.emit(dict(kind='executable-memory-remap-verified',model=memory_policy.REMAP_MODEL,
                       pid=pid,entrySequence=entry['sequence'],exitSequence=record['sequence'],
                       barrierSequence=barrier['sequence'],memoryDomain=pending['memoryDomain'],
                       memoryDomainMembers=pending['memoryDomainMembers'],
                       oldRange=[low,high],newBase=base,newRange=[base,new_high],
                       coverageComplete=True,executableBytes=0,ownerMaps=owner_maps,cohortMaps=peers))
        self.exclusive=None
        return base

    def lifetime_open(self,pid,path):
        """Open the actual lexical target through the tracee's own root.

        Existing process authority must already have sampled this pid. Binding
        the opened root re-validates its six-field identity, so a root swap
        between the authority barrier and this open refuses the lease.
        """
        assert isinstance(path,str) and path.startswith('/') and '\x00' not in path,'absolute actual lexical target required'
        assert pid in self.authority_observed,'lifetime target requires an existing actual process authority sample'
        root=os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        try:
            # The held root must still be the identity captured by process
            # authority; bind() rechecks the full six-field stat of this FD.
            self.authority_handles.bind('root',root)
            # Linux openat2 RESOLVE_IN_ROOT also confines absolute symlink
            # targets. A relative openat alone would still escape via symlinks.
            assert os.uname().machine in ['x86_64','aarch64'],'supported openat2 ABI required'
            how=(ctypes.c_uint64*3)(os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK,0,0x10|0x02)
            libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long
            descriptor=libc.syscall(ctypes.c_long(437),ctypes.c_int(root),ctypes.c_char_p(os.fsencode(path)),ctypes.byref(how),ctypes.c_size_t(ctypes.sizeof(how)))
            if descriptor<0:raise OSError(ctypes.get_errno(),'root-contained lifetime open failed',path)
            return descriptor
        finally:os.close(root)
    def execveat_descriptor_is_image(self,pid,descriptor):
        """Reject an empty-path execveat target that cannot be a regular image."""
        try:
            value=os.stat('/proc/'+str(pid)+'/fd/'+str(descriptor))
            return stat.S_ISREG(value.st_mode) and not descriptor_flags(pid,descriptor)&os.O_PATH
        except (FileNotFoundError,ProcessLookupError):return False
    def lifetime_acquisition(self,pid,lexical,role,entry_sequence,barrier_sequence,*,descriptor=None,depth=0,source='lexical',collected=None):
        """Acquire one actual kernel read lease before the syscall is resumed.

        Every local descriptor is closed in this function; LeaseSet holds its own
        CLOEXEC duplicate, so a tracee FD may later close without ending evidence.
        """
        assert self.lifetime_leases is not None and depth<=LIFETIME_MAXIMUM_DEPTH,'bounded lifetime lease recursion required'
        assert role in ['executable','interpreter','mmap','input-read'],'typed lifetime lease role required'
        local=None
        try:
            try:
                local=os.open('/proc/'+str(pid)+'/fd/'+str(descriptor),os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK) if descriptor is not None else self.lifetime_open(pid,lexical)
            except OSError as error:
                if not expected_oserror(error,LIFETIME_OPEN_ERRORS):raise
                self.tool_unresolved(pid,'toolchain-lease-open-unavailable',role=role,actualPath=lexical[:4096],errorCode=error.errno,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            value=os.fstat(local);ident=probe.identity(value)
            if not stat.S_ISREG(value.st_mode):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role=role,actualPath=lexical[:4096],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            if not fcntl.fcntl(local,fcntl.F_GETFL)&os.O_NONBLOCK:
                self.tool_unresolved(pid,'toolchain-lease-descriptor-flags-differ',role=role,actualPath=lexical[:4096],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,source=source)
                return None
            return self.lifetime_ensure(pid,local,ident,lexical,role,entry_sequence,barrier_sequence,source=source,depth=depth,collected=collected)
        finally:
            if local is not None:os.close(local)
    def lifetime_ensure(self,pid,reader,ident,lexical,role,entry_sequence,barrier_sequence,*,source,depth,collected=None):
        key=tuple(ident[:2]);present=self.lifetime_acquired.get(key)
        if present is not None:
            assert present['identity']==ident,'same leased inode changed identity before reuse'
            self.lifetime_leases.check(present['token'])
            if collected is not None:collected.append(list(ident))
            if role in ['executable','interpreter']:
                interpreter=self.lifetime_classify(reader,ident)
                if interpreter is not None:self.lifetime_interpreter(pid,interpreter,depth+1,entry_sequence,barrier_sequence,collected)
            return self.emit(dict(kind='toolchain-lease-reused',pid=pid,leaseId=present['token']['leaseId'],acquisitionSequence=present['sequence'],identity=ident,entrySequence=entry_sequence,barrierSequence=barrier_sequence,role=role,source=source,scope='same kernel-held read lease token reused; no second acquisition'))
        # Classify before acquiring. An unsupported executable format stays an
        # explicit pending observation and must never receive lease evidence.
        interpreter=None
        if role in ['executable','interpreter']:
            try:interpreter=self.lifetime_classify(reader,ident)
            except ValueError as error:
                self.tool_unresolved(pid,'toolchain-lease-format-unclassified',role=role,actualPath=lexical[:4096],detail=str(error)[:256],entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return None
        token=self.lifetime_leases.acquire(reader)
        assert token['identity']==ident and fcntl.fcntl(reader,fcntl.F_GETLEASE)==fcntl.F_RDLCK,'actual held kernel read lease required before resume'
        captured=self.emit(dict(kind='toolchain-lease-acquired',model=LIFETIME_MODEL,pid=pid,role=role,source=source,identity=ident,actualPath=lexical[:4096],actualPathTruncated=len(lexical)>4096,actualPathSha256=hashlib.sha256(os.fsencode(lexical)).hexdigest(),leaseId=token['leaseId'],entrySequence=entry_sequence,barrierSequence=barrier_sequence,depth=depth,**({'interpreter':interpreter} if interpreter else {})))
        self.lifetime_acquired[key]=dict(token=dict(token),sequence=captured['sequence'],identity=list(ident))
        self.lifetime_by_identity[tuple(ident)]=dict(token=dict(token),sequence=captured['sequence'])
        if collected is not None:collected.append(list(ident))
        if interpreter is not None:self.lifetime_interpreter(pid,interpreter,depth+1,entry_sequence,barrier_sequence,collected)
        return captured
    def lifetime_classify(self,reader,ident):
        """Return the single actual interpreter named by supported image bytes."""
        header=os.pread(reader,4096,0)
        if header.startswith(b'#!'):
            words=header[2:].split(b'\n',1)[0].split()
            interpreter=words[0].decode('utf-8','strict') if words else ''
        elif header.startswith(b'\x7fELF'):
            interpreter=bindings.elf_interpreter(lambda offset,size:os.pread(reader,size,offset),ident[3]).get('interpreter') or ''
        else:raise ValueError('actual image is neither supported ELF64 nor an absolute shebang')
        if interpreter and (not interpreter.startswith('/') or '\x00' in interpreter or len(interpreter.encode())>4096):raise ValueError('absolute bounded interpreter path required')
        return interpreter or None
    def lifetime_interpreter(self,pid,interpreter,depth,entry_sequence,barrier_sequence,collected=None):
        if depth>LIFETIME_MAXIMUM_DEPTH:
            self.tool_unresolved(pid,'toolchain-lease-interpreter-depth-exceeded',role='interpreter',actualPath=interpreter[:4096],entrySequence=entry_sequence,barrierSequence=barrier_sequence);return
        local=None
        try:
            try:local=self.lifetime_open(pid,interpreter)
            except OSError as error:
                if not expected_oserror(error,LIFETIME_OPEN_ERRORS):raise
                self.tool_unresolved(pid,'toolchain-lease-interpreter-open-unavailable',role='interpreter',actualPath=interpreter[:4096],errorCode=error.errno,entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return
            value=os.fstat(local);next_identity=probe.identity(value)
            if not stat.S_ISREG(value.st_mode):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role='interpreter',actualPath=interpreter[:4096],identity=next_identity,entrySequence=entry_sequence,barrierSequence=barrier_sequence)
                return
            self.lifetime_ensure(pid,local,next_identity,interpreter,'interpreter',entry_sequence,barrier_sequence,source='interpreter',depth=depth,collected=collected)
        finally:
            if local is not None:os.close(local)
    def tool_unresolved(self,pid,reason,**fields):
        return self.emit(dict(kind='toolchain-unresolved',pid=pid,reason=reason,**fields))
    def input_read_capture(self,pid,fd,role,form,entry,args,barrier=None):
        """Capture ONE verified regular-input read under an all-stop barrier.

        The whole read family is admitted here, but each ABI form is decoded
        with its OWN operand layout:
          read/readv        -> consumed range starts at the descriptor position
          pread64/preadv*   -> consumed range starts at the explicit offset
          readv/preadv*     -> bounded by SUM(iov_len), never by iovcnt, so a
                               short vector cannot hide unread bytes
        The capture happens at the ENTRY stop (before the kernel consumes) and
        records only the pre-use facts: the protected inode bytes, the requested
        bound, the iovec shape and the exact FD generation. The actual consumed
        range is derived by the replay from the matching real exit result, so
        the observer never asserts a transfer it has not yet seen.

        File bytes are captured ONCE per stable protected inode and reused for
        every later read of the same identity; only the range and the exact
        per-FD-generation proof are recorded per observation.
        """
        # The caller already took the all-stop; reuse THAT barrier so the
        # observation's barrier sequence is the one the replay validated.
        barrier=barrier or self.barrier();self.check()
        path='/proc/'+str(pid)+'/fd/'+str(fd)
        try:reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK)
        except OSError as error:
            if not expected_oserror(error,[errno.EPERM,errno.EACCES,errno.ENOENT,errno.ESRCH]):raise
            self.tool_unresolved(pid,'regular-input-FD-unavailable',role=role,syscall=form['name'],entrySequence=entry['sequence'],errorCode=error.errno)
            return None
        try:
            value=os.fstat(reader);identity=probe.identity(value)
            # RESOLVE the descriptor's REAL target. A tracee that opens
            # /proc/<pid>/fd/<n> (a very common compiler self-reference) is
            # reading the underlying regular file, not a kernel pseudo-file;
            # /proc/self/fd is the observer's own stable handle on that object.
            target=os.readlink('/proc/self/fd/'+str(reader))
            if target!=path:
                self.emit(dict(kind='regular-input-target-resolution',pid=pid,fd=fd,
                    requestedPath=path,resolvedPath=target,identity=identity,
                    mode=value.st_mode,scope='descriptor target resolved through the observer-held FD; not a claim about the pathname'))
            # NON-FILE / PSEUDO-FILE INPUTS. These are NOT file/source inputs and
            # an object kind or path prefix is NOT closure. A positive read is
            # discharged only through an actual verified chain captured here;
            # without one the row is evidence and the replay keeps the obligation
            # open until the exit (and then forever, if the read was positive).
            if (not stat.S_ISREG(value.st_mode)
                    or target.startswith(('/proc/','/sys/','/dev/'))
                    or target.startswith(('pipe:','socket:','anon_inode:'))):
                chain=self.input_nonexec_chain(pid,fd,target,value,form,entry,barrier)
                disposition=self.input_nonregular_disposition(pid,fd,target,value,role,form,entry,barrier,chain)
                self.emit(disposition)
                return None
            if identity[3]>self.maximum_file_bytes:
                self.tool_unresolved(pid,'regular-input-unsupported-or-unbounded',role=role,syscall=form['name'],entrySequence=entry['sequence'],identity=identity,scope='regular bounded input FD required for source-input custody')
                return None
            flags=descriptor_flags(pid,fd)
            if flags&os.O_ACCMODE!=os.O_RDONLY:
                # A writable descriptor is a POTENTIAL WRITER, never an immutable
                # source input. It is still an OBSERVED input operation: record
                # its exact identity/bytes as a typed, NON-creditable disposition
                # so the universe stays complete while the source axis refuses.
                disposition=dict(kind='regular-input-disposition',pid=pid,role=role,
                    syscall=form['name'],form=form['name'],entrySequence=entry['sequence'],
                    barrierSequence=barrier['sequence'],fd=fd,path=path,
                    mode=value.st_mode,inode=value.st_ino,device=value.st_dev,
                    requestedBound=entry['args'][2] if not form['iovec'] else None,
                    disposition='writable-descriptor',dispositionVerified=True,
                    descriptorFlags=flags,
                    scope='actual stopped read on a writable descriptor; a potential writer, never immutable source input')
                self.emit(disposition)
                return None
            if form['iovec']:
                layout=self.input_iovec_layout(pid,args[1],args[2])
                if layout is None:
                    self.tool_unresolved(pid,'regular-input-iovec-layout-unavailable',role=role,syscall=form['name'],entrySequence=entry['sequence'],identity=identity,iovcnt=args[2])
                    return None
                bound=layout['bytes'];iovcnt=args[2];iovLengths=layout['lengths']
            else:
                bound=args[2];iovcnt=None;iovLengths=None
            if not 0<=bound<=self.maximum_file_bytes:
                self.tool_unresolved(pid,'regular-input-requested-bound-invalid',role=role,syscall=form['name'],entrySequence=entry['sequence'],identity=identity,requestedBound=bound)
                return None
            start=args[form['offset']] if form['offset'] is not None else descriptor_position(pid,fd)
            if not 0<=start<=self.maximum_file_bytes:
                self.tool_unresolved(pid,'regular-input-start-offset-invalid',role=role,syscall=form['name'],entrySequence=entry['sequence'],identity=identity,rangeStart=start)
                return None
            generation=self.input_generation_key(pid,fd,identity,flags)
            self.input_generation[(pid,fd)]=generation
            cached=self.input_read_cache.get(tuple(identity))
            if cached is None:
                name=self.next_capture_name();digest=hashlib.sha256();count=0
                with (self.capture_dir/name).open('xb') as output:
                    while True:
                        self.check();block=os.pread(reader,65536,count)
                        if not block:break
                        count+=len(block)
                        if count>self.maximum_file_bytes:raise AssertionError('regular input FD grew beyond bounded capture')
                        digest.update(block)
                        self.claim(len(block),category='capture-body',context=dict(role='input-read',pid=pid,fd=fd,start=count-len(block)))
                        output.write(block)
                    output.flush();os.fsync(output.fileno())
                after=probe.identity(os.fstat(reader))
                if count!=identity[3] or after!=identity:
                    # A partial entity is NOT evidence. Remove it so the next
                    # allocation can never collide with an unreferenced file.
                    try:(self.capture_dir/name).unlink()
                    except FileNotFoundError:pass
                    # The read itself may have advanced mtime/atime or truncated
                    # the object. Only a SHRINK/SIZE/GENUINE-TYPE change makes the
                    # captured bytes untrustworthy; a metadata-only change is
                    # recorded against the exact pre/post pair and is NOT credit.
                    reason=('regular-input-FD-changed-during-capture'
                            if after[:4]!=identity[:4] else 'regular-input-FD-metadata-changed-during-capture')
                    self.tool_unresolved(pid,reason,role=role,syscall=form['name'],
                        entrySequence=entry['sequence'],identity=identity,
                        afterIdentity=after,scope='captured regular input bytes are not credited when the FD identity changed')
                    return None
                reference=dict(path=name,bytes=count,sha256=digest.hexdigest())
                entity=self.register_capture_entity(reference);self.capture_bytes+=count
                captured=self.emit(dict(kind='toolchain-original',captureKind='input-read',
                    observedPath=path,identity=identity,original=reference,
                    originalEntityIdentity=entity,regularInputOriginalModel='once-per-stable-protected-inode-v1'))
                self.append_capture(captured)
                cached=dict(reference=reference,sequence=captured['sequence'],entity=entity)
                leaf_sequence=None
                # REAL IMMUTABILITY. The captured bytes are only usable as an
                # INPUT if this inode cannot be mutated before the kernel executes
                # the traced read. O_RDONLY on the tracee's descriptor prevents
                # only THAT descriptor from writing; a different open file
                # description or another process could still modify the inode.
                # The SAME common LeaseSet used for executable/mmap inputs holds a
                # real kernel read lease (F_RDLCK) on this exact inode, which
                # blocks foreign writers for the whole remaining window. The leaf
                # is emitted LAST, so its registration never changes the inode.
                if self.lifetime_leases is not None:
                    token=self.lifetime_acquisition(pid,path,'input-read',entry['sequence'],
                        barrier['sequence'],descriptor=fd)
                    if token is None:
                        # No proven exclusivity => the bytes must not become a
                        # credited input. Keep the uncredited evidence and drop
                        # the cached reuse so a later read re-tries under a lease.
                        self.tool_unresolved(pid,'regular-input-read-lease-unavailable',role=role,
                            syscall=form['name'],entrySequence=entry['sequence'],identity=identity,
                            scope='regular read input has no held kernel read lease')
                        return None
                    # The ACQUISITION row is the binding: its own emitted
                    # `sequence` is the row number the replay's lease_tokens
                    # entry records, and `leaseId` is the token. No second
                    # capture entity is minted, so the byte entity registered
                    # above stays unique.
                    leaf_sequence=token['sequence']
                    lease_id=token['leaseId']
                    assert token.get('entrySequence')==entry['sequence'],'lease row must bind this exact read entry'
                else:
                    self.tool_unresolved(pid,'regular-input-read-lease-unavailable',role=role,
                        syscall=form['name'],entrySequence=entry['sequence'],identity=identity)
                    return None
                cached['leaseSequence']=leaf_sequence;cached['leaseId']=lease_id
                self.input_read_cache[tuple(identity)]=cached
                original_sequence=captured['sequence'];reused=False
            else:
                # REUSE: identical protected inode only. Re-verify the physical
                # entity before recording a second reference to the same bytes.
                entity=self.verify_capture_entity(cached['reference'])
                if entity!=cached['entity']:
                    self.tool_unresolved(pid,'regular-input-original-entity-changed',role=role,syscall=form['name'],entrySequence=entry['sequence'],identity=identity)
                    return None
                original_sequence=cached['sequence'];reused=True
                # Reuse keeps the ORIGINAL held lease; verify it is still live for
                # this exact inode instead of minting a second token.
                if cached.get('leaseSequence') is None:
                    self.tool_unresolved(pid,'regular-input-read-lease-unavailable',role=role,
                        syscall=form['name'],entrySequence=entry['sequence'],identity=identity)
                    return None
            observation=self.emit(dict(kind='regular-input-observation',pid=pid,role=role,syscall=form['name'],
                form=form['name'],entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],fd=fd,path=path,
                identity=identity,descriptorFlags=flags,generation=generation,
                resolvedPath=target,
                original=cached['reference'],originalSequence=original_sequence,
                readLeaseSequence=cached.get('leaseSequence'),readLeaseId=cached.get('leaseId'),
                rangeStart=start,requestedBound=bound,iovcnt=iovcnt,
                iovLengths=iovLengths,
                reuseModel=('same-protected-inode-exact-fd-generation-v1' if reused else 'canonical-input-original-v1'),
                scope='actual stopped pre-use regular read-family input facts; consumed range and result are derived from the matching real exit'))
            return observation
        finally:os.close(reader)

    def kernel_metadata_original(self,pid,name):
        """Capture ONE kernel-provided process metadata file of the tracee.

        ``mountinfo``/``cgroup`` are generated by the kernel for THIS pid in THIS
        mount namespace. They are not source bytes and are not authority on their
        own: the capture is a bounded byte original that the replay must match
        against a verified same-interval process-authority sample before any read
        of that file can be discharged.
        """
        assert name in ('mountinfo','cgroup'),'unreviewed kernel metadata name'
        path='/proc/'+str(pid)+'/'+name
        fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
        try:
            self.check();data=bytearray()
            while True:
                block=os.read(fd,min(65536,self.tool_metadata_bytes+1-len(data)))
                if not block:break
                data.extend(block)
                assert len(data)<=self.tool_metadata_bytes,'kernel metadata byte bound'
                self.check()
            identity=probe.identity(os.fstat(fd))
        finally:os.close(fd)
        digest=hashlib.sha256(data).hexdigest();key=(pid,name,digest)
        reference=self.tool_provider_cache.get(key)
        if reference is None:
            assert len(self.tool_provider_cache)<self.maximum_processes,'kernel metadata original count bound'
            capture_name=self.next_capture_name()
            with (self.capture_dir/capture_name).open('xb') as output:
                output.write(data);output.flush();os.fsync(output.fileno())
            reference=dict(path=capture_name,bytes=len(data),sha256=digest)
            row=self.emit(dict(kind='toolchain-original',captureKind='kernel-metadata',
                observedPid=pid,kernelMetadataName=name,contentIdentity=identity,original=reference))
            self.append_capture(row);self.capture_bytes+=len(data);self.tool_provider_cache[key]=reference
        return dict(name=name,subjectPid=pid,original=reference,contentIdentity=identity)

    def input_nonregular_disposition(self,pid,fd,path,value,role,form,entry,barrier,chain=None):
        """Typed observation of a read-family entry on a NON-regular object.

        This row is EVIDENCE ONLY. It never discharges the read obligation: the
        matching real exit decides whether anything was consumed, and a positive
        read additionally needs a verified chain (``chain``) built from an actual
        trusted relation — the observer's own startup gate, or a kernel metadata
        original for the SAME subject and namespace. A pipe/socket/any-proc-path
        read without such a chain stays an unresolved input obligation no matter
        what its name or object kind says.
        """
        mode=value.st_mode
        object_kind=('fifo' if stat.S_ISFIFO(mode) else 'socket' if stat.S_ISSOCK(mode)
            else 'character-device' if stat.S_ISCHR(mode) else 'block-device' if stat.S_ISBLK(mode)
            else 'regular' if stat.S_ISREG(mode) else 'other')
        path_class=('pipe' if path.startswith('pipe:') else 'socket' if path.startswith('socket:')
            else 'anon-inode' if path.startswith('anon_inode:')
            else 'proc' if path.startswith('/proc/') else 'sys' if path.startswith('/sys/')
            else 'dev' if path.startswith('/dev/') else 'other')
        row=dict(kind='regular-input-disposition',pid=pid,role=role,syscall=form['name'],
            form=form['name'],entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],
            fd=fd,path=path,mode=mode,inode=value.st_ino,device=value.st_dev,
            requestedBound=entry['args'][2] if not form['iovec'] else None,
            objectKind=object_kind,pathClass=path_class,
            descriptorFlags=descriptor_flags(pid,fd),
            scope='actual stopped non-regular read observation; object kind/name alone grants no credit')
        if chain is not None:row['chain']=chain
        return row

    def input_nonexec_chain(self,pid,fd,target,value,form,entry,barrier):
        """Resolve an ACTUAL trusted relation for a positive non-file read.

        Every admitted relation is built HERE from held observer state or a fresh
        kernel original. Nothing is decided from a path prefix, a name, an object
        kind or a caller-provided flag.

        * ``observer-startup-gate-v1`` — the exact pre-exec pipe the observer
          created for this phase, bound to this root, one released byte.
        * ``kernel-process-metadata-v1`` — ``/proc/<pid>/{mountinfo,cgroup}`` of
          THIS pid, captured under the current all-stop.
        * ``kernel-virtual-fs-metadata-v1`` — a read-only KERNEL-GENERATED
          virtual file (sysfs topology such as ``/sys/devices/system/cpu/online``)
          whose mount is proven by the SAME tracee mountinfo the process-authority
          interval verified: the mount is a known kernel virtual filesystem,
          mounted read-only, the mount id and superblock device of the actually
          opened FD agree with that mount line, and the captured original bytes
          come from that exact FD. A regular file bind-mounted at the same path
          would be on a different filesystem/mount/inode and is REFUSED.
        """
        gate=getattr(self,'current_gate',None)
        if stat.S_ISFIFO(value.st_mode) and gate is not None:
            bound=gate.get('bindings',{}).get(pid);released=gate.get('released')
            if (bound is not None and released is not None
                    and probe.identity(value)==bound['identity']
                    and released['sequence']<entry['sequence']):
                return dict(model='observer-startup-gate-v1',
                    gateSequence=gate['row']['sequence'],bindingSequence=bound['sequence'],
                    releaseSequence=released['sequence'],subjectPid=pid,
                    identity=[str(v) for v in bound['identity']],byteLength=1,
                    byteSha256=hashlib.sha256(b'x').hexdigest(),
                    scope='exact object is the observer-owned pre-exec startup gate for this traced root')
        match=re.fullmatch(r'/proc/([0-9]+)/(mountinfo|cgroup)',target)
        if match is not None and int(match.group(1))==pid:
            name=match.group(2);original=self.kernel_metadata_original(pid,name)
            return dict(model='kernel-process-metadata-v1',subjectPid=pid,
                metadataName=name,subjectOriginal=original['original'],
                contentIdentity=[str(v) for v in original['contentIdentity']],
                scope='kernel-generated metadata of this exact pid, captured under the current all-stop')
        if (stat.S_ISREG(value.st_mode) and target.startswith(('/sys/','/proc/sys/'))
                and not target.startswith('/proc/'+str(pid)+'/')):
            return self.kernel_virtual_fs_chain(pid,fd,target,value,form,entry,barrier)
        return None

    def kernel_virtual_fs_chain(self,pid,fd,target,value,form,entry,barrier):
        """Prove a read-only kernel-generated virtual filesystem file.

        The mount table used is the tracee's own, already verified by the
        process-authority interval; the FD's mount id and the mount line's
        superblock device are cross-checked. Only kernel virtual filesystems are
        admitted, so a bind-mounted regular file can never satisfy this even at
        the same path.
        """
        KERNEL_VIRTUAL_FS={'sysfs'}
        with open('/proc/'+str(pid)+'/mountinfo','rb') as source:
            mountinfo=source.read(self.tool_metadata_bytes+1)
        assert len(mountinfo)<=self.tool_metadata_bytes,'tracee mountinfo byte bound'
        # Longest matching mount for THIS path, exactly like the kernel.
        best=None
        for line in mountinfo.decode('utf-8','strict').splitlines():
            fields=line.split();separator=fields.index('-')
            assert separator>=6 and len(fields)>separator+3,'mountinfo layout'
            mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
            if target==mount or target.startswith(mount.rstrip('/')+'/'):
                if best is None or len(mount)>len(best[1]):best=(fields,mount)
        if best is None:return None
        fields,mount=best
        try:mount_id=int(fields[0])
        except ValueError:return None
        # The FD's OWN kernel mount id (fdinfo) must be that mount: a different
        # mount with the same pathname cannot be substituted.
        info_fd=os.open('/proc/'+str(pid)+'/fdinfo/'+str(fd),os.O_RDONLY|os.O_CLOEXEC)
        try:fdinfo_data=os.pread(info_fd,4096,0)
        finally:os.close(info_fd)
        fd_mount=None
        for line in fdinfo_data.decode('utf-8','replace').splitlines():
            info_key,_,info_value=line.partition(':')
            if info_key.strip()=='mnt_id' and info_value.strip().isdigit():fd_mount=int(info_value.strip())
        if fd_mount!=mount_id:return None
        return dict(model='kernel-virtual-fs-metadata-v1',subjectPid=pid,path=target,
            descriptorMountId=fd_mount,
            mountPoint=mount,mountId=mount_id,mountOptions=fields[5].split(','),
            fstype=fields[fields.index('-')+1],
            superblockOptions=fields[fields.index('-')+3].split(','),
            device=fields[2],
            allowedKernelVirtualFilesystems=sorted(KERNEL_VIRTUAL_FS),
            descriptorFlags=descriptor_flags(pid,fd),
            fileIdentity=[str(v) for v in probe.identity(value)],
            observedAtAllStop=barrier['sequence'],
            scope='read-only kernel-generated virtual filesystem file, proven by the tracee mount table and the opened FD')

    def input_generation_key(self,pid,fd,identity,flags):
        """Exact FD-generation proof: identity + flags + current position.

        A reused descriptor slot after close/reopen normally has a new identity;
        including the position and flags means an old generation's proof can
        never authorise a later one.
        """
        return dict(identity=list(identity),flags=flags,position=descriptor_position(pid,fd))

    def input_iovec_layout(self,pid,address,count):
        """Read the ACTUAL iovec vector: (sum(iov_len), individual lengths).

        Bounded by IOVECTOR_MAXIMUM entries and the fixed 16-byte layout of a
        64-bit {iov_base,iov_len} pair. An unreadable or implausible vector is an
        unresolved input, never a silently smaller bound.
        """
        if not isinstance(count,int) or count<0 or count>IOVECTOR_MAXIMUM:return None
        def word(position):
            raw=int(single.trace(single.PEEKDATA,pid,position)).to_bytes(8,'little',signed=True)
            return int.from_bytes(raw,'little',signed=False)
        lengths=[];total=0
        for index in range(count):
            word(address+index*IOVECTOR_ENTRY_BYTES)      # iov_base: read, not needed
            length=word(address+index*IOVECTOR_ENTRY_BYTES+8)
            if not 0<=length<=self.maximum_file_bytes:return None
            lengths.append(length);total+=length
            if total>self.maximum_file_bytes:return None
        return dict(bytes=total,lengths=lengths)

    def tool_original(self,reader,observed_path):
        before=probe.identity(os.fstat(reader));assert stat.S_ISREG(before[2]) and before[3]<=self.maximum_file_bytes,'bounded regular tool FD required'
        cached=self.tool_original_cache.get(tuple(before))
        if cached:return cached
        name=self.next_capture_name()
        def body():
            offset=0;digest=hashlib.sha256()
            with (self.capture_dir/name).open('xb') as output:
                while True:
                    self.check();block=os.pread(reader,65536,offset)
                    if not block:break
                    offset+=len(block);assert offset<=before[3] and offset<=self.maximum_file_bytes,'tool FD grew during bounded capture'
                    self.claim(len(block),category='capture-body');output.write(block);digest.update(block)
                output.flush();os.fsync(output.fileno())
            assert offset==before[3] and before==probe.identity(os.fstat(reader)),'tool FD changed during capture'
            return dict(path=name,bytes=offset,sha256=digest.hexdigest())
        original=self.read_body(body)
        row=self.emit(dict(kind='toolchain-original',captureKind='file',observedPath=observed_path,identity=before,original=original))
        self.append_capture(row);self.capture_bytes+=original['bytes'];self.tool_original_cache[tuple(before)]=row
        return row
    def tool_mountinfo_original(self,pid,namespace_identity,data):
        digest=hashlib.sha256(data).hexdigest();key=(tuple(namespace_identity),digest)
        reference=self.tool_provider_cache.get(key)
        if reference is None:
            assert len(self.tool_provider_cache)<self.maximum_processes,'actual tool provider original count bound'
            name=self.next_capture_name()
            with (self.capture_dir/name).open('xb') as output:
                for at in range(0,len(data),65536):self.check();block=data[at:at+65536];self.claim(len(block),category='capture-body');output.write(block)
                output.flush();os.fsync(output.fileno())
            reference=dict(path=name,bytes=len(data),sha256=digest)
            capture=self.emit(dict(kind='toolchain-original',captureKind='mountinfo',observedPid=pid,original=reference));self.append_capture(capture);self.capture_bytes+=len(data);self.tool_provider_cache[key]=reference
        return reference
    def capture_process_authority(self,pid,role,event_sequence=None):
        barrier=self.barrier()
        try:mounts,observation=tool_providers.capture_process_authority(pid,self.check,self.tool_metadata_bytes,self.authority_handles)
        except BaseException as error:
            # Parent-visible context only; the sole provider owns actual status
            # originals. Preserve its original failure and never resume here.
            context=dict(kind='process-authority-capture-rejected',pid=pid,role=role,eventSequence=event_sequence,barrierSequence=barrier['sequence'],phase=self.current_phase,exceptionClass=type(error).__name__,authorityVerified=False)
            encoded=json.dumps(context,sort_keys=True);assert len(encoded.encode())<=2048,'authority failure context bound'
            print('SDK_PROCESS_AUTHORITY_REJECTED '+encoded,file=sys.stderr,flush=True)
            raise
        observation['mountinfoOriginal']=self.tool_mountinfo_original(pid,observation['namespaces']['mnt']['identity'],mounts)
        self.authority_observed.add(pid)
        self.emit(dict(kind='toolchain-process-authority',pid=pid,role=role,eventSequence=event_sequence,barrierSequence=barrier['sequence'],observation=observation))
    def capture_exit_authority_at_stop(self,pid,status,event):
        lease=tool_providers.ExitStopAuthorityLease(pid,status,event['exitStatus'],self.check,self.tool_metadata_bytes,self.authority_handles)
        try:
            observation=lease.observation
            observation['authority']['mountinfoOriginal']=self.tool_mountinfo_original(pid,observation['authority']['namespaces']['mnt']['identity'],lease.mounts)
            original=self.emit(dict(kind='toolchain-terminal-authority',pid=pid,eventSequence=event['sequence'],observation=observation))
            self.tasks[pid]['terminalAuthority']=dict(lease=lease,event=event,original=original,closed=False)
        except BaseException:lease.close();raise
    def reap_terminal_task(self,pid,*,allow_pending=False):
        task=self.tasks[pid];terminal=task.get('terminalAuthority')
        assert terminal and terminal['lease'].assert_task_before_wait()=='Z','actual held EXIT task required before terminal wait'
        self.check();assert self.waiter.active,'existing owned wait deadline must be armed';self.waiter.check()
        observed,status=os.waitpid(pid,WALL|os.WNOHANG);self.waiter.check();self.check()
        if allow_pending and observed==0:return False
        assert observed==pid and (os.WIFEXITED(status) or os.WIFSIGNALED(status)) and status==terminal['event']['exitStatus'],'EXIT message lacks matching actual terminal wait'
        self.event(pid,status,False);return True
    def tool_provider(self,pid,reader,actual_path,identity,original,barrier):
        try:data,observation=tool_providers.capture_provider(pid,reader,actual_path,identity,self.check,self.tool_metadata_bytes)
        except tool_providers.ProviderUnavailable as error:
            self.tool_unresolved(pid,'toolchain-effective-readonly-provider-unverified',actualPath=actual_path,barrierSequence=barrier,detail=str(error)[:512]);return None
        reference=self.tool_mountinfo_original(pid,observation['mountNamespaceIdentity'],data)
        observation['mountinfoOriginal']=reference
        return self.emit(dict(kind='toolchain-provider-original',pid=pid,barrierSequence=barrier,fileOriginal=original,observation=observation))['sequence']
    def generated_wait_word(self,pid,address):
        assert sys.byteorder=='little' and single.ctypes.sizeof(single.ctypes.c_long)==8,'reviewed 64-bit little-endian ptrace word required'
        assert type(address) is int and address>0 and address%4==0,'aligned uint32 word required'
        value=single.trace(single.PEEKDATA,pid,address&~7);raw=int(value).to_bytes(8,'little',signed=True);return raw[address%8:address%8+4]
    def content_tool_maps(self,pid):
        """One complete read-only maps observation under a private single frame.

        The frame exists only for the duration of this call, on this thread and
        phase, and is never re-entrant. Inside it, nested ``check()`` calls still
        run budget, waiter, stdio and deadline refusal on every existing call and
        skip only the redundant full lifetime-lease sweep. The frame is closed
        unconditionally, a COMPLETE check runs before any result can escape, and
        emission happens after the frame is gone so it pays its own full sweeps.
        Every fresh read, digest and identity assertion is unchanged.
        """
        assert getattr(self,'owned_maps_frame',None) is None,'owned maps frame is not re-entrant'
        assert not self.read_frame_any(),'maps frame cannot open inside a read body'
        assert getattr(self,'owned_emit_record_frame',None) is None,'maps frame cannot open inside a record callback'
        path='/proc/'+str(pid)+'/maps';name=self.next_capture_name();data=bytearray();digest=hashlib.sha256()
        def identity(value):return [*probe.identity(value),value.st_nlink]
        with open(path,'rb')as source:
            before=identity(os.fstat(source.fileno()));named=identity(os.stat(path,follow_symlinks=False))
            assert stat.S_ISREG(before[2])and before[3]==0 and before[6]==1 and before==named,'actual proc maps descriptor/named identity differs'
            self.check_owned_entry()
            pending=None;failure=None
            frame=(threading.get_ident(),self.current_phase)
            try:
                self.install_owned_maps_frame(frame)
                while True:
                    self.check_deadline();block=source.read(65536)
                    if not block:break
                    assert len(data)+len(block)<=self.tool_metadata_bytes,'bounded actual maps required'
                    data.extend(block);digest.update(block)
                observed=(len(data),digest.hexdigest());after=identity(os.fstat(source.fileno()));assert before==after==identity(os.stat(path,follow_symlinks=False)),'actual complete maps FD changed'
                progress=self.phase_progress()
                if progress is not None:progress.observe_maps_body(observed[0])
                reused=self.prior_content_entity(observed,scope=('maps',));extra={}
                if reused is None:
                    with(self.capture_dir/name).open('xb')as output:
                        for at in range(0,len(data),65536):
                            self.check();block=data[at:at+65536];self.claim(len(block),category='capture-body',context=dict(role='toolchain-original',captureKind='maps',observedPid=pid));output.write(block)
                        output.flush();os.fsync(output.fileno())
                    ref=dict(path=name,bytes=observed[0],sha256=observed[1]);self.capture_bytes+=observed[0]
                else:
                    prior,ref,_=reused;extra['originalReuse']=dict(model='same-phase-maps-content-entity-v1',originCaptureSequence=prior['sequence'])
                assert before==identity(os.fstat(source.fileno()))==identity(os.stat(path,follow_symlinks=False)),'maps FD/named identity changed during physical original verification'
                ref=dict(ref,observationSequence=self.seq+1)
                pending=dict(kind='toolchain-original',captureKind='maps',observedPid=pid,original=ref,mapsWindowIdentity=before,mapsWindowAfterIdentity=after,mapsNamedWindowIdentity=named,mapsNamedWindowAfterIdentity=identity(os.stat(path,follow_symlinks=False)),**extra)
                assert getattr(self,'owned_maps_frame',None) is frame,'maps claim ownership changed'
            except BaseException as error:
                failure=error
            finally:
                # Unconditional reset, then a COMPLETE validation that cannot be
                # suppressed by any frame. A broken lease refuses the result even
                # when the body bytes and digests were complete.
                self.clear_own_maps_frame(frame)
                try:self.check_full()
                except BaseException as error:
                    failure=error if failure is None else failure
            if failure is not None:raise failure
            # Emitted after the frame: emit pays its own full sweeps.
            row=self.emit(pending);self.append_capture(row)
        mappings=bindings.parse_proc_maps(bytes(data));memory_policy.validate_mappings(mappings)
        return row,mappings
    def tool_maps(self,pid):
        if getattr(self,'capture_maps_content_entities',False):return self.content_tool_maps(pid)
        # Read only while all registered potential writers are at OS stops.
        name=self.next_capture_name();data=bytearray()
        def body():
            digest=hashlib.sha256()
            with open('/proc/'+str(pid)+'/maps','rb') as source,(self.capture_dir/name).open('xb') as output:
                while True:
                    self.check();block=source.read(65536)
                    if not block:break
                    assert len(data)+len(block)<=self.tool_metadata_bytes,'bounded actual maps required'
                    self.claim(len(block),category='capture-body');output.write(block);data.extend(block);digest.update(block)
                output.flush();os.fsync(output.fileno())
            return dict(path=name,bytes=len(data),sha256=digest.hexdigest())
        original=self.read_body(body)
        row=self.emit(dict(kind='toolchain-original',captureKind='maps',observedPid=pid,original=original));self.append_capture(row);self.capture_bytes+=len(data)
        mappings=bindings.parse_proc_maps(bytes(data));memory_policy.validate_mappings(mappings)
        return row,mappings
    def tool_mapping(self,pid,mapping,parent,barrier,actual_fd=None,*,required=False,permitted=None):
        common=dict(pid=pid,parentCaptureSequence=parent,barrierSequence=barrier,mapping=mapping,actualFd=actual_fd)
        if mapping['inode']==0 and mapping['path'] in ['[vdso]','[vsyscall]'] and 'x' in mapping['permissions'] and 'w' not in mapping['permissions']:
            return self.emit(dict(kind='toolchain-kernel-executable-mapping',model=memory_policy.MODEL,**common,scope='kernel-provided immutable execution mapping; kernel is controller TCB, not a userspace source archive'))
        if mapping['inode']==0 or not mapping['path'].startswith('/'):
            return self.tool_unresolved(pid,'anonymous-or-kernel-mapping-original-unavailable',**{key:value for key,value in common.items() if key!='pid'})
        path='/proc/'+str(pid)+'/map_files/'+mapping['startHex']+'-'+mapping['endHex']
        held_candidates=[value for identity,value in self.lifetime_by_identity.items() if (os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode'])]
        if len(held_candidates)!=1:
            return self.tool_unresolved(pid,'actual-VMA-has-no-unique-pre-use-held-inode',**{key:value for key,value in common.items() if key!='pid'})
        backing=held_candidates[0]
        reader=self.lifetime_leases.duplicate_reader(backing['token'])
        common['mappingBackingModel']='held-pre-use-lease-v1'
        try:
            identity=probe.identity(os.fstat(reader));assert (os.major(identity[0]),os.minor(identity[0]),identity[1])==(mapping['deviceMajor'],mapping['deviceMinor'],mapping['inode']),'actual map_files FD differs from VMA'
            original=self.tool_original(reader,mapping['path'])
            if actual_fd is not None:
                if actual_fd['identity']!=identity:return self.tool_unresolved(pid,'entry-FD-to-actual-mapped-file-identity-differs',**{key:value for key,value in common.items() if key!='pid'})
            assert identity==probe.identity(os.fstat(reader))==backing['token']['identity'],'actual held mapping inode identity changed'
            self.lifetime_leases.check(backing['token'])
            held=self.lifetime_by_identity.get(tuple(identity))
            if held is not None and (permitted is None or tuple(identity) in permitted):self.lifetime_leases.check(held['token'])
            else:
                held=None
                if required:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='mapping',parentCaptureSequence=parent,actualPath=mapping['path'][:4096],identity=identity,scope='initial exec image backing VMA has no earlier matching pre-use read lease')
            provider=self.tool_provider(pid,reader,mapping['path'],identity,original['original'],barrier)
            row=self.emit(dict(kind='toolchain-mapping-original',**common,identity=identity,original=original['original'],providerSequence=provider,**({'lifetimeLeaseSequence':held['sequence']} if held is not None else {})))
            if held is not None and mapping['permissions'] in ['r-xp','r-xs']:
                self.tasks[pid].setdefault('approvedExecutableMappings',{})[tuple(sorted(mapping.items()))]=row
            return row
        finally:os.close(reader)
    def observe_tool_stop(self,pid,job):
        barrier=self.barrier();self.check();kind,entry,event=job
        if kind=='exec-before':
            self.tasks[pid].pop('toolExecPath',None)
            rules=profile(entry['arch']);args=entry['args'];at=1 if entry['nr']==rules['execveat'] else 0
            lexical=None;raw_path=''
            try:
                raw_path=single.cstring(pid,args[at]) if args[at] else ''
                cwd=os.readlink('/proc/'+str(pid)+'/cwd');base=cwd if at==0 or args[0] in [0xffffffffffffff9c,0xffffff9c,-100] else fdpath(pid,args[0])
                lexical=os.path.normpath(raw_path if raw_path.startswith('/') else base+'/'+raw_path) if raw_path and base else None
                captured=self.emit(dict(kind='toolchain-exec-path-entry',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],syscall=entry['nr'],entryPath=raw_path,lexicalPath=lexical,scope='actual entry-stop string only; actual executable FD is independently captured'))
                self.tasks[pid]['toolExecPath']=captured
            except OSError as error:
                if not expected_oserror(error,[errno.EIO,errno.EFAULT,errno.EPERM,errno.EACCES,errno.ENOENT]):raise
                self.tool_unresolved(pid,'exec-entry-path-original-unavailable',entrySequence=entry['sequence'],errorCode=error.errno)
            except UnicodeError:self.tool_unresolved(pid,'exec-entry-path-non-UTF8',entrySequence=entry['sequence'])
            except ValueError as error:
                if str(error)!='tracee path bound':raise
                self.tool_unresolved(pid,'exec-entry-path-bound',entrySequence=entry['sequence'])
            descriptor=args[0] if entry['nr']==rules['execveat'] and not raw_path and args[0] not in [0xffffffffffffff9c,0xffffff9c,-100] else None
            if descriptor is not None and not self.execveat_descriptor_is_image(pid,descriptor):
                self.tool_unresolved(pid,'toolchain-lease-unsupported-nonregular',role='executable',actualPath='/proc/'+str(pid)+'/fd/'+str(descriptor),entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],source='execveat-fd');descriptor=None;lexical=None
            collected=[]
            if lexical is not None or descriptor is not None:
                # Actual entry-stop target through the tracee root (or its own
                # execveat FD) is leased before this syscall may resume.
                # Authority/lease invariant ValueError and LeaseError both
                # abort; only an ordinary open failure stays explicit pending.
                try:
                    lease=self.lifetime_acquisition(pid,lexical or '/proc/'+str(pid)+'/fd/'+str(descriptor),'executable',entry['sequence'],barrier['sequence'],descriptor=descriptor,source='execveat-fd' if descriptor is not None else 'lexical',collected=collected)
                    if lease is not None:self.tasks[pid]['toolExecLease']=dict(sequence=lease['sequence'],identities=[list(value) for value in collected],entrySequence=entry['sequence'])
                except OSError as error:
                    if not expected_oserror(error,LIFETIME_OPEN_ERRORS):raise
                    self.tool_unresolved(pid,'toolchain-lease-acquisition-failed',role='executable',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],errorClass=type(error).__name__)
            else:self.tool_unresolved(pid,'toolchain-lease-target-unresolved',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],hasRawPath=bool(raw_path))
        elif kind=='exec':
            expected=profile(entry['arch'])['exec'] if entry is not None else []
            if entry is None or entry['nr'] not in expected:
                self.tool_unresolved(pid,'exec-stop-actual-syscall-entry-unavailable',execEventSequence=event['sequence']);return
            path='/proc/'+str(pid)+'/exe'
            try:reader=os.open(path,os.O_RDONLY|os.O_CLOEXEC)
            except OSError as error:
                if not expected_oserror(error,[errno.EPERM,errno.EACCES,errno.ENOENT,errno.ESRCH]):raise
                self.tool_unresolved(pid,'exec-stop-executable-FD-unavailable',execEntrySequence=entry['sequence'],execEventSequence=event['sequence'],errorCode=error.errno);return
            try:
                identity=probe.identity(os.fstat(reader));resolved=os.readlink(path);original=self.tool_original(reader,resolved)
                try:elf=bindings.elf_interpreter(lambda offset,size:os.pread(reader,size,offset),identity[3])
                except ValueError as error:elf=dict(unresolved='actual-ELF-interpreter-unclassified:'+str(error)[:256])
                assert identity==probe.identity(os.fstat(reader))==probe.identity(os.stat(path)),'actual exe FD changed'
                lease=self.tasks[pid].pop('toolExecLease',None)
                permitted={tuple(value) for value in lease['identities']} if lease is not None and lease['entrySequence']==entry['sequence'] else set()
                if tuple(identity) not in permitted:self.tool_unresolved(pid,'toolchain-lifetime-lease-mismatch',role='executable',execEntrySequence=entry['sequence'],actualPath=resolved[:4096],identity=identity,permittedIdentities=[list(value) for value in sorted(permitted)],scope='actual exec image differs from its own pre-resume acquisition chain')
                held=self.lifetime_by_identity.get(tuple(identity))
                if held is not None:self.lifetime_leases.check(held['token'])
                provider=self.tool_provider(pid,reader,resolved,identity,original['original'],barrier['sequence'])
                maps,mappings=self.tool_maps(pid)
                with open('/proc/'+str(pid)+'/personality','rb') as personality_file:personality=personality_file.read(33)
                assert re.fullmatch(rb'[0-9a-f]{8}\n',personality) and not int(personality,16)&0x400000,'READ_IMPLIES_EXEC personality refused before executable resume'
                captured=self.emit(dict(kind='toolchain-exec-image-capture',executionPersonalityRaw=personality.decode('ascii'),pid=pid,barrierSequence=barrier['sequence'],execEntrySequence=entry['sequence'],execEventSequence=event['sequence'],execPathEntrySequence=self.tasks[pid].get('toolExecPath',{}).get('sequence'),exe=dict(lexicalPath=self.tasks[pid].get('toolExecPath',{}).get('lexicalPath'),resolvedPath=resolved,identity=identity,original=original['original'],providerSequence=provider),elf=elf,mapsOriginal=maps['original'],**(dict(lifetimeLeaseSequence=held['sequence'],lifetimeLeaseVerified=tuple(identity) in permitted) if held is not None else {})))
                for mapping in mappings:
                    if mapping['inode'] or 'x' in mapping['permissions']:
                        # Every initial executable/interpreter backing VMA must
                        # match this exec's own pre-resume acquisition chain.
                        self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'],required=True,permitted=permitted)
            finally:os.close(reader)
        elif kind=='protect-before':
            maps,_=self.tool_maps(pid);self.tasks[pid]['toolProtectBefore']=maps['original']
            self.emit(dict(kind='toolchain-executable-protection-before',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],mapsOriginal=maps['original']))
        elif kind=='mmap-before':
            self.tasks[pid].pop('toolMmapLease',None)
            descriptor=entry['args'][4]
            # Only queued for a nonanonymous regular FD; this job must acquire
            # through the tracee's own /proc/PID/fd/N before the kernel maps it.
            lease=self.lifetime_acquisition(pid,fdpath(pid,descriptor) or '/proc/'+str(pid)+'/fd/'+str(descriptor),'mmap',entry['sequence'],barrier['sequence'],descriptor=descriptor,source='descriptor')
            if lease is not None:self.tasks[pid]['toolMmapLease']=dict(sequence=lease['sequence'],identity=lease['identity'],entrySequence=entry['sequence'])
        else:
            maps,mappings=self.tool_maps(pid);args=entry['args']
            if kind=='mmap':
                begin=event['result'];end=begin+args[1];assert 0<=begin<end<=1<<64,'actual mmap returned range overflow';anonymous=bool(args[3]&0x20);fd=self.tasks[pid].pop('toolMmapFd',None)
                if fd is not None:
                    try:
                        reader=os.open('/proc/'+str(pid)+'/fd/'+str(fd['fd']),os.O_RDONLY|os.O_CLOEXEC)
                        try:
                            current=probe.identity(os.fstat(reader))
                            if current==fd['identity'] and stat.S_ISREG(current[2]):fd['original']=self.tool_original(reader,fdpath(pid,fd['fd']))['original']
                            else:self.tool_unresolved(pid,'actual-mmap-FD-changed-or-nonregular',entrySequence=entry['sequence'])
                        finally:os.close(reader)
                    except OSError as error:
                        if not expected_oserror(error,[errno.EPERM,errno.EACCES,errno.ENOENT,errno.ESRCH]):raise
                        self.tool_unresolved(pid,'actual-mmap-FD-original-unavailable',entrySequence=entry['sequence'],errorCode=error.errno)
                lease=self.tasks[pid].pop('toolMmapLease',None)
                if lease is not None and not(anonymous or fd is None or lease['identity']!=fd['identity'] or lease['entrySequence']!=entry['sequence']):
                    self.lifetime_leases.check(self.lifetime_by_identity[tuple(lease['identity'])]['token'])
                else:
                    lease=None
                    if not anonymous and fd is not None:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='mmap',entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],identity=fd.get('identity'),actualPath=fdpath(pid,args[4]),scope='file-backed mmap has no earlier matching pre-use read lease')
                captured=self.emit(dict(kind='toolchain-file-mapping-capture',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],exitSequence=event['sequence'],actualReturnedAddressHex=format(begin,'x'),actualFd=fd,requestedLength=args[1],fileOffset=args[5],flags=args[3],protection=args[2],mapsOriginal=maps['original'],**(dict(lifetimeLeaseSequence=lease['sequence'],lifetimeLeaseIdentity=lease['identity']) if lease is not None else {})))
                selected=[row for row in mappings if int(row['startHex'],16)<end and int(row['endHex'],16)>begin]
                bindings.verify_vma_range(mappings,begin,args[1],args[2])
                if anonymous:self.tool_unresolved(pid,'anonymous-or-JIT-mapping-source-unresolved',parentCaptureSequence=captured['sequence'])
                elif fd is None:self.tool_unresolved(pid,'actual-mapping-entry-FD-unavailable',parentCaptureSequence=captured['sequence'])
                else:
                    assert selected,'successful mmap has no actual VMA'
                    for mapping in selected:
                        if mapping['fileOffset']+max(begin-int(mapping['startHex'],16),0)!=args[5]+max(int(mapping['startHex'],16)-begin,0):
                            self.tool_unresolved(pid,'actual-mmap-VMA-offset-differs',parentCaptureSequence=captured['sequence']);continue
                        self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'],fd)
            else:
                begin,end=args[0],args[0]+args[1];before=self.tasks[pid].pop('toolProtectBefore',None)
                captured=self.emit(dict(kind='toolchain-executable-protection-capture',pid=pid,barrierSequence=barrier['sequence'],entrySequence=entry['sequence'],exitSequence=event['sequence'],actualSyscall=entry['nr'],requestedStartHex=format(begin,'x'),requestedLength=args[1],protection=args[2],beforeMapsOriginal=before,afterMapsOriginal=maps['original']))
                if entry['nr'] in [329,288]:self.tool_unresolved(pid,'toolchain-protection-key-access-state-unverified',parentCaptureSequence=captured['sequence'])
                if before is None:self.tool_unresolved(pid,'executable-protection-before-VMA-unavailable',parentCaptureSequence=captured['sequence'])
                actual_mappings=bindings.verify_vma_range(mappings,begin,args[1],args[2])
                if any(mapping['inode']==0 or not mapping['path'].startswith('/') for mapping in actual_mappings):self.tool_unresolved(pid,'anonymous-or-JIT-mapping-source-unresolved',parentCaptureSequence=captured['sequence'])
                def protected(mapping):
                    try:return self.tool_mapping(pid,mapping,captured['sequence'],barrier['sequence'])
                    except BaseException:
                        # A mapping-original rejection must not hide its own
                        # explicit lifetime fault before this syscall resumes.
                        self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='protected-mapping',parentCaptureSequence=captured['sequence'],actualPath=mapping['path'][:4096],mapping=mapping,scope='executable protection original could not be bound to any earlier pre-use lease')
                        raise
                # mprotect never acquires. Each executable file-backed mapping
                # must carry an earlier full-identity lease, else explicit pending.
                for mapping in actual_mappings:
                    if 'x' not in mapping['permissions'] or mapping['inode']==0 or not mapping['path'].startswith('/'):continue
                    row=protected(mapping)
                    if 'lifetimeLeaseSequence' not in row:self.tool_unresolved(pid,'toolchain-lifetime-lease-unavailable',role='protected-mapping',parentCaptureSequence=captured['sequence'],actualPath=mapping['path'][:4096],mapping=mapping,scope='executable protection has no earlier matching pre-use read lease')
                for mapping in mappings:
                    if int(mapping['startHex'],16)<end and int(mapping['endHex'],16)>begin and mapping not in actual_mappings:protected(mapping)
    def resume(self):
        progress=self.phase_progress()
        if progress is None:return self.resume_original()
        return self.instrument('resume',self.resume_original)
    def resume_original(self):
        assert not self.read_frame_any(),'tracee resume is forbidden inside an owned read-only body'
        assert getattr(self,'owned_emit_record_frame',None) is None,'tracee resume is forbidden inside a record callback'
        if self.generated_vma and getattr(self.generated_vma,'round',None) is not None:return self.generated_vma.drive()
        focus=getattr(self,'terminal_focus',None)
        if focus is not None and self.tasks[focus].get('terminalAuthority',{}).get('closed')and state(focus)=='Z':self.terminal_focus=None
        if getattr(self,'serialize_terminal_syscalls',False)and self.terminal_focus is None and self.exclusive is None:
            def candidates():
                return [(pid,task)for pid,task in self.tasks.items()if not task['exited']and not task.get('terminalAuthority')and task.get('entry')and task['entry']['nr']in bindings.policy(task['entry']['arch'])['exits']]
            if candidates():
                self.barrier()
                pending=candidates();assert pending,'selected exit entry escaped all-stop'
                # Linux thread exit is 93/60; group exit is 94/231. Finish the
                # already stopped individual exits before a sibling can kill
                # their still pending EXIT-event authority boundaries.
                pid,task=min(pending,key=lambda pair:(pair[1]['entry']['nr']in [94,231],pair[0]))
                assert task['stopped']and state(pid)=='t'and not task.get('authorityPending'),'selected terminal task lacks initialized stop'
                self.terminal_focus=pid
        # Snapshot filtered by ALREADY-EXITED rows only. Every guard below is a
        # `continue`; the single branch that does work ends in
        # `if row['stopped'] and not row['exited']`. An exited row can never be
        # resumed, so removing it from the ITERABLE cannot change which pids
        # resume, in what order, or how often. Rows stay in self.tasks: full
        # history, terminal authorities and closed/exited state are untouched.
        # Constant-factor saving only: this snapshot still scans every row.
        for pid,row in [(p,t) for p,t in self.tasks.items() if not t['exited']]:
            if getattr(self,'terminal_focus',None)is not None and pid!=self.terminal_focus and not row.get('terminalAuthority',{}).get('closed'):continue
            if self.generated_vma and self.generated_vma.owner is not None and pid!=self.generated_vma.owner:continue
            if self.exclusive and pid!=self.exclusive[0]:continue
            if row.get('vforkHeldChild') is not None:continue
            if row.get('identityNoopPending') or row.get('clone3Pending') or row.get('btiPending'):continue
            if getattr(self,'mremapDeferred',None) and pid in self.mremapDeferred:continue
            # Never resume a pid whose initial/late authority sample has not been
            # captured yet: the next pending_captures() drains it at this same
            # held stop, so this defers real work instead of rejecting anything.
            if row.get('authorityPending'):continue
            if row['stopped'] and not row['exited']:
                terminal=row.get('terminalAuthority')
                if terminal:
                    assert terminal['closed'],'EXIT task resumed before terminal/peer closure'
                    if state(pid)=='Z':self.reap_terminal_task(pid,allow_pending=getattr(self,'serialize_terminal_syscalls',False));continue
                    signal_value=row.pop('signal',0);assert signal_value==0,'EXIT resume may not inject a signal'
                    single.trace(SYSCALL,pid,0,0);row['stopped']=False
                    terminal['resumed']=self.emit(dict(kind='actual-terminal-exit-resume',pid=pid,originalSequence=terminal['original']['sequence'],closeSequence=terminal['closedRow']['sequence'],request='PTRACE_SYSCALL',signal=0))
                else:
                    single.trace(SYSCALL,pid,0,row.pop('signal',0));row['stopped']=False
    def close_terminal_authorities(self,barrier):
        if not getattr(self,'terminal_exit_evidence',False):return
        for pid,task in list(self.tasks.items()):
            terminal=task.get('terminalAuthority')
            if terminal and not terminal['closed']:
                terminal['closedRow']=self.emit(dict(kind='toolchain-terminal-authority-closed',pid=pid,eventSequence=terminal['event']['sequence'],originalSequence=terminal['original']['sequence'],barrierSequence=barrier['sequence'],actualWaitSequence=task.get('actualWaitSequence')))
                terminal['closed']=True
                if task['exited']:terminal['lease'].close()
    def capture_identity_noop_entry(self,pid,record,status):
        task=self.tasks[pid]
        assert self.exclusive is None and not self.pausing and not task.get('authorityPending'),'identity requires initialized exclusive authority boundary'
        assert task['stopped'] and not task['exited'] and task['entry'] is record,'identity entry changed before its boundary'
        identity_axis=tool_providers.identity_noop_axis(record['arch'],record['nr'])
        barrier=self.barrier()
        transition_type=tool_providers.StoppedIdentityNoopTransition if getattr(self,'verified_identity_noop',False) else tool_providers.StoppedSetresuidTransition
        transition=transition_type(pid,record['arch'],record['nr'],record['args'],self.check,entry_sequence=record['sequence'],barrier_sequence=barrier['sequence'],stopped_wait_status=status)
        task['setresuidTransition']=transition
        try:
            self.emit(dict(kind='identity-noop-entry-original' if getattr(self,'verified_identity_noop',False) else 'setresuid-noop-entry-original',**(dict(identityAxis=identity_axis) if getattr(self,'verified_identity_noop',False) else {}),pid=pid,entrySequence=record['sequence'],barrierSequence=barrier['sequence'],observation=transition.observation))
            self.exclusive=(pid,record['sequence'])
        except BaseException:transition.close();task.pop('setresuidTransition',None);raise
    def capture_queued_identity(self):
        if not getattr(self,'queued_identity_noop',False):return False
        assert self.exclusive is None and not self.pausing,'queued identity requires a quiescent dispatcher'
        for pid,task in self.tasks.items():
            pending=task.get('identityNoopPending')
            if pending and not task['exited'] and not task.get('authorityPending'):
                entry_sequence,status=pending;record=task['entry']
                assert record is not None and record['sequence']==entry_sequence and task['stopped'],'queued identity lost its actual stopped entry'
                self.capture_identity_noop_entry(pid,record,status)
                del task['identityNoopPending']
                return True
        return False
    def checkpoint_append_boundaries(self):
        if not any(task.get('appendBoundary') for task in self.tasks.values()):return
        self.barrier()
        for task in self.tasks.values():
            # A peer may reach its exit while the all-stop barrier is assembled.
            # Preserve the actual causal entry rather than borrowing its later
            # mutable entry slot, which can already be closed at this point.
            boundary=task.pop('appendBoundary',None)
            if boundary is not None:self.checkpoint_appends('syscall-boundary',boundary)
    def bti_held(self,pid,mappings):
        prior=[]
        for mapping in mappings:
            row=self.tasks[pid].get('approvedExecutableMappings',{}).get(tuple(sorted(mapping.items())))
            assert row and row.get('lifetimeLeaseSequence'),'BTI lacks prior exact approved executable VMA'
            held=self.lifetime_by_identity.get(tuple(row['identity']))
            assert held and held['sequence']==row['lifetimeLeaseSequence'],'BTI lost original held backing'
            self.lifetime_leases.check(held['token']);prior.append(row['sequence'])
        return prior
    def capture_bti_pending(self):
        selected=next(((pid,task) for pid,task in self.tasks.items() if task.get('btiPending') and not task['exited']),None)
        if selected is None:return False
        assert self.exclusive is None
        pid,task=selected;barrier=self.barrier();entry=task['entry']
        assert task['stopped'] and state(pid)=='t' and entry['sequence']==task['btiPending']
        page_size=os.sysconf('SC_PAGE_SIZE');maps,mappings=self.tool_maps(pid)
        selected=memory_policy.bti_mappings(entry['arch'],entry['nr'],entry['args'],mappings,page_size)
        prior=self.bti_held(pid,selected)
        original=self.emit(dict(kind='bti-hardening-before',model='held-rx-bti-hardening-v1',pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],pageSize=page_size,mapsOriginal=maps['original'],mappingSequences=prior))
        task['btiOriginal']=(original,selected);del task['btiPending'];self.exclusive=(pid,entry['sequence'])
        return True
    def complete_bti(self,pid,entry,event):
        original,before=self.tasks[pid]['btiOriginal']
        assert self.exclusive==(pid,entry['sequence']) and event['entrySequence']==entry['sequence']
        assert event['isError'] and event['result']<0 or event['isError'] is False and event['result']==0,'BTI exit differs'
        barrier=self.barrier();maps,mappings=self.tool_maps(pid)
        after=memory_policy.bti_mappings(entry['arch'],entry['nr'],entry['args'],mappings,original['pageSize'])
        assert after==before,'BTI changed executable backing/range/offset/permissions'
        assert self.bti_held(pid,after)==original['mappingSequences'],'BTI prior held mappings changed'
        self.emit(dict(kind='bti-hardening-after',model=original['model'],pid=pid,entrySequence=entry['sequence'],exitSequence=event['sequence'],beforeSequence=original['sequence'],barrierSequence=barrier['sequence'],mapsOriginal=maps['original']))
        del self.tasks[pid]['btiOriginal'];self.exclusive=None
    def phase_progress(self):
        progress=getattr(self,'_phase_progress',None)
        if progress is None or progress.deadline!=self.deadline or progress.phase!=self.current_phase:return None
        return progress
    def phase_progress_ns(self,progress):
        try:return int(progress.now()*1e9)
        except BaseException:return None
    # ---- bounded per-owned-window diagnostic -------------------------------
    #
    # Motivation: in the failing run a full lease sweep was entered with only
    # 171.610us of the 1s owned window left, and the retained 8-span ring could not
    # answer "what ran in the first ~790ms of this window". This records a SMALL
    # fixed baseline when a window is armed and reports per-method count/duration
    # DELTAS relative to it while that window is still the active one.
    #
    # Deliberate limits, so the reader cannot over-read the numbers:
    #   * no per-event list, no per-call dict, no extra clock read or syscall on the
    #     hot path: the deltas ride on the counters instrument() already updates;
    #   * the numbers are INCLUSIVE deltas. A parent call that started before the arm
    #     and is still running contributes its pre-arm time to the delta, so this is
    #     never an exclusive per-window decomposition;
    #   * only the innermost method active at arm time is known, so crossedMethods
    #     lists exactly that one name and says so;
    #   * the field is emitted ONLY while the window is genuinely active and its
    #     deadline still matches the recorded one - a closed window, a later phase,
    #     or a deadline mismatch never reports stale data;
    #   * nothing is written to the raw evidence stream;
    #   * a real TimeoutError / KeyboardInterrupt / SystemExit is re-raised
    #     untouched: only ordinary diagnostic-internal faults are suppressed.
    WINDOW_METHOD_KEYS=PHASE_PROGRESS_BUCKETS

    def audit_site(self,state,action,*args,primary=None):
        """An optional diagnostic fault cannot block the original operation."""
        if state is None:return None
        try:return getattr(state,action)(self,*args)
        except (TimeoutError,KeyboardInterrupt,SystemExit):
            if primary is None:raise
            if getattr(self,'_audit_sites',None) is state:self._audit_sites=None
        except BaseException:
            if getattr(self,'_audit_sites',None) is state:self._audit_sites=None
        return None
    def audit_snapshot_check(self,ticket,telemetry):
        self.audit_site(ticket[0],'snapshot_stage',ticket,telemetry)
        return self.check()

    def window_arm(self,deadline_ns):
        """Record a bounded baseline for the window being armed right now.

        Reads no kernel state, takes no lease, checks nothing, and returns nothing.
        A previous baseline is dropped first, so a failed arm cannot leave stale
        data behind for the next window.
        """
        self._window_diag=None;self._audit_sites=None
        try:
            progress=self.phase_progress()
            if progress is None:return None
            baseline={name:tuple(progress.buckets[name]) for name in self.WINDOW_METHOD_KEYS
                      if name in progress.buckets}
            self._window_diag=dict(deadlineNs=int(deadline_ns),
                                   phase=getattr(self,'current_phase',None),
                                   baseline=baseline,
                                   activeAtArm=getattr(progress,'active',None),
                                   armedSeq=getattr(progress,'events',0))
            try:
                active,local,parent=held_owned_window_state(getattr(self,'waiter',None))
                if active and local==int(deadline_ns) and parent is not None and local<parent:
                    self._audit_sites=OwnedWindowAuditSites(self,local,parent)
            except (TimeoutError,KeyboardInterrupt,SystemExit):raise
            except BaseException:self._audit_sites=None # keep the original baseline intact
        except (TimeoutError,KeyboardInterrupt,SystemExit):
            raise                      # an owned deadline must never be hidden here
        except BaseException:
            self._window_diag=None;self._audit_sites=None # ordinary diagnostic fault: stay inert
        return None

    def window_summary(self):
        """Inclusive per-method deltas for the CURRENT armed window, or None.

        Returns None unless the owned window is actually active and its deadline
        still equals the one recorded at arm time, so a closed window, a later
        phase, or a re-armed window can never report stale numbers.
        """
        try:
            diag=getattr(self,'_window_diag',None)
            progress=self.phase_progress()
            if diag is None or progress is None:return None
            active,deadline,_parent=self.owned_window_state()
            if not active or deadline is None:return None
            if getattr(self,'current_phase',None)!=diag.get('phase'):return None
            if int(deadline)!=diag['deadlineNs']:return None   # owned_window_state already returns ns
            rows=[];crossed=[]
            for name in self.WINDOW_METHOD_KEYS:
                base=diag['baseline'].get(name)
                if base is None:continue
                calls,total,maximum=progress.buckets[name]
                dcalls=calls-base[0];dtotal=total-base[1]
                if dcalls==0 and dtotal==0:continue
                rows.append(dict(method=name,calls=dcalls,totalNs=dtotal))
                if name==diag.get('activeAtArm'):crossed.append(name)
            return dict(windowDeadlineNs=diag['deadlineNs'],armedEventCount=diag['armedSeq'],
                        methods=rows,crossedMethods=crossed,
                        knownInnermostAtArm=diag.get('activeAtArm'),
                        semantics=('inclusive deltas since window arm; overlapping and NOT additive. '
                                   'A parent call already running at arm time contributes its pre-arm '
                                   'time, so this is not an exclusive per-window decomposition. '
                                   'Only the innermost active method at arm time is known; enclosing '
                                   'calls that were already running are not separately marked, and '
                                   'Still-running calls enter these buckets only when they complete; '
                                   'their partial duration is not included.'),
                        spanRing='last %d retained spans remain the only per-operation view' % PHASE_PROGRESS_MAXIMUM_SPANS)
        except (TimeoutError,KeyboardInterrupt,SystemExit):
            raise                      # never hide an owned deadline or interpreter exit
        except BaseException:
            return None

    def instrument(self,name,function,*arguments,**keywords):
        """Inclusive duration of one existing call; return/exception identity kept.

        Nested calls are timed independently, so their buckets intentionally
        overlap: barrier/resume/emit/lease work is charged to each bucket.
        """
        progress=self.phase_progress()
        if progress is None:return function(*arguments,**keywords)
        started=self.phase_progress_ns(progress);previous=(progress.active,progress.active_started)
        progress.active=name;progress.active_started=started
        if previous[0] is None:progress.failed=None;progress.failed_started=None
        ticket=None;failure=None
        try:
            sites=getattr(self,'_audit_sites',None)
            if name=='lifetime_lease_check' and sites is not None:ticket=self.audit_site(sites,'native_begin',started)
            return function(*arguments,**keywords)
        except BaseException as error:
            failure=error
            try:
                if progress.failed is None:progress.failed=name;progress.failed_started=started
            except BaseException:pass
            raise
        finally:
            ended=None
            try:
                ended=self.phase_progress_ns(progress)
                if started is not None and ended is not None:progress.record(name,ended-started)
            finally:
                try:
                    if ticket is not None:self.audit_site(ticket[0],'native_end',ticket,ended,failure,primary=sys.exc_info()[1])
                finally:progress.active,progress.active_started=previous
    def owned_window_state(self):
        """Held waiter window metadata only; issues no syscall and never arms.

        Returns (windowActive, deadlineNs, parentDeadlineNs) read from the existing
        BlockingOwnedWait attributes this observer already holds. ``deadline`` is
        the currently armed deadline, which equals ``parent_deadline`` exactly when
        no local mapping window is clamped.
        """
        waiter=getattr(self,'waiter',None)
        if waiter is None:return (False,None,None)
        try:return held_owned_window_state(waiter)
        except BaseException:
            return (False,None,None)
    def instrument_substep(self,name,function,*arguments,**keywords):
        """Inclusive duration of one existing pending_captures sub-step.

        Timing-only: the return value and exception identity are preserved exactly
        as ``instrument`` does, and nothing is published here. An unknown name is
        executed unchanged and NOT recorded, so the fixed tables never grow and no
        runtime assertion is added to a diagnostic path.

        Each observed span is tagged with the owned-window state seen at its START
        and its END. That makes correlation honest: a span whose two tags differ
        crossed the window boundary, and a span tagged inactive was not inside any
        local window. Nothing here infers a window start.
        """
        progress=self.phase_progress()
        if progress is None or name not in PENDING_CAPTURE_SUBSTEPS:
            return function(*arguments,**keywords)
        started=self.phase_progress_ns(progress)
        active_start,deadline_start,parent_start=self.owned_window_state()
        try:return function(*arguments,**keywords)
        finally:
            try:
                ended=self.phase_progress_ns(progress)
                active_end,deadline_end,parent_end=self.owned_window_state()
                if started is not None and ended is not None:
                    progress.record_substep(name,ended-started)
                    progress.record_span(dict(
                        name=name,startNs=str(started),elapsedNs=str(ended-started),
                        windowActiveStart=active_start,windowActiveEnd=active_end,
                        windowDeadlineNsStart=None if deadline_start is None else str(deadline_start),
                        windowDeadlineNsEnd=None if deadline_end is None else str(deadline_end),
                        windowParentNsStart=None if parent_start is None else str(parent_start),
                        windowParentNsEnd=None if parent_end is None else str(parent_end),
                        crossedWindowStart=bool(active_start and not active_end),
                        clampedStart=bool(active_start and parent_start is not None
                                          and deadline_start is not None and deadline_start!=parent_start),
                        clampedEnd=bool(active_end and parent_end is not None
                                        and deadline_end is not None and deadline_end!=parent_end)))
            except BaseException:pass
    def snapshot_due(self):
        progress=self.phase_progress()
        if progress is None:return False
        now=progress.now()
        if now-progress.last_snapshot<PHASE_PROGRESS_INTERVAL:return False
        if progress.snapshots>=PHASE_PROGRESS_MAXIMUM_SNAPSHOTS:return False
        progress.last_snapshot=now;return True
    def phase_progress_payload(self,kind,failure=False):
        progress=getattr(self,'_phase_progress',None)
        now=(progress.now() if progress is not None else time.monotonic());tasks=getattr(self,'tasks',{}) or {}
        state_counts=dict(stopped=0,running=0,exited=0,pending=0)
        try:
            for task in tasks.values():
                if task.get('exited'):state_counts['exited']+=1
                elif task.get('stopped'):state_counts['stopped']+=1
                else:state_counts['running']+=1
                if any(task.get(key) for key in ('clone3Pending','btiPending','capture','identityNoopPending','authorityPending','toolPending')):state_counts['pending']+=1
        except BaseException:pass
        exclusive=getattr(self,'exclusive',None);terminal=getattr(self,'terminal_focus',None)
        generated=getattr(self,'generated_vma',None)
        lifecycle=getattr(self,'lifetime_leases',None)
        def ns(value):return int(value*1e9) if value is not None else None
        started=ns(getattr(progress,'started',None)) if progress is not None else None
        deadline=ns(getattr(progress,'deadline',None)) if progress is not None else None
        now_ns=ns(now)
        window_active,window_deadline,window_parent=self.owned_window_state()
        owned_window=(window_active,
                      None if window_deadline is None else str(window_deadline),
                      None if window_parent is None else str(window_parent))
        # Optional bounded per-window diagnostic. Present only after a window was
        # armed; a failure to build it must never hide the primary diagnostic.
        payload_window=self.window_summary()
        payload=dict(schemaVersion=1,kind=kind,authorityVerified=False,phase=self.current_phase,phaseStartedMonotonicNs=str(started) if started is not None else None,phaseDeadlineMonotonicNs=str(deadline) if deadline is not None else None,nowMonotonicNs=str(now_ns) if now_ns is not None else None,elapsedNs=str(now_ns-started) if now_ns is not None and started is not None else None,remainingNs=str(deadline-now_ns) if deadline is not None and now_ns is not None else None,globalRawSequence=getattr(self,'seq',0),phaseTicks=getattr(progress,'ticks',0) if progress is not None else 0,eventCount=getattr(progress,'events',0) if progress is not None else 0,waitReturnCount=getattr(progress,'waits',0) if progress is not None else 0,lastBoundary=getattr(progress,'last_boundary',None) if progress is not None else None,lastWait=getattr(progress,'last_wait',None) if progress is not None else None,taskCounts=state_counts,exclusiveOwnerPid=exclusive[0] if isinstance(exclusive,tuple) and len(exclusive)==2 else None,exclusiveOwnerSequence=exclusive[1] if isinstance(exclusive,tuple) and len(exclusive)==2 else None,terminalFocusPid=terminal,generatedVmaOwner=getattr(generated,'owner',None) if generated is not None else None,lifetimeLeaseActive=lifecycle is not None,lifetimeLeaseCount=len(lifecycle.fds) if lifecycle is not None else 0,activeInclusiveMethod=getattr(progress,'active',None) if progress is not None else None,activeInclusiveMethodStartedNs=str(getattr(progress,'active_started',None)) if progress is not None and getattr(progress,'active_started',None) is not None else None,lastFailedInclusiveMethod=getattr(progress,'failed',None) if progress is not None else None,lastFailedInclusiveMethodStartedNs=str(getattr(progress,'failed_started',None)) if progress is not None and getattr(progress,'failed_started',None) is not None else None,inclusiveBuckets={name:dict(calls=value[0],totalNs=value[1],maxNs=value[2]) for name,value in (progress.buckets.items() if progress is not None else [])},pendingCaptureSubsteps={name:dict(calls=value[0],totalNs=value[1],maxNs=value[2]) for name,value in (getattr(progress,'substeps',{}) or {}).items()},pendingCaptureSubstepLast=getattr(progress,'substep_last',None),pendingCaptureSpans=list(getattr(progress,'spans',()) or ()),pendingCaptureSpansDropped=getattr(progress,'spans_dropped',0),mapsBodyBytesLast=getattr(progress,'maps_bytes_last',0),mapsBodyBytesMax=getattr(progress,'maps_bytes_max',0),mapsBodyCount=getattr(progress,'maps_bodies',0),syscallStops=getattr(progress,'syscall_summary',lambda:None)() if progress is not None else None,ownedWindowActive=owned_window[0],ownedWindowDeadlineNs=owned_window[1],ownedWindowParentNs=owned_window[2],inclusiveDurationNote='inclusive nested durations; buckets overlap by design; non-additive',failure=bool(failure))
        if payload_window is not None:payload['ownedWindowActivity']=payload_window
        sites=getattr(self,'_audit_sites',None)
        if sites is not None:
            attribution=self.audit_site(sites,'summary',primary=sys.exc_info()[1])
            if attribution is not None:payload['ownedWindowAuditSites']=attribution
        # Out-of-band chunk-store counters for the active/failed snapshot. Bounded
        # scalars only, diagnostics-only, never read by any verifier and never a
        # proof field: presence here grants no authority over captured bytes.
        try:
            snapshot=dict(active=None,completed=None,failed=None)
            active=getattr(self,'snapshot_telemetry',None)
            if active:snapshot['active']=chunk_store.bounded_snapshot_telemetry(active)
            completed=getattr(self,'snapshot_telemetry_completed',None)
            if completed:snapshot['completed']=dict(completed)
            failed=getattr(self,'snapshot_telemetry_failure',None)
            if failed:snapshot['failed']=dict(failed)
            if snapshot['active'] is not None or snapshot['completed'] is not None or snapshot['failed'] is not None:
                snapshot['authority']='diagnostic-only: counters are out-of-band and grant no capture/durability authority'
                payload['snapshotTelemetry']=snapshot
        except BaseException:pass
        return payload
    def publish_phase_progress(self,kind,failure=False):
        """Bounded stderr diagnostic from held state only; never raises.

        The attempt is counted before writing, so a failed write is never
        retried and cannot exceed 32 normal plus at most 1 failure line.
        """
        progress=getattr(self,'_phase_progress',None)
        failure_claimed=False
        try:
            if progress is not None:
                if failure:
                    if progress.failure_snapshots>=1:return
                    progress.failure_snapshots+=1;failure_claimed=True
                else:
                    if progress.snapshots>=PHASE_PROGRESS_MAXIMUM_SNAPSHOTS:return
                    progress.snapshots+=1
            payload=self.phase_progress_payload(kind,failure)
            encoded=json.dumps(payload,sort_keys=True,separators=(',',':'))
            line=(PHASE_PROGRESS_PREFIX+encoded+'\n').encode()
            sidecar=None
            if len(line)>PHASE_PROGRESS_MAXIMUM_BYTES and isinstance(payload,dict) and 'ownedWindowAuditSites' in payload:
                # Restore the ORIGINAL payload before its original histogram
                # fallback. New optional data must never displace an old field.
                payload=dict(payload);attribution=payload.pop('ownedWindowAuditSites')
                encoded=json.dumps(payload,sort_keys=True,separators=(',',':'))
                line=(PHASE_PROGRESS_PREFIX+encoded+'\n').encode()
                if failure_claimed:sidecar=attribution
            if len(line)>PHASE_PROGRESS_MAXIMUM_BYTES and isinstance(payload,dict) and 'syscallStops' in payload:
                # The histogram is OPTIONAL instrumentation. It must never make a
                # diagnostic that was previously valid become unpublishable, so on
                # overflow we drop ONLY this new field and serialize the original
                # old payload again. No old field is removed and the fixed cap is
                # unchanged; a frame that was ALREADY too large still fails the
                # assert below exactly as before.
                fallback=dict(payload)
                fallback.pop('syscallStops',None)
                encoded=json.dumps(fallback,sort_keys=True,separators=(',',':'))
                line=(PHASE_PROGRESS_PREFIX+encoded+'\n').encode()
            assert len(line)<=PHASE_PROGRESS_MAXIMUM_BYTES,'bounded phase progress snapshot line'
            sys.stderr.write(line.decode());sys.stderr.flush()
            if sidecar is not None:
                # Only a successfully claimed original failure attempt permits
                # one extra bounded line; no normal sidecar, retry or new quota.
                line=(AUDIT_SITE_PREFIX+json.dumps(sidecar,sort_keys=True,separators=(',',':'))+'\n').encode()
                if len(line)<=AUDIT_SITE_MAXIMUM_BYTES:
                    sys.stderr.write(line.decode());sys.stderr.flush()
        except BaseException:pass
    def publish_clone3_parse_refusal(self,pid,entry,barrier,size,data,refusal):
        # Exactly the already-read stopped-task struct: no pointer, argv, env or
        # additional /proc access; grants no source, ABI or process authority.
        try:
            bounded=type(data) is bytes and type(size) is int and size in memory_policy.CLONE3_SIZES and len(data)<=size
            complete=bounded and len(data)==size
            payload=dict(kind='clone3-args-parse-refused',schemaVersion=1,model='stopped-clone3-parse-refused-v1',pid=pid,arch=entry['arch'],syscall=entry['nr'],entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],requestedSize=size,capturedLength=len(data) if bounded else None,complete=complete,dataHex=data.hex() if bounded else None,sha256=hashlib.sha256(data).hexdigest() if bounded else None,flagsHex=data[:8][::-1].hex() if bounded and len(data)>=8 else None,refusal=type(refusal).__name__[:64],authorityVerified=False,scope='actual stopped-task clone3 argument bytes already read; strict parse refused; no source, ABI or process authority',phase=self.current_phase)
            encoded=json.dumps(payload,sort_keys=True,separators=(',',':'))
            assert len(encoded.encode())<=1024,'bounded clone3 refusal diagnostic'
            print('SDK_CLONE3_ARGS_PARSE_REFUSED '+encoded,file=sys.stderr,flush=True)
        except BaseException:pass
    def capture_clone3_pending(self):
        selected=next(((pid,task) for pid,task in self.tasks.items() if task.get('clone3Pending') and not task['exited']),None)
        if selected is None:return False
        assert self.exclusive is None
        pid,task=selected;barrier=self.barrier();entry=task['entry']
        assert task['stopped'] and state(pid)=='t' and entry['sequence']==task['clone3Pending'] and entry['nr']==435
        address,size=entry['args'][:2]
        assert type(size) is int and size in memory_policy.CLONE3_SIZES and type(address) is int and 0<address<1<<64 and address+size<1<<64,'bounded clone3 argument range required'
        descriptor=os.open('/proc/'+str(pid)+'/mem',os.O_RDONLY|os.O_CLOEXEC)
        try:data=os.pread(descriptor,size,address)
        finally:os.close(descriptor)
        try:parsed=memory_policy.parse_clone3_original(data,size)
        except ValueError as refusal:
            # Mechanical refusal record for the bytes already read above; the
            # strict parse still refuses with this exact exception object.
            self.publish_clone3_parse_refusal(pid,entry,barrier,size,data,refusal)
            raise
        original=self.emit(dict(kind='kernel-clone3-args-original',model='stopped-clone3-args-v1',pid=pid,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],size=size,dataHex=data.hex(),sha256=hashlib.sha256(data).hexdigest(),flags=parsed['flags'],exitSignal=parsed['exitSignal'],threadMode=parsed.get('thread',False)))
        flags=parsed['flags']|parsed['exitSignal'];bindings.inspect_shared_clone_flags(flags)
        task['observedCloneFlags']=flags;task['cloneFlags']=flags;task['clone3Original']=original
        del task['clone3Pending']
        self.emit(dict(kind='kernel-clone-flags',pid=pid,entrySequence=entry['sequence'],flags=flags,clone3OriginalSequence=original['sequence']))
        self.exclusive=(pid,entry['sequence'])
        self.emit(dict(kind='exclusive-clone3-resume',pid=pid,entrySequence=entry['sequence'],originalSequence=original['sequence']))
        return True
    def complete_clone3_consumption(self,pid,event,*,child=None):
        task=self.tasks[pid];original=task.get('clone3Original')
        if original is None:return
        assert self.exclusive==(pid,original['entrySequence'])
        if child is None:assert event['op']=='exit' and event['entrySequence']==original['entrySequence'] and event['isError'] and event['result']<0,'clone3 success requires actual child event'
        else:
            # Actual kernel event must match the requested clone shape:
            # PTRACE_EVENT_VFORK=2 for CLONE_VFORK, PTRACE_EVENT_CLONE=3 for
            # CLONE_THREAD (ordinary pthread_create), PTRACE_EVENT_FORK=1 else.
            flags=original['flags'];expected=2 if flags&0x4000 else 3 if flags&0x10000 else 1
            assert event['event']==expected,'clone3 child event differs from requested clone flags'
        # Thread mode shares the parent TGID and FD table; the kernel child event
        # and actual /proc TGID are still required to confirm it below.
        self.emit(dict(kind='clone3-arguments-consumed',pid=pid,entrySequence=original['entrySequence'],originalSequence=original['sequence'],eventSequence=event['sequence'],childPid=child))
        task.pop('clone3Original');self.exclusive=None
    def pending_captures(self):
        progress=self.phase_progress()
        if progress is None:return self.pending_captures_original()
        return self.instrument('pending_captures',self.pending_captures_original)
    def pending_captures_original(self):
        if self.generated_vma and getattr(self.generated_vma,'round',None) is not None:return
        if self.exclusive:return
        if getattr(self,'terminal_focus',None)is not None:
            if any(t.get('terminalAuthority')and not t['terminalAuthority']['closed']for t in self.tasks.values()):self.instrument_substep('close_terminal_authorities',self.close_terminal_authorities,self.barrier())
            return
        if self.generated_vma and self.generated_vma.owner is not None:
            pid=self.generated_vma.owner;task=self.tasks[pid]
            if task.get('capture'):
                assert task.pop('capture')==(None,'generated-vma-before'),'unsupported capture while generated mapping dirty'
                capture=self.instrument_substep('generated_vma_capture',self.generated_vma.capture,pid);task['entry']['captureSequence']=capture['sequence'];self.exclusive=(pid,task['entry']['sequence']);self.emit(dict(kind='exclusive-generated-vma-resume',pid=pid,entrySequence=task['entry']['sequence'],captureSequence=capture['sequence']))
            return
        if self.capture_deferred_mremap():return
        # INITIAL/LATE process-authority samples are a PRECONDITION for admitting
        # any syscall from that pid (the consumer's interval requires
        # `pid in samples` before it will replay a syscall row). This drain used
        # to sit AFTER the first `capture_queued_identity` call, which can return
        # early holding an exclusive slot; the pending pid was then resumed and
        # produced a syscall row before its `initial-child` sample existed, which
        # the consumer correctly rejected as "syscall resumed outside live
        # authority boundary". The sample is captured at the SAME already-held
        # stop (capture_process_authority takes its own all-stop barrier), so this
        # is a scheduling move of real evidence, not synthesised data.
        while self.process_authority:
            # `not exited` is tested FIRST: it is a plain field read, while the
            # pending field is an optional lookup. An exited row can never be
            # selected (the predicate requires not-exited either way), so hoisting
            # the guard only short-circuits rows that could not match.
            selected=next(((pid,row) for pid,row in self.tasks.items() if not row['exited'] and row.get('authorityPending')),None)
            if selected is None:break
            pid,task=selected;role,event_sequence=task['authorityPending'].pop(0);self.instrument_substep('capture_process_authority',self.capture_process_authority,pid,role,event_sequence)
        if self.instrument_substep('capture_queued_identity',self.capture_queued_identity):return
        if getattr(self,'terminal_exit_evidence',False) and any(t.get('terminalAuthority') and not t['terminalAuthority']['closed'] for t in self.tasks.values()):
            self.instrument_substep('close_terminal_authorities',self.close_terminal_authorities,self.barrier())
        if self.instrument_substep('capture_queued_identity',self.capture_queued_identity):return
        self.instrument_substep('checkpoint_append_boundaries',self.checkpoint_append_boundaries)
        while self.capture_toolchain:
            selected=next(((pid,row) for pid,row in self.tasks.items() if not row['exited'] and row.get('toolPending')),None)
            if selected is None:break
            pid,task=selected
            self.barrier();self.instrument_substep('checkpoint_appends',self.checkpoint_appends,'toolchain-access',task['entry']['sequence'] if task.get('entry') else None)
            self.instrument_substep('observe_tool_stop',self.observe_tool_stop,pid,task['toolPending'].pop(0))
        if self.instrument_substep('capture_bti_pending',self.capture_bti_pending):return
        if self.instrument_substep('capture_clone3_pending',self.capture_clone3_pending):return
        # All candidate entries encountered while stopping peers are preserved;
        # process each before resuming any potential writer.
        while True:
            candidate=next(((pid,r) for pid,r in self.tasks.items() if not r['exited'] and r.get('capture')),None)
            if not candidate:break
            pid,task=candidate;fd,role=task.pop('capture');
            if role!='writer-before':
                self.instrument_substep('barrier_before_capture',self.barrier);self.instrument_substep('checkpoint_appends',self.checkpoint_appends,'captured-access',task['entry']['sequence'])
            _entry=task.get('entry') or {}
            _read_form=bindings.read_form(_entry.get('arch',0),_entry.get('nr',-1))
            _form=_read_form if role=='input-read' else None
            _citation_role=role
            function,arguments,substep=(self.generated_vma.capture,(pid,),'generated_vma_capture') if role=='generated-vma-before' else \
                (self.capture_rename,(pid,),'capture_rename') if role=='rename-before' else \
                (self.capture_metadata,(pid,),'capture_metadata') if role=='metadata-before' else \
                (self.capture_link_metadata,(pid,),'capture_link_metadata') if role=='link-metadata-before' else \
                (self.capture_write,(pid,fd),'capture_write') if role=='writer-before' else \
                (self.input_read_capture,(pid,fd,role,_form,_entry,_entry.get('args')),'input_read_capture') if role=='input-read' and _form is not None else \
                (self.capture,(pid,fd,role),'capture')
            if role in ('source-read','consumer') and _read_form is not None:
                # ONE REAL READ, TWO OBLIGATIONS. A regular source/dependency or
                # build-root read carries two independent axes:
                #   (a) ROLE EVIDENCE. `source-read` is the only producer of the
                #       source/dependency axis and `consumer` the only producer of
                #       generated-consumer custody, so the role capture must still
                #       be emitted.
                #   (b) COMPLETENESS. R5 requires EVERY read-family entry to be
                #       discharged by a validated `regular-input-observation` plus
                #       its matching real exit; role-only captures leave
                #       `inputComplete=false`, which over-refuses a valid SDK.
                # The observation is taken FIRST because it owns the canonical byte
                # original and the held read lease; the role capture then records
                # its own independently validated row and (under the content-entity
                # model) aliases that same physical original instead of copying it.
                # Neither row is relabelled and neither validator is relaxed.
                observation=self.instrument_substep('input_read_capture',self.input_read_capture,
                    pid,fd,'input-read',_read_form,_entry,_entry.get('args'))
                role_capture=self.instrument_substep(substep,function,*arguments)
                if observation is not None and role_capture is not None and role_capture.get('kind')=='fd-capture':
                    # Cite the observation as the exclusive window's own validated
                    # capture: it is the row the regular-input resume must name.
                    # The role is reported as observed (`input-read`), never
                    # rewritten to the source/consumer label.
                    capture=observation;_form=_read_form;_citation_role='input-read'
                else:
                    # Either the completeness observation was refused (no lease,
                    # writable descriptor, non-regular, unresolvable) -- the
                    # obligation then honestly stays OPEN -- or the role capture is
                    # a NON-plain window (`empty-read-window`, `readwrite-consumer`)
                    # whose own resume/EOF closure must stay authoritative. The role
                    # row is real evidence in both cases and is never relabelled.
                    capture=role_capture
            else:
                capture=self.instrument_substep(substep,function,*arguments)
            if capture is None:
                # capture declined to claim an endpoint (unobserved/out-of-scope target).
                # DRAIN THE REMAINING CANDIDATES before any resume: every peer entry
                # preserved while stopping must be processed first, otherwise
                # resume_original (which resumes all peers when exclusive is None)
                # would let another pending writer run before its entry snapshot.
                # No callee self-requeues (audited), so this loop still terminates.
                task['entry']['captureSequence']=None
                continue
            task['entry']['captureSequence']=capture['sequence'];self.exclusive=(pid,task['entry']['sequence']);self.emit(dict(kind={'generated-vma-operation-window':'exclusive-generated-vma-resume','actual-write-window':'exclusive-write-resume','actual-link-window':'exclusive-link-resume','actual-mode-window':'exclusive-mode-resume','actual-timestamp-window':'exclusive-timestamp-resume','actual-rename-window':'exclusive-rename-resume','empty-read-window':'exclusive-empty-read-resume','alias-close-window':'exclusive-alias-close-resume'}.get(capture['kind'],'exclusive-captured-syscall-resume'),pid=pid,entrySequence=task['entry']['sequence'],captureSequence=capture['sequence'],**({'inputObservationSequence':capture['sequence'],'regularInputRole':_citation_role,'regularInputForm':_form['name']} if _form is not None else {})));break
        if self.exclusive is None:self.instrument_substep('capture_queued_identity',self.capture_queued_identity)
    def release_vfork_parent(self,child,event,reason):
        task=self.tasks[child];parent_pid=task.pop('vforkParent',None)
        if parent_pid is None:return
        parent=self.tasks[parent_pid]
        assert parent.get('vforkHeldChild')==child and parent['stopped'] and not parent['exited'] and state(parent_pid)=='t','actual vfork parent ptrace-stop lost'
        hold=parent.pop('vforkHoldSequence');del parent['vforkHeldChild']
        self.emit(dict(kind='vfork-parent-release',parentPid=parent_pid,childPid=child,holdSequence=hold,releaseSequence=event['sequence'],releaseKind=reason,actualParentState='t'))
    def reject_shared_clone(self,pid,entry,flags):
        # Failure diagnostics only. No FD-table/TGID ownership or closure is
        # inferred from flags, a pathname, or this bounded /proc snapshot.
        with open('/proc/'+str(pid)+'/status','rb') as source:status=source.read(65537)
        assert len(status)<=65536,'bounded clone status original required'
        fields={}
        for line in status.splitlines():
            if b':' in line:
                key,value=line.split(b':',1)
                if key in [b'Pid',b'Tgid',b'PPid',b'TracerPid',b'Threads']:fields[key.decode('ascii')]=int(value.strip())
        assert fields.get('Pid')==pid,'actual clone PID status differs'
        tids=sorted(int(value) for value in os.listdir('/proc/'+str(pid)+'/task'));tracked=sorted(key for key,row in self.tasks.items() if not row['exited'])
        executable=os.readlink('/proc/'+str(pid)+'/exe');identity=probe.identity(os.stat('/proc/'+str(pid)+'/exe'))
        def summary(values):
            digest=hashlib.sha256()
            for value in values:self.check();digest.update((str(value)+'\n').encode())
            return dict(count=len(values),sample=values[:32],truncated=len(values)>32,sha256=digest.hexdigest())
        diagnostic=dict(kind='unsupported-shared-clone-before-resume',pid=pid,entrySequence=entry['sequence'],arch=entry['arch'],syscall=entry['nr'],actualFlags=flags,
            selectedTaskOsState=state(pid),status=fields,taskTids=summary(tids),registeredLivePids=summary(tracked),observerPid=os.getpid(),registeredRootPid=self.root,
            actualProcessGroup=os.getpgid(pid),executablePath=executable[:4096],executablePathTruncated=len(executable)>4096,executablePathSha256=hashlib.sha256(os.fsencode(executable)).hexdigest(),executableIdentity=identity,
            sharedMemory=bool(flags&0x100),sharedFdTable=bool(flags&0x400),sameThreadGroup=bool(flags&0x10000),scope='unsupported clone rejected before syscall resume; diagnostics only, no shared ownership or source authority')
        encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=16384,'bounded shared clone diagnostic'
        row=self.emit(diagnostic);print('SDK_UNSUPPORTED_SHARED_CLONE '+encoded,file=sys.stderr,flush=True)
        raise AssertionError('shared thread/FD-table clone refused before resume; diagnostic sequence '+str(row['sequence']))
    def stopped_executable_diagnostic(self,pid,status,*,descriptor=None):
        # A held executable FD and process starttime bind this selected stopped
        # task independently of its inherited historical exec-event cache.
        assert os.WIFSTOPPED(status) and self.tasks[pid]['stopped'] and not self.tasks[pid]['exited'],'actual stopped selected task required'
        assert descriptor is None or type(descriptor) is int and 0<=descriptor<(1<<31),'bounded selected descriptor required'
        selected='exe' if descriptor is None else 'fd/'+str(descriptor)
        self.check();directory=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        executable=None
        try:
            def starttime():
                self.check();fd=os.open('stat',os.O_RDONLY|os.O_CLOEXEC,dir_fd=directory)
                try:
                    raw=os.read(fd,4097);assert len(raw)<=4096,'bounded process stat'
                    assert os.read(fd,1)==b'','complete process stat'
                finally:os.close(fd)
                tail=raw[raw.rfind(b')')+2:].split();assert len(tail)>=20 and tail[0] in [b't',b'T'],'selected task no longer stopped'
                return int(tail[19])
            def fdinfo():
                self.check();fd=os.open('fdinfo/'+str(descriptor),os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=directory)
                try:
                    raw=os.read(fd,4097);assert len(raw)<=4096 and os.read(fd,1)==b'','bounded complete selected fdinfo'
                finally:os.close(fd)
                fields={}
                for name,base in [('flags',8),('pos',10),('mnt_id',10),('ino',10)]:
                    values=[line.split(b':',1)[1].strip() for line in raw.splitlines() if line.startswith(name.encode()+b':')]
                    assert len(values)==1 and values[0] and all(c in (b'01234567' if base==8 else b'0123456789') for c in values[0]),'unique numeric selected fdinfo required'
                    fields[name]=int(values[0],base)
                return raw,fields
            before=starttime();path=os.readlink(selected,dir_fd=directory)
            info,fields=fdinfo() if descriptor is not None else (None,None)
            executable=os.open(selected,(os.O_RDONLY if descriptor is None else os.O_PATH)|os.O_CLOEXEC,dir_fd=directory)
            identity=probe.identity(os.fstat(executable));assert stat.S_ISREG(identity[2]),'selected executable regular file required'
            self.check();assert identity==probe.identity(os.stat(selected,dir_fd=directory))==probe.identity(os.fstat(executable)),'held executable identity changed'
            assert path==os.readlink(selected,dir_fd=directory) and before==starttime(),'selected task executable/starttime changed'
            assert probe.identity(os.fstat(directory))==probe.identity(os.stat('/proc/'+str(pid))),'selected process directory replaced'
            result=dict(path=path[:512],pathTruncated=len(path)>512,pathSha256=hashlib.sha256(os.fsencode(path)).hexdigest(),identity=identity,processStarttime=before,scope='same stopped task held executable FD identity; diagnostic only, no source authority')
            if descriptor is not None:
                assert (info,fields)==fdinfo(),'selected fdinfo changed during held sample'
                assert fields['ino']==identity[1],'selected fdinfo inode differs'
                assert identity==probe.identity(os.fstat(executable))==probe.identity(os.stat(selected,dir_fd=directory)) and path==os.readlink(selected,dir_fd=directory) and before==starttime(),'selected descriptor or process identity changed after fdinfo'
                result.update(fd=descriptor,flags=fields['flags'],position=fields['pos'],mountId=fields['mnt_id'],fdinfoRaw=info.decode('ascii'),fdinfoSHA256=hashlib.sha256(info).hexdigest(),scope='same selected ptrace-stop held descriptor numeric metadata only; no body read or output/source authority')
                producer=self.producers.get(tuple(identity[:2]))
                if producer and probe.identity(os.fstat(producer[1]))==identity and producer[0].get('identity')==identity:
                    result['trackedProducerAssociation']=dict(captureSequence=producer[0]['sequence'],identity=identity,scope='existing retained producer FD identity match only; not mapping allowance')
                else:result['trackedProducerAssociationPending']='no-exact-current-retained-producer-identity'
                if path.startswith(self.build+'/') and not path.endswith(' (deleted)'):result['buildRelativePath']=os.path.relpath(path,self.build)
            return result
        finally:
            if executable is not None:os.close(executable)
            os.close(directory)
    def syscall_rejection_diagnostic(self,pid,status,entry,*,authority=False,shared_mapping=False):
        # Numeric kernel-entry arguments only: never dereference user pointers,
        # collect argv/environment, or resume a forbidden operation for diagnosis.
        args=entry['args'];assert isinstance(args,list) and len(args)==6 and all(type(value) is int and 0<=value<(1<<64) for value in args),'bounded actual syscall argument words required'
        assert type(shared_mapping) is bool and not(authority and shared_mapping),'one fixed syscall rejection category required'
        kind,pending,prefix=('process-authority-syscall-before-resume','process-authority-syscall-refused','SDK_PROCESS_AUTHORITY_SYSCALL_REJECTED ') if authority else ('shared-writable-mapping-before-resume','shared-writable-mapping-refused','SDK_SHARED_WRITABLE_MAPPING_REJECTED ') if shared_mapping else ('unsupported-asynchronous-external-writer-before-resume','unsupported-asynchronous-external-writer-syscall','SDK_UNSUPPORTED_WRITER_SYSCALL ')
        task=self.tasks[pid]
        diagnostic=dict(kind=kind,pid=pid,tid=pid,tgid=task.get('tgid'),arch=entry['arch'],syscall=entry['nr'],args=args,entrySequence=entry['sequence'],phase=self.current_phase,waitStatus=status,stopSignal=os.WSTOPSIG(status),ptraceEvent=status>>16,registeredStopped=task['stopped'],registeredExited=task['exited'],registeredRootPid=self.root,observerPid=os.getpid(),authorityVerified=False,pending=pending,scope='actual kernel syscall-entry numeric words only; refused before resume; no source or process authority')
        if task.get('diagnosticExec'):
            actual=dict(task['diagnosticExec']);path=actual['path'];actual.update(path=path[:512],pathTruncated=actual.get('pathTruncated',False) or len(path)>512)
            diagnostic['actualExecImage']=actual
        else:diagnostic['actualExecImagePending']='selected-exec-stop-original-unavailable'
        try:diagnostic['selectedStoppedExecutable']=self.stopped_executable_diagnostic(pid,status)
        except BaseException as error:diagnostic['selectedStoppedExecutablePending']=type(error).__name__[:128]
        if shared_mapping:
            if args[3]&0x20:diagnostic['selectedMappingFdPending']='actual-MAP_ANONYMOUS-flag-no-file-descriptor-sample'
            elif args[4]>=(1<<31):diagnostic['selectedMappingFdPending']='actual-fd-word-outside-nonnegative-int-range'
            else:
                try:diagnostic['selectedMappingFd']=self.stopped_executable_diagnostic(pid,status,descriptor=args[4])
                except BaseException as error:diagnostic['selectedMappingFdPending']=type(error).__name__[:128]
        encoded=json.dumps(diagnostic,sort_keys=True);assert len(encoded.encode())<=(12288 if shared_mapping else 4096),'bounded forbidden syscall diagnostic'
        print(prefix+encoded,file=sys.stderr,flush=True)
        return self.emit(diagnostic)
    def reject_forbidden_syscall(self,pid,status,entry):
        row=self.syscall_rejection_diagnostic(pid,status,entry)
        raise AssertionError('unsupported asynchronous/external writer syscall; diagnostic sequence '+str(row['sequence']))
    def event(self,pid,status,allow_capture=True):
        progress=self.phase_progress()
        if progress is None:return self.event_original(pid,status,allow_capture)
        try:
            progress.events+=1
        except BaseException:pass
        return self.instrument('event',self.event_original,pid,status,allow_capture)
    def event_original(self,pid,status,allow_capture=True):
        if pid not in self.tasks:
            assert os.WIFSTOPPED(status) and status>>16==128,'unregistered non-child tracee event'
            tracer=[line.split()[1] for line in Path('/proc',str(pid),'status').read_text().splitlines() if line.startswith('TracerPid:')]
            assert tracer==[str(os.getpid())] and pid not in self.unknown_stops,'unknown observer-owned stop identity'
            self.unknown_stops[pid]=status;return
        task=self.tasks[pid]
        if task.get('setresuidTransition'):
            assert os.WIFSTOPPED(status) and status>>16==0 and os.WSTOPSIG(status)==(signal.SIGTRAP|0x80),'setresuid transition lost its actual syscall exit stop'
        if task.get('deniedIoUring'):
            assert os.WIFSTOPPED(status) and status>>16==0 and os.WSTOPSIG(status)==(signal.SIGTRAP|0x80),'explicitly denied syscall lost its actual exit stop'
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            if getattr(self,'terminal_focus',None)==pid:self.terminal_focus=None
            # A task that disappears while an absent-operand marker is still
            # unresolved never produced the required failing syscall exit, so the
            # observation is unproven and must fail closed. The kernel reaping and
            # cleanup state below is preserved exactly: the task is still marked
            # exited and its wait record is still emitted, so no dead task is left
            # looking live merely because the proof failed.
            pending_absent=task.pop('absentLinkOperand',None)
            task.update(exited=True,stopped=False);code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
            wait=self.emit(dict(kind='actual-wait-exit',pid=pid,returnCode=code,**(dict(waitStatus=status) if getattr(self,'terminal_exit_evidence',False) else {}),**({'actualExecImage':task['diagnosticExec']} if 'diagnosticExec' in task else {})));self.wait_references.append(dict(pid=pid,sequence=wait['sequence'],returnCode=code,phase=self.current_phase))
            task['actualWaitSequence']=wait['sequence']
            terminal=task.get('terminalAuthority')
            if terminal and terminal['closed']:terminal['lease'].close()
            self.release_vfork_parent(pid,wait,'actual-terminal-wait')
            if pid==self.root:self.root_code=code
            assert pending_absent is None,'absent operand marker unresolved at terminal exit without the required failing syscall exit'
            return
        assert os.WIFSTOPPED(status);task['stopped']=True;event=status>>16;sig=os.WSTOPSIG(status)
        if event:
            extra={}
            if self.process_authority and event==6 and getattr(self,'terminal_exit_evidence',False):
                message=ctypes.c_ulong();single.trace(GETEVENTMSG,pid,0,ctypes.byref(message));extra=dict(waitStatus=status,exitStatus=int(message.value))
            observed_event=self.emit(dict(kind='ptrace-event',pid=pid,event=event,**extra))
            if extra:self.capture_exit_authority_at_stop(pid,status,observed_event)
            if self.process_authority and event in [4,6] and not extra:task.setdefault('authorityPending',[]).append(('exec-stop' if event==4 else 'exit-stop',observed_event['sequence']))
            if event==4:
                actual_exe=os.readlink('/proc/'+str(pid)+'/exe');actual_identity=probe.identity(os.stat('/proc/'+str(pid)+'/exe'))
                task['diagnosticExec']=dict(path=actual_exe[:4096],pathTruncated=len(actual_exe)>4096,pathSha256=hashlib.sha256(os.fsencode(actual_exe)).hexdigest(),identity=actual_identity,eventSequence=observed_event['sequence'],entrySequence=task.get('entry',{}).get('sequence'),scope='actual exec-stop image only; argv/environment not collected')
            if event==4 and self.shared_tasks:
                prior=task['fdTable'];task['fdTable']=-observed_event['sequence'];self.emit(dict(kind='actual-exec-fd-table-unshare',pid=pid,eventSequence=observed_event['sequence'],priorFdTable=prior,fdTable=task['fdTable'],tgid=task['tgid']))
            if event==4:self.release_vfork_parent(pid,observed_event,'actual-exec')
            if event==4 and self.capture_toolchain:task.setdefault('toolPending',[]).append(('exec',task.get('entry'),observed_event))
            if event in [1,2,3]:
                child=ctypes.c_ulong();single.trace(GETEVENTMSG,pid,0,ctypes.byref(child));new=int(child.value);assert new not in self.tasks and len(self.tasks)<self.maximum_processes,'actual child/PID bound'
                fields={}
                if self.shared_tasks:
                    entry=task['entry'];assert entry is not None,'actual child lacks syscall entry'
                    if entry['nr'] in [profile(entry['arch'])['clone'],profile(entry['arch'])['clone3']]:flags=task['cloneFlags']
                    else:
                        assert entry['arch']==0xc000003e and entry['nr'] in [57,58],'unknown actual fork operation';flags=17|(0x4100 if entry['nr']==58 else 0)
                    ownership=bindings.inspect_shared_clone_flags(flags);tgid=task['tgid'] if ownership['sameThreadGroup'] else new;table=task['fdTable'] if ownership['sharedFdTable'] else new
                    assert self.actual_tgid(new)==tgid,'kernel child TGID differs from clone flags';fields=dict(tgid=tgid,fdTable=table)
                self.tasks[new]=dict(stopped=False,exited=False,entry=None,initial=True,**(dict(authorityPending=[('initial-child',None)]) if self.process_authority else {}),**fields);self.emit(dict(kind='actual-child-binding',parentPid=pid,childPid=new,event=event,**(dict(cloneEntrySequence=task['entry']['sequence'],cloneFlags=flags,**fields) if self.shared_tasks else {})))
                # The kernel child event establishes inherited executable memory;
                # it is not a new exec-stop or a current named-file observation.
                # Keep only the immediate inheritance edge, so clone depth cannot
                # enlarge a bounded failure diagnostic indefinitely.
                if task.get('diagnosticExec'):
                    inherited=dict(task['diagnosticExec'])
                    inherited.update(inheritedFromPid=pid,inheritanceEventSequence=observed_event['sequence'],inheritanceEvent=event,scope='kernel child-event inherited prior exec-stop image; not current executable-file verification; argv/environment not collected')
                    self.tasks[new]['diagnosticExec']=inherited
                if event==2:
                    if not self.shared_tasks:
                        entry=task['entry'];flags=task['observedCloneFlags'] if entry['nr'] in [profile(entry['arch'])['clone'],profile(entry['arch'])['clone3']] else 0x4111
                    assert flags&0x4000 and task.get('vforkHeldChild') is None and task['stopped'] and state(pid)=='t','actual VFORK event/parent stop required'
                    hold=self.emit(dict(kind='vfork-parent-held',parentPid=pid,childPid=new,eventSequence=observed_event['sequence'],entrySequence=task['entry']['sequence'],actualParentState='t'))
                    task.update(vforkHeldChild=new,vforkHoldSequence=hold['sequence']);self.tasks[new]['vforkParent']=pid
                self.complete_clone3_consumption(pid,observed_event,child=new)
                if new in self.unknown_stops:self.event(new,self.unknown_stops.pop(new),False)
            elif event not in [4,5,6,128]:raise ValueError('unsupported ptrace event')
            return
        if sig!=(signal.SIGTRAP|0x80):
            # SIGCHLD delivery is recorded then suppressed; actual wait syscalls
            # still report every child. Other signals are fail-closed.
            assert sig==signal.SIGCHLD,'unexpected tracee signal';task['signal']=sig;self.emit(dict(kind='signal-delivery',pid=pid,signal=sig));return
        kernel,_=single.syscall(pid);policy=profile(kernel['arch'])
        if kernel['op']=='exit' and task['entry'] is not None:kernel['entrySequence']=task['entry']['sequence']
        _kernel_row=dict(kind='kernel-syscall',pid=pid,**kernel,**(dict(waitStatus=status) if getattr(self,'verified_setresuid_noop',False) or getattr(self,'verified_identity_noop',False) else {}))
        _phase_progress=self.phase_progress()
        if _phase_progress is not None:_phase_progress.observe_syscall(_kernel_row)
        # ADVANCE ANY WITNESSED OWNED TRANSITION **BEFORE** THIS EMIT.
        # `emit` runs a full lease sweep, and for a rename exit the kernel has
        # already moved ctime on BOTH affected inodes. A frozen PRE token would
        # therefore latch here -- before `complete_rename` is ever reached -- which
        # is exactly the observed failure. The retained FDs held in the rename
        # window make the real post-state available at this point, so this is the
        # earliest correct place. Only a SUCCESSFUL exit is advanced; a failed or
        # unknown exit is left alone and fails closed in `complete_rename`.
        try:
            # Advance AND emit share one boundary: the identity refusal can be
            # raised by either, so both must be inside the recording scope.
            if (getattr(self,'lifetime_leases',None) is not None
                    and _kernel_row.get('op')=='exit'
                    and not _kernel_row.get('isError') and _kernel_row.get('result')==0):
                self.advance_pending_owned_transitions(pid,_kernel_row)
            record=self.emit(_kernel_row)
        except BaseException:
            try:self.record_failed_kernel_stop(pid,_kernel_row,task)
            except BaseException:pass  # diagnostic faults never replace the original
            raise
        if record['op']=='entry':
            if self.capture_toolchain and record['nr']!=435 and not memory_policy.bti_candidate(record['arch'],record['nr'],record['args']):self.enforce_executable_memory(pid,record)
            assert task['entry'] is None,'syscall entry missing prior exit';task['initial']=False;task['entry']=record;nr=record['nr'];args=record['args']
            identity_axis=tool_providers.identity_noop_axis(kernel['arch'],nr)
            if self.process_authority and ((getattr(self,'verified_identity_noop',False) and identity_axis is not None) or (getattr(self,'verified_setresuid_noop',False) and identity_axis=='Uid')):
                assert self.exclusive is None,'identity entry crossed an active exclusive operation'
                if getattr(self,'queued_identity_noop',False) and (self.pausing or task.get('authorityPending')):
                    assert task['stopped'] and not task.get('identityNoopPending'),'duplicate or nonstopped queued identity entry'
                    task['identityNoopPending']=(record['sequence'],status)
                    return
                self.capture_identity_noop_entry(pid,record,status)
                return
            if nr==425 and getattr(self,'deny_optional_io_uring',False):
                executable=self.stopped_executable_diagnostic(pid,status)
                registers=single.deny_io_uring_setup(pid,kernel['arch'],nr,model='explicit-kernel-enosys-denial-v2') if getattr(self,'io_uring_enosys_v2',False) else single.deny_io_uring_setup(pid,kernel['arch'],nr)
                denied=self.emit(dict(kind='explicit-io-uring-setup-denied',pid=pid,entrySequence=record['sequence'],arch=kernel['arch'],args=args,waitStatus=status,executable=executable,**registers))
                task['deniedIoUring']=denied
                return
            if nr in policy['forbidden']:self.reject_forbidden_syscall(pid,status,record)
            if self.process_authority:
                try:tool_providers.verify_authority_syscall(kernel['arch'],nr,args)
                except BaseException:
                    try:self.syscall_rejection_diagnostic(pid,status,record,authority=True)
                    except BaseException as diagnostic_error:
                        # Preserve the original policy rejection even if the
                        # existing raw ledger/deadline refuses a diagnostic row.
                        try:print('SDK_PROCESS_AUTHORITY_SYSCALL_DIAGNOSTIC_UNAVAILABLE '+type(diagnostic_error).__name__[:128],file=sys.stderr,flush=True)
                        except BaseException:pass
                    raise
            if self.generated_vma and self.generated_vma.classify(pid,record,lambda dirfd,address:path_argument(pid,dirfd,address)):return
            if self.capture_toolchain and memory_policy.bti_candidate(record['arch'],nr,args):
                task['btiPending']=record['sequence'];return
            if nr==435 and self.capture_toolchain:
                assert self.shared_tasks,'clone3 original requires complete tracked task ownership'
                task['clone3Pending']=record['sequence']
                return
            if nr in [policy['clone'],policy['clone3']]:
                flags=args[0] if nr==policy['clone'] else single.trace(2,pid,args[0])&((1<<64)-1)
                # The executable-memory clone-shape policy applies only to the
                # toolchain-capture path; the generic observer path keeps its
                # original behaviour (shared-task flag checks only, below).
                if self.capture_toolchain:
                    shape=memory_policy.classify_clone(flags)
                    if not shape['thread'] and not shape['vfork']:
                        assert not flags&0x400,'executable memory policy requires independent FD tables for a non-thread clone'
                task['observedCloneFlags']=flags
                if self.shared_tasks:bindings.inspect_shared_clone_flags(flags);task['cloneFlags']=flags
                elif flags&(0x10000|0x400):self.reject_shared_clone(pid,record,flags)
                if not self.shared_tasks:assert flags&~(0xff|0x100|0x4000|0x1000000|0x200000|0x100000000)==0,'unknown clone flags refused'
                self.emit(dict(kind='kernel-clone-flags',pid=pid,entrySequence=record['sequence'],flags=flags))
            if self.shared_tasks:
                assert not(nr==436 and args[2]&2),'close_range UNSHARE FD ownership unsupported'
                execs=[59,322] if kernel['arch']==0xc000003e else [221,281]
                if nr in execs:assert pid==task['tgid'],'nonleader exec TID replacement unsupported before resume'
            if self.append_chains and bindings.append_boundary_syscall(kernel['arch'],nr,args):task['appendBoundary']=record['sequence']
            if nr==policy['read']:
                try:read_identity=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(args[0])))
                except FileNotFoundError:read_identity=None
                if read_identity and tuple(read_identity[:2]) in self.append_chains:task['appendBoundary']=record['sequence']
            if nr==policy['mmap'] and args[2]&2 and args[3]&1:
                try:self.syscall_rejection_diagnostic(pid,status,record,shared_mapping=True)
                except BaseException:pass
                raise AssertionError('shared writable mapping refused before resume')
            if self.capture_toolchain and nr in policy['exec']:task.pop('toolExecLease',None);task.setdefault('toolPending',[]).append(('exec-before',record,None))
            if self.capture_toolchain and nr in policy['protect'] and args[2]&4:task.setdefault('toolPending',[]).append(('protect-before',record,None))
            if self.capture_toolchain and nr==policy['mmap']:task.pop('toolMmapFd',None);task.pop('toolMmapLease',None)
            if self.capture_toolchain and nr==policy['mmap'] and not(args[3]&0x20) and args[4]<(1<<31):
                try:task['toolMmapFd']=dict(fd=args[4],identity=probe.identity(os.stat('/proc/'+str(pid)+'/fd/'+str(args[4]))))
                except FileNotFoundError:task['toolMmapFd']=None
                if task['toolMmapFd'] and stat.S_ISREG(task['toolMmapFd']['identity'][2]):task.setdefault('toolPending',[]).append(('mmap-before',record,None))
            selected=None;fd=None
            if nr in [policy['read'],policy['write'],policy['close']] or nr in policy.get('reads',set()):fd=args[0];selected=fdpath(pid,fd)
            if nr==policy['mmap'] and args[4]<(1<<31):fd=args[4];selected=fdpath(pid,fd)
            if nr in policy.get('reads',set()):
                # EVERY read-family entry becomes an obligation, even when the
                # descriptor is not a regular file (pipe/socket/procfs) or its
                # path cannot be resolved. The dedicated capture method records
                # either real bytes or an exact declared disposition; silence is
                # what caused the missing-input over-credit.
                #
                # ROLE SELECTION MUST STILL HAPPEN. `policy['reads']` CONTAINS
                # `policy['read']` on both reviewed architectures, so guarding
                # the whole read family with this branch alone would make the
                # role decision unreachable and downgrade every regular source
                # and build-root read to `input-read` (no `source-read`
                # fd-capture, hence no source/dependency axis). The completeness
                # obligation is preserved: every read-family form still gets a
                # capture, and `input-read` remains the fallback whenever the
                # descriptor is not a resolvable regular file.
                try:item=os.stat('/proc/'+str(pid)+'/fd/'+str(fd))
                except FileNotFoundError:item=None
                task['capture']=(fd,read_capture_role(selected,item,self.source,self.build))
            elif selected:
                try:item=os.stat('/proc/'+str(pid)+'/fd/'+str(fd))
                except FileNotFoundError:item=None
                if item and stat.S_ISREG(item.st_mode):
                    if nr==policy['write'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE==os.O_RDWR:task['capture']=(fd,'writer-before')
                    elif nr==policy['close'] and selected.startswith(self.build+'/') and descriptor_flags(pid,fd)&os.O_ACCMODE in [os.O_WRONLY,os.O_RDWR]:task['capture']=(fd,'producer-close')
                    elif nr==policy['mmap'] and selected.startswith(self.build+'/') and (self.selected_names is None or Path(selected).name in self.selected_names):self.emit(dict(kind='generated-mmap-unverified',pid=pid,path=selected,entrySequence=record['sequence']))
                    # No read-role branch belongs here: the complete read family
                    # is routed by the `reads` branch above, which is a strict
                    # superset of `read_form` on both reviewed architectures.
            if nr==TIMESTAMP_SYSCALLS[kernel['arch']] and args[3]==0:
                # flags==0 only. NOTHING is resolved or stat'ed here: the build-root
                # decision and every namespace/memory read happen at the fresh
                # all-stop in capture_metadata, where /proc/<pid>/fd and /proc/<pid>/cwd
                # are stable. The entry contributes only the raw operand addresses.
                task['metadataPath']=dict(model=TIMESTAMP_MODEL,
                    form=('fd' if args[1]==0 else 'path'),dirfd=args[0],
                    pathAddress=args[1],timesAddress=args[2],flags=args[3],
                    entryNr=nr,entryArch=kernel['arch'])
                task['capture']=(None,'metadata-before')
            link_form=link_metadata_form(kernel['arch'],nr)
            if link_form is not None:
                # EXACT per-form operand layout on the reviewed ABIs:
                #   link(oldpath, newpath)                    : args[0]=old, args[1]=new, no dirfd
                #   linkat(olddirfd, oldpath, newdirfd, newpath, flags) : args[0..4]
                #   unlink(path)                              : args[0]=path, no dirfd
                #   unlinkat(dirfd, path, flags)              : args[0]=dirfd,args[1]=path,args[2]=flags
                # Nothing is read from tracee memory here; the args carry raw addresses.
                if link_form=='link':
                    operands=dict(newDirfd=None,newPathAddress=args[1],
                                  oldDirfd=None,oldPathAddress=args[0],flags=0)
                elif link_form=='linkat':
                    operands=dict(newDirfd=args[2],newPathAddress=args[3],
                                  oldDirfd=args[0],oldPathAddress=args[1],flags=args[4])
                elif link_form=='unlink':
                    operands=dict(newDirfd=None,newPathAddress=args[0],
                                  oldDirfd=None,oldPathAddress=None,flags=0)
                else:  # unlinkat
                    operands=dict(newDirfd=args[0],newPathAddress=args[1],
                                  oldDirfd=None,oldPathAddress=None,flags=args[2])
                task['linkMetadata']=dict(model=LINK_MODEL,form=link_form,entryNr=nr,
                                          entryArch=kernel['arch'],**operands)
                task['capture']=(None,'link-metadata-before')
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
                if old and new and old.startswith(self.build+'/') and new.startswith(self.build+'/'):
                    try:rename_source=os.stat(old,follow_symlinks=False)
                    except FileNotFoundError:rename_source=None
                    if rename_source and ((rename_source.st_dev,rename_source.st_ino) in self.producers or self.generated_vma and self.generated_vma.model==generated_vma_module.PARKED_WAIT_MODEL and (rename_source.st_dev,rename_source.st_ino) in self.generated_vma.checkpoints):
                        assert nr!=policy.get('renameat2') or args[4]==0,'retained renameat2 flags unsupported'
                        task['capture']=(None,'rename-before')
        else:
            old=task['entry']
            if old is None:assert task['initial'],'orphan syscall exit';task['initial']=False;return
            record['entrySequence']=old['sequence'];task['entry']=None
            # Settle an entry-observed absent operand against the MATCHING real exit
            # FIRST, before any early return can bypass it. Absence at entry says
            # nothing about the kernel's actual result: a peer may have created the
            # name while the tracee was stopped, so a success here would be an
            # unproven metadata effect and must fail closed.
            absent=task.pop('absentLinkOperand',None)
            if absent is not None:self.settle_absent_link_operand(pid,absent,old,record)
            self.complete_clone3_consumption(pid,record)
            if task.get('btiOriginal'):
                self.complete_bti(pid,old,record);return
            if self.generated_vma and pid in self.generated_vma.pending:
                self.instrument_substep('generated_vma_finish',self.generated_vma.finish,pid,old,record);self.emit(dict(kind='exclusive-captured-syscall-exit',pid=pid,entrySequence=old['sequence'],result=record['result'],isError=record['isError']));self.exclusive=None;return
            if task.get('mremapPending'):
                # Proven private-anonymous resize: verify the ACTUAL kernel result
                # against fresh maps before anything else consumes this exit.
                self.instrument_substep('generated_vma_remap',self.verify_private_anonymous_remap,pid,old,record)
            transition=task.pop('setresuidTransition',None)
            if transition is not None:
                try:
                    assert self.exclusive==(pid,old['sequence']) and record['isError'] is False and type(record['result']) is int and record['result']==0,'setresuid requires actual exclusive successful syscall exit'
                    barrier=self.barrier()
                    observation=transition.finish(exit_sequence=record['sequence'],barrier_sequence=barrier['sequence'],stopped_wait_status=status,result=record['result'])
                    self.emit(dict(kind='identity-noop-exit-original' if getattr(self,'verified_identity_noop',False) else 'setresuid-noop-exit-original',**(dict(identityAxis=transition.axis) if getattr(self,'verified_identity_noop',False) else {}),pid=pid,entrySequence=old['sequence'],exitSequence=record['sequence'],barrierSequence=barrier['sequence'],observation=observation))
                    self.exclusive=None
                finally:transition.close()
                return
            denied=task.pop('deniedIoUring',None)
            if denied is not None:
                assert old['nr']==425 and record['arch']==old['arch'] and record['isError'] is True and record['result']==-bindings.DENIED_IO_URING_ERRNO,'explicit denial lacks actual kernel ENOSYS exit'
                current=self.stopped_executable_diagnostic(pid,status)
                assert current==denied['executable'],'explicit denial task/executable changed'
                self.emit(dict(kind='explicit-io-uring-setup-denied-exit',pid=pid,entrySequence=old['sequence'],denialSequence=denied['sequence'],exitSequence=record['sequence'],result=record['result'],isError=record['isError'],executable=current))
                return
            alias_close=task.pop('aliasCloseWindow',None)
            if alias_close is not None:
                window,held=alias_close
                try:
                    assert self.exclusive==(pid,old['sequence']) and not record['isError'] and record['result']==0,'alias close did not actually complete'
                    identity=probe.identity(os.fstat(held));assert identity[:2]==window['identity'][:2],'alias close retained a different inode'
                    absent=[]
                    for owner in window['tableOwners']:
                        try:os.stat('/proc/'+str(owner)+'/fd/'+str(window['fd']))
                        except FileNotFoundError:absent.append(dict(tid=owner,fd=window['fd'],errorCode=errno.ENOENT))
                        else:raise AssertionError('closed descriptor slot still exists in shared table')
                    self.emit(dict(kind='alias-close-exit',pid=pid,entrySequence=old['sequence'],windowSequence=window['sequence'],exitSequence=record['sequence'],retainedIdentity=identity,slotAbsences=absent,result=record['result'],isError=record['isError']))
                finally:os.close(held);self.retained.remove(held)
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
            if self.capture_toolchain:
                rules=profile(old['arch'])
                if record['isError']:
                    if old['nr']==rules['mmap']:task.pop('toolMmapFd',None);task.pop('toolMmapLease',None)
                    if old['nr'] in rules['protect']:task.pop('toolProtectBefore',None)
                    if old['nr'] in rules['exec']:task.pop('toolExecPath',None);task.pop('toolExecLease',None)
                if not record['isError'] and record['result']>=0 and old['nr']==rules['mmap'] and (not(old['args'][3]&0x20) or old['args'][2]&4):task.setdefault('toolPending',[]).append(('mmap',old,record))
                if not record['isError'] and record['result']==0 and old['nr'] in rules['protect'] and old['args'][2]&4:task.setdefault('toolPending',[]).append(('protect-after',old,record))
            if task.get('renameWindow') is not None:self.complete_rename(pid,old,record)
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
        self.reset_owned_frames()
        capture_start=len(self.captures);started_ns=time.time_ns();stdout_path=Path(stdoutPath) if stdoutPath is not None else self.out/(name+'.stdout.raw');stderr_path=Path(stderrPath) if stderrPath is not None else self.out/(name+'.stderr.raw')
        self.wait_references=[];self.tasks={};self.unknown_stops={};self.root_code=None;self.current_phase=name;self._phase_progress=PhaseProgress(name,self.deadline);self.raw=EncodedShardedRaw(self,name,self.shard_bytes or self.maximum_file_bytes) if self.compressed_raw else ShardedRaw(self.out,name,self.shard_bytes) if self.shard_bytes else open(self.out/(name+'.syscalls.original.jsonl'),'xb')
        self.raw_encoder=probe.IndexedRawEncoderV2() if self.indexed_raw_records else None
        if not self.prepared_sealed:
            try:
                self.seal_prepared_dependency_sources()
                self.seal_prepared_build_inputs()
            except BaseException:
                self.raw_bytes_completed+=self.raw.tell();self.raw.close();self.close();raise
        ready_read,ready_write=os.pipe() if self.process_authority else (None,None)
        read_fd,write_fd=os.pipe();stdout_read,stdout_write=os.pipe();stderr_read,stderr_write=os.pipe()
        # TRUSTED STARTUP CONTROL GATE. The observer creates this pipe itself and
        # later writes exactly one byte; the child blocks on it before exec. The
        # gate row records the observer-owned pipe identity and the exact byte so
        # a tracee read of THIS object can be bound to the observer's own action
        # instead of being credited from a pipe path prefix. A later read of any
        # other pipe has no such relation and remains an unresolved obligation.
        gate_identity=probe.identity(os.fstat(read_fd))
        gate=dict(kind='toolchain-control-gate',model='observer-owned-startup-gate-v1',phase=name,
            targetPid=None,readEndFd=read_fd,writeEndFd=write_fd,
            identity=gate_identity,byteLength=1,byteSha256=hashlib.sha256(b'x').hexdigest())
        gate=self.emit(gate)
        self.current_gate=dict(row=gate,bindings={},released=None)
        child=os.fork()
        if child==0:
            stage='setup'
            try:
                os.close(write_fd);os.close(stdout_read);os.close(stderr_read)
                close_child_observer_retained(self.retained)
                if self.process_authority:
                    stage='authority';os.close(ready_read);tool_providers.restrict_child_authority();os.write(ready_write,b'R');os.close(ready_write)
                stage='release';assert os.read(read_fd,1)==b'x';os.close(read_fd)
                stage='stdio';os.dup2(stdout_write,1);os.dup2(stderr_write,2);os.close(stdout_write);os.close(stderr_write)
                stage='chdir';os.chdir(cwd if cwd is not None else self.source)
                stage='exec';os.execve(actual_executable(command),command,env if env is not None else {'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':str(self.out),'TMPDIR':str(self.out)})
            except BaseException as failure:
                # OPAQUE child-setup diagnostic: fixed stage name + exception
                # CLASS + numeric errno ONLY. Deliberately excludes the
                # exception text, argv, env, paths and any token/secret. Exit
                # status and control flow are unchanged (still 70).
                code = getattr(failure,'errno',None)
                code = code if type(code) is int else -1
                try:
                    os.write(2,b'SDK_CHILD_SETUP_FAILED stage='+stage.encode('ascii')+
                             b' type='+type(failure).__name__.encode('ascii','replace')[:48]+
                             b' errno='+str(code).encode('ascii')+b'\n')
                except BaseException:
                    pass
                os._exit(70)
        os.close(stdout_write);os.close(stderr_write);self.pump_errors=[]
        pumps=[BoundedPipePump(stdout_read,stdout_path,self.maximum_stdio_bytes,lambda count:self.claim(count,category='stdio'),self.pump_errors),BoundedPipePump(stderr_read,stderr_path,self.maximum_stdio_bytes,lambda count:self.claim(count,category='stdio'),self.pump_errors)]
        root_pgid=os.getpgid(child);self.root=child;self.tasks[child]=dict(stopped=False,exited=False,entry=None,initial=True,**(dict(authorityPending=[('initial-root',None)]) if self.process_authority else {}),**(dict(tgid=child,fdTable=child) if self.shared_tasks else {}))
        try:
            # Created only here, in the parent after fork: the child must never
            # inherit a lease FD or SIGIO ownership.
            if self.capture_toolchain:self.lifetime_leases=self.lifetime_leases_class()
            # LEASES ARE PER-PHASE. The cache and the FD-generation map are keyed
            # by inode, so carrying them across phases would let a later phase
            # cite a token that the previous phase already closed. Reset them
            # exactly where a fresh LeaseSet is created.
            self.input_read_cache={};self.input_generation={}
            self.lifetime_phase=name;self.lifetime_acquired={};self.lifetime_by_identity={};self.authority_observed=set()
            os.close(read_fd)
            for pump in pumps:pump.start()
            if self.process_authority:
                os.close(ready_write);ready_write=None;self.check();remaining=max(0,self.deadline-time.monotonic());readable,_,_=select.select([ready_read],[],[],remaining);self.check();assert readable and os.read(ready_read,1)==b'R','child authority setup did not complete before release';os.close(ready_read);ready_read=None
            self.emit(dict(kind='owned-root-binding',pid=child,command=command,**(dict(toolchainLifetimeModel=LIFETIME_MODEL,executableMemoryPolicy=memory_policy.MODEL,clone3ArgsModel='stopped-clone3-args-v1',btiHardeningModel='held-rx-bti-hardening-v1',**(dict(remapCapabilityModel=memory_policy.REMAP_MODEL) if self.generated_vma else {})) if self.capture_toolchain else {}),**(dict(rawRecordModel=probe.RAW_RECORD_MODEL_V2)if self.indexed_raw_records else {}),backend='ptrace-all-stop-process-v1',**(dict(chunkOriginalStorageModel='chunk-original-v1') if self.capture_content_entities else {}),captureOriginalEntityModel='same-phase-content-entity-v2' if self.capture_content_entities else 'same-phase-producer-original-v1',**(dict(mapsOriginalEntityModel='same-phase-maps-content-entity-v1')if getattr(self,'capture_maps_content_entities',False)else {}),**(dict(generatedVmaModel=self.generated_vma.model,**(dict(generatedVmaMetadataModel=generated_vma_module.RETAINED_METADATA_MODEL)if getattr(self,'retained_generated_metadata',False)else {}),generatedVmaBuildRoot=self.build,generatedVmaParentDeadlineMonotonicNs=str(int(self.waiter.parent_deadline*1e9))) if self.generated_vma else {}),**(dict(stoppedWriterAliasModel='all-stop-exclusive-write-aliases-v1') if getattr(self,'stopped_writer_aliases',False) else {}),**(dict(optionalIoUringModel='explicit-kernel-enosys-denial-v2' if getattr(self,'io_uring_enosys_v2',False) else 'explicit-kernel-enosys-denial-v1') if self.deny_optional_io_uring else {}),**(dict(setresuidNoopModel='actual-stopped-setresuid-noop-v1') if self.verified_setresuid_noop else {}),**(dict(setresIdentityNoopModel='actual-stopped-setres-identity-noop-queued-v2' if getattr(self,'queued_identity_noop',False) else 'actual-stopped-setres-identity-noop-v1') if getattr(self,'verified_identity_noop',False) else {}),**(dict(processAuthorityModel=tool_providers.AUTHORITY_MODEL) if self.process_authority else {}),**(dict(exitAuthorityModel='actual-selected-exit-stop-held-terminal-peers-v2'if getattr(self,'serialize_terminal_syscalls',False)else 'actual-selected-exit-stop-before-peer-barrier-v1') if getattr(self,'terminal_exit_evidence',False) else {}),**(dict(taskOwnershipModel='all-tracked-tids-shared-fd-v1',tgid=child,fdTable=child) if self.shared_tasks else {})));single.trace(SEIZE,child,0,OPTIONS);single.trace(INTERRUPT,child);pid,status=self.wait_one();self.event(pid,status,False);self.pending_captures()
            binding=self.emit(dict(kind='toolchain-control-gate-binding',model='observer-owned-startup-gate-v1',
                gateSequence=gate['sequence'],pid=child,identity=gate_identity,
                scope='the observer, not the tracee, owns the write end of this exact pipe inode'))
            self.current_gate['bindings'][child]=dict(sequence=binding['sequence'],identity=gate_identity)
            os.write(write_fd,b'x')
            released=self.emit(dict(kind='toolchain-control-gate-release',model='observer-owned-startup-gate-v1',
                gateSequence=gate['sequence'],pid=child,identity=gate_identity,
                byteLength=1,byteSha256=hashlib.sha256(b'x').hexdigest(),
                scope='the single gate byte was written by the observer after the traced root stopped'))
            self.current_gate['released']=dict(sequence=released['sequence'],identity=gate_identity)
            os.close(write_fd);write_fd=None;self.resume()
            while any(not r['exited'] for r in self.tasks.values()):
                progress=self._phase_progress;progress.ticks+=1
                pid,status=self.wait_one();self.event(pid,status);self.pending_captures();self.resume()
                if self.snapshot_due():self.publish_phase_progress('phase-progress')
            assert getattr(self,'terminal_focus',None)is None,'serialized terminal wait did not close'
            assert not any(task.get('vforkHeldChild') is not None for task in self.tasks.values()),'vfork child release/wait closure missing'
            if self.generated_vma:self.generated_vma.complete_phase()
            self.checkpoint_appends('phase-final')
            # Exact boundary: every tracked wait is closed; closures follow.
            self.complete_lifetime_leases()
            for pump in pumps:pump.finish(self.check)
            if self.require_success:assert self.root_code==0,'actual observed root did not exit successfully'
            completed_ns=time.time_ns()
            summary=dict(schemaVersion=1,kind='owned-multiprocess-all-stop-CMake-diagnostic',command=command,actualRootPid=child,actualRootReturnCode=self.root_code,actualTrackedPids=sorted(self.tasks),allTrackedWaitsClosed=all(r['exited'] for r in self.tasks.values()),backend='ptrace-all-stop-process-v1',scope='tracked process wait/FD-byte observations only; shared threads/FD tables/async writers unsupported')
            probe.jsonfile(self.out/(name+'.receipt.json'),summary)
            self.raw.flush()
            if isinstance(self.raw,EncodedShardedRaw):self.raw.finish()
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
                rawTraceShards=[dict(original(path),wire=self.raw.references[str(path)]) for path in self.raw.paths] if isinstance(self.raw,EncodedShardedRaw) else [original(path) for path in self.raw.paths] if isinstance(self.raw,ShardedRaw) else [original(Path(self.raw.name))],
                captureFiles=self.phase_capture_files(capture_start),
                observedToolFiles=self.observed_tool_files(capture_start,name))
        finally:
            primary=sys.exc_info()[1]
            # Exactly one failure snapshot from held state; never self.check after
            # expiry and never let diagnostic failure replace the primary error.
            if primary is not None:
                # One-shot, out-of-band lease failure diagnostic. Fatal path only:
                # it runs because the phase is already raising, so it cannot alter
                # admission. Emission is bounded (<=8192 bytes), goes to stderr only,
                # never enters the raw stream, and every failure inside it is
                # swallowed so the ORIGINAL exception object still propagates.
                if not getattr(self,'lease_failure_diagnostic_emitted',False):
                    self.lease_failure_diagnostic_emitted=True
                    try:
                        leases=getattr(self,'lifetime_leases',None)
                        if leases is not None and getattr(leases,'_failure',None):
                            # Pass the EXISTING phase deadline; never extend it.
                            # ONE formatter mechanism: the decisive stop is passed
                            # into the product formatter so its existing shrink loop
                            # budgets it together with the rows. The stop is never a
                            # lease row and is never popped, so it cannot be lost.
                            text=leases.failure_diagnostic(deadline=getattr(self,'deadline',None),
                                                           fatal_stop=getattr(self,'fatal_stop',None))
                            if text is not None and len(text.encode())<=8192:
                                sys.stderr.write('SDK_READ_LEASE_FATAL '+text+'\n')
                                sys.stderr.flush()
                    except BaseException:
                        pass
                progress=getattr(self,'_phase_progress',None)
                if progress is not None and progress.failure_snapshots<1:self.publish_phase_progress('phase-failure',failure=True)
            for control_fd in [ready_read,ready_write]:
                if control_fd is not None:os.close(control_fd)
            if write_fd is not None:os.close(write_fd)
            for pid,row in self.tasks.items():
                if not row['exited']:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
            self.close_outer_lease_window()
            leases=self.lifetime_leases
            if leases is not None:
                try:leases.close()
                except BaseException:
                    if primary is None:raise
                finally:self.lifetime_leases=None
            self.raw_bytes_completed+=self.raw.tell();self.raw.close()
    def complete_lifetime_leases(self):
        """Require and emit only real closed lease tokens after all waits."""
        leases=self.lifetime_leases
        if leases is None:return None
        assert all(row['exited'] for row in self.tasks.values()),'lifetime lease closure before allTrackedWaitsClosed'
        closed_pids=sorted(pid for pid,row in self.tasks.items() if row['exited'])
        tokens=leases.complete()
        acquired={row['token']['leaseId']:row['sequence'] for row in self.lifetime_acquired.values()}
        assert set(acquired)=={token['leaseId'] for token in tokens} and sorted(acquired)==[token['leaseId'] for token in tokens],'lease tokens/acquisitions differ'
        # Each token and closed PID remains explicit, in bounded rows; never
        # expand the existing 64 KiB raw-record limit for a large phase.
        digest=hashlib.sha256()
        for token in tokens:
            value=dict(leaseId=token['leaseId'],identity=token['identity'],acquisitionSequence=acquired[token['leaseId']])
            digest.update(json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n')
            self.emit(dict(kind='toolchain-lease-closed-token',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,**value))
        for offset in range(0,len(closed_pids),256):
            self.emit(dict(kind='toolchain-lease-closed-pids',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,offset=offset,actualClosedPids=closed_pids[offset:offset+256]))
        row=self.emit(dict(kind='toolchain-leases-closed',model=LIFETIME_MODEL,pid=self.root,phaseName=self.lifetime_phase,tokenCount=len(tokens),tokensSha256=digest.hexdigest(),actualClosedPidCount=len(closed_pids),allTrackedWaitsClosed=True,scope='actual kernel-held read leases closed after all tracked waits; no source authority'))
        return row
    def observed_tool_files(self,capture_start,name):
        rows=[dict(actualOriginalPath=row['observedPath'],identity=row['identity'],actualMode=row['identity'][2],sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase=row['phase'],rawEventKind='toolchain-original',captureSequence=row['sequence'],original=dict(row['original'],path=str(self.capture_dir/row['original']['path']))) for row in self.captures[capture_start:] if row.get('kind')=='toolchain-original' and row.get('captureKind')=='file']
        assert all(row['phase']==name for row in rows),'tool original belongs to another phase'
        return rows
    def close(self):
        self.reset_owned_frames()
        self.close_outer_lease_window()
        if getattr(self,'generated_vma',None):self.generated_vma.close()
        for task in getattr(self,'tasks',{}).values():
            transition=task.pop('setresuidTransition',None)
            if transition is not None:transition.close()
            terminal=task.get('terminalAuthority')
            if terminal:terminal['lease'].close()
        if hasattr(self,'authority_handles'):self.authority_handles.close()
        for fd in list(self.retained):os.close(fd);self.retained.remove(fd)
    def abort(self):
        self.reset_owned_frames()
        self.close_outer_lease_window()
        # Never claim whole-kernel ownership from this traced PID registry. The
        # producer must propagate failure to its existing PID1 owner, whose
        # actual wait/ECHILD cleanup closes descendants outside this registry.
        for pid,row in self.tasks.items():
            if not row['exited']:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
        self.close()


class SdkExecutionObserver(Observer):
    # B3 FIX: the SDK observer alone requires the native lease backend.
    # This is the single DI decision; the base Observer stays pure so the
    # host-diagnostic path in sdk-service-native-runtime-originals.py is
    # unchanged. No env/CLI switch, no per-phase re-resolution: the class
    # is fixed here once, and LeaseSet resolves the backend at construction.
    lifetime_leases_class = lifetime_leases.SdkLeaseSet
    """Production API: one instance per actual inner build owner.

    The caller supplies the existing ExecutionBudget.end and remaining *shared*
    source-domain bytes. Per-phase deadlines may shorten it, never extend it.
    .phase returns real command/tracked receipts; it does not claim a closed
    process group while this long-lived observer still retains descriptors.
    """
    def __init__(self,out,source,build,*,deadline_monotonic,check_budget,maximum_bytes,maximum_stdio_bytes,prepared_dependencies=None):
        limits=load_sdk_execution_limits()
        assert isinstance(maximum_bytes,int) and 0<maximum_bytes<=limits['sourceMaterialBytes'],'canonical shared execution byte bound required'
        assert isinstance(maximum_stdio_bytes,int) and 0<maximum_stdio_bytes<=min(maximum_bytes,limits['shardBytes']),'existing bounded command raw limit required'
        assert Path(source)==Path('/opt/qlever-sdk/source') and Path(build)==Path('/opt/qlever-sdk/build'),'fixed SDK source/build roots required'
        assert isinstance(deadline_monotonic,(float,int)) and math.isfinite(deadline_monotonic) and time.monotonic()<deadline_monotonic,'existing live SDK deadline required'
        super().__init__(out,source,build,deadline_monotonic=deadline_monotonic,check_budget=check_budget,maximum_bytes=maximum_bytes,
            maximum_file_bytes=limits['shardBytes'],selected_names=None,maximum_processes=limits['sourceMembers'],shard_bytes=limits['shardBytes'],require_success=False,maximum_stdio_bytes=maximum_stdio_bytes,shared_tasks=True,capture_toolchain=True,deny_optional_io_uring=True,verified_identity_noop=True,terminal_exit_evidence=True,generated_vma_output=True,generated_vma_shared_mm=True,generated_vma_private_wake=True,generated_vma_private_wait_mismatch=True,capture_content_entities=True,queued_identity_noop=True,stopped_writer_aliases=True,generated_vma_coordinated_wait=True,generated_vma_parked_wait=True,io_uring_enosys_v2=True,serialize_terminal_syscalls=True,capture_maps_content_entities=True,retained_generated_metadata=True,indexed_raw_records=True,compressed_raw=True)
        self.capture_dir=self.out/'captures';self.capture_dir.mkdir(exist_ok=False);self.sdk_phase_index=0;self.sdk_failed=False
        mounts=Path('/proc/self/mountinfo').read_bytes();assert len(mounts)<=limits['metadataBytes'],'source provider metadata bound'
        self.source_provider=probe.effective_readonly(source,mounts);self.source_provider_originals=dict(mountinfo=probe.put(self.out/'source-provider.mountinfo.raw',mounts));self.claim(len(mounts))
        if prepared_dependencies is not None:
            self.deadline=self.deadline_monotonic
            self.load_prepared_dependencies(prepared_dependencies)
    def phase(self,name,command,deadline_monotonic,*,cwd,env,stdoutPath,stderrPath):
        assert not self.sdk_failed and self.sdk_phase_index<2 and name==['configure','compile'][self.sdk_phase_index] and deadline_monotonic<=self.deadline_monotonic,'fixed phase within existing SDK deadline required'
        expected=['bash','/components/qlever/scripts/build-qlever-runtime-sdk.sh','configure-prepared' if name=='configure' else 'build-prepared']
        assert command==expected,'fixed actual SDK phase argv required'
        result=super().phase(name,command,deadline_monotonic,cwd=cwd,env=env,stdoutPath=stdoutPath,stderrPath=stderrPath)
        self.sdk_failed=result['trackingReceipt']['actualRootReturnCode']!=0;self.sdk_phase_index+=1;return result

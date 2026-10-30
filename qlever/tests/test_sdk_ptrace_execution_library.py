"""Library contract/budget tests; actual ptrace execution is a queued Linux probe."""
import importlib.util
from pathlib import Path
import tempfile
import os
import hashlib
import json
import signal
import stat
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
bindings=module.bindings
READ_ROLE_ARCHS=(0xc000003e,0xc00000b7)
class Tests(unittest.TestCase):
    def test_sdk_policy_modes_keep_the_same_parent_budget_and_strict_generic_default(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        mounts=b'1 0 0:1 / / ro - overlay overlay rw\n'
        original_read=Path.read_bytes
        def read(path):
            return mounts if path==Path('/proc/self/mountinfo') else original_read(path)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            end=time.monotonic()+10;check=lambda:None
            # Mount input is a fixture; no child or kernel execution is claimed.
            with patch.object(Path,'read_bytes',read):
                observer=module.SdkExecutionObserver(Path(directory),Path('/opt/qlever-sdk/source'),Path('/opt/qlever-sdk/build'),deadline_monotonic=end,check_budget=check,maximum_bytes=4096,maximum_stdio_bytes=1024)
            try:
                self.assertTrue(observer.deny_optional_io_uring and observer.verified_identity_noop and observer.terminal_exit_evidence)
                self.assertFalse(observer.verified_setresuid_noop)
                self.assertTrue(observer.shared_tasks and observer.capture_toolchain)
                self.assertEqual(observer.deadline_monotonic,end);self.assertIs(observer.check_budget,check)
                self.assertEqual((observer.maximum_bytes,observer.maximum_stdio_bytes),(4096,1024))
                self.assertEqual(observer.domain_bytes,len(mounts))
            finally:observer.close()
            generic=module.Observer(directory,directory,directory)
            try:self.assertFalse(generic.deny_optional_io_uring or generic.verified_setresuid_noop or generic.verified_identity_noop or generic.terminal_exit_evidence)
            finally:generic.close()
    def test_shards_preserve_exact_bytes_and_order(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            stream=module.ShardedRaw(Path(directory),'compile',8);stream.write(b'first\n');stream.write(b'next\n');self.assertEqual(stream.tell(),11);stream.close()
            self.assertEqual([path.name for path in stream.paths],['compile.trace-0000.jsonl','compile.trace-0001.jsonl']);self.assertEqual(b''.join(path.read_bytes() for path in stream.paths),b'first\nnext\n')
    def test_normal_phase_must_use_fixed_argv_and_existing_deadline(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            # Pure argument checks only: no constructor, kernel provider, ptrace or cap is simulated.
            backend=object.__new__(module.SdkExecutionObserver);backend.sdk_failed=False;backend.sdk_phase_index=0;backend.deadline_monotonic=time.monotonic()+10;backend.retained=set()
            with self.assertRaisesRegex(AssertionError,'fixed actual SDK phase argv'):
                backend.phase('configure',['/bin/true'],time.monotonic()+1,cwd='/',env={},stdoutPath='/unused',stderrPath='/unused')
            with self.assertRaisesRegex(AssertionError,'existing SDK deadline'):
                backend.phase('configure',['bash','/components/qlever/scripts/build-qlever-runtime-sdk.sh','configure-prepared'],time.monotonic()+100,cwd='/',env={},stdoutPath='/unused',stderrPath='/unused')
            backend.close()
    def test_effective_source_ro_includes_superblock_and_rejects_rw(self):
        for flags,superflags in [('ro','rw'),('rw','ro')]:
            raw=('1 0 0:1 / / '+flags+' - overlay overlay '+superflags+'\n').encode()
            self.assertEqual(module.probe.effective_readonly('/opt/qlever-sdk/source',raw)['mount'],'/')
        with self.assertRaisesRegex(AssertionError,'writable'):
            module.probe.effective_readonly('/opt/qlever-sdk/source',b'1 0 0:1 / / rw - overlay overlay rw\n')
    def test_remaining_tightens_private_ledger_without_reset_or_increase(self):
        observer=module.Observer('/unused','/unused','/unused',maximum_bytes=100)
        observer.claim(20);self.assertEqual(observer.tighten_remaining(30),50)
        observer.claim(30);self.assertEqual(observer.domain_bytes,50)
        with self.assertRaisesRegex(AssertionError,'shared execution'):observer.claim(1)
        self.assertEqual(observer.tighten_remaining(1000),50)
        self.assertEqual(observer.tighten_remaining(0),50)
        for invalid in [-1,True,1.5]:
            with self.assertRaisesRegex(AssertionError,'remaining source'):observer.tighten_remaining(invalid)
    def test_actual_preexisting_build_inputs_are_sealed_once_with_held_FDs(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);build=root/'build';build.mkdir();out=root/'originals';out.mkdir()
            paths=[build/'.xpod-source-prepared',build/'arbitrary-prepared.conf']
            for path in paths:path.write_bytes(b'prepared-17')
            backend=module.Observer(out,root/'source',build);backend.deadline=time.monotonic()+5;backend.current_phase='configure';backend.raw=(out/'raw.jsonl').open('xb')
            try:
                backend.seal_prepared_build_inputs();self.assertEqual(set(backend.prepared_inputs),set(map(str,paths)))
                self.assertEqual(len(backend.captures),2)
                for path in paths:
                    row,fd,data=backend.prepared_inputs[str(path)];self.assertEqual(os.pread(fd,100,0),b'prepared-17');self.assertEqual(row['original']['sha256'],hashlib.sha256(b'prepared-17').hexdigest())
                held=backend.prepared_inputs[str(paths[0])][1];before=os.fstat(held).st_ino;paths[0].write_bytes(b'prepared-18')
                self.assertEqual(os.fstat(held).st_ino,before);self.assertEqual(os.pread(held,100,0),b'prepared-18')
                with self.assertRaisesRegex(AssertionError,'precede'):backend.seal_prepared_build_inputs()
            finally:backend.raw.close();backend.close()
    def test_canonical_budget_cannot_be_increased(self):
        with self.assertRaisesRegex(AssertionError,'canonical shared execution'):
            module.SdkExecutionObserver(Path('/unused'),Path('/opt/qlever-sdk/source'),Path('/opt/qlever-sdk/build'),deadline_monotonic=time.monotonic()+1,check_budget=lambda:None,maximum_bytes=4*1024**3+1,maximum_stdio_bytes=1000)

class ReadFamilyRoutingTests(unittest.TestCase):
    """OBS-READ-ROUTE-SHADOW: read-family role routing must stay reachable.

    `policy['reads']` CONTAINS `policy['read']` on both reviewed architectures, so
    the pre-fix `if nr in policy['reads']: input-read / elif selected: role` made
    every role branch dead and downgraded every regular source/dependency or
    build-root read to `input-read`. These tests assert the SHIPPED predicate and
    the SHIPPED role helper, not a re-implementation.
    """
    def test_read_family_contains_read_on_both_architectures(self):
        for arch in READ_ROLE_ARCHS:
            policy=module.profile(arch)
            self.assertIn(policy['read'],policy['reads'])
            # every reviewed ABI form is also a read-family number
            self.assertEqual(set(policy['reads']),set(bindings.READ_FORMS[arch]))

    def test_every_read_family_number_reaches_the_role_decision(self):
        """The role helper is consulted for the WHOLE family, not just `read`."""
        class Item:
            st_mode=stat.S_IFREG|0o644
        for arch in READ_ROLE_ARCHS:
            policy=module.profile(arch)
            for nr in sorted(policy['reads']):
                with self.subTest(arch=hex(arch),nr=nr):
                    self.assertIsNotNone(bindings.read_form(arch,nr))
                    self.assertEqual(module.read_capture_role('/opt/qlever-sdk/source/a.h',Item(),'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'source-read')
                    self.assertEqual(module.read_capture_role('/opt/qlever-sdk/dependencies/d/a.h',Item(),'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'source-read')
                    self.assertEqual(module.read_capture_role('/opt/qlever-sdk/build/a.h',Item(),'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'consumer')

    def test_nonregular_and_unresolved_reads_keep_the_input_obligation(self):
        """Role-specific evidence never waives a read-family obligation."""
        class Item:
            def __init__(self,mode):self.st_mode=mode
        regular=Item(stat.S_IFREG|0o644)
        for mode in (stat.S_IFIFO|0o600,stat.S_IFSOCK|0o600,stat.S_IFCHR|0o600):
            with self.subTest(mode=oct(mode)):
                # A non-regular descriptor under a source path is NOT a source read.
                self.assertEqual(module.read_capture_role('/opt/qlever-sdk/source/a.h',Item(mode),'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'input-read')
        # An unresolvable descriptor and a symlinked /proc view keep the fallback.
        for selected,item in ((None,None),('/proc/11/fd/3',regular),('/opt/qlever-sdk/source/a.h',None)):
            with self.subTest(selected=selected,item=item):
                self.assertEqual(module.read_capture_role(selected,item,'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'input-read')

    def test_role_helper_never_returns_a_role_outside_the_reviewed_set(self):
        class Item:
            st_mode=stat.S_IFREG|0o644
        for selected in ('/opt/qlever-sdk/source/a.h','/opt/qlever-sdk/build/a.h','/usr/include/a.h',None,''):
            for item in (Item(),None):
                with self.subTest(selected=selected,item=item is not None):
                    self.assertIn(module.read_capture_role(selected,item,'/opt/qlever-sdk/source','/opt/qlever-sdk/build'),
                                  ('source-read','consumer','input-read'))


class _FakeLeases:
    """Token contract only: no real fcntl lease on a non-Linux host."""
    def __init__(self):self.n=0
    def check(self,*a,**k):pass
    def close(self):pass
    def acquire(self,fd):
        self.n+=1;st=os.fstat(fd)
        return dict(leaseId=self.n,identity=[st.st_dev,st.st_ino,st.st_mode,st.st_size,st.st_mtime_ns,st.st_ctime_ns])


# Synthetic mountinfo for the DEPENDENCY PROVIDER boundary only. `dependency_source`
# re-proves the read-only mount of the registered root through
# `effective_readonly`, so the fixture supplies this table instead of the host's
# /proc/self/mountinfo. No host mount is created or consulted.
DEPENDENCY_MOUNTS=(b'1 0 0:1 / / ro - overlay overlay ro\n'
                   b'2 1 0:2 / /opt/qlever-sdk/dependencies/dep1 ro - ext4 deps ro\n')


class ReadDispatchTests(unittest.TestCase):
    """The SHIPPED event_original -> pending_captures dispatch for one real read.

    A role helper alone cannot prove the defect is fixed: `pending_captures`
    decides BOTH whether the role capture is emitted and whether the
    regular-input completeness observation is emitted. This drives the REAL
    production entry router and the REAL drain loop over a real temp file, with
    only the kernel-facing ptrace/proc/lease boundary substituted (the same
    boundary the existing library tests already substitute). Nothing here runs
    ptrace and no kernel/SDK authority is claimed.
    """
    STOP=((signal.SIGTRAP|0x80)<<8)|0x7f

    def _drive(self,rel,*,arch=0xc00000b7,nr=None,fifo=False,content=False,producer=False,dependency=False,drain=True):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        directory=tempfile.mkdtemp(dir=base)
        self.addCleanup(_remove_tree,directory)
        root=Path(directory);out=root/'out';out.mkdir()
        src=root/'source';src.mkdir();build=root/'build';build.mkdir()
        deps=root/'dependencies';deps.mkdir()
        if dependency:
            # LOGICAL PRODUCTION PATH, PRIVATE REAL BYTES. The tracee-visible path
            # stays the fixed production literal /opt/qlever-sdk/dependencies/dep1,
            # while every byte the observer actually reads lives in this private
            # temp tree. Nothing under /opt is created, read or modified.
            logical='/opt/qlever-sdk/dependencies/dep1/a.h'
            target=deps/'a.h'
        else:
            logical=rel.replace('/SOURCE',str(src)).replace('/DEPS',str(deps)).replace('/BUILD',str(build)).replace('/ORDINARY',str(root/'ordinary'))
            target=Path(logical)
        target.parent.mkdir(parents=True,exist_ok=True)
        data=b'#pragma once\n'
        if fifo:os.mkfifo(target)
        else:target.write_bytes(data)
        observer=module.Observer(out,src,build,maximum_bytes=8*1024**2,maximum_file_bytes=1024**2,
            capture_toolchain=True,shared_tasks=True,terminal_exit_evidence=True,verified_identity_noop=True,
            deny_optional_io_uring=True,capture_content_entities=content,queued_identity_noop=True,
            stopped_writer_aliases=True,io_uring_enosys_v2=True,serialize_terminal_syscalls=True,
            capture_maps_content_entities=content,indexed_raw_records=False,compressed_raw=False)
        observer.current_phase='compile';observer.deadline=time.monotonic()+30
        observer.raw=open(out/'compile.jsonl','xb')
        pid=11
        observer.tasks={pid:dict(stopped=True,exited=False,entry=None,initial=False,tgid=pid,fdTable=pid)}
        observer.lifetime_leases=_FakeLeases()
        # One stopped read fd is the whole FD universe for this fixture.
        observer.writable_aliases=lambda *a,**k:[]
        st=target.lstat();identity=[st.st_dev,st.st_ino,st.st_mode,st.st_size,st.st_mtime_ns,st.st_ctime_ns]
        dependency_calls=[]
        if dependency:
            # UNIT BOUNDARY (declared). The prepared-dependency REGISTRATION plan
            # itself is not rebuilt here: qlever/tests/test_sdk_prepared_dependency_sources.py
            # owns the real binding/root/mount/byte contract. This fixture supplies
            # exactly that already-validated plan shape, with the root pinned to the
            # fixed production literal, and records every provider call so the fixed
            # logical path is asserted rather than assumed. `dependency_source` still
            # runs for real: it matches this root, re-proves the read-only mount via
            # `effective_readonly(DEPENDENCY_MOUNTS)`, and returns the binding that
            # `capture` compares against the actual held-FD bytes.
            entry=dict(kind='file',mode=stat.S_IMODE(st.st_mode),bytes=len(data),
                       sha256=hashlib.sha256(data).hexdigest())
            observer.dependency_roots={
                'dep1':dict(name='dep1',sourceRoot='/opt/qlever-sdk/dependencies/dep1',
                            files={'a.h':entry},registrationSequence=1,
                            mounts=DEPENDENCY_MOUNTS,
                            provider=module.probe.effective_readonly(
                                '/opt/qlever-sdk/dependencies/dep1',DEPENDENCY_MOUNTS))}
            observer.prepared_dependency_plan=dict(mounts=DEPENDENCY_MOUNTS)
            observer.dependency_mountinfo=lambda:DEPENDENCY_MOUNTS
            real_dependency_source=observer.dependency_source
            def recorded_dependency_source(path):
                dependency_calls.append(path)
                return real_dependency_source(path)
            observer.dependency_source=recorded_dependency_source
        if producer:
            # A REAL prepared producer original for this exact inode: bytes are
            # written once as capture-0000.original and the held FD is retained.
            name='capture-0000.original';(out/name).write_bytes(data)
            reference=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
            observer.register_capture_entity(reference)
            held=os.open(target,os.O_RDONLY);observer.retained.add(held)
            row=dict(kind='prepared-build-input-original',phase='compile',sequence=1,path=str(target),
                     identity=identity,original=reference,originalEntityIdentity=observer.capture_entities[name][1])
            observer.producers[(st.st_dev,st.st_ino)]=(row,held,(len(data),hashlib.sha256(data).hexdigest()))
        realstat=os.stat;realopen=os.open;realreadlink=os.readlink
        proc='/proc/11/fd/3'
        def fake_stat(path,*a,**k):
            return realstat(target) if os.fspath(path)==proc else realstat(path,*a,**k)
        def fake_open(path,*a,**k):
            return realopen(target,*a,**k) if os.fspath(path)==proc else realopen(path,*a,**k)
        def fake_readlink(path):
            return str(target) if path==proc or path.startswith('/proc/self/fd/') else realreadlink(path)
        def fake_fcntl(fd,cmd,*a):
            if cmd==module.fcntl.F_GETLEASE:return module.fcntl.F_RDLCK
            if cmd==module.fcntl.F_GETFL:return os.O_RDONLY|os.O_NONBLOCK
            raise AssertionError('unexpected fcntl')
        form=module.bindings.read_form(arch,nr if nr is not None else module.profile(arch)['read'])
        args=[3,0,len(data),0,0,0]
        if form['iovec']:
            # iovec forms point at tracee memory the observer would read through
            # its own ptrace boundary; this fixture only needs the ROUTING proof.
            args=[3,0,len(data),0,0,0]
        syscall_nr=nr if nr is not None else module.profile(arch)['read']
        try:
            with patch.object(module,'fdpath',lambda p,f:logical),patch.object(module.os,'stat',fake_stat), \
                 patch.object(module.os,'open',fake_open),patch.object(module.os,'readlink',fake_readlink), \
                 patch.object(module,'descriptor_flags',lambda p,f:os.O_RDONLY), \
                 patch.object(module,'descriptor_position',lambda p,f:0),patch.object(module,'state',lambda p:'t'), \
                 patch.object(module.fcntl,'fcntl',fake_fcntl), \
                 patch.object(module.single,'syscall',lambda p:({'op':'entry','nr':syscall_nr,
                     'args':args,'arch':arch},dict(module.profile(arch)))):
                observer.barrier=lambda:observer.emit(dict(kind='all-stop-barrier',pids=[pid],osStates=['t']))
                module.Observer.event_original(observer,pid,self.STOP,False)
                scheduled=observer.tasks[pid].get('capture')
                if drain:observer.pending_captures()
        finally:
            observer.raw.close();observer.close()
        rows=[json.loads(line) for line in (out/'compile.jsonl').read_text().splitlines() if line.strip()]
        # BOUNDARY EVIDENCE: every call the production `capture(source-read)` made
        # into `dependency_source`, so the fixed logical path is asserted, not assumed.
        self.last_dependency_calls=dependency_calls
        return scheduled,rows,data

    def _capture_roles(self,rows):
        return [row['role'] for row in rows if row['kind']=='fd-capture']

    def test_source_read_keeps_source_read_capture_and_discharges_obligation(self):
        scheduled,rows,data=self._drive('/SOURCE/a.h')
        self.assertEqual(scheduled,(3,'source-read'))
        self.assertEqual(self._capture_roles(rows),['source-read'])
        observations=[row for row in rows if row['kind']=='regular-input-observation']
        self.assertEqual(len(observations),1,'the very same read must still be an input obligation')
        self.assertEqual(observations[0]['role'],'input-read')
        self.assertEqual(observations[0]['entrySequence'],[row for row in rows if row['kind']=='fd-capture'][0]['entrySequence'])
        self.assertGreater(observations[0]['readLeaseSequence'],0)

    def test_dependency_prefix_is_the_shipped_literal_and_stays_source_read(self):
        """The dependency root is a FIXED production literal, not a caller option.

        Relocating the fixture directory cannot change the shipped predicate, so a
        fixture path that merely *looks* like a dependency root keeps the honest
        `input-read` fallback. The literal predicate itself is asserted directly.
        """
        class Item:
            st_mode=stat.S_IFREG|0o644
        self.assertEqual(module.read_capture_role('/opt/qlever-sdk/dependencies/d/a.h',Item(),
                                                  '/opt/qlever-sdk/source','/opt/qlever-sdk/build'),'source-read')
        # POSITIVE HALF: a read on the fixed production dependency path, backed by
        # private real bytes, must produce a REAL `source-read` fd-capture carrying
        # the dependency binding AND still coexist with the completeness observation.
        scheduled,rows,data=self._drive(None,dependency=True)
        self.assertEqual(scheduled,(3,'source-read'))
        captures=[row for row in rows if row['kind']=='fd-capture']
        self.assertEqual([row['role'] for row in captures],['source-read'])
        capture=captures[0]
        self.assertEqual(capture['path'],'/opt/qlever-sdk/dependencies/dep1/a.h')
        # The production provider was actually consulted, with the FIXED logical path.
        self.assertEqual(self.last_dependency_calls,['/opt/qlever-sdk/dependencies/dep1/a.h'])
        self.assertEqual(capture['dependency'],dict(name='dep1',relativePath='a.h',registrationSequence=1))
        # REAL BYTE SNAPSHOT: the captured original is exactly the private bytes.
        self.assertEqual((capture['original']['bytes'],capture['original']['sha256']),
                         (len(data),hashlib.sha256(data).hexdigest()))
        # COEXISTENCE: the same entry is also the completeness obligation.
        observations=[row for row in rows if row['kind']=='regular-input-observation']
        self.assertEqual(len(observations),1)
        self.assertEqual(observations[0]['entrySequence'],capture['entrySequence'])
        # Both rows carry the SAME real byte image of the dependency file.
        self.assertEqual((observations[0]['original']['bytes'],observations[0]['original']['sha256']),
                         (capture['original']['bytes'],capture['original']['sha256']))
        self.assertGreater(observations[0]['readLeaseSequence'],0)
        # NEGATIVE HALF: relocating the fixture cannot change the shipped literal, so
        # a path that merely looks like a dependency root stays the honest fallback.
        scheduled,rows,_=self._drive('/DEPS/a.h')
        self.assertEqual(scheduled,(3,'input-read'))
        self.assertNotIn('fd-capture',[row['kind'] for row in rows])
        self.assertEqual([row['kind'] for row in rows].count('regular-input-observation'),1)
        self.assertEqual(self.last_dependency_calls,[])

    def test_build_read_routes_to_consumer_with_real_producer(self):
        scheduled,rows,_=self._drive('/BUILD/a.h',producer=True)
        self.assertEqual(scheduled,(3,'consumer'))
        self.assertEqual(self._capture_roles(rows),['consumer'])
        self.assertEqual([row['kind'] for row in rows].count('regular-input-observation'),1)

    def test_ordinary_regular_read_stays_input_read(self):
        scheduled,rows,_=self._drive('/ORDINARY/a.h')
        self.assertEqual(scheduled,(3,'input-read'))
        kinds=[row['kind'] for row in rows]
        self.assertIn('regular-input-observation',kinds)
        self.assertNotIn('fd-capture',kinds)

    def test_nonregular_source_read_is_observed_without_source_credit(self):
        scheduled,rows,_=self._drive('/SOURCE/a.h',fifo=True)
        self.assertEqual(scheduled,(3,'input-read'))
        kinds=[row['kind'] for row in rows]
        self.assertIn('regular-input-disposition',kinds)
        self.assertNotIn('fd-capture',kinds)

    def test_content_entity_model_aliases_the_same_physical_original(self):
        scheduled,rows,_=self._drive('/SOURCE/a.h',content=True)
        self.assertEqual(scheduled,(3,'source-read'))
        captures=[row for row in rows if row['kind']=='fd-capture']
        observations=[row for row in rows if row['kind']=='regular-input-observation']
        self.assertEqual(len(captures),1);self.assertEqual(len(observations),1)
        self.assertEqual(captures[0]['original'],observations[0]['original'])
        # The role row must ALIAS the same physical original, never copy it twice.
        self.assertEqual(captures[0]['originalReuse']['model'],'same-phase-content-entity-v2')
        self.assertEqual(captures[0]['originalReuse']['originCaptureSequence'],
                         [row['sequence'] for row in rows if row['kind']=='toolchain-original'][0])

    def test_emitted_rows_discharge_the_real_replay_completeness_gate(self):
        """The emitted pair must satisfy the REAL replay, not merely be present.

        A role-only capture leaves `inputComplete=false` (over-refusal). This runs
        the shipped `observe()` over a producer stream carrying the SAME rows the
        dispatch emits, and asserts the read is discharged as an input edge.
        """
        _,rows,data=self._drive('/SOURCE/a.h')
        entry=[row for row in rows if row['kind']=='kernel-syscall' and row['op']=='entry'][0]
        capture=[row for row in rows if row['kind']=='fd-capture'][0]
        observation=[row for row in rows if row['kind']=='regular-input-observation'][0]
        original=[row for row in rows if row['kind']=='toolchain-original'][0]
        lease=[row for row in rows if row['kind']=='toolchain-lease-acquired'][0]
        out_data=b'OUTPUT-0'
        stream=[]
        def emit(kind,**fields):
            stream.append(dict(kind=kind,phase='compile',sequence=len(stream)+1,**fields));return stream[-1]
        emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',toolchainLifetimeModel='kernel-held-read-lease-v1')
        emit('actual-child-binding',parentPid=10,childPid=11,event=1)
        # Copy the real observed read/lease/observation rows onto this stream.
        read_entry=emit('kernel-syscall',pid=11,arch=entry['arch'],op='entry',nr=entry['nr'],args=list(entry['args']))
        barrier=emit('all-stop-barrier',pids=[10,11],osStates=['t','t'])
        the_original=emit('toolchain-original',captureKind='input-read',observedPath=original['observedPath'],
            identity=original['identity'],original=original['original'],
            originalEntityIdentity=original['originalEntityIdentity'],
            regularInputOriginalModel=original['regularInputOriginalModel'])
        the_lease=emit('toolchain-lease-acquired',pid=11,role='input-read',leaseId=1,
            model='kernel-held-read-lease-v1',identity=lease['identity'],
            entrySequence=read_entry['sequence'],barrierSequence=barrier['sequence'])
        the_observation=emit('regular-input-observation',pid=11,role='input-read',
            syscall=observation['syscall'],form=observation['form'],entrySequence=read_entry['sequence'],
            barrierSequence=barrier['sequence'],fd=3,path=observation['path'],identity=observation['identity'],
            descriptorFlags=0,generation=dict(identity=observation['identity'],flags=0,position=0),
            original=observation['original'],originalSequence=the_original['sequence'],
            readLeaseSequence=the_lease['sequence'],readLeaseId=1,resolvedPath=observation['resolvedPath'],
            rangeStart=0,requestedBound=len(data),iovcnt=None,iovLengths=None,
            reuseModel='canonical-input-original-v1')
        emit('exclusive-captured-syscall-resume',pid=11,entrySequence=read_entry['sequence'],
             captureSequence=the_observation['sequence'],inputObservationSequence=the_observation['sequence'],
             regularInputRole='input-read',regularInputForm=observation['form'])
        emit('kernel-syscall',pid=11,arch=entry['arch'],op='exit',entrySequence=read_entry['sequence'],
             result=len(data),isError=False)
        emit('exclusive-captured-syscall-exit',pid=11,entrySequence=read_entry['sequence'],
             result=len(data),isError=False)
        oid=list(capture['identity'])
        close=emit('kernel-syscall',pid=11,arch=entry['arch'],op='entry',nr=module.profile(entry['arch'])['close'],args=[3,0,0,0,0,0])
        cbar=emit('all-stop-barrier',pids=[10,11],osStates=['t','t'])
        held_name='capture-9000.original'
        producer=emit('fd-capture',pid=11,fd=3,entrySequence=close['sequence'],role='producer-close',
            path='/build/out.h',identity=[oid[0],oid[1],0o100600,len(out_data),oid[4],oid[5]],
            barrierSequence=cbar['sequence'],writers=[dict(pid=11,fd=3)],
            original=dict(path=held_name,bytes=len(out_data),sha256=hashlib.sha256(out_data).hexdigest()))
        emit('exclusive-captured-syscall-resume',pid=11,entrySequence=close['sequence'],captureSequence=producer['sequence'])
        emit('kernel-syscall',pid=11,arch=entry['arch'],op='exit',entrySequence=close['sequence'],result=0,isError=False)
        emit('exclusive-captured-syscall-exit',pid=11,entrySequence=close['sequence'],result=0,isError=False)
        emit('actual-wait-exit',pid=11,returnCode=0);emit('actual-wait-exit',pid=10,returnCode=0)
        emit('toolchain-lease-closed-token',model='kernel-held-read-lease-v1',leaseId=1,
             identity=lease['identity'],acquisitionSequence=the_lease['sequence'])
        projection=dict(leaseId=1,identity=lease['identity'],acquisitionSequence=the_lease['sequence'])
        digest=hashlib.sha256((json.dumps(projection,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
        emit('toolchain-lease-closed-pids',model='kernel-held-read-lease-v1',actualClosedPids=[10,11],pid=10,offset=0)
        emit('toolchain-leases-closed',model='kernel-held-read-lease-v1',actualClosedPidCount=2,
             allTrackedWaitsClosed=True,pid=10,tokenCount=1,tokensSha256=digest,scope='actual held read leases closed')
        originals={original['original']['path']:data,held_name:out_data}
        result=bindings.observe([('compile',[(json.dumps(row)+'\n').encode() for row in stream])],
                                lambda name,maximum: originals[name])
        witness=[row for row in result['verifiedGeneratedProducerWitness'] if row['path']=='/build/out.h'][0]
        self.assertTrue(witness['inputComplete'],witness.get('unexplainedReads'))
        self.assertEqual(witness['readOperations'],0)
        self.assertEqual(result['verifiedRegularInputUniverse']['observationCount'],1)

    def test_both_architectures_route_every_read_family_form(self):
        """Every read-family number on both ABIs reaches the role decision."""
        for arch in READ_ROLE_ARCHS:
            for nr in sorted(module.profile(arch)['reads']):
                with self.subTest(arch=hex(arch),nr=nr):
                    scheduled,_rows,_data=self._drive('/SOURCE/a.h',arch=arch,nr=nr,drain=False)
                    self.assertEqual(scheduled,(3,'source-read'))


def _remove_tree(directory):
    import shutil
    shutil.rmtree(directory,ignore_errors=True)


class ActualStdioTests(unittest.TestCase):
    def pipe_case(self,maximum_stream,maximum_domain,data):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            observer=module.Observer(Path(directory),Path(directory),Path(directory),maximum_bytes=maximum_domain)
            read_fd,write_fd=os.pipe();errors=[];target=Path(directory)/'stdout.raw';pump=module.BoundedPipePump(read_fd,target,maximum_stream,observer.claim,errors)
            pid=os.fork()
            if pid==0:
                try:os.close(read_fd);os.write(write_fd,data);os.close(write_fd);os._exit(0)
                except BaseException:os._exit(70)
            os.close(write_fd);pump.start();waited,status=os.waitpid(pid,0);pump.thread.join(2)
            self.assertFalse(pump.thread.is_alive());self.assertEqual(waited,pid)
            return target.read_bytes(),errors,pump,observer.domain_bytes
    def test_actual_pipe_bytes_are_hashed_and_charged(self):
        content,errors,pump,charged=self.pipe_case(1024,1024,b'actual stdout')
        self.assertEqual(content,b'actual stdout');self.assertEqual(errors,[]);self.assertEqual(charged,len(content));self.assertEqual(pump.sha256,hashlib.sha256(content).hexdigest())
    def test_actual_large_write_rejected_before_unbounded_disk_write(self):
        for stream,domain in [(32,10000),(10000,32)]:
            content,errors,pump,charged=self.pipe_case(stream,domain,b'x'*4096)
            self.assertTrue(errors);self.assertLessEqual(len(content),32);self.assertIsNone(pump.sha256);self.assertLessEqual(charged,domain)
    @unittest.skipUnless(Path('/usr/bin/bash').is_file(),'fixed Debian SDK executable is tested by queued Linux context')
    def test_actual_fixed_bash_execve_from_directory_without_relative_bash(self):
        base=ROOT/'.test-data/sdk-ptrace-library';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            read_fd,write_fd=os.pipe();pid=os.fork()
            if pid==0:
                os.close(read_fd);os.chdir(directory);os.dup2(write_fd,1);os.close(write_fd)
                command=['bash','-c','printf actual-fixed-bash'];os.execve(module.actual_executable(command),command,{'PATH':'/usr/bin:/bin','LANG':'C'})
            os.close(write_fd);content=os.read(read_fd,1024);os.close(read_fd);waited,status=os.waitpid(pid,0)
            self.assertEqual(waited,pid);self.assertEqual(os.waitstatus_to_exitcode(status),0);self.assertEqual(content,b'actual-fixed-bash')



if __name__=='__main__':unittest.main()

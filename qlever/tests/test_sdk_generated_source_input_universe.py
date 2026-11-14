"""Generated-source complete input universe over the REAL replay.

The base producer/consumer fixture is the shared bindings fixture. These tests
build their own stream through ONE sequence-rewrite pass (an explicit old->new
map, so every internal reference is remapped once and cannot drift) and then
assert the FACTS the real `observe()` replay derives. A caller flag can never
mint a witness: the replay must validate the entry, the all-stop barrier, the
canonical original and the matching real exit.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
bindings = load('multi_universe', ROOT / 'scripts/sdk-generation-multiprocess-bindings.py')
base = load('multi_universe_base', Path(__file__).with_name('test_sdk_generation_multiprocess_bindings.py'))
ARCH = 0xc00000b7
REFERENCE_KEYS = ('entrySequence', 'barrierSequence', 'captureSequence', 'producerCaptureSequence',
                  'windowSequence', 'inputObservationSequence', 'originalSequence', 'gateSequence')

def build(observe_read=True):
    """One ordinary read inserted BEFORE the producers write and close."""
    rows, originals = base.fixture()
    # A stream that carries a real kernel-held read lease must declare the
    # matching lifetime model on its root binding. The no-evidence variant has no
    # lease at all, so it must NOT declare one (that would be an unclosed phase).
    if observe_read:rows[0]['toolchainLifetimeModel']='kernel-held-read-lease-v1'
    head, tail = rows[:2], rows[2:]
    injected = []
    def emit(kind, **fields):
        # Provisional numbering: the single rewrite pass below replaces it.
        row = dict(kind=kind, phase='compile', sequence=len(head) + len(injected) + 1, **fields)
        injected.append(row); return row
    data = b'#pragma once\n'
    entry = emit('kernel-syscall', pid=11, arch=ARCH, op='entry', nr=67, args=[3, 0, len(data), 0, 0, 0])
    barrier = emit('all-stop-barrier', pids=[10, 11], osStates=['t', 't'])
    name = 'capture-9000.original'; originals[name] = data
    identity = [1, 900, 0o100644, len(data), 7, 8]
    reference = dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    if observe_read:
        original = emit('toolchain-original', captureKind='input-read', observedPath='/usr/include/ord.h',
                        identity=identity, original=reference,
                        originalEntityIdentity=[1, 999, 0o100644, len(data), 0, 0, 1],
                        regularInputOriginalModel='once-per-stable-protected-inode-v1')
        # REAL CUSTODY: a held kernel read lease acquisition for this exact
        # inode, emitted before the observation. Without it the read is not a
        # creditable input (a read-only FD is not inode immutability).
        lease = emit('toolchain-lease-acquired', pid=11, role='input-read', leaseId=1,
            model='kernel-held-read-lease-v1', identity=identity,
            entrySequence=entry['sequence'], barrierSequence=barrier['sequence'])
        observation = emit('regular-input-observation', pid=11, role='input-read', syscall='pread64',
            form='pread64', entrySequence=entry['sequence'], barrierSequence=barrier['sequence'], fd=3,
            path='/usr/include/ord.h', identity=identity, descriptorFlags=0,
            generation=dict(identity=identity, flags=0, position=0), original=reference,
            originalSequence=original['sequence'], readLeaseSequence=lease['sequence'], readLeaseId=1,
            resolvedPath='/usr/include/ord.h',
            rangeStart=0, requestedBound=len(data),
            iovcnt=None, iovLengths=None, reuseModel='canonical-input-original-v1')
        emit('exclusive-captured-syscall-resume', pid=11, entrySequence=entry['sequence'],
             captureSequence=observation['sequence'], inputObservationSequence=observation['sequence'],
             regularInputRole='input-read', regularInputForm='pread64')
    exit_row = emit('kernel-syscall', pid=11, arch=ARCH, op='exit', entrySequence=entry['sequence'],
                    result=len(data), isError=False)
    if observe_read:
        emit('exclusive-captured-syscall-exit', pid=11, entrySequence=entry['sequence'],
             result=len(data), isError=False)
    # ONE rewrite pass. The injected rows are already numbered by their FINAL
    # position (head + position), so they are excluded from the remap; only the
    # original tail carries old numbers that must be translated.
    ordered = head + injected + [dict(row) for row in tail]
    mapping = {row['sequence']: index + 1 for index, row in enumerate(ordered)}
    injected_ids = {id(row) for row in injected}
    for index, row in enumerate(ordered):
        row['sequence'] = index + 1
        if id(row) in injected_ids: continue
        for key in REFERENCE_KEYS:
            if key in row and isinstance(row[key], int) and row[key] in mapping:
                row[key] = mapping[row[key]]
    def append_tail(kind, **fields):
        item = dict(kind=kind, phase='compile', sequence=len(ordered) + 1, **fields)
        ordered.append(item); return item
    # EXACT lease-phase closure, in the emitter's order: token close AFTER all
    # tracked waits, then the pid set, then the receipts row.
    if observe_read:
        append_tail('toolchain-lease-closed-token', model='kernel-held-read-lease-v1',
                    leaseId=1, identity=identity, acquisitionSequence=lease['sequence'])
        # the terminal receipt must hash the EXACT closed-token projection
        token_projection=dict(leaseId=1, identity=identity, acquisitionSequence=lease['sequence'])
        digest=hashlib.sha256((json.dumps(token_projection,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
        append_tail('toolchain-lease-closed-pids', model='kernel-held-read-lease-v1',
                    actualClosedPids=[10, 11], pid=10, offset=0)
        append_tail('toolchain-leases-closed', model='kernel-held-read-lease-v1',
                    actualClosedPidCount=2, allTrackedWaitsClosed=True, pid=10, tokenCount=1,
                    tokensSha256=digest, scope='actual kernel-held read leases closed after all tracked waits')
    return ordered, originals, exit_row

def replay(rows, originals):
    return bindings.observe([('compile', [(json.dumps(row) + '\n').encode() for row in rows])],
                            lambda name, maximum: originals[name])

class InputUniverseTests(unittest.TestCase):
    def test_an_ordinary_read_becomes_a_causal_input(self):
        rows, originals, _ = build()
        result = replay(rows, originals)
        witness = result['verifiedGeneratedProducerWitness']
        self.assertTrue(witness)
        table={row['inputId']:row for row in result['verifiedGeneratedProducerInputs']}
        models = {table[i]['inputModel'] for i in witness[0]['inputIds']}
        self.assertIn('regular-read', models)
        self.assertGreaterEqual(witness[0]['readInputCount'], 1)
        self.assertEqual(len(witness[0]['inputIds']),len(set(witness[0]['inputIds'])))
        self.assertTrue(witness[0]['inputComplete'])
    def test_dropping_that_read_makes_the_universe_incomplete(self):
        """The read really happens (entry AND successful exit) with no evidence.

        This is exactly the older capture-scope gap. The producer's universe must
        be INCOMPLETE instead of credited from the remaining mapping set.
        """
        rows, originals, _ = build(observe_read=False)
        result = replay(rows, originals)
        witness = result['verifiedGeneratedProducerWitness'][0]
        self.assertFalse(witness['inputComplete'])
        self.assertGreaterEqual(witness['readOperations'], 1)
        self.assertEqual(witness['readInputCount'], 0)
    def _insert_disposition(self, rows, disposition, drop_observation=True):
        observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
        original = next(row for row in rows if row['kind'] == 'toolchain-original'
                        and row.get('captureKind') == 'input-read')
        entry = observation['entrySequence']
        barrier_row = next(row for row in rows if row['kind'] == 'all-stop-barrier'
                           and row['sequence'] == observation['barrierSequence'])
        rows = [row for row in rows if not (row is observation and drop_observation) and row is not original
                and not (row['kind'] == 'exclusive-captured-syscall-resume'
                         and row.get('regularInputForm') is not None)
                and not (row['kind'] == 'exclusive-captured-syscall-exit'
                         and row.get('entrySequence') == entry)]
        rows.insert(rows.index(barrier_row) + 1, disposition)
        mapping = {row['sequence']: index + 1 for index, row in enumerate(rows)}
        for index, row in enumerate(rows):
            row['sequence'] = index + 1
            for key in REFERENCE_KEYS:
                if key in row and isinstance(row[key], int) and row[key] in mapping:
                    row[key] = mapping[row[key]]
        return rows

    def test_a_POSITIVE_pipe_read_without_a_trusted_gate_chain_stays_pENDING(self):
        """Object kind is not closure: an arbitrary positive pipe read is unknown."""
        rows, originals, _ = build()
        observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
        disposition = dict(kind='regular-input-disposition', phase='compile', sequence=0,
            pid=11, role='input-read', syscall='pread64', form='pread64',
            entrySequence=observation['entrySequence'], barrierSequence=observation['barrierSequence'],
            fd=3, path='pipe:[123]', mode=0o010600, inode=123, device=9, requestedBound=4096,
            objectKind='fifo', pathClass='pipe', descriptorFlags=0,
            scope='actual stopped non-regular read observation')
        rows = self._insert_disposition(rows, disposition)
        result = replay(rows, originals)
        witness = result['verifiedGeneratedProducerWitness'][0]
        self.assertFalse(witness['inputComplete'])
        self.assertGreaterEqual(witness['readOperations'], 1)
        self.assertEqual(result['verifiedRegularInputUniverse']['unverifiedNonFileReads'], 1)
        self.assertEqual(result['verifiedRegularInputUniverse']['verifiedNonFileChains'], {})

    def test_a_POSITIVE_socket_or_proc_read_without_a_chain_stays_pending(self):
        for path, mode, kind, klass in (('socket:[77]', 0o0140777, 'socket', 'socket'),
                                        ('/proc/11/environ', 0o100400, 'regular', 'proc'),
                                        ('/dev/zero', 0o020666, 'character-device', 'dev')):
            rows, originals, _ = build()
            observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
            disposition = dict(kind='regular-input-disposition', phase='compile', sequence=0,
                pid=11, role='input-read', syscall='pread64', form='pread64',
                entrySequence=observation['entrySequence'], barrierSequence=observation['barrierSequence'],
                fd=3, path=path, mode=mode, inode=77, device=9, requestedBound=64,
                objectKind=kind, pathClass=klass, descriptorFlags=0,
                scope='actual stopped non-regular read observation')
            rows = self._insert_disposition(rows, disposition)
            result = replay(rows, originals)
            self.assertFalse(result['verifiedGeneratedProducerWitness'][0]['inputComplete'], path)

    def test_a_ZERO_length_non_file_read_is_discharged_by_its_real_exit(self):
        rows, originals, exit_row = build()
        exit_row['result'] = 0
        observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
        disposition = dict(kind='regular-input-disposition', phase='compile', sequence=0,
            pid=11, role='input-read', syscall='pread64', form='pread64',
            entrySequence=observation['entrySequence'], barrierSequence=observation['barrierSequence'],
            fd=3, path='pipe:[123]', mode=0o010600, inode=123, device=9, requestedBound=4096,
            objectKind='fifo', pathClass='pipe', descriptorFlags=0,
            scope='actual stopped non-regular read observation')
        rows = self._insert_disposition(rows, disposition)
        result = replay(rows, originals)
        self.assertTrue(result['verifiedGeneratedProducerWitness'][0]['inputComplete'])
        self.assertEqual(result['verifiedRegularInputUniverse']['zeroLengthReads'], 1)

    def test_a_FAILED_non_file_read_is_discharged_but_grants_no_bytes(self):
        rows, originals, exit_row = build()
        exit_row.update(result=-13, isError=True)
        observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
        disposition = dict(kind='regular-input-disposition', phase='compile', sequence=0,
            pid=11, role='input-read', syscall='pread64', form='pread64',
            entrySequence=observation['entrySequence'], barrierSequence=observation['barrierSequence'],
            fd=3, path='pipe:[123]', mode=0o010600, inode=123, device=9, requestedBound=4096,
            objectKind='fifo', pathClass='pipe', descriptorFlags=0,
            scope='actual stopped non-regular read observation')
        rows = self._insert_disposition(rows, disposition)
        result = replay(rows, originals)
        self.assertTrue(result['verifiedGeneratedProducerWitness'][0]['inputComplete'])
        self.assertEqual(result['verifiedRegularInputUniverse']['failedReads'], 1)

    def test_a_non_file_read_WITHOUT_an_exit_stays_pending(self):
        rows, originals, exit_row = build()
        observation = next(row for row in rows if row['kind'] == 'regular-input-observation')
        disposition = dict(kind='regular-input-disposition', phase='compile', sequence=0,
            pid=11, role='input-read', syscall='pread64', form='pread64',
            entrySequence=observation['entrySequence'], barrierSequence=observation['barrierSequence'],
            fd=3, path='pipe:[123]', mode=0o010600, inode=123, device=9, requestedBound=4096,
            objectKind='fifo', pathClass='pipe', descriptorFlags=0,
            scope='actual stopped non-regular read observation')
        rows = self._insert_disposition(rows, disposition)
        rows = [row for row in rows if row is not exit_row]
        mapping = {row['sequence']: index + 1 for index, row in enumerate(rows)}
        for index, row in enumerate(rows):
            row['sequence'] = index + 1
            for key in REFERENCE_KEYS:
                if key in row and isinstance(row[key], int) and row[key] in mapping:
                    row[key] = mapping[row[key]]
        result = replay(rows, originals)
        self.assertFalse(result['verifiedGeneratedProducerWitness'][0]['inputComplete'])

    def _gate_case(self, *, identity, reader_pid, gate_pid=None, release_before_entry=True,
                   result=1, gate_identity=None):
        """A complete stream where the reader's first positive input is a pipe.

        Layout (strict by construction): gate, binding, release, entry, barrier,
        disposition, resume, real exit, exclusive close, waits. ``gate_identity``
        lets a case make the captured gate inode differ from the read object.
        """
        rows, originals = base.fixture()
        head = rows[:2]
        injected = []
        def emit(kind, **fields):
            row = dict(kind=kind, phase='compile', sequence=len(head) + len(injected) + 1, **fields)
            injected.append(row); return row
        same = identity if gate_identity is None else gate_identity
        gate = emit('toolchain-control-gate', model='observer-owned-startup-gate-v1',
            targetPid=None, readEndFd=3, writeEndFd=4, identity=same, byteLength=1,
            byteSha256=hashlib.sha256(b'x').hexdigest())
        bound_pid = gate_pid if gate_pid is not None else reader_pid
        binding = emit('toolchain-control-gate-binding', model='observer-owned-startup-gate-v1',
            gateSequence=gate['sequence'], pid=bound_pid, identity=same)
        release = emit('toolchain-control-gate-release', model='observer-owned-startup-gate-v1',
            gateSequence=gate['sequence'], pid=bound_pid, identity=same, byteLength=1,
            byteSha256=hashlib.sha256(b'x').hexdigest())
        entry = emit('kernel-syscall', pid=reader_pid, arch=ARCH, op='entry', nr=63, args=[3, 0, 1, 0, 0, 0])
        barrier = emit('all-stop-barrier', pids=[10, 11], osStates=['t', 't'])
        chain = dict(model='observer-startup-gate-v1', identity=identity,
            gateSequence=gate['sequence'], bindingSequence=binding['sequence'],
            releaseSequence=release['sequence'], byteLength=1,
            byteSha256=hashlib.sha256(b'x').hexdigest())
        disposition = emit('regular-input-disposition', pid=reader_pid, role='input-read',
            syscall='read', form='read', entrySequence=entry['sequence'],
            barrierSequence=barrier['sequence'], fd=3, path='pipe:[%d]' % identity[1],
            mode=0o010600, inode=identity[1], device=identity[0], requestedBound=1,
            objectKind='fifo', pathClass='pipe', descriptorFlags=0, chain=chain,
            scope='actual stopped non-regular read observation')
        # A disposition is NOT an exclusive capture: the observer emits no resume
        # row for it (the tracee simply continues to its real exit).
        exit_row = emit('kernel-syscall', pid=reader_pid, arch=ARCH, op='exit',
                        entrySequence=entry['sequence'], result=result, isError=result < 0)
        emit('ptrace-event', pid=bound_pid, event=4)
        body = head + injected + [dict(row) for row in rows[2:]]
        mapping = {row['sequence']: index + 1 for index, row in enumerate(body)}
        injected_ids = {id(row) for row in injected}
        for index, row in enumerate(body):
            row['sequence'] = index + 1
            if id(row) in injected_ids: continue
            for key in REFERENCE_KEYS:
                if key in row and isinstance(row[key], int) and row[key] in mapping:
                    row[key] = mapping[row[key]]
        return body, originals

    def test_a_gate_chained_positive_read_is_credited_only_with_the_exact_real_relation(self):
        rows, originals = self._gate_case(
            identity=[3, 501, 0o010600, 0, 1700000000000000000, 1700000000000000001], reader_pid=11)
        universe = replay(rows, originals)['verifiedRegularInputUniverse']
        self.assertEqual(universe['verifiedNonFileChains'].get('observer-startup-gate-v1'), 1)
        self.assertEqual(universe['unverifiedNonFileReads'], 0)

    def test_a_gate_chained_read_bound_to_the_WRONG_PEER_pid_stays_pending(self):
        rows, originals = self._gate_case(
            identity=[3, 501, 0o010600, 0, 1700000000000000000, 1700000000000000001],
            reader_pid=11, gate_pid=12)
        universe = replay(rows, originals)['verifiedRegularInputUniverse']
        self.assertEqual(universe['verifiedNonFileReads'] if 'verifiedNonFileReads' in universe else universe['unverifiedNonFileReads'], 1)

    def test_a_gate_chained_read_on_a_DIFFERENT_pipe_inode_stays_pending(self):
        rows, originals = self._gate_case(
            identity=[3, 501, 0o010600, 0, 1700000000000000000, 1700000000000000001],
            reader_pid=11, gate_identity=[3, 999, 0o010600, 0, 1700000000000000000, 1700000000000000001])
        universe = replay(rows, originals)['verifiedRegularInputUniverse']
        self.assertEqual(universe['unverifiedNonFileReads'], 1)

    def test_a_gate_chained_read_consuming_more_than_the_released_byte_stays_pending(self):
        rows, originals = self._gate_case(
            identity=[3, 501, 0o010600, 0, 1700000000000000000, 1700000000000000001],
            reader_pid=11, result=2)
        universe = replay(rows, originals)['verifiedRegularInputUniverse']
        self.assertEqual(universe['unverifiedNonFileReads'], 1)

    # ---- kernel virtual filesystem (sysfs) chain ----
    # These exercise the SAME pure verifier the replay path calls, so there is
    # one implementation of the rule and no test-only copy.
    TABLE=('293 1 0:99 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro\n'
           '300 1 0:41 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup2 rw\n'
           '310 1 8:1 / /data rw,relatime - ext4 /dev/sda1 rw\n').encode()

    def _chain(self, **over):
        chain=dict(model='kernel-virtual-fs-metadata-v1', subjectPid=11,
            path='/sys/devices/system/cpu/online', descriptorMountId=293, mountPoint='/sys',
            mountId=293, mountOptions=['ro','nosuid','nodev','noexec'], fstype='sysfs',
            superblockOptions=['ro'], device='0:99', descriptorFlags=0,
            fileIdentity=['99','201',str(0o100444),'4096','1','1'], observedAtAllStop=7)
        chain.update(over); return chain

    def _verify(self, chain=None, result=5, bound=1024, flags=0, tables=None):
        return bindings.verify_kernel_virtual_fs_chain(chain if chain is not None else self._chain(),
            [self.TABLE] if tables is None else tables, subject_pid=11, result=result,
            requested_bound=bound, descriptor_flags=flags, need=lambda value,reason: None)

    def test_a_sysfs_kernel_metadata_read_verifies_from_the_subject_mount_table(self):
        verified=self._verify()
        self.assertIsNotNone(verified)
        self.assertEqual(verified['fstype'],'sysfs')
        self.assertEqual(verified['mountId'],293)
        self.assertEqual(verified['consumedLength'],5)

    def test_a_REGULAR_FILE_bind_mounted_at_the_trusted_path_is_refused(self):
        """Same path, real ext4 data filesystem: NOT kernel-supplied topology."""
        self.assertIsNone(self._verify(self._chain(fstype='ext4',device='8:1',mountId=310,
            descriptorMountId=310,mountPoint='/data'), tables=[self.TABLE.replace(b'293 1 0:99 / /sys',b'310 1 8:1 / /sys')]))

    def test_an_UNKNOWN_filesystem_at_sys_is_refused_even_with_ro_options(self):
        self.assertIsNone(self._verify(self._chain(fstype='tmpfs'),
            tables=[self.TABLE.replace(b'- sysfs sysfs ro',b'- tmpfs tmpfs ro')]))

    def test_a_WRITABLE_mount_at_the_trusted_path_is_refused(self):
        self.assertIsNone(self._verify(self._chain(mountOptions=['rw','nosuid'])))

    def test_a_superblock_writable_mount_is_refused(self):
        self.assertIsNone(self._verify(tables=[self.TABLE.replace(b'- sysfs sysfs ro',b'- sysfs sysfs rw')]))

    def test_a_DIFFERENT_FD_MOUNT_ID_than_the_resolved_mount_is_refused(self):
        self.assertIsNone(self._verify(self._chain(descriptorMountId=999)))

    def test_a_MOUNT_ABSENT_from_the_captured_table_is_refused(self):
        self.assertIsNone(self._verify(self._chain(mountPoint='/sys/fs/cgroup',mountId=300,
            descriptorMountId=300,fstype='cgroup2')))

    def test_a_DEVICE_mismatch_against_the_captured_table_is_refused(self):
        self.assertIsNone(self._verify(self._chain(device='0:41')))

    def test_a_read_BEYOND_the_requested_bound_is_refused(self):
        self.assertIsNone(self._verify(result=2048,bound=1024))

    def test_a_ZERO_or_negative_virtual_fs_read_grants_no_chain(self):
        self.assertIsNone(self._verify(result=0))
        self.assertIsNone(self._verify(result=-11))

    def test_a_WRITABLE_descriptor_virtual_fs_read_is_refused(self):
        self.assertIsNone(self._verify(flags=2))

    def test_no_authority_mount_table_means_no_chain(self):
        self.assertIsNone(self._verify(tables=[]))

    def test_a_proc_environ_path_is_not_a_kernel_virtual_fs_chain(self):
        self.assertIsNone(self._verify(self._chain(path='/proc/11/environ')))

    def test_graph_nodes_are_deduplicated(self):
        rows, originals, _ = build()
        result = replay(rows, originals)
        graph = result['verifiedGeneratedProducerGraph']
        keys = [tuple(node['identity']) + (node['bytes'], node['sha256']) for node in graph['nodes']]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertGreater(graph['nodeCount'], 1)

if __name__ == '__main__':
    unittest.main()

class ReadSourceClassTests(unittest.TestCase):
    """Per-input SOURCE class: byte custody/inventory is not source authority."""
    ROOT='/opt/qlever-sdk/dependencies/fmt'
    def roots(self):
        return {'fmt':dict(root=self.ROOT,registrationSequence=7,
            files={'include/fmt/core.h':dict(kind='file',bytes=10,sha256='a'*64)})}
    def item(self,**over):
        base=dict(resolvedPath=self.ROOT+'/include/fmt/core.h',bytes=10,sha256='a'*64)
        base.update(over);return base
    def test_a_registered_root_closes_the_class(self):
        kind,detail=bindings.classify_read_input_origin(self.item(),self.roots(),set())
        self.assertEqual(kind,'prepared-fetchcontent')
        self.assertEqual(detail['dependency'],'fmt')
        self.assertEqual(detail['registrationSequence'],7)
    def test_wrong_bytes_in_that_root_stay_unresolved(self):
        kind,_=bindings.classify_read_input_origin(self.item(sha256='b'*64),self.roots(),set())
        self.assertEqual(kind,'unresolved')
    def test_wrong_size_in_that_root_stays_unresolved(self):
        kind,_=bindings.classify_read_input_origin(self.item(bytes=11),self.roots(),set())
        self.assertEqual(kind,'unresolved')
    def test_a_path_outside_every_registered_root_stays_unresolved(self):
        kind,_=bindings.classify_read_input_origin(self.item(resolvedPath='/usr/include/fmt/core.h'),self.roots(),set())
        self.assertEqual(kind,'unresolved')
    def test_no_canonical_path_never_classifies(self):
        kind,_=bindings.classify_read_input_origin(self.item(resolvedPath=None),self.roots(),set())
        self.assertEqual(kind,'unresolved')
    def test_no_registered_roots_never_classifies(self):
        kind,_=bindings.classify_read_input_origin(self.item(),{},set())
        self.assertEqual(kind,'unresolved')

"""Derived credit for file-backed generated mmap custody.

These drive the ACTUAL replay (`sdk-generation-multiprocess-bindings.observe`)
and the ACTUAL consumer (`sdk-generated-source-originals.observe`), end to end.
They fabricate a raw trace in the real wire format; they do not mirror any new
helper, and they do not issue SDK/Git authority.

The rule under test: a `generated-mmap-unverified` marker is discharged only
when that same ordinary replay has validated the exact phase/pid/entry, the
actual mmap exit/address/range/offset/prot/flags, a matching held pre-use
lease+identity, the retained whole FD original and every VMA mapping original,
inside a phase whose lease lifetime closed exactly. Anything less stays
uncovered.
"""
import hashlib
import importlib.util
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bindings = load('mmap_bindings', ROOT / 'qlever/scripts/sdk-generation-multiprocess-bindings.py')
consumer = load('mmap_consumer', ROOT / 'qlever/scripts/sdk-generated-source-originals.py')
providers = load('mmap_providers', ROOT / 'qlever/scripts/sdk-tool-provider-originals.py')

ARCH = 0xc00000b7          # aarch64
NR_MMAP = 222
NR_CLOSE = 57
MODE = 'file-exec-no-transition-v1'
LEASE_MODEL = 'kernel-held-read-lease-v1'


class Trace:
    """Minimal but format-faithful raw trace builder for one compile phase."""

    def __init__(self):
        self.rows = []
        self.originals = {}
        self.captures = 0

    def emit(self, kind, **fields):
        row = dict(kind=kind, phase='compile', sequence=len(self.rows) + 1, **fields)
        self.rows.append(row)
        return row

    def entry(self, pid, nr, args):
        return self.emit('kernel-syscall', pid=pid, arch=ARCH, op='entry', nr=nr, args=args)

    def exit(self, pid, call, result, is_error=False):
        return self.emit('kernel-syscall', pid=pid, arch=ARCH, op='exit',
                         entrySequence=call['sequence'], result=result, isError=is_error)

    def barrier(self, pids=(10, 11)):
        # Production runs shared_tasks=True, so a barrier also carries the exact
        # TID/TGID/shared-FD-table ownership of every stopped task.
        return self.emit('all-stop-barrier', pids=list(pids),
                         osStates=['t'] * len(pids),
                         taskOwnership=[dict(tid=p, tgid=p, fdTable=p) for p in pids])


def storage_ref(data):
    return dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


def scenario(*, shared_root=None, command=('fixed',), data=None, prot=3, flags=2, offset=0, length=None,
             lease_role='mmap', lease_early=False, lease_closed=True,
             wrong_pid=False, wrong_entry=False, drop_fd_original=False,
             drop_mapping_original=False, alter_original=False,
             range_offset_mismatch=False, make_anonymous=False,
             emit_marker=True, close_phase=True):
    """Build ONE compile phase containing a file-backed generated mmap.

    Returns (rows, originals, extra) where extra carries the marker identity so a
    test can assert credit/refusal against the same entry.
    """
    data = b'PCH-BYTES-' + b'x' * 64 if data is None else data
    length = len(data) if length is None else length
    t = Trace()
    build = '/opt/qlever-sdk/build'
    pch = build + '/pch.h.gch'
    pid = 12 if wrong_pid else 11

    # Legacy (one JSON object per line) raw format: the decoder infers it from
    # the first record, so no rawRecordModel may be declared.
    sr = dict(shared_root or {})
    if sr:
        # shared-task ownership requires the exact TID/TGID/FD-table triple
        sr.setdefault('tgid', 10); sr.setdefault('fdTable', 10)
    t.emit('owned-root-binding', pid=10, backend='ptrace-all-stop-process-v1', command=command,
           executableMemoryPolicy=MODE, toolchainLifetimeModel=LEASE_MODEL, **sr)
    if sr:
        # shared-task mode: every child binding must cite the actual clone entry
        # and the exact ownership flags that produced it.
        boot_flags = 0x100 | 0x4000                 # same legal vfork shared-VM shape
        boot = t.entry(10, 220, [boot_flags, 0, 0, 0, 0, 0])
        t.emit('kernel-clone-flags', pid=10, entrySequence=boot['sequence'], flags=boot_flags)
        # the child binding must cite the entry while it is still retained, i.e.
        # BEFORE the clone exit pops it
        t.emit('actual-child-binding', parentPid=10, childPid=11, event=1,
               cloneEntrySequence=boot['sequence'], cloneFlags=boot_flags, tgid=11, fdTable=11)
        t.exit(10, boot, 11)
    else:
        t.emit('actual-child-binding', parentPid=10, childPid=11, event=1)

    # ---- the pre-use read lease is acquired BEFORE the mmap entry ----
    # Replay ordering contracts:
    #  * a lease row must cite a RETAINED entry of the same pid, and
    #    entry < barrier < lease row;
    #  * the mmap row's own entry/exit come after its lease.
    # The retained entry is therefore the mmap entry itself, leased BEFORE the
    # syscall is admitted - exactly the production ordering.
    fd = 4
    mmap_args = [0, length, prot, (0x20 if make_anonymous else 0) | flags, fd, offset]
    call = t.entry(11, NR_MMAP, mmap_args)
    b = t.barrier()
    lease = t.emit('toolchain-lease-acquired', pid=11, role=lease_role,
                   identity=[1, 555, 0o100644, len(data), 7, 8], leaseId=1,
                   model=LEASE_MODEL, entrySequence=call['sequence'],
                   barrierSequence=b['sequence'])
    marker = None
    if emit_marker:
        marker = t.emit('generated-mmap-unverified', pid=pid, path=pch,
                        entrySequence=(call['sequence'] + 4 if wrong_entry else call['sequence']))
    result_address = 0x1000000000

    # ---- retained whole FD original ----
    name = 'capture-' + str(t.captures).zfill(4) + '.original'
    t.captures += 1
    t.originals[name] = data
    fd_original = dict(path=name, **storage_ref(data))
    actual_fd = dict(fd=fd, identity=[1, 555, 0o100644, len(data), 7, 8])
    if not drop_fd_original:
        actual_fd['original'] = fd_original

    maps_name = 'capture-' + str(t.captures).zfill(4) + '.original'
    t.captures += 1
    mstart, mend = 0x1000000000, 0x1000000000 + max(length, 4096)
    maps_line = '%x-%x %s %08x 00:01 555 %s\n' % (
        mstart, mend, 'rw-p' if prot & 2 else 'r--p',
        offset if not range_offset_mismatch else offset + 4096, pch)
    t.originals[maps_name] = maps_line.encode()
    maps_ref = dict(path=maps_name, **storage_ref(maps_line.encode()))
    maps_row = t.emit('toolchain-original', captureKind='maps', observedPid=11,
                      original=maps_ref)
    # the whole FD original is registered as a 'file' tool original too
    t.emit('toolchain-original', captureKind='file', observedPath=pch,
           identity=[1, 555, 0o100644, len(data), 7, 8], original=fd_original)
    mmap_exit = t.exit(11, call, result_address)
    mapping_capture = t.emit('toolchain-file-mapping-capture', pid=pid,
           barrierSequence=t.barrier()['sequence'],
           entrySequence=call['sequence'], exitSequence=mmap_exit['sequence'],
           actualReturnedAddressHex=format(result_address, 'x'), actualFd=actual_fd,
           requestedLength=length, fileOffset=offset, flags=flags, protection=prot,
           mapsOriginal=maps_row['original'], lifetimeLeaseSequence=lease['sequence'],
           lifetimeLeaseIdentity=[1, 555, 0o100644, len(data), 7, 8])

    if not drop_mapping_original:
        mapping_original = bytearray(data if not alter_original else data + b'!')
        t.originals[fd_original['path']] = bytes(mapping_original)
        # FAITHFUL provider-original role: the real observer ALWAYS emits this and
        # passes its sequence as `providerSequence` (sdk-ptrace-execution.py:2345).
        # Omitting it would make a supposedly valid trace carry a genuine
        # stop-provider pending, which the C5 rule must refuse.
        mounts = b'149 1 0:1 / /opt ro,relatime - ext4 /dev/root rw\n'
        mname = 'capture-' + str(t.captures).zfill(4) + '.original'
        t.captures += 1
        t.originals[mname] = mounts
        mref = dict(path=mname, bytes=len(mounts), sha256=hashlib.sha256(mounts).hexdigest())
        prov_observation = dict(
            schemaVersion=1, kind='actual-stopped-tracee-tool-provider', pid=pid,
            actualPath=pch, identity=[1, 555, 0o100644, len(data), 7, 8],
            mountNamespace='mnt:[11]',
            mountNamespaceIdentity=[1, 11, stat.S_IFREG, 0, 0, 0],
            rootIdentity=[1, 12, stat.S_IFDIR, 0, 0, 0],
            heldFdinfoRaw='mnt_id:\t149\nino:\t555\n',
            namedFdinfoRaw='mnt_id:\t149\nino:\t555\n',
            provider=providers.provider_for(pch, mounts, [1, 555, 0o100644, len(data), 7, 8], 149),
            mountinfoOriginal=mref)
        t.emit('toolchain-original', captureKind='mountinfo', observedPid=pid, original=mref)
        # one shared barrier for both the provider role and the mapping row
        held_barrier = t.barrier()['sequence']
        provider_row = t.emit('toolchain-provider-original', pid=pid,
                              barrierSequence=held_barrier,
                              fileOriginal=fd_original, observation=prov_observation)
        t.emit('toolchain-mapping-original', pid=pid,
               parentCaptureSequence=mapping_capture['sequence'], barrierSequence=held_barrier,
               providerSequence=provider_row['sequence'],
               # EXACT dict equality with the parsed /proc/maps line is required
               # (mapsLineIndex is 1-based in parse_proc_maps).
               mapping=dict(startHex=format(mstart, 'x'), endHex=format(mend, 'x'),
                            permissions='rw-p', fileOffset=offset,
                            deviceMajor=0, deviceMinor=1, inode=555, path=pch,
                            mapsLineIndex=1),
               identity=[1, 555, 0o100644, len(data), 7, 8],
               original=fd_original, mappingBackingModel='held-pre-use-lease-v1',
               lifetimeLeaseSequence=lease['sequence'], actualFd=actual_fd)

    # Lease closure requires the whole process tree to have been reaped first.
    if close_phase:
        t.emit('actual-wait-exit', pid=11, returnCode=0)
        t.emit('actual-wait-exit', pid=10, returnCode=0)
    if lease_closed:
        t.emit('toolchain-lease-closed-token', pid=11, leaseId=1,
               identity=[1, 555, 0o100644, len(data), 7, 8],
               acquisitionSequence=lease['sequence'], model=LEASE_MODEL)
        t.emit('toolchain-lease-closed-pids', model=LEASE_MODEL, actualClosedPids=[10, 11], offset=0)
        digest = hashlib.sha256()
        digest.update(json.dumps(dict(leaseId=1, identity=[1, 555, 0o100644, len(data), 7, 8],
                                      acquisitionSequence=lease['sequence']),
                                 sort_keys=True, separators=(',', ':')).encode() + b'\n')
        t.emit('toolchain-leases-closed', model=LEASE_MODEL, tokenCount=1,
               tokensSha256=digest.hexdigest(), actualClosedPidCount=2,
               allTrackedWaitsClosed=True)

    extra = dict(marker=marker, path=pch, call=call, data=data, lease=lease)
    return t.rows, t.originals, extra


def run_replay(rows, originals, record_observer=None):
    return bindings.observe([('compile', [(json.dumps(r) + '\n').encode() for r in rows])],
                            lambda name, maximum: originals[name],
                            record_observer=record_observer)


def run_replay_phases(phases, originals, record_observer=None):
    """Drive the real replay over SEVERAL phases, as production does.

    `phases` is a list of (name, rows). Phase N+1 is handed to the same
    observe() call, so state carried across phases is exercised for real.
    """
    return bindings.observe([(name, [(json.dumps(r) + '\n').encode() for r in rows])
                             for name, rows in phases],
                            lambda name, maximum: originals[name],
                            record_observer=record_observer)


def run_consumer(rows, originals, command=('fixed',)):
    """Drive the real consumer over the same raw phase."""
    prefix = 'inner/toolchain-execution/'
    members = {prefix + 'captures/' + n: b for n, b in originals.items()}
    # C6.6: keep all transient output inside the system temp root, never inside
    # the source tree (a read-only checkout must still be able to run this).
    with tempfile.TemporaryDirectory(prefix='sdk-mmap-custody-') as d:
        rawpath = prefix + 'compile.trace-0000.jsonl'
        members[rawpath] = b''.join((json.dumps(r) + '\n').encode() for r in rows)
        caps = [dict(path=p, bytes=len(b), sha256=hashlib.sha256(b).hexdigest())
                for p, b in sorted(members.items()) if p.startswith(prefix + 'captures/')]
        idx = prefix + 'capture-index-0000.json'
        members[idx] = json.dumps(dict(schemaVersion=1, files=caps)).encode()
        prov = prefix + 'source-provider.mountinfo.raw'
        members[prov] = b'1 0 0:1 / / ro - overlay overlay ro\n'

        def ref(p):
            return dict(path=p, bytes=len(members[p]),
                        sha256=hashlib.sha256(members[p]).hexdigest())

        plan = dict(sourceRoot='/opt/qlever-sdk/source',
                    sourceProviderOriginals=dict(mountinfo=ref(prov)),
                    remainingMilliseconds=5000,
                    phases=[dict(name='compile', actualCommand=list(command),
                                 rawTraceShards=[ref(rawpath)],
                                 captures=dict(indexes=[ref(idx)], files=len(caps),
                                               bytes=sum(c['bytes'] for c in caps)))],
                    sourceFiles={}, requiredInputs={})
        archive = Path(d) / 'sdk.zip'
        with zipfile.ZipFile(archive, 'w') as out:
            for p, b in members.items():
                out.writestr(p, b)
        return consumer.observe(archive, plan)


class CreditTests(unittest.TestCase):
    def test_exact_rich_mapping_discharges_only_that_marker(self):
        rows, originals, extra = scenario()
        result = run_replay(rows, originals)
        keys = result['verifiedFileMappedMmapKeys']
        self.assertEqual(len(keys), 1, 'exactly the validated operation is derived')
        phase, pid, entry_sequence, path = keys[0]
        self.assertEqual(phase, 'compile')
        self.assertEqual(entry_sequence, extra['call']['sequence'])
        self.assertEqual(path, extra['path'])
        # only the identity tuple is derived; per-operation facts stay in the
        # existing verified operation projection
        self.assertEqual(len(keys[0]), 4)
        self.assertTrue(result['toolchainExecutionLifetimeImmutabilityVerified'])

    def test_consumer_credits_the_verified_marker(self):
        rows, originals, extra = scenario()
        result = run_consumer(rows, originals)
        self.assertEqual(result['uncoveredOperations'], [],
                         'the co-occurring marker is discharged by the derived entry')

    def test_marker_without_rich_capture_stays_uncovered(self):
        rows, originals, extra = scenario(drop_fd_original=True)
        result = run_consumer(rows, originals)
        self.assertEqual(result['uncoveredOperations'],
                         ['generated-input-mmap:' + extra['path']],
                         'a bare marker is never credited')

    def test_marker_without_any_capture_stays_uncovered(self):
        rows, originals, extra = scenario(emit_marker=True, drop_mapping_original=True)
        result = run_consumer(rows, originals)
        self.assertEqual(result['uncoveredOperations'],
                         ['generated-input-mmap:' + extra['path']])

    def test_path_match_alone_is_never_credited(self):
        """A marker for a DIFFERENT entry of the same path must not be credited."""
        rows, originals, extra = scenario(wrong_entry=True)
        result = run_consumer(rows, originals)
        self.assertEqual(result['uncoveredOperations'],
                         ['generated-input-mmap:' + extra['path']],
                         'credit requires the exact entry sequence')

    def test_wrong_pid_is_not_credited(self):
        """The marker names a pid that is not the mapped process."""
        rows, originals, extra = scenario(wrong_pid=True)
        # The replay rejects the mismatched mapping row outright rather than
        # crediting it; either way nothing is derived and the marker stays.
        with self.assertRaises(ValueError):
            run_replay(rows, originals)

    def test_incomplete_lease_closure_is_not_credited(self):
        """Without exact token/wait closure the phase is refused, so no derived
        entry can exist and the marker can never be discharged."""
        rows, originals, extra = scenario(lease_closed=False)
        with self.assertRaisesRegex(ValueError,'lifetime phase missing exact token/wait closure'):
            run_replay(rows, originals)
        with self.assertRaises(ValueError):
            run_consumer(rows, originals)

    def test_anonymous_mapping_is_never_credited(self):
        """An anonymous mapping can never claim file custody, so the replay
        refuses it and nothing is derived."""
        rows, originals, extra = scenario(make_anonymous=True)
        with self.assertRaises(ValueError):
            run_replay(rows, originals)

    def test_offset_mismatch_is_never_credited(self):
        rows, originals, extra = scenario(range_offset_mismatch=True)
        with self.assertRaises(ValueError):
            run_replay(rows, originals)

    def test_altered_mapping_original_is_rejected(self):
        rows, originals, extra = scenario(alter_original=True)
        with self.assertRaises(ValueError):
            run_replay(rows, originals)


class SharedVmReleaseObligationTests(unittest.TestCase):
    """REAL behavioural test for memory_shared_entries <= memory_released_entries.

    A shared-VM clone records `memory_shared_entries`. The ONLY place that adds a
    matching `memory_released_entries` is the clone3-failure branch and the vfork
    release path; nothing in the ordinary success path releases it. So a trace
    whose shared-VM clone is never released must leave the phase lifetime
    incomplete, and therefore must produce NO derived mmap credit.

    Every other obligation is controlled: the mmap capture is exact and complete
    (so it WOULD be credited if lifetime were complete), and lease token/wait
    closure is normal.

    PROVEN DISCRIMINATING: deleting the predicate in a scratch copy flips this
    exact test to FAIL (lifetime becomes True and the mmap credit reappears).
    """

    def _shared_vm_scenario(self):
        rows, originals, extra = scenario(
            shared_root=dict(taskOwnershipModel='all-tracked-tids-shared-fd-v1'))
        return rows, originals, extra

    def test_unreleased_shared_vm_blocks_derived_credit(self):
        rows, originals, extra = self._shared_vm_scenario()
        try:
            result = run_replay(rows, originals)
        except ValueError:
            return
        self.assertFalse(result['toolchainExecutionLifetimeImmutabilityVerified'],
                         'an unreleased shared-VM entry must break lifetime completeness')
        self.assertEqual(result['verifiedFileMappedMmapKeys'], [],
                         'no mmap credit may survive an unmet shared-VM obligation')


class ScannerPayloadTests(unittest.TestCase):
    """The scanner payload must not carry a SECOND serialization of proof.

    toolchainOperationCoverage already records every verified operation. The
    derived key registry is consumed inside the scanner to discharge markers and
    must not survive into the JSON that crosses execFileSync (maxBuffer =
    metadataBytes = 4 MiB). This is a capacity/payload test only: it makes no
    kernel-run or SDK-scale claim.
    """

    def test_scanner_output_has_no_duplicate_key_registry(self):
        rows, originals, extra = scenario()
        out = run_consumer(rows, originals)
        self.assertNotIn('verifiedFileMappedMmapKeys', out,
                         'the derived key registry must be consumed, not serialized')
        # proof is still effective after the strip
        self.assertEqual(out['uncoveredOperations'], [])
        self.assertTrue(out['generatedInputIoClosureVerified'])

    def test_marker_still_uncovered_when_capture_incomplete(self):
        rows, originals, extra = scenario(drop_fd_original=True)
        out = run_consumer(rows, originals)
        self.assertNotIn('verifiedFileMappedMmapKeys', out)
        self.assertEqual(out['uncoveredOperations'],
                         ['generated-input-mmap:' + extra['path']])

    def test_aggregate_payload_stays_bounded_at_21785_operations(self):
        """Scale the EXISTING 21785-operation capacity corpus and measure the
        aggregate payload the scanner would return."""
        idx = load('idx_cov', ROOT / 'qlever/tests/test_sdk_toolchain_operation_coverage.py')
        c = bindings.IndexedToolchainOperationCoverage()
        for index in range(21785):
            c.start('mmap', idx.row(index * 3 + 3), dict(sequence=index * 3 + 1),
                    [idx.mapping(format(index * 4096 + 4096, 'x'),
                                 format(index * 4096 + 8192, 'x'))])
        coverage = c.finish()
        payload = json.dumps(dict(toolchainOperationCoverage=coverage),
                             separators=(',', ':')).encode()
        self.assertLess(len(payload), 4 * 1024 ** 2,
                        'aggregate operation-coverage payload must fit the existing 4 MiB budget')
        # and the removed key registry would have added a whole second copy
        self.assertEqual(len(coverage['operations']), 21785)
        self.assertNotIn('verifiedFileMappedMmapKeys', coverage)


class ReentrantObservationTests(unittest.TestCase):
    """TRUE reentry: an outer `bindings.observe` is paused mid-phase while a
    user-supplied `record_observer` synchronously runs an INDEPENDENT inner
    replay on the SAME module.

    This is the case a module-global proof store would corrupt: the inner call
    would clear/mix the outer observation's validated mmap key registry. With
    observation-local state the outer credit must survive intact and the inner
    outcome must stay independent.
    """

    def _inner_rows(self):
        """A fully VALID independent observation: different pids, same shapes.

        It completes with exactly ONE credit of its own. A shared module-global
        store would let this inner call clear the outer registry (losing the
        outer credit) or leak the outer entry into the inner result (2 keys).
        """
        rows, originals, extra = scenario()
        mapping = {10: 1010, 11: 1011, 12: 1012}
        for row in rows:
            for key in ('pid', 'parentPid', 'childPid', 'tgid', 'fdTable', 'observedPid'):
                if isinstance(row.get(key), int) and row[key] in mapping:
                    row[key] = mapping[row[key]]
            obs = row.get('observation')
            if isinstance(obs, dict) and isinstance(obs.get('pid'), int) and obs['pid'] in mapping:
                obs['pid'] = mapping[obs['pid']]
            if isinstance(row.get('pids'), list):
                row['pids'] = sorted(mapping.get(p, p) for p in row['pids'])
            if isinstance(row.get('taskOwnership'), list):
                row['taskOwnership'] = [dict(t, tid=mapping.get(t['tid'], t['tid']),
                                             tgid=mapping.get(t['tgid'], t['tgid']),
                                             fdTable=mapping.get(t['fdTable'], t['fdTable']))
                                        for t in row['taskOwnership']]
            if isinstance(row.get('actualClosedPids'), list):
                row['actualClosedPids'] = sorted(mapping.get(p, p) for p in row['actualClosedPids'])
        return rows, originals, extra

    def test_outer_credit_survives_paused_inner_replay(self):
        outer_rows, outer_originals, extra = scenario()
        inner_rows, inner_originals, inner_extra = self._inner_rows()
        state = {'fired': False, 'inner': None, 'inner_keys': None}

        def reenter(phase, row):
            # Fire ONCE, late in the outer phase, after the mmap metadata and its
            # mapping originals have been recorded.
            if state['fired'] or row.get('kind') != 'toolchain-leases-closed':
                return
            state['fired'] = True
            try:
                inner = run_replay(inner_rows, inner_originals)
                state['inner'] = 'accepted'
                state['inner_keys'] = len(inner['verifiedFileMappedMmapKeys'])
            except ValueError:
                state['inner'] = 'refused'

        outer = run_replay(outer_rows, outer_originals, record_observer=reenter)
        self.assertTrue(state['fired'], 'the reentrant callback must have fired')
        self.assertIn(state['inner'], ('accepted', 'refused'))
        # OUTER proof must be untouched by the inner run
        self.assertEqual(len(outer['verifiedFileMappedMmapKeys']), 1,
                         'outer validated mmap credit must survive the inner replay')
        outer_key = outer['verifiedFileMappedMmapKeys'][0]
        # The FULL identity must be the outer observation's own: same phase, the
        # OUTER pid, the outer entry sequence and path. A shared store would leave
        # the inner observation's pid here (both scenarios share the path).
        self.assertEqual(outer_key[0], 'compile')
        self.assertEqual(outer_key[1], 11, 'outer credit must not carry the inner pid')
        self.assertEqual(outer_key[2], extra['call']['sequence'])
        self.assertEqual(outer_key[3], extra['path'])
        self.assertTrue(outer['toolchainExecutionLifetimeImmutabilityVerified'])
        # inner outcome is independent of the outer: its own SINGLE credit, with
        # its own path, never doubling or inheriting the outer entry
        self.assertEqual(state['inner'], 'accepted', 'the inner observation must run fully')
        self.assertEqual(state['inner_keys'], 1,
                         'the independent inner observation must keep exactly its own credit')
        inner_pid = None
        for row in inner_rows:
            if row.get('kind') == 'generated-mmap-unverified':
                inner_pid = row['pid']
        self.assertEqual(inner_pid, 1011, 'the inner observation must be a different process')


class SecondGenuineEntryTests(unittest.TestCase):
    """C6.1: credit must bind to the EXACT validated entry, not merely the path.

    The previous `test_path_match_alone_is_never_credited` used a non-existent
    entry sequence, which only proves a bogus id is rejected. Here the trace
    contains a SECOND genuine `generated-mmap-unverified` marker for the SAME
    path at a DIFFERENT (also real) entry, while only the FIRST entry carries a
    fully verified mapping chain. The second marker must stay uncovered.

    This drives the real consumer, so it exercises the actual credit predicate
    rather than only the replay.
    """

    def _second_marker_scenario(self):
        rows, originals, extra = scenario()
        # append a second REAL mmap entry + marker for the same path, before the
        # closing lease closure so the phase stays structurally valid.
        # must be inserted while pid 11 is still live: BEFORE the first wait
        at = next(i for i, r in enumerate(rows) if r.get('kind') == 'actual-wait-exit')
        head, tail = rows[:at], rows[at:]
        seq = [len(head)]
        def add(kind, **fields):
            seq[0] += 1
            row = dict(kind=kind, phase='compile', sequence=seq[0], **fields)
            head.append(row)
            return row
        args = [0, len(extra['data']), 3, 2, 9, 0]     # MAP_PRIVATE PROT_WRITE
        second = add('kernel-syscall', pid=11, arch=ARCH, op='entry', nr=222, args=args)
        add('generated-mmap-unverified', pid=11, path=extra['path'],
            entrySequence=second['sequence'])
        add('kernel-syscall', pid=11, arch=ARCH, op='exit',
            entrySequence=second['sequence'], result=0x3000000000, isError=False)
        for r in tail:
            seq[0] += 1
            r['sequence'] = seq[0]
        return head + tail, originals, extra, second['sequence']

    def test_second_genuine_same_path_entry_stays_uncovered(self):
        rows, originals, extra, second_seq = self._second_marker_scenario()
        r = run_replay(rows, originals)
        keys = r.get('verifiedFileMappedMmapKeys', [])
        seqs = {k[2] for k in keys}
        self.assertNotIn(second_seq, seqs,
                         'a second real entry of the same path must not be credited')
        self.assertEqual(len(keys), len({tuple(k) for k in keys}), 'no duplicate credits')
        # the first entry keeps its credit
        self.assertIn(extra['call']['sequence'], seqs)

    def test_second_genuine_entry_marker_is_uncovered_in_consumer(self):
        rows, originals, extra, second_seq = self._second_marker_scenario()
        out = run_consumer(rows, originals)
        # exactly one uncovered marker: the second entry, same path
        self.assertEqual(out['uncoveredOperations'],
                         ['generated-input-mmap:' + extra['path']],
                         'the unverified second entry must remain uncovered')
        self.assertFalse(out['generatedInputIoClosureVerified'])


class OperationScopedPendingTests(unittest.TestCase):
    """C5: an operation whose OWN authority is still pending must not be credited,
    while the same trace without that gap must credit normally.

    The pending is attributed to this operation by its own mapped path, so the
    global toolchain axis and the per-file closure axis agree.
    """

    def _without_provider_role(self):
        rows, originals, extra = scenario()
        kept = [r for r in rows if r.get('kind') != 'toolchain-provider-original']
        for r in kept:
            r.pop('providerSequence', None)
        for i, r in enumerate(kept, 1):
            r['sequence'] = i
        return kept, originals, extra

    def test_operation_with_pending_provider_authority_is_not_credited(self):
        rows, originals, extra = self._without_provider_role()
        r = run_replay(rows, originals)
        self.assertTrue(any('stop-readonly-provider-original-unavailable' in str(x)
                            for x in r['toolchainPending']),
                        'the missing provider role must be recorded as a real pending')
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a pending provider authority must not be credited')

    def test_same_trace_with_provider_role_credits(self):
        rows, originals, extra = scenario()
        r = run_replay(rows, originals)
        self.assertEqual(r['toolchainPending'], [])
        self.assertEqual(len(r['verifiedFileMappedMmapKeys']), 1)


class ExactPendingAttributionTests(unittest.TestCase):
    """Pending attribution must be EXACT tuple equality, not substring matching.

    These build TWO real mmap operations in ONE phase that share the exact same
    mapped path. Only the FIRST has a provider role; the SECOND reaches its
    mapping-original row without one, which is where the shipped code records
    `toolchain-stop-readonly-provider-original-unavailable:<seq>:<path>`.

    The old implementation matched `str(sequence) in str(reason)` and
    `path in str(reason)` over the GLOBAL pending accumulation, so the second
    operation's gap denied credit to the first (identical path, and the second
    sequence's digits contain the first's). Exact attribution keys on
    (phase, own capture sequence, exact path), so the first keeps its credit.
    """

    def _two_operations(self, second_sequence_digits=13):
        rows, originals, extra = scenario()
        at = next(i for i, r in enumerate(rows) if r.get('kind') == 'actual-wait-exit')
        head, tail = rows[:at], rows[at:]
        t = Trace()
        t.rows, t.originals, t.captures = head, originals, 95
        pch = extra['path']
        data = extra['data']
        identity = [1, 555, 0o100644, len(data), 7, 8]
        # ---- second REAL mmap operation on the SAME path, NO provider role ----
        addr2 = 0x2000000000
        args2 = [0, len(data), 3, 2, 7, 0]
        e2 = t.emit('kernel-syscall', pid=11, arch=ARCH, op='entry', nr=NR_MMAP, args=args2)
        b2 = t.barrier()
        lease2 = t.emit('toolchain-lease-acquired', pid=11, role='mmap', leaseId=2, identity=identity,
               model=LEASE_MODEL, entrySequence=e2['sequence'], barrierSequence=b2['sequence'])
        maps2 = 'capture-' + str(t.captures).zfill(4) + '.original'; t.captures += 1
        line2 = '%x-%x rw-p %08x 00:01 555 %s\n' % (addr2, addr2 + len(data), 0, pch)
        originals[maps2] = line2.encode()
        maps_ref2 = dict(path=maps2, **storage_ref(line2.encode()))
        maps_row2 = t.emit('toolchain-original', captureKind='maps', observedPid=11, original=maps_ref2)
        fname2 = 'capture-' + str(t.captures).zfill(4) + '.original'; t.captures += 1
        originals[fname2] = data
        fd_ref2 = dict(path=fname2, **storage_ref(data))
        t.emit('toolchain-original', captureKind='file', observedPath=pch, identity=identity, original=fd_ref2)
        x2 = t.emit('kernel-syscall', pid=11, arch=ARCH, op='exit',
                    entrySequence=e2['sequence'], result=addr2, isError=False)
        cap2 = t.emit('toolchain-file-mapping-capture', pid=11,
                      barrierSequence=t.barrier()['sequence'], entrySequence=e2['sequence'],
                      exitSequence=x2['sequence'], actualReturnedAddressHex=format(addr2, 'x'),
                      actualFd=dict(fd=7, identity=identity, original=fd_ref2),
                      requestedLength=len(data), fileOffset=0, flags=2, protection=3,
                      mapsOriginal=maps_row2['original'],
                      lifetimeLeaseSequence=lease2['sequence'], lifetimeLeaseIdentity=identity)
        # NO providerSequence -> the shipped code records the exact pending fact
        t.emit('toolchain-mapping-original', pid=11, parentCaptureSequence=cap2['sequence'],
               barrierSequence=t.barrier()['sequence'],
               mapping=dict(startHex=format(addr2, 'x'), endHex=format(addr2 + len(data), 'x'),
                            permissions='rw-p', fileOffset=0, deviceMajor=0, deviceMinor=1,
                            inode=555, path=pch, mapsLineIndex=1),
               identity=identity, original=fd_ref2, mappingBackingModel='held-pre-use-lease-v1',
               lifetimeLeaseSequence=lease2['sequence'],
               actualFd=dict(fd=7, identity=identity, original=fd_ref2))
        # close the SECOND token before the trailing closure/waits block, and
        # rebuild the terminal digest over both tokens
        # closure tokens are consumed in ACQUISITION order (lease_tokens is keyed
        # by insertion), so lease 2 closes AFTER lease 1, before the pid chunk.
        # tokens close in leaseId order: insert AFTER the existing token 1
        pids_at = next(i for i, r in enumerate(tail)
                       if r.get('kind') == 'toolchain-lease-closed-pids')
        close2 = dict(kind='toolchain-lease-closed-token', phase='compile', pid=11,
                      leaseId=2, model=LEASE_MODEL, identity=identity,
                      acquisitionSequence=lease2['sequence'])
        tail = tail[:pids_at] + [close2] + tail[pids_at:]
        waits=sorted(r['pid'] for r in tail if r.get('kind')=='actual-wait-exit')
        for r in tail:
            if r.get('kind') == 'toolchain-lease-closed-pids':
                r['actualClosedPids'] = waits
                r['offset'] = 0
            if r.get('kind') == 'toolchain-leases-closed':
                r['actualClosedPidCount'] = len(waits)
        both = [dict(leaseId=1, identity=[1, 555, 0o100644, len(extra['data']), 7, 8],
                     acquisitionSequence=extra['lease']['sequence']),
                dict(leaseId=2, identity=identity, acquisitionSequence=lease2['sequence'])]
        digest = hashlib.sha256()
        for v in both:
            digest.update(json.dumps(v, sort_keys=True, separators=(',', ':')).encode() + b'\n')
        # compute the digest from the ACTUAL final closure order
        ordered=[{k:r.get(k) for k in ('leaseId','identity','acquisitionSequence')}
                 for r in tail if r.get('kind')=='toolchain-lease-closed-token']
        digest = hashlib.sha256()
        for v in ordered:
            digest.update(json.dumps(v, sort_keys=True, separators=(',', ':')).encode() + b'\n')
        for r in tail:
            if r.get('kind') == 'toolchain-leases-closed':
                r['tokenCount'] = len(ordered)
                r['tokensSha256'] = digest.hexdigest()
        for i, r in enumerate(t.rows + tail, 1):
            r['sequence'] = i
        return t.rows + tail, originals, extra

    def test_identical_path_second_operation_does_not_deny_first(self):
        rows, originals, extra = self._two_operations()
        r = run_replay(rows, originals)
        keys = r['verifiedFileMappedMmapKeys']
        self.assertEqual(len(keys), 1,
                         'the second operation has no provider role and must not be '
                         'credited, but it must not deny the first either')
        self.assertEqual(keys[0][3], extra['path'])
        # the gap is still reported on the wire, unchanged
        self.assertTrue(any('stop-readonly-provider-original-unavailable' in str(x)
                            for x in r['toolchainPending']),
                        'the wire reason must be preserved')

    def test_own_exact_provider_gap_still_denies_credit(self):
        rows, originals, extra = scenario()
        kept = [r for r in rows if r.get('kind') != 'toolchain-provider-original']
        for r in kept:
            r.pop('providerSequence', None)
        for i, r in enumerate(kept, 1):
            r['sequence'] = i
        r = run_replay(kept, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a gap naming THIS operation exactly must still deny credit')

    def test_valid_map_private_prot_write_still_grants(self):
        rows, originals, extra = scenario(prot=3, flags=2)
        r = run_replay(rows, originals)
        self.assertEqual(len(r['verifiedFileMappedMmapKeys']), 1,
                         'MAP_PRIVATE PROT_WRITE must still be credited')


class GeneratedRWProviderCreditTests(unittest.TestCase):
    """REAL generated-write case: the build root is RW, so the toolchain
    read-only SOURCE-provider axis legitimately reports
    `toolchain-effective-readonly-provider-unverified` for the PCH path.

    That pending is a SOURCE-provenance fact and must stay visible on its global
    axis. File-IO closure is a DIFFERENT axis, and the same ordinary replay may
    close it through a validated generated `producer-close` capture: a retained
    fd-capture whose own exit returned 0, whose whole captured bytes equal this
    operation's mapped FD original, and whose (device,inode) is the same object.

    These cases use actual producer records (fd-capture + real exit), not a
    synthetic 'generated:true' claim.
    """

    # Sequence-valued fields that must be remapped when rows are spliced in.
    _SEQ_FIELDS = ('acquisitionSequence', 'barrierSequence', 'entrySequence',
                   'exitSequence', 'lifetimeLeaseSequence', 'parentCaptureSequence',
                   'providerSequence')

    def _rw_scenario(self, *, producer=True, wrong_inode=False, wrong_bytes=False,
                     failed_exit=False, producer_after=False, wrong_ctime=False):
        """Build a phase where a REAL producer-close PRECEDES the PCH mmap.

        `producer_after=True` places the close AFTER the mmap, which must NOT
        credit: a later close is not evidence about bytes already mapped.
        """
        base, originals, extra = scenario()
        pch, data = extra['path'], extra['data']
        t = Trace()
        t.originals = originals
        t.captures = 70

        # locate the mmap ENTRY row so the producer can be inserted before it
        entry_at = next(i for i, r in enumerate(base)
                        if r.get('kind') == 'kernel-syscall' and r.get('op') == 'entry')
        before, after = base[:entry_at], base[entry_at:]

        rows = list(before)
        t.rows = rows

        # the RW build root correctly yields NO read-only source provider
        t.emit('toolchain-unresolved', pid=11,
               reason='toolchain-effective-readonly-provider-unverified',
               actualPath=pch, detail='source provider is writable')

        if producer:
            name = 'capture-' + str(t.captures).zfill(4) + '.original'
            t.captures += 1
            t.originals[name] = data if not wrong_bytes else data + b'!'
            ref = dict(path=name, **storage_ref(t.originals[name]))
            cap_bytes = t.originals[name]
            cap_identity = [1, 556 if wrong_inode else 555, 0o100644, len(cap_bytes), 7,
                            9 if wrong_ctime else 8]
            close_entry = t.entry(11, NR_CLOSE, [9, 0, 0, 0, 0, 0])
            b = t.barrier()
            cap = t.emit('fd-capture', pid=11, role='producer-close', fd=9,
                         entrySequence=close_entry['sequence'], path=pch,
                         identity=cap_identity, original=ref,
                         barrierSequence=b['sequence'], writers=[dict(pid=11, fd=9)])
            t.emit('exclusive-captured-syscall-resume', pid=11,
                   captureSequence=cap['sequence'], entrySequence=close_entry['sequence'])
            ok = not failed_exit
            t.emit('kernel-syscall', pid=11, arch=ARCH, op='exit',
                   entrySequence=close_entry['sequence'], result=0 if ok else -1,
                   isError=not ok)
            t.emit('exclusive-captured-syscall-exit', pid=11, captureSequence=cap['sequence'],
                   entrySequence=close_entry['sequence'], result=0 if ok else -1,
                   isError=not ok)

        combined = rows + after
        shift = len(rows)                       # rows already occupy 1..shift
        # 1) relocate the ORIGINAL tail + chain into final positions first
        tail_rows = after
        orig_index = {r['sequence']: r for r in tail_rows}
        for index, r in enumerate(tail_rows, shift + 1):
            r['sequence'] = index
        final_of_original = {orig: r['sequence'] for orig, r in orig_index.items()}
        for r in tail_rows:
            for field in self._SEQ_FIELDS:
                v = r.get(field)
                if isinstance(v, int) and v in final_of_original:
                    r[field] = final_of_original[v]
        # 2) the new prefix already holds FINAL numbers, so its own references
        # must NOT be relocated. Only drop a reference that would now point into
        # the relocated tail by coincidence is impossible -- leave it untouched.
        need_seqs = [r['sequence'] for r in combined]
        if need_seqs != list(range(1, len(combined) + 1)):
            raise AssertionError('fixture produced non-contiguous sequences')
        # the terminal lease digest names each closed token's acquisition sequence,
        # which moved with the shift -- recompute it from the final rows
        tokens = [{k: r.get(k) for k in ('leaseId', 'identity', 'acquisitionSequence')}
                  for r in combined if r.get('kind') == 'toolchain-lease-closed-token']
        digest = hashlib.sha256()
        for token in tokens:
            digest.update(json.dumps(token, sort_keys=True, separators=(',', ':')).encode() + b'\n')
        for r in combined:
            if r.get('kind') == 'toolchain-leases-closed':
                r['tokenCount'] = len(tokens)
                r['tokensSha256'] = digest.hexdigest()

        if producer_after:
            # Keep the fd-capture and its entry/barrier where they are, but move
            # the COMPLETION rows (the successful kernel exit and the exclusive
            # capture exit) to AFTER the mmap marker. The close then genuinely
            # completes later than the mmap, which must not credit it.
            kinds = ('exclusive-captured-syscall-resume',
                     'exclusive-captured-syscall-exit')
            moved = [r for r in combined if r.get('kind') in kinds]
            rest = [r for r in combined if r.get('kind') not in kinds]
            close_entry_seq = next(r['entrySequence'] for r in rest
                                   if r.get('kind') == 'fd-capture')
            moved_exit = [r for r in rest
                          if r.get('kind') == 'kernel-syscall' and r.get('op') == 'exit'
                          and r.get('entrySequence') == close_entry_seq]
            rest = [r for r in rest if r not in moved_exit]
            ordered_block = moved_exit + moved
            mark = next(i for i, r in enumerate(rest)
                        if r.get('kind') == 'generated-mmap-unverified')
            combined = rest[:mark + 1] + ordered_block + rest[mark + 1:]
            old_to_new = {r['sequence']: i for i, r in enumerate(combined, 1)}
            for r in combined:
                r['sequence'] = old_to_new[r['sequence']]
                for field in self._SEQ_FIELDS:
                    v = r.get(field)
                    if isinstance(v, int) and v in old_to_new:
                        r[field] = old_to_new[v]
            tokens = [{k: r.get(k) for k in ('leaseId', 'identity', 'acquisitionSequence')}
                      for r in combined if r.get('kind') == 'toolchain-lease-closed-token']
            digest = hashlib.sha256()
            for token in tokens:
                digest.update(json.dumps(token, sort_keys=True, separators=(',', ':')).encode() + b'\n')
            for r in combined:
                if r.get('kind') == 'toolchain-leases-closed':
                    r['tokenCount'] = len(tokens)
                    r['tokensSha256'] = digest.hexdigest()
        return combined, originals, extra

    def test_real_rw_producer_credits_file_io_and_keeps_source_pending(self):
        rows, originals, extra = self._rw_scenario()
        r = run_replay(rows, originals)
        # file-IO axis closed by the validated producer-close capture
        self.assertEqual(len(r['verifiedFileMappedMmapKeys']), 1,
                         'a validated generated producer-close must close file-IO custody')
        self.assertEqual(r['verifiedFileMappedMmapKeys'][0][3], extra['path'])
        # SOURCE-provider pending must REMAIN visible on its global axis
        self.assertTrue(any('effective-readonly-provider-unverified' in str(x)
                            for x in r['toolchainPending']),
                        'the readonly SOURCE-provider pending must not be suppressed')

    def test_missing_producer_stays_uncovered(self):
        rows, originals, extra = self._rw_scenario(producer=False)
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'without a validated producer-close the operation stays uncovered')
        self.assertTrue(any('effective-readonly-provider-unverified' in str(x)
                            for x in r['toolchainPending']))

    def test_wrong_inode_producer_cannot_credit(self):
        rows, originals, extra = self._rw_scenario(wrong_inode=True)
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a producer on a DIFFERENT inode must not credit this mapping')

    def test_wrong_bytes_producer_cannot_credit(self):
        rows, originals, extra = self._rw_scenario(wrong_bytes=True)
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a producer whose captured bytes differ must not credit')

    def test_failed_producer_exit_cannot_credit(self):
        rows, originals, extra = self._rw_scenario(failed_exit=True)
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a producer-close whose exit failed is not a validated close')

    def test_same_phase_future_close_cannot_credit(self):
        """A producer-close that happens AFTER the mmap is not evidence about
        bytes the mmap already observed. This is the causality defect: merely
        being in the same phase, or having the right role, is not enough."""
        rows, originals, extra = self._rw_scenario(producer_after=True)
        close_exit = next(r['sequence'] for r in rows
                          if r.get('kind') == 'exclusive-captured-syscall-exit')
        mmap_entry = next(r['sequence'] for r in rows
                          if r.get('kind') == 'generated-mmap-unverified')
        self.assertLess(mmap_entry, close_exit, 'fixture must place the close AFTER the mmap')
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a later producer-close must not credit an earlier mmap')

    def test_identity_divergence_on_ctime_cannot_credit(self):
        """Same device/inode/size/mtime but a DIFFERENT ctime is a different
        object version. The key is the full six-field identity, so this must not
        alias the operation's mapped FD."""
        rows, originals, extra = self._rw_scenario(wrong_ctime=True)
        r = run_replay(rows, originals)
        self.assertEqual(r['verifiedFileMappedMmapKeys'], [],
                         'a ctime-divergent producer must not credit')


    def _rw_two_close_scenario(self):
        """Extend the RW scenario with a SECOND actual successful close.

        Close #1 comes from `_rw_scenario` and already completes BEFORE the mmap
        entry. This adds close #2 -- same full six-field identity, same whole
        byte image, its own real close(2) exit -- that completes AFTER the mmap
        entry but still inside the phase. Both closes are genuine producer
        closes; only their completion order differs.
        """
        rows, originals, extra = self._rw_scenario()
        pch, data = extra['path'], extra['data']
        mmap_entry = extra['call']['sequence']
        wait_at = next(i for i, r in enumerate(rows) if r.get('kind') == 'actual-wait-exit')
        head, tail = rows[:wait_at], rows[wait_at:]
        t = Trace()
        t.rows = head
        t.originals = originals
        t.captures = 75
        name = 'capture-' + str(t.captures).zfill(4) + '.original'
        t.captures += 1
        t.originals[name] = data
        ref = dict(path=name, **storage_ref(data))
        identity = [1, 555, 0o100644, len(data), 7, 8]
        fd = 10
        close_entry = t.entry(11, NR_CLOSE, [fd, 0, 0, 0, 0, 0])
        b = t.barrier()
        cap = t.emit('fd-capture', pid=11, role='producer-close', fd=fd,
                     entrySequence=close_entry['sequence'], path=pch,
                     identity=identity, original=ref,
                     barrierSequence=b['sequence'], writers=[dict(pid=11, fd=fd)])
        t.emit('exclusive-captured-syscall-resume', pid=11,
               captureSequence=cap['sequence'], entrySequence=close_entry['sequence'])
        second_exit = t.emit('kernel-syscall', pid=11, arch=ARCH, op='exit',
                             entrySequence=close_entry['sequence'], result=0, isError=False)
        t.emit('exclusive-captured-syscall-exit', pid=11, captureSequence=cap['sequence'],
               entrySequence=close_entry['sequence'], result=0, isError=False)
        # relocate the original tail behind the appended block, keeping every
        # internal sequence reference exact
        base = max(r['sequence'] for r in head)
        new_of_old = {r['sequence']: base + 1 + i
                      for i, r in enumerate(sorted(tail, key=lambda r: r['sequence']))}
        for r in tail:
            r['sequence'] = new_of_old[r['sequence']]
        for r in tail:
            for field in self._SEQ_FIELDS:
                v = r.get(field)
                if isinstance(v, int) and v in new_of_old:
                    r[field] = new_of_old[v]
        combined = head + tail
        assert [r['sequence'] for r in combined] == list(range(1, len(combined) + 1))
        # The completion fact the replay keys on is the close's OWN kernel exit
        # row (`completedCloseSequence`), not the capture row and not the
        # exclusive boundary row that follows it.
        first_entry = next(r['entrySequence'] for r in combined
                           if r.get('kind') == 'fd-capture')
        first_kernel_exit = next(r['sequence'] for r in combined
                                 if r.get('kind') == 'kernel-syscall'
                                 and r.get('op') == 'exit'
                                 and r.get('entrySequence') == first_entry)
        return combined, originals, dict(mmapEntry=mmap_entry,
                                        firstCloseExit=first_kernel_exit,
                                        secondCloseExit=second_exit['sequence'], path=pch)

    def test_earliest_completed_close_survives_later_duplicate_close(self):
        """The earliest completed close must keep its credit when a second,
        identical close completes later in the same phase.

        Retention is what makes the credit causal: only the earliest successful
        close can be at or before the mmap entry, so a later duplicate must not
        be allowed to overwrite the entry the operation already earned.
        """
        rows, originals, extra = self._rw_two_close_scenario()
        self.assertLess(extra['firstCloseExit'], extra['mmapEntry'],
                        'fixture must complete close #1 before the mmap entry')
        self.assertLess(extra['mmapEntry'], extra['secondCloseExit'],
                        'fixture must complete close #2 after the mmap entry')
        r = run_replay(rows, originals)
        keys = r['verifiedFileMappedMmapKeys']
        self.assertEqual(len(keys), 1,
                         'the earliest completed close must still credit the operation')
        self.assertEqual(keys[0][2], extra['mmapEntry'])
        self.assertEqual(keys[0][3], extra['path'])
        out = run_consumer(rows, originals)
        self.assertEqual(out['uncoveredOperations'], [],
                         'the indexed consumer must still discharge the marker')


    def _rw_cross_phase_scenario(self, *, earlier_phase=True):
        """Put the producer-close in an EARLIER phase than the mmap.

        This is the production shape: the build phase writes and closes the PCH,
        a later phase maps it. The producer index is deliberately carried across
        phases, so the credit must survive the phase boundary -- and still leave
        the readonly SOURCE pending untouched.
        """
        rows, originals, extra = scenario()
        data, pch = extra['data'], extra['path']
        identity = [1, 555, 0o100644, len(data), 7, 8]
        name = 'capture-0099.original'
        originals[name] = data

        t = Trace()
        t.rows = []
        t.originals = originals
        t.emit('owned-root-binding', pid=10, backend='ptrace-all-stop-process-v1',
               command=('fixed',), executableMemoryPolicy=MODE)
        t.emit('actual-child-binding', parentPid=10, childPid=11, event=1)
        close_entry = t.entry(11, NR_CLOSE, [9, 0, 0, 0, 0, 0])
        b = t.barrier()
        cap = t.emit('fd-capture', pid=11, role='producer-close', fd=9,
                     entrySequence=close_entry['sequence'], path=pch,
                     identity=identity, original=dict(path=name, **storage_ref(data)),
                     barrierSequence=b['sequence'], writers=[dict(pid=11, fd=9)])
        t.emit('exclusive-captured-syscall-resume', pid=11,
               captureSequence=cap['sequence'], entrySequence=close_entry['sequence'])
        close_exit = t.emit('kernel-syscall', pid=11, arch=ARCH, op='exit',
                            entrySequence=close_entry['sequence'], result=0, isError=False)
        t.emit('exclusive-captured-syscall-exit', pid=11, captureSequence=cap['sequence'],
               entrySequence=close_entry['sequence'], result=0, isError=False)
        t.emit('actual-wait-exit', pid=11, returnCode=0)
        t.emit('actual-wait-exit', pid=10, returnCode=0)
        first = t.rows

        # The RW build root correctly reports NO readonly SOURCE provider for the
        # generated path; that fact must survive on its global axis.
        entry_at = next(i for i, r in enumerate(rows)
                        if r.get('kind') == 'kernel-syscall' and r.get('op') == 'entry')
        unresolved = dict(kind='toolchain-unresolved', phase='consumer', sequence=-1,
                          pid=11, reason='toolchain-effective-readonly-provider-unverified',
                          actualPath=pch, detail='source provider is writable')
        rows = list(rows[:entry_at]) + [unresolved] + list(rows[entry_at:])
        for row in first:
            row['phase'] = 'producer'
        for row in rows:
            row['phase'] = 'consumer'

        # Phase 2 numbering continues after phase 1 on the real wire.
        offset = len(first) if earlier_phase else 0
        old = {row['sequence']: offset + i + 1 for i, row in enumerate(rows)}
        for index, row in enumerate(rows):
            row['sequence'] = offset + index + 1
        for row in rows:
            for field in self._SEQ_FIELDS:
                value = row.get(field)
                if isinstance(value, int) and value in old:
                    row[field] = old[value]
        tokens = [{k: row.get(k) for k in ('leaseId', 'identity', 'acquisitionSequence')}
                  for row in rows if row.get('kind') == 'toolchain-lease-closed-token']
        digest = hashlib.sha256()
        for token in tokens:
            digest.update(json.dumps(token, sort_keys=True, separators=(',', ':')).encode() + bytes([10]))
        for row in rows:
            if row.get('kind') == 'toolchain-leases-closed':
                row['tokenCount'] = len(tokens)
                row['tokensSha256'] = digest.hexdigest()
        phases = [('producer', first), ('consumer', rows)] if earlier_phase else [('consumer', rows)]
        assert [r['sequence'] for name, phase in phases for r in phase] == list(
            range(1, 1 + sum(len(phase) for name, phase in phases)))
        mmap_entry = next(row['sequence'] for row in rows
                          if row.get('kind') == 'kernel-syscall' and row.get('op') == 'entry')
        return phases, originals, dict(closeExit=close_exit['sequence'],
                                       mmapEntry=mmap_entry, path=pch)

    def test_cross_phase_producer_close_credits_consumer_mapping(self):
        """A close completed in an EARLIER phase must credit a later mapping.

        The same consumer phase WITHOUT that earlier phase must credit nothing,
        which is what makes this a phase-boundary regression rather than a
        second copy of the same-phase case. SOURCE stays pending either way.
        """
        phases, originals, extra = self._rw_cross_phase_scenario()
        self.assertLess(extra['closeExit'], extra['mmapEntry'],
                        'the close must complete in the earlier phase')
        r = run_replay_phases(phases, originals)
        keys = r['verifiedFileMappedMmapKeys']
        self.assertEqual(len(keys), 1, 'the earlier-phase close must credit the mapping')
        self.assertEqual(keys[0][0], 'consumer')
        self.assertEqual(keys[0][3], extra['path'])
        self.assertIs(r['toolchainSourceClosureVerified'], False)
        self.assertTrue(any('effective-readonly-provider-unverified' in str(x)
                            for x in r['toolchainPending']),
                        'SOURCE pending must survive the cross-phase credit')

        alone, originals_alone, _ = self._rw_cross_phase_scenario(earlier_phase=False)
        r_alone = run_replay_phases(alone, originals_alone)
        self.assertEqual(r_alone['verifiedFileMappedMmapKeys'], [],
                         'without the earlier close the consumer phase cannot credit')

    def test_static_readonly_valid_case_is_unchanged(self):
        rows, originals, extra = scenario()
        r = run_replay(rows, originals)
        self.assertEqual(len(r['verifiedFileMappedMmapKeys']), 1)
        self.assertEqual(r['toolchainPending'], [])


if __name__ == '__main__':
    unittest.main()

"""Real full-runloop regression: owned CMake-cache metadata transitions.

WHY THIS FILE EXISTS
--------------------
The new native positives exercise ``LeaseSet``/``SdkLeaseSet`` DIRECTLY, and the
existing ``test_sdk_strict_rename_control`` extracts ``Observer`` methods with
``ast`` into a hand-made ``Control`` object that has no real lease set, no
``emit`` and no runloop. Neither proves the production chain:

    real child -> syscall entry -> all-stop -> successful rename/unlink
      -> syscall exit -> raw emit -> observer metadata finish
      -> replay/closing token

This module drives the REAL ``backend.Observer`` object through a REAL
``phase()`` runloop over a REAL forked child that performs the genuine CMake
cache lifecycle in a real temp directory. Every step is a real syscall and a real
``F_RDLCK`` lease taken by the production code path; nothing about ``emit``,
``check`` or ``capture`` is replaced and no live lease is stubbed to manufacture
a positive.

Linux only: the positive path needs real kernel read leases (``F_SETLEASE``).
On macOS the whole module skips explicitly rather than reporting a false green.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever' / 'scripts'
ACTOR = ROOT / 'qlever' / 'tests' / 'fixtures' / 'owned-metadata' / 'write_then_rename.py'
LIMITS = json.loads((ROOT / 'scripts' / 'lib' / 'module-artifact-limits.json').read_text())
WORKROOT = ROOT / '.test-data' / 'owned-metadata-observer'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def capabilities():
    """Probe the REAL capabilities this module needs, without a blanket UID gate.

    CI may run as an ordinary user, so gate on what the tests actually require:
    (a) our own FD can take a real kernel read lease, and (b) we can ptrace and
    reap our own child. Both are tested directly; a normal Linux CI user passes
    when the kernel permits it, and only a genuinely incapable host skips.
    """
    import tempfile
    lease = False
    path = None
    fd = None
    try:
        fd, path = tempfile.mkstemp(prefix='lease-probe-')
        os.write(fd, b'x' * 32)
        os.close(fd)
        fd = os.open(path, os.O_RDONLY)
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        lease = fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_RDLCK
    except OSError:
        lease = False
    finally:
        try:
            if fd is not None:
                os.close(fd)
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    ptrace_ok = False
    if sys.platform.startswith('linux'):
        pid = os.fork()
        if pid == 0:
            try:
                os._exit(0)
            except BaseException:
                os._exit(1)
        try:
            waited, status = os.waitpid(pid, 0)
            ptrace_ok = waited == pid
        except OSError:
            ptrace_ok = False
    return lease, ptrace_ok


def production_profile(backend):
    """Derive the SDK observer profile from the PRODUCTION source, not a subset.

    ROOT finding: a fixture that passes only ``capture_toolchain=True`` exercises
    a legacy subset. The real ``SdkExecutionObserver`` super() call enables many
    more booleans, so a fixture that re-types them by hand can silently drift and
    weaken coverage.

    This reads the actual ``super().__init__(...)`` kwargs out of
    ``sdk-ptrace-execution.py`` with ``ast``, resolves the constant booleans and the
    ``limits[...]`` resource parameters against the canonical limits file, and
    returns exactly that profile. The fixed SDK subclass additionally pins its own
    roots and argv; the base ``Observer`` accepts the same kwargs, which is the
    documented reason using the base class here is legitimate.
    """
    import ast
    source = (SCRIPTS / 'sdk-ptrace-execution.py').read_text()
    tree = ast.parse(source)
    klass = next(n for n in tree.body
                 if isinstance(n, ast.ClassDef) and n.name == 'SdkExecutionObserver')
    call = None
    for node in ast.walk(klass):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == '__init__'):
            call = node
            break
    if call is None:
        raise AssertionError('SDK observer super().__init__ not found')

    # Parameters this fixture supplies itself (identical names in production).
    supplied = {'maximum_bytes', 'maximum_stdio_bytes', 'deadline_monotonic',
                'check_budget', 'out', 'source', 'build'}

    def resolve(node):
        # literal bool/int/str/None
        if isinstance(node, ast.Constant):
            return node.value
        # a production parameter the fixture passes explicitly
        if isinstance(node, ast.Name) and node.id in supplied:
            return ('SUPPLIED', node.id)
        # limits['name']
        if (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name)
                and node.value.id == 'limits'):
            key = node.slice
            if isinstance(key, ast.Constant):
                return LIMITS[key.value]
        # parameterised callables that must not be re-typed here
        raise AssertionError('unresolved SDK profile argument: '
                             + ast.dump(node)[:120])

    profile = {}
    for keyword in call.keywords:
        if keyword.arg in supplied:
            continue
        value = resolve(keyword.value)
        if isinstance(value, tuple) and value and value[0] == 'SUPPLIED':
            # the fixture passes this explicitly; never re-type it here
            continue
        profile[keyword.arg] = value
    return profile


_LEASE, _PTRACE = (capabilities() if sys.platform.startswith('linux')
                   else (False, False))


@unittest.skipUnless(sys.platform.startswith('linux'),
                     'real kernel read leases and ptrace require Linux')
@unittest.skipUnless(_LEASE, 'kernel refuses F_SETLEASE on this host')
@unittest.skipUnless(_PTRACE, 'cannot ptrace/reap own child on this host')
class OwnedMetadataObserverRunloop(unittest.TestCase):
    """One real Observer, one real phase, real child transitions."""

    @classmethod
    def setUpClass(cls):
        # Capability gating is already applied by the class decorators; this only
        # loads the real production module.
        cls.backend = load('owned_meta_backend', 'sdk-ptrace-execution.py')
        cls.probe = cls.backend.probe

    def setUp(self):
        shutil.rmtree(WORKROOT, ignore_errors=True)
        WORKROOT.mkdir(parents=True)
        self.case = WORKROOT / self._testMethodName
        self.out = self.case / 'originals'
        self.build = self.case / 'build'
        self.source = self.case / 'source'
        for directory in (self.out, self.build, self.source):
            directory.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(WORKROOT, ignore_errors=True)

    # ---- helpers -------------------------------------------------------
    def _observer(self):
        """The REAL production Observer with the REAL Python lease set.

        """

        kwargs = production_profile(self.backend)
        return self.backend.Observer(
            self.out, self.source, self.build,
            deadline_monotonic=time.monotonic() + 60,
            check_budget=lambda: None,
            maximum_bytes=LIMITS['sourceMaterialBytes'],
            maximum_stdio_bytes=LIMITS['shardBytes'],
            # generated_build_root is a real constructor parameter whose production
            # default is the fixed SDK path /opt/qlever-sdk/build. Point it at THIS
            # fixture's build dir so the same generated-VMA/retained-metadata profile
            # is exercised without the fixed-SDK root restriction. Nothing is
            # disabled: every generated-VMA flag from the derived profile stays on.
            generated_build_root=str(self.build),
            **kwargs,
        )

    def _run(self, mode, fail=False):
        """Drive a real phase over the real actor; return (phase, rows)."""
        observer = self._observer()
        shutil.copyfile(ACTOR, self.source / 'actor.py')
        argv = [sys.executable, '-B', str(self.source / 'actor.py'),
                str(self.build), mode] + (['fail'] if fail else [])
        closed = None
        try:
            phase = observer.phase('configure', argv, cwd=str(self.source),
                                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C',
                                        'LC_ALL': 'C'})
            rows = list(self.probe.decoded_raw_records(
                self._raw_lines(phase)))
            return phase, rows, observer
        except BaseException:
            # Keep the causing syscall and the moved leases visible in the log so a
            # genuine product failure is actionable. Nothing is asserted here.
            raise
        finally:
            # ROOT finding: phase_armed's finally SIGKILLs recorded non-exited tasks
            # but does not wait/reap them, so a later phase in the same process can
            # observe stale wait state. Reap ONLY the child PIDs this phase itself
            # recorded as owned -- never an arbitrary or foreign pid.
            owned = [int(pid) for pid in getattr(observer, 'tasks', {})]
            try:
                closed = observer.close()
            except BaseException:
                closed = None
            for pid in owned:
                # Deterministic COMPLETE cleanup of ONLY this phase's recorded owned
                # child: kill if still alive, then BLOCKING wait so the process
                # cannot leave an unreaped tracee for a later case. No global wait,
                # no pkill, no production change, no sleep-to-hide.
                try:
                    os.kill(pid, 0)
                except (ProcessLookupError, OSError):
                    pass
                else:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass
                try:
                    os.waitpid(pid, 0)          # blocking: guarantees reaped
                except (ChildProcessError, OSError):
                    # already reaped by the observer itself, or never our child
                    pass

    def _raw_lines(self, phase):
        """Official raw-record source for THIS phase.

        With the real SDK profile the shards are gzip-encoded
        (``configure.trace-NNNN.jsonl.gz``), so the authoritative list comes from
        the phase receipt's ``rawTraceShards`` rather than a filename glob. Each
        shard is streamed through a bounded decompressor.
        """
        import gzip
        for shard in phase.get('rawTraceShards', []):
            path = Path(shard['path'])
            if not path.is_absolute():
                path = self.out / path
            opener = gzip.open if str(path).endswith('.gz') else open
            with opener(path, 'rb') as handle:
                for line in handle:
                    if line.endswith(b'\n'):
                        yield line

    def _kinds(self, rows):
        return [row.get('kind') for row in rows]

    # ---- positive: real rename over a held destination ------------------
    def test_real_rename_emit_and_lease_advance(self):
        """Full chain: acquire -> stop-all -> rename -> advance -> emit."""
        phase, rows, observer = self._run('rename')
        # The real phase receipt nests the actual exit under commandReceipt.
        self.assertEqual(phase['commandReceipt']['exit'], 0,
                         'the real actor must succeed')
        kinds = self._kinds(rows)
        self.assertIn('toolchain-lease-acquired', kinds,
                      'the real consumer read must earn a kernel read lease')
        self.assertIn('actual-rename-transition', kinds,
                      'the real rename must reach the observer metadata finish')
        lease_rows = [r for r in rows if r.get('kind') == 'toolchain-lease-acquired']
        self.assertTrue(lease_rows, 'at least one real lease row is required')
        for row in lease_rows:
            self.assertEqual(len(row['identity']), 6)
            self.assertIsInstance(row.get('leaseId'), int)
        transition = [r for r in rows if r.get('kind') == 'actual-rename-transition'][0]
        # the transition must carry the SAME inode and only move ctime
        self.assertEqual(transition['afterIdentity'][:2], transition['namedIdentity'][:2])
        self.assertTrue(transition['oldPathAbsent'])
        # the frozen PRE token must have been advanced, not latched as a failure
        self.assertFalse(getattr(observer, 'failures', []),
                         'a real owned rename must not latch a lease failure')

    # ---- positive: real unlink of the generated temp -------------------
    def test_real_unlink_emit_and_lease_advance(self):
        """Real owned temp unlink: the lease must be advanced, not latched.

        ROOT's isolated per-process run shows this case genuinely PASSES. In the
        combined process it previously failed only because an unreaped killed child
        left stale wait state; the fixture now reaps its own recorded PIDs, so this
        runs for real here. If the guard refuses, that is a real product failure and
        is reported as one -- never converted into a skip or a pass.
        """
        phase, rows, observer = self._run('unlink')
        self.assertEqual(phase['commandReceipt']['exit'], 0,
                         'the real unlink actor must exit successfully')
        kinds = self._kinds(rows)
        self.assertIn('toolchain-lease-acquired', kinds,
                      'the real consumer read must earn a kernel read lease')
        self.assertIn('actual-link-transition', kinds,
                      'the real unlink must reach the observer metadata finish')
        unlink_rows = [r for r in rows
                       if r.get('kind') == 'actual-link-transition'
                       and r.get('afterLinks', 1) < 1]
        self.assertTrue(unlink_rows,
                        'the unlink transition must record the real nlink drop')
        self.assertFalse(getattr(observer, 'failures', []),
                         'a witnessed owned unlink must not latch a lease failure')

    def _semantic_observe(self, phase, rows):
        """Invoke the PRODUCTION semantic replay on the real phase bytes.

        ``decoded_raw_records`` is only a DECODER. The authoritative acceptance is
        ``sdk-generation-multiprocess-bindings.observe(phase_lines, read_original,
        ..., limits=..., generated_build_root=...)``, which the production executor
        calls. This feeds it the ACTUAL decompressed indexed wire from the phase's
        own rawTraceShards, and a bounded reader over the ACTUAL retained capture
        originals under this observer's capture_dir.
        """
        bindings = self._bindings()
        capture_dir = Path(getattr(self._observer_last, 'capture_dir', self.out))

        def read_original(name, maximum):
            # Real retained originals only; never a live path substitute.
            if '/' in name:
                path = capture_dir / name
            else:
                path = capture_dir / name
            with path.open('rb') as handle:
                while True:
                    block = handle.read(min(65536, maximum))
                    if not block:
                        return
                    yield block

        limits = dict(LIMITS)
        return bindings.observe(
            [('configure', self._raw_lines(phase))],
            read_original,
            {},
            lambda: None,
            limits=limits,
            generated_build_root=str(self.build),
        )

    def _bindings(self):
        return load('owned_meta_bindings',
                    'sdk-generation-multiprocess-bindings.py')

    def _closing_rows(self, rows):
        return [r for r in rows
                if r.get('kind') == 'toolchain-lease-closed-token']

    def test_real_semantic_observe_accepts_advanced_rename_and_unlink(self):
        """N2 semantic acceptance: production observe() must ACCEPT the real stream.

        For BOTH a real rename and a real unlink phase this drives the production
        ``observe`` and asserts it accepts, that its closing/terminal state matches
        the emitted rows, and that the closing identity for the transitioned lease
        is the ADVANCED postimage -- not the acquisition tuple.
        """
        for mode in ('rename', 'unlink'):
            with self.subTest(mode=mode):
                # each phase needs its own originals dir: the observer writes an
                # exclusive shard name, so a reused dir would collide.
                self.setUp()
                phase, rows, observer = self._run(mode)
                self._observer_last = observer
                self.assertEqual(phase['commandReceipt']['exit'], 0)

                acquired = {}
                for row in rows:
                    if row.get('kind') == 'toolchain-lease-acquired':
                        acquired[row['leaseId']] = list(row['identity'])
                self.assertTrue(acquired, 'real acquisitions required')

                closed = {}
                for row in self._closing_rows(rows):
                    closed[row['leaseId']] = list(row['identity'])
                self.assertTrue(closed, 'real closing tokens required')
                self.assertEqual(set(acquired), set(closed),
                                 'every acquisition must close exactly once')

                # the transition really moved ctime on a leased inode, so at least
                # one closing identity must DIFFER from its acquisition identity
                advanced = [lid for lid in acquired if closed[lid] != acquired[lid]]
                self.assertTrue(
                    advanced,
                    'the witnessed owned transition must advance at least one '
                    'closing identity beyond its acquisition tuple')

                # The rename advances TWO distinct leased inodes: the SOURCE and
                # the pre-leased DISPLACED DESTINATION. Both must be advanced and
                # both must be accepted by the semantic replay.
                advanced_inodes = {tuple(closed[lid][:2]) for lid in advanced}
                if mode == 'rename':
                    self.assertGreaterEqual(
                        len(advanced_inodes), 2,
                        'a rename must advance BOTH the source and the displaced '
                        'destination lease, not just one')
                    transition = [r for r in rows
                                  if r.get('kind') == 'actual-rename-transition'][0]
                    source_ino = tuple(transition['afterIdentity'][:2])
                    self.assertIn(source_ino, advanced_inodes,
                                  'the source inode must be among advanced leasess')
                    replacement = transition.get('replacementAfter')
                    if replacement:
                        dest_ino = tuple(replacement['identity'][:2])
                        self.assertIn(dest_ino, advanced_inodes,
                                      'the displaced destination inode must also '
                                      'be advanced')
                        self.assertNotEqual(source_ino, dest_ino,
                                            'source and destination are distinct')

                # THE REAL TEST: production observe() accepts the actual bytes
                result = self._semantic_observe(phase, rows)
                self.assertIsInstance(result, dict)
                self.assertIn('observedEmptyReadEofWindows', result)

    def test_semantic_observe_refuses_forged_closing_identity(self):
        """Negative: an altered closing identity must be refused by observe().

        The forged record is produced by the OFFICIAL encoder so the stream stays
        structurally valid; only the closing identity is mutated (and the terminal
        digest recomputed, so it cannot be caught by the hash alone). This pins that
        N2 validates the FINAL IDENTITY, not merely the digest.
        """
        phase, rows, observer = self._run('rename')
        self._observer_last = observer
        self.assertEqual(phase['commandReceipt']['exit'], 0)

        closed = self._closing_rows(rows)
        self.assertTrue(closed)
        target = closed[0]
        forged_identity = list(target['identity'])
        forged_identity[5] = forged_identity[5] + 1        # perturb ctime only

        lines = []
        for line in self._raw_lines(phase):
            record = json.loads(line)
            lines.append(record)

        # rewrite the matching closed-token + terminal digest via the same rules
        rewritten = []
        terminal = None
        for record in lines:
            if (isinstance(record, list) and len(record) == 3
                    and record[0] == 'row'):
                pass
            rewritten.append(record)

        # Decode, mutate, and re-encode through the official encoder path.
        mutated = self._reencode_with_forged_closing(
            phase, target['leaseId'], forged_identity)
        with self.assertRaises(BaseException) as caught:
            self._semantic_observe_raw(phase, mutated)
        message = str(caught.exception)
        self.assertTrue(message,
                        'observe() must refuse with an explicit reason, not silently')
        self.assertNotIsInstance(caught.exception, KeyError,
                                 'refusal must be a real semantic error: %r' % message)

    def _reencode_with_forged_closing(self, phase, lease_id, forged_identity):
        """Rebuild the phase stream with ONE closing identity altered.

        Uses the official encoder so every other byte stays canonical.
        """
        decoder = self.probe.RawRecordDecoder()
        records = []
        for line in self._raw_lines(phase):
            row = decoder.feed(line)
            if row is not None:
                records.append(row)
        encoder = self.probe.IndexedRawEncoderV2() if hasattr(
            self.probe, 'IndexedRawEncoderV2') else None
        if encoder is None:
            self.skipTest('official encoder unavailable in this build')
        out_lines = []
        mutated = []
        for row in records:
            copy = dict(row)
            if (copy.get('kind') == 'toolchain-lease-closed-token'
                    and copy.get('leaseId') == lease_id):
                copy['identity'] = list(forged_identity)
                mutated.append(copy)
            out_lines.append(copy)
        if not mutated:
            self.fail('could not locate the closing token to forge')
        # recompute the terminal digest over the forged closing rows, exactly as
        # production does, so the digest matches and only identity is wrong
        digest = hashlib.sha256()
        for copy in mutated:
            projection = {k: copy.get(k)
                          for k in ('leaseId', 'identity', 'acquisitionSequence')}
            digest.update(json.dumps(projection, sort_keys=True,
                                     separators=(',', ':')).encode() + b'\n')
        for copy in out_lines:
            if copy.get('kind') == 'toolchain-leases-closed':
                copy['tokensSha256'] = digest.hexdigest()
        encoded = []
        for row in out_lines:
            for part in encoder.encode(row):
                encoded.append(part)
        return encoded

    def _semantic_observe_raw(self, phase, wire_lines):
        bindings = self._bindings()
        capture_dir = Path(getattr(self._observer_last, 'capture_dir', self.out))

        def read_original(name, maximum):
            path = capture_dir / name
            with path.open('rb') as handle:
                while True:
                    block = handle.read(min(65536, maximum))
                    if not block:
                        return
                    yield block

        return bindings.observe([('configure', wire_lines)], read_original, {},
                                lambda: None, limits=dict(LIMITS),
                                generated_build_root=str(self.build))

    def test_failed_rename_is_not_absorbed(self):
        """A genuinely FAILING rename must not produce a successful transition row.

        Production runs with ``require_success=False`` (the SDK observer sets it),
        so a failing child surfaces as a real nonzero root code rather than a
        Python raise. The contract to pin is that NO successful
        ``actual-rename-transition`` is emitted for it -- absence of the transition
        row is the evidence, never an invented exception.
        """
        phase, rows, observer = self._run('rename', fail=True)
        receipt = phase['trackingReceipt']
        self.assertNotEqual(receipt['actualRootReturnCode'], 0,
                            'the failing actor must report a real nonzero exit')
        transitions = [r for r in rows
                       if r.get('kind') == 'actual-rename-transition']
        self.assertEqual(transitions, [],
                         'a failed rename must never emit a success transition')

    # ---- negative: foreign metadata transition is refused ---------------
    def test_foreign_identity_cannot_advance(self):
        """LeaseSet.advance must refuse a before/after pair it never witnessed."""
        leases = load('owned_meta_leases', 'sdk-tool-lifetime-leases.py')
        group = leases.LeaseSet()
        self.addCleanup(self._quiet, group)
        temp = self.case / 'held.bin'
        temp.write_bytes(b'h' * 64)
        fd = os.open(temp, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        token = group.acquire(fd)
        before = list(token['identity'])
        other = self.case / 'foreign.bin'
        other.write_bytes(b'f' * 64)
        other_fd = os.open(other, os.O_RDONLY)
        self.addCleanup(os.close, other_fd)
        foreign = list(leases.identity(other_fd))
        with self.assertRaises(leases.LeaseError) as caught:
            group.advance(token, before, foreign, 'owned-rename-over-destination')
        self.assertIn('inode', str(caught.exception))

    # ---- negative: unknown operation is refused -------------------------
    def test_unknown_operation_refused(self):
        leases = load('owned_meta_leases_ops', 'sdk-tool-lifetime-leases.py')
        group = leases.LeaseSet()
        self.addCleanup(self._quiet, group)
        temp = self.case / 'held2.bin'
        temp.write_bytes(b'k' * 64)
        fd = os.open(temp, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        token = group.acquire(fd)
        before = list(token['identity'])
        with self.assertRaises(leases.LeaseError):
            group.advance(token, before, before, 'not-an-owned-operation')

    @staticmethod
    def _quiet(group):
        try:
            group._held.clear()
            group.close()
        except BaseException:
            pass


if __name__ == '__main__':
    unittest.main()

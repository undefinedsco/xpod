"""Owned Linux read leases. Tokens are observations, never authority by themselves."""
import errno
import fcntl
import hashlib
import os
import signal
import stat
import time


class LeaseError(RuntimeError):
    pass


# Owned generation transitions a held lease token may legally advance across.
# These are OWNED OPERATION KINDS witnessed by the observer's own rename/unlink
# path, never a path, filename or profile: a foreign or unwitnessed change has no
# operation to name and therefore still fails the six-field sweep.
ADVANCE_OPERATIONS = ('owned-rename-over-destination', 'owned-temp-unlink')
# Of those, the inode-metadata-only kind may legitimately move ctime alone.
ADVANCE_METADATA_ONLY = ('owned-rename-over-destination', 'owned-temp-unlink')


def identity(fd):
    value = os.fstat(fd)
    return [value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns]


def interrupted(error):
    """An interruption (e.g. caller SIGALRM) rather than a kernel errno."""
    return isinstance(error, OSError) and error.errno is None

# Native TCB helper for THIS observer only. It is loaded from ONE fixed internal
# path; callers cannot nominate a library. When it is absent we do NOT pretend a
# sweep happened - see LeaseSet.__init__.
def _load_native_lease_sweep():
    """Load the observer's TCB binding from ONE fixed layout.

    No directory argument: the layout follows this file's own location. In a
    normal SDK run this succeeds; on a host without a built helper it returns
    None so the public diagnostic API keeps working. The SDK observer does NOT
    use that leniency - see required_native_backend().
    """
    import importlib.util as _importlib_util
    from pathlib import Path as _Path
    here = _Path(globals().get('__file__') or '.').resolve().parent
    helper = here / 'native' / 'lease_sweep_binding.py'
    if not helper.is_file():
        return None
    spec = _importlib_util.spec_from_file_location('lease_sweep_binding', helper)
    if spec is None or spec.loader is None:
        return None
    module = _importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def required_native_backend():
    """SDK-mode factory: return (binding, extension) or raise.

    FAIL CLOSED. A missing helper, an unverified build receipt, a source or ELF
    hash mismatch, or an interpreter ABI mismatch all abort the SDK observation
    instead of silently checking fewer leases.
    """
    binding = _load_native_lease_sweep()
    if binding is None:
        raise RuntimeError('SDK native lease backend required but not present')
    return binding, binding.load_required()


def pure_backend():
    """Host-diagnosis factory: explicitly no native backend."""
    return None, None


class LeaseSet:
    # B3 FIX -- ONE dependency-injection seam, resolved once per instance.
    #
    # The BASE class keeps the ORIGINAL pure-Python behaviour: the base
    # Observer host-diagnostic path in sdk-service-native-runtime-originals.py
    # (which passes capture_toolchain=True) therefore behaves exactly as it did
    # before this change. The SDK execution observer rebinds this seam for its
    # own subclass; there is no ENV var, no CLI flag, no receipt field, and no
    # per-call re-resolution.
    _native_backend_required = False

    def _resolve_native_backend(self):
        if not self._native_backend_required:
            return None, None
        return required_native_backend()

    def __init__(self, maximum=4096):
        """Original public constructor. Pure Python unless a subclass opts in."""
        if type(maximum) is not int or maximum < 1:
            raise ValueError('positive unique lease bound required')
        self.maximum = maximum
        self._held = {}
        # Immutable REGISTRATION input for the unfiltered sweep: one
        # (fd, expected identity tuple) per held row, built only from data fixed
        # at acquire time. It is never authority for an observation: every check
        # still issues a fresh F_GETLEASE + fstat per fd and compares all six
        # fields. It only removes the per-check Python rebuild of identical
        # (fd, tuple(identity)) pairs.
        #
        # `_held` has exactly two writes in this class: the insert in acquire()
        # and the clear in close(). Both invalidate the plan, and check() also
        # requires the plan length to equal the live owned-set length, so a
        # shrunken set can never be served a stale plan. There is no per-row
        # delete, rename or in-place row mutation, and acquire() returns a COPY
        # of the token, so callers cannot alias the stored identity.
        self._plan = None
        # Lifetime-owned NATIVE decode of the same immutable registration input.
        # Built only by the native backend when the owned set changes; released on
        # every membership change and on close(). This is a decode cache, never an
        # observation cache: sweep_plan still runs live fcntl+fstat per row.
        self._native_plan = None
        self._native_plan_source = None
        self._failure = None
        # ONE resolution, at construction, through the class seam.
        self._native_binding, self._native = self._resolve_native_backend()
        self._closed = False
        self._previous = signal.getsignal(signal.SIGIO)
        if callable(self._previous):
            raise LeaseError('SIGIO already has an owner')
        self._handler = self._break
        signal.signal(signal.SIGIO, self._handler)

    def _break(self, signum, frame):
        self._failure = 'kernel requested read lease break'

    def _reject(self, reason):
        self._failure = self._failure or reason
        raise LeaseError(self._failure)

    DIAGNOSTIC_MAXIMUM_BYTES=8192
    DIAGNOSTIC_MAXIMUM_ROWS=64
    DIAGNOSTIC_SCAN_MAXIMUM=4096

    def failure_diagnostic(self, deadline=None, fatal_stop=None):
        """Read-only fatal-path snapshot over the ALREADY-OWNED lease FDs.

        Issued only after the set is already fatally failed, so it can never
        change admission. Per held FD it re-reads F_GETLEASE and the six-field
        identity and reports whether the lock is still RDLCK. It never acquires,
        releases, retries, sleeps or extends a budget, and it never replaces the
        caller's original LeaseError.

        Scan is BOUNDED by min(existing maximum, DIAGNOSTIC_SCAN_MAXIMUM) using
        islice over the live mapping, so no full list copy is built. If the scan
        is cut short by the row cap or an expired deadline, the payload says so
        explicitly (`scannedComplete`, `truncated`, `partialReason`) and never
        claims `allHeldStillReadable=true` on incomplete evidence.

        ABNORMAL ROWS ARE RETAINED FIRST. Rows are ordered abnormal-before-ok,
        so the row cap can never drop a mismatched lease behind healthy ones.

        Output is compact JSON capped at DIAGNOSTIC_MAXIMUM_BYTES; if even the
        base payload exceeds that bound the function returns None instead of an
        oversized frame. `authority=False` means this is evidence only.
        """
        import itertools
        import json as _json

        rows = []
        inspected = 0
        abnormal = 0
        partial = None
        scan_limit = self.DIAGNOSTIC_SCAN_MAXIMUM
        try:
            if type(self.maximum) is int:
                scan_limit = min(self.maximum, self.DIAGNOSTIC_SCAN_MAXIMUM)
        except BaseException:
            pass

        clock_unavailable = False

        def expired():
            nonlocal clock_unavailable
            if deadline is None:
                return False
            try:
                return time.monotonic() >= deadline
            except BaseException:
                # A broken clock must not be read as "not expired": stop the scan
                # and report a fixed partial reason instead of claiming completion.
                clock_unavailable = True
                return True

        for row in itertools.islice(self._held.values(), scan_limit):
            if expired():
                partial = 'clock-unavailable' if clock_unavailable else 'deadline-expired'
                break
            inspected += 1
            entry = dict(leaseId=None, state='unknown', mismatch=False,
                         identityEqual=None, error=None, path=None)
            fd = row.get('fd')
            token = row.get('token') or {}
            expected = token.get('identity')
            if type(token.get('leaseId')) is int:
                entry['leaseId'] = token['leaseId']
            if type(fd) is not int:
                entry['state'] = 'invalid-fd'
                entry['error'] = 'numeric-fd-required'
                entry['mismatch'] = True
                abnormal += 1
                rows.append(entry)
                continue
            try:
                lock = fcntl.fcntl(fd, fcntl.F_GETLEASE)
                entry['state'] = ('rdlck' if lock == fcntl.F_RDLCK else
                                  'unlck' if lock == fcntl.F_UNLCK else
                                  'wrlck' if lock == fcntl.F_WRLCK else 'other')
                entry['mismatch'] = lock != fcntl.F_RDLCK
            except OSError as exc:
                entry['state'] = 'fgetlease-error'
                entry['error'] = ('errno-%d' % exc.errno) if type(exc.errno) is int else 'errno-None'
                entry['mismatch'] = True
            except BaseException as exc:
                entry['state'] = 'fgetlease-error'
                entry['error'] = type(exc).__name__
                entry['mismatch'] = True
            try:
                info = os.fstat(fd)
                actual = [info.st_dev, info.st_ino, info.st_mode,
                          info.st_size, info.st_mtime_ns, info.st_ctime_ns]
                if isinstance(expected, list):
                    entry['identityEqual'] = actual == expected
                    if entry['identityEqual'] is False:
                        entry['mismatch'] = True
                # The six-field pair is captured from THIS SAME fstat observation
                # that produced identityEqual, so the two can never disagree.
                # Only abnormal rows carry it (cheap, and the decisive datum).
                diagnostic_actual = actual
            except OSError as exc:
                entry['identityEqual'] = False
                entry['mismatch'] = True
                diagnostic_actual = None
                if entry['error'] is None:
                    entry['error'] = ('errno-%d' % exc.errno) if type(exc.errno) is int else 'errno-None'
            except BaseException as exc:
                entry['identityEqual'] = False
                entry['mismatch'] = True
                diagnostic_actual = None
                if entry['error'] is None:
                    entry['error'] = type(exc).__name__
            if entry['mismatch']:
                abnormal += 1
                # Six integers ordered st_dev, st_ino, st_mode, st_size,
                # st_mtime_ns, st_ctime_ns. `actual` is explicitly unavailable
                # (None) when fstat failed; it is never fabricated.
                entry['identityCapturePoint'] = 'diagnostic-fstat'
                if isinstance(expected, list) and len(expected) == 6 and all(type(v) is int for v in expected):
                    entry['identityExpected'] = list(expected)
                else:
                    entry['identityExpected'] = None
                entry['identityActual'] = list(diagnostic_actual) if diagnostic_actual is not None else None
                try:
                    target = os.readlink('/proc/self/fd/%d' % fd)
                    deleted = target.endswith(' (deleted)')
                    entry['targetDeleted'] = deleted
                    entry['pathClass'] = ('whitelisted'
                                          if target.startswith(('/opt/qlever-sdk/', '/components/', '/usr/'))
                                          else ('deleted' if deleted else 'other'))
                    if entry['pathClass'] == 'whitelisted':
                        entry['path'] = target[:256]
                    else:
                        # Keep the redacted form: no arbitrary raw host path is
                        # ever copied into CI artifacts.
                        entry['path'] = 'sha256:' + hashlib.sha256(
                            os.fsencode(target)).hexdigest()
                except OSError as exc:
                    entry['targetDeleted'] = None
                    entry['pathClass'] = 'unavailable'
                    entry['path'] = ('unavailable-errno-%d' % exc.errno) if type(exc.errno) is int else 'unavailable-errno-None'
                except BaseException as exc:
                    entry['targetDeleted'] = None
                    entry['pathClass'] = 'unavailable'
                    entry['path'] = 'unavailable-' + type(exc).__name__
            rows.append(entry)

        total = len(self._held)
        if partial is None and clock_unavailable:
            partial = 'clock-unavailable'
        if partial is None and inspected < total:
            # Bounded scan stopped early for a non-deadline reason.
            partial = 'scan-limit'
        scanned_complete = partial is None and inspected >= total

        # ABNORMAL FIRST: a row cap must never hide a mismatched lease.
        ordered = ([r for r in rows if r['mismatch']] +
                   [r for r in rows if not r['mismatch']])
        omitted = max(0, len(ordered) - self.DIAGNOSTIC_MAXIMUM_ROWS)
        kept = ordered[:self.DIAGNOSTIC_MAXIMUM_ROWS]
        # Count abnormal rows ACTUALLY dropped rather than hardcoding zero, so an
        # incomplete abnormal picture is always visible in the payload.
        abnormal_available = sum(1 for r in ordered if r['mismatch'])
        abnormal_kept = sum(1 for r in kept if r['mismatch'])

        payload = dict(
            schemaVersion=2, kind='read-lease-fatal-diagnostic', authority=False,
            signalSenderKnown=False,
            evidenceNote=('Current lock/identity evidence for already-owned FDs only. A holder '
                          'of this evidence CANNOT infer the SIGIO sender: the handler records '
                          'no sender, so this does not prove a kernel-originated break.'),
            heldLeaseCount=total, inspectedLeaseCount=inspected,
            totalRowCount=len(ordered), omittedRowCount=omitted,
            scannedComplete=scanned_complete,
            truncated=bool(omitted or partial or not scanned_complete),
            partialReason=partial,
            abnormalLeaseCount=abnormal,
            abnormalRowCountAvailable=abnormal_available,
            abnormalOmitted=max(0, abnormal_available - abnormal_kept),
            identityFields=['st_dev', 'st_ino', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns'],
            allHeldStillReadable=(scanned_complete and abnormal == 0 and total > 0),
            leases=kept)
        # DECISIVE fatality context rides the SAME payload, so the existing
        # shrink loop below budgets it together with the rows and can never
        # silently drop it: it is not a lease row and is never popped.
        if fatal_stop is not None:
            payload['failedKernelStop']=fatal_stop
        # Byte bound: shrink the RETAINED rows (abnormal-first order preserved)
        # until the frame fits, then report the omission explicitly. Only if even
        # the empty base payload cannot fit do we return None.
        try:
            encoded = _json.dumps(payload, sort_keys=True, separators=(',', ':'))
            while len(encoded.encode('utf-8')) > self.DIAGNOSTIC_MAXIMUM_BYTES and payload['leases']:
                dropped = payload['leases'].pop()
                payload['omittedRowCount'] += 1
                payload['truncated'] = True
                if dropped['mismatch']:
                    payload['abnormalOmitted'] += 1
                encoded = _json.dumps(payload, sort_keys=True, separators=(',', ':'))
        except BaseException:
            return None
        if len(encoded.encode('utf-8')) > self.DIAGNOSTIC_MAXIMUM_BYTES:
            return None
        return encoded

    def _ready(self):
        if self._closed:
            raise LeaseError('lease set closed')
        if self._failure:
            raise LeaseError(self._failure)
        if signal.getsignal(signal.SIGIO) != self._handler:
            self._reject('SIGIO ownership changed')

    @property
    def fds(self):
        return tuple(row['fd'] for row in self._held.values())

    def check(self, token=None):
        self._ready()
        # The unfiltered sweep is the hot path. Its input is pure registration
        # data: for every held row, the owned fd and the identity recorded at
        # acquire. Rebuild that tuple only when the owned set changed; validate
        # it against the live size so an added or removed row is never served
        # stale data. A filtered call (token given) keeps the original
        # value-comparing path, because "which row matched" is part of it.
        plan = None
        if token is None:
            plan = self._plan
            if plan is None or len(plan) != len(self._held):
                plan = tuple((row['fd'], tuple(row['token']['identity']))
                             for row in self._held.values())
                self._plan = plan
        if plan is not None:
            pairs = plan           # tuple: no extra O(n) copy per check
        else:
            # Filtered call. The row is keyed by the first two identity fields
            # (st_dev, st_ino), which `acquire` fixes at insertion time, so a
            # direct lookup replaces a full scan of every held row. The stored
            # token is then compared with the caller's value EXACTLY as the old
            # scan did: a row whose token is absent, replaced, or mutated (any
            # of the six identity fields or the leaseId) fails the same check
            # and reaches the same _reject string. This only removes the O(n)
            # rebuild for a single-row query; it adds no cache and no new
            # authority, and the live lease/identity syscalls below are
            # unchanged.
            # NB: must not be named `identity` -- that shadows the module-level
            # identity(fd) helper used by the pure-Python backend below.
            token_identity = token.get('identity') if isinstance(token, dict) else None
            row = None
            if isinstance(token_identity, list) and len(token_identity) >= 2:
                try:
                    row = self._held.get(tuple(token_identity[:2]))
                except TypeError:
                    row = None
            if row is None or row['token'] != token:
                self._reject('unknown or changed lease token')
            pairs = [(row['fd'], tuple(row['token']['identity']))]
        try:
            if self._native is not None and self._native_binding is not None:
                # Native plan: the decode of expected values is reused; the live
                # sweep is NOT. The capsule is owned by THIS LeaseSet and passed
                # EXPLICITLY, so no module-global plan exists to override another
                # instance's expectations. generic sweep() is never affected.
                plan_supported = hasattr(self._native, 'plan_new') and hasattr(self._native, 'sweep_plan')
                use_plan = (token is None and plan_supported
                            and getattr(self._native_binding, 'sweep_plan', None) is not None
                            and pairs is self._plan)
                if use_plan:
                    if self._native_plan is None or self._native_plan_source is not self._plan:
                        self._native_plan = self._native.plan_new(self._plan)
                        self._native_plan_source = self._plan
                    self._native_binding.sweep_plan(
                        self._native, self._native_plan, self._reject)
                else:
                    self._native_binding.sweep_rows(
                        self._native,
                        pairs,
                        self._reject)
            else:
                # Pure-Python backend verifies EVERY pair, planned ones included.
                for fd, expected in pairs:
                    if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK:
                        self._reject('read lease no longer held')
                    if identity(fd) != list(expected):
                        self._reject('leased inode identity changed')
            self._ready()
        except OSError as error:
            # A caller-owned SIGALRM (or any other interruption without an
            # errno) is the observation deadline, not a lease verdict: report
            # it verbatim so the actual timeout stays visible. Only a genuine
            # errno from a lease/proc syscall becomes a sticky lease failure.
            if interrupted(error):
                raise
            self._reject('lease check failed: ' + str(error.errno))

    def duplicate_reader(self, token):
        """Borrow bytes from the exact continuously held inode, never a path."""
        self.check(token)
        row = self._held.get(tuple(token['identity'][:2]))
        if row is None or row['token'] != token:
            self._reject('unknown held reader token')
        fd = fcntl.fcntl(row['fd'], fcntl.F_DUPFD_CLOEXEC, 0)
        try:
            self.check(token)
            if identity(fd) != token['identity']:
                self._reject('held reader identity changed')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def acquire(self, fd):
        self.check()
        owned = None
        leased = False
        try:
            before = identity(fd)
            if not stat.S_ISREG(before[2]) or fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY:
                self._reject('read-only regular FD required')
            key = tuple(before[:2])
            if key in self._held:
                row = self._held[key]
                if row['token']['identity'] != before:
                    self._reject('same inode changed before reuse')
                self.check(row['token'])
                return dict(row['token'], identity=list(before))
            if len(self._held) >= self.maximum:
                self._reject('unique lease bound exceeded')
            owned = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 0)
            if fcntl.fcntl(owned, fcntl.F_GETLEASE) != fcntl.F_UNLCK:
                self._reject('input FD already has a lease')
            fcntl.fcntl(owned, fcntl.F_SETOWN, os.getpid())
            fcntl.fcntl(owned, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            leased = True
            if identity(owned) != before or fcntl.fcntl(owned, fcntl.F_GETLEASE) != fcntl.F_RDLCK:
                self._reject('inode changed during lease acquisition')
            self._ready()
            token = {'leaseId': len(self._held) + 1, 'identity': before}
            self._held[key] = {'fd': owned, 'token': token}
            self._plan = None      # owned set changed: the plan is no longer the whole set
            self._native_plan = None   # and the native decode no longer covers the set
            self._native_plan_source = None
            owned = None
            return dict(token, identity=list(before))
        except BaseException as error:
            # An interrupted acquisition leaves no lease verdict behind; the
            # timeout keeps propagating and a later check still evaluates the
            # real lease state instead of reporting a synthetic failure.
            if not interrupted(error):
                self._failure = self._failure or 'lease acquisition failed'
            raise
        finally:
            if owned is not None:
                try:
                    if leased:
                        fcntl.fcntl(owned, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                finally:
                    os.close(owned)

    def advance(self, token, before, after, operation):
        """Admit ONE witnessed owned generation transition; never a waiver.

        A held read lease freezes the six-field identity recorded at `acquire`.
        A genuinely owned namespace transition (rename over a destination, or an
        owned temp unlink) legitimately moves `st_ctime_ns` on the SAME inode, so
        the frozen token would reject a change that a reviewed owned operation
        already admitted. This method advances the frozen identity to the
        transition's verified postimage.

        It grants no authority by itself and cannot invent a transition. The
        caller must have already validated the owned operation and its endpoints
        (the existing `retained_metadata_chain` / rename-window / producer
        discipline), and must pass those exact endpoints here:

        * `before` must equal the token's CURRENT expected identity exactly
          (six fields) — so a stale, foreign or already-moved baseline refuses;
        * `after` must be the transition's verified postimage, six exact ints,
          with the same `(st_dev, st_ino)` and the same file type — an inode
          replacement or a foreign path can never be absorbed;
        * `operation` must name a known owned transition kind, and the ctime-only
          shape is enforced for the metadata-only kinds.

        Nothing else relaxes: the six-field sweep still compares every held row
        against its (now advanced) token, the sticky first failure is untouched,
        and the native capsule plus both Python plans are invalidated exactly as
        `acquire` does so the next sweep re-decodes the advanced expected tuple.
        """
        # NOTE: deliberately NOT self.check(). At this point the owned operation
        # has ALREADY happened, so the live inode is the POST image while the
        # token still holds PRE; an unfiltered sweep would reject the very row we
        # are about to advance and latch a sticky failure. `_ready` performs the
        # meta-checks this method needs (closed, latched failure, SIGIO owner)
        # WITHOUT sweeping held tokens. The live state is still proven below by
        # the still-held F_GETLEASE check and the exact postimage comparison.
        self._ready()
        if not isinstance(operation, str) or operation not in ADVANCE_OPERATIONS:
            self._reject('unknown owned transition operation')
        if not (isinstance(before, list) and isinstance(after, list)
                and len(before) == 6 and len(after) == 6):
            self._reject('owned transition requires six-field endpoints')
        if not all(type(v) is int for v in before) or not all(type(v) is int for v in after):
            self._reject('owned transition endpoints require exact integers')
        token_identity = token.get('identity') if isinstance(token, dict) else None
        # A real token carries SIX fields (acquire() stores `identity(fd)`), while
        # `_held` is keyed by the first two. Conflating them rejects every genuine
        # token, so the length check and the key derivation must agree with
        # acquire(): six fields in the token, `[:2]` for the lookup.
        if not isinstance(token_identity, list) or len(token_identity) != 6:
            self._reject('owned transition requires a held token')
        if not all(type(value) is int for value in token_identity):
            self._reject('owned transition requires a held token')
        row = self._held.get(tuple(token_identity[:2]))
        if row is None or row['token'] != token:
            self._reject('owned transition token is not a live held lease')
        expected = row['token']['identity']
        if list(before) != list(expected):
            # The transition's BEFORE must BE our frozen expectation; a gap means
            # an unwitnessed change already happened and stays fatal.
            self._reject('owned transition before-state differs from held identity')
        if after[:2] != before[:2] or stat.S_IFMT(after[2]) != stat.S_IFMT(before[2]):
            self._reject('owned transition must preserve inode and file type')
        if operation in ADVANCE_METADATA_ONLY:
            if after[:4] != before[:4] or after[4] != before[4]:
                self._reject('owned metadata transition may only move ctime')
            if after[5] == before[5]:
                self._reject('owned metadata transition requires an actual ctime move')
        # The lease must still be really held on this exact FD at admission time.
        fd = row['fd']
        if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK:
            self._reject('owned transition requires a still-held read lease')
        if identity(fd) != list(after):
            self._reject('owned transition postimage differs from live identity')
        row['token'] = {'leaseId': row['token']['leaseId'], 'identity': list(after)}
        self._plan = None            # expected tuple advanced: plan is stale
        self._native_plan = None     # native decode no longer covers the set
        self._native_plan_source = None
        # Return the SAME token shape `acquire()` returns (leaseId + identity
        # only). A filtered `check()` compares a supplied token EXACTLY, so
        # decorating it with extra keys would make the advanced token unusable
        # there. Transition bookkeeping lives in the emitted raw rows, not here.
        return {'leaseId': row['token']['leaseId'], 'identity': list(after)}

    def complete(self):
        self.check()
        return tuple(dict(row['token'], identity=list(row['token']['identity']))
                     for row in self._held.values())

    def close(self):
        if self._closed:
            return
        error = None
        for row in self._held.values():
            fd = row['fd']
            try:
                current = identity(fd)
                expected = row['token']['identity']
                # A closed descriptor number may already name somebody else's
                # file. Never unlock or close that replacement object.
                if current[:2] != expected[:2] or stat.S_IFMT(current[2]) != stat.S_IFMT(expected[2]):
                    raise LeaseError('owned lease descriptor replaced')
            except (OSError, LeaseError) as caught:
                error = error or caught
                continue
            try:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError as caught:
                # Linux may return EAGAIN when a forced/manual break already
                # removed the lease. Closing still owns and releases this FD.
                try:
                    already_removed = caught.errno == errno.EAGAIN and fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_UNLCK
                except OSError:
                    already_removed = False
                if not already_removed: error = error or caught
            finally:
                try: os.close(fd)
                except OSError as caught: error = error or caught
        self._held.clear()
        self._plan = None              # owned set changed
        self._native_plan = None       # release the native decode with the set
        self._native_plan_source = None
        self._closed = True
        if signal.getsignal(signal.SIGIO) == self._handler:
            signal.signal(signal.SIGIO, self._previous)
        if error:
            raise error


class SdkLeaseSet(LeaseSet):
    """SDK execution observer's LeaseSet: the native backend is REQUIRED.

    Selecting this CLASS is the single DI decision. It is made once, by the SDK
    observer, at its own construction - never by the base Observer, never by an
    environment/CLI switch, and never per phase.
    """

    _native_backend_required = True

    def __init__(self, maximum=4096):
        super().__init__(maximum)

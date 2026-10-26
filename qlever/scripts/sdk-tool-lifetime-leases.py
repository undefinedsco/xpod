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

    def failure_diagnostic(self, deadline=None):
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
            except OSError as exc:
                entry['identityEqual'] = False
                entry['mismatch'] = True
                if entry['error'] is None:
                    entry['error'] = ('errno-%d' % exc.errno) if type(exc.errno) is int else 'errno-None'
            except BaseException as exc:
                entry['identityEqual'] = False
                entry['mismatch'] = True
                if entry['error'] is None:
                    entry['error'] = type(exc).__name__
            if entry['mismatch']:
                abnormal += 1
                try:
                    target = os.readlink('/proc/self/fd/%d' % fd)
                    if target.startswith(('/opt/qlever-sdk/', '/components/', '/usr/')):
                        entry['path'] = target[:256]
                    else:
                        entry['path'] = 'sha256:' + hashlib.sha256(
                            os.fsencode(target)).hexdigest()
                except OSError as exc:
                    entry['path'] = ('unavailable-errno-%d' % exc.errno) if type(exc.errno) is int else 'unavailable-errno-None'
                except BaseException as exc:
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
            allHeldStillReadable=(scanned_complete and abnormal == 0 and total > 0),
            leases=kept)
        # Byte bound: shrink the RETAINED rows (abnormal-first order preserved)
        # until the frame fits, then report the omission explicitly. Only if even
        # the empty base payload cannot fit do we return None.
        try:
            encoded = _json.dumps(payload, sort_keys=True, separators=(',', ':'))
            while len(encoded.encode('utf-8')) > self.DIAGNOSTIC_MAXIMUM_BYTES and payload['leases']:
                dropped = payload['leases'].pop()
                payload['omittedRowCount'] += 1
                payload['truncated'] = True
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
            rows = list(self._held.values())
            rows = [row for row in rows if row['token'] == token]
            if len(rows) != 1:
                self._reject('unknown or changed lease token')
            pairs = [(row['fd'], tuple(row['token']['identity'])) for row in rows]
        try:
            if self._native is not None and self._native_binding is not None:
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

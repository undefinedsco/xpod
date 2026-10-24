"""Owned Linux read leases. Tokens are observations, never authority by themselves."""
import errno
import fcntl
import os
import signal
import stat


class LeaseError(RuntimeError):
    pass


def identity(fd):
    value = os.fstat(fd)
    return [value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns]


def interrupted(error):
    """An interruption (e.g. caller SIGALRM) rather than a kernel errno."""
    return isinstance(error, OSError) and error.errno is None


class LeaseSet:
    def __init__(self, maximum=4096):
        if type(maximum) is not int or maximum < 1:
            raise ValueError('positive unique lease bound required')
        self.maximum = maximum
        self._held = {}
        self._failure = None
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
        rows = list(self._held.values())
        if token is not None:
            rows = [row for row in rows if row['token'] == token]
            if len(rows) != 1:
                self._reject('unknown or changed lease token')
        try:
            for row in rows:
                if fcntl.fcntl(row['fd'], fcntl.F_GETLEASE) != fcntl.F_RDLCK:
                    self._reject('read lease no longer held')
                if identity(row['fd']) != row['token']['identity']:
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
        self._closed = True
        if signal.getsignal(signal.SIGIO) == self._handler:
            signal.signal(signal.SIGIO, self._previous)
        if error:
            raise error

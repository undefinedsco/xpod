"""Join the host protocol session to the existing service-original ledger.

This adapter grants no CID, source, native membership or release authority.
Failed collection keeps its reservations; it cannot refund partial originals.
"""
import hashlib
import os
from pathlib import Path
import stat
import threading


def observe(command, *, retained, host_session, output, **session_args):
    if (not isinstance(output, Path) or not output.is_absolute() or
            output.parent != retained.out or output.name != 'abi-session'):
        raise ValueError('fixed direct child of the owned service original output required')
    if 'outer_parent_deadline' in session_args:
        raise ValueError('the existing service ledger alone supplies outer parent deadline')
    if 'reserve' in session_args:
        raise ValueError('the existing service ledger owns all session charges')
    metadata_limit = 1024**2
    # One serialized ledger; membership capture reserves/settles per file while
    # protocol streams are still reserving. No parallel precharge is refunded.
    ledger = threading.RLock()
    retained.ledger_lock = ledger
    reserved = retained.reserve(metadata_limit)

    def charge(amount):
        nonlocal reserved
        with ledger:
            reserved += retained.reserve(amount)

    # On any failure leave all charged bytes reserved, including partial writes.
    result = host_session.observe(command, output=output, reserve=charge,
        outer_parent_deadline=retained.budget.end, **session_args)
    expected = {'stdin.raw', 'stdout.raw', 'stderr.raw', 'result.original.json'}
    if {entry.name for entry in output.iterdir()} != expected:
        raise ValueError('closed host protocol original set required')
    identity = lambda v: (v.st_dev, v.st_ino, v.st_mode, v.st_nlink, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
    refs = []
    for name in sorted(expected):
        retained.budget.check(0)
        path = output / name
        value = path.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > metadata_limit:
            raise ValueError('bounded ordinary host protocol original required')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        primary = None
        try:
            if identity(os.fstat(fd)) != identity(value):
                raise ValueError('host protocol original replaced before open')
            pieces = []; count = 0
            while True:
                retained.budget.check(0)
                block = os.read(fd, min(65536, metadata_limit + 1 - count))
                if not block: break
                pieces.append(block); count += len(block)
                if count > metadata_limit:
                    raise ValueError('host protocol original grew')
            raw = b''.join(pieces)
            if len(raw) != value.st_size or identity(os.fstat(fd)) != identity(value) or identity(path.lstat()) != identity(value):
                raise ValueError('host protocol original changed during retention')
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                os.close(fd)
            except BaseException:
                if primary is None: raise
        refs.append(dict(path='abi-session/' + name, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
    # Existing settle independently reads/hash-checks the same closed originals.
    with ledger:
        retained.settle(reserved, refs)
    return dict(observation=result, originals=refs, serviceAbiVerified=False,
                scope='retained host protocol session only; whole service authority pending')

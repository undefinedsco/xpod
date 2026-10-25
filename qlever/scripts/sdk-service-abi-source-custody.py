"""Load fixed ABI helpers from retained Git bodies and hold actual source FDs.

This proves only helper byte custody. Git issuer, binary source pairing, native
membership, actual runtime and whole-service qualification remain independent.
"""
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import re
import types

LIMIT = 1024**2
HELPERS = {
    'declarations': 'qlever/scripts/sdk-service-abi-declarations.py',
    'collector': 'qlever/scripts/sdk-service-abi-collector.py',
    'direct_commands': 'qlever/scripts/sdk-service-abi-direct-runtime-commands.py',
    'retained_session': 'qlever/scripts/sdk-service-abi-retained-session.py',
    'host_session': 'qlever/scripts/sdk-service-abi-host-session.py',
    'transport': 'qlever/scripts/sdk-service-abi-transport.py',
    'replay': 'qlever/scripts/sdk-service-abi-protocol-replay.py',
    'helper': 'qlever/scripts/verify-local-runtime-artifacts.py',
    'seed': 'qlever/scripts/sdk-service-abi-seed.py',
    'source_custody': 'qlever/scripts/sdk-service-abi-source-custody.py',
}


def need(ok, message):
    if not ok:
        raise ValueError(message)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def read_lease(fd, path, before, check):
    check()
    need(identity(os.fstat(fd)) == before == identity(path.lstat()),
         'ABI helper lease replaced')
    parts = []; count = 0
    while count < before[4]:
        check()
        block = os.pread(fd, min(65536, before[4]-count), count)
        need(bool(block), 'short ABI helper source')
        parts.append(block); count += len(block)
    need(identity(os.fstat(fd)) == before == identity(path.lstat()),
         'ABI helper lease changed while reading')
    return b''.join(parts)


def open_lease(path, check):
    check()
    need(path.is_absolute() and path.resolve(strict=True) == path,
         'canonical ABI helper path required')
    value = path.lstat()
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_size <= LIMIT,
         'bounded single-link ABI helper file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = identity(value)
        raw = read_lease(fd, path, before, check)
        return fd, before, raw
    except BaseException:
        try:
            os.close(fd)
        except BaseException:
            pass
        raise


class Custody:
    def __init__(self, source, rows, retained):
        need(isinstance(source, Path) and source.is_absolute()
             and source.resolve(strict=True) == source, 'canonical ABI source required')
        need(isinstance(rows, dict) and set(rows) == set(HELPERS),
             'complete fixed ABI helper source set required')
        self.retained = retained; self.leases = {}; self.modules = {}; self.closed = False
        bodies = {}
        try:
            # Verify every body and actual held source before executing any module.
            for role, relative in HELPERS.items():
                row = rows[role]
                need(isinstance(row, dict) and set(row) == {'path', 'gitBlobOid', 'body'}
                     and row['path'] == relative, 'exact fixed ABI helper binding required')
                ref = row['body']
                need(isinstance(ref, dict) and set(ref) == {'path', 'bytes', 'sha256'}
                     and isinstance(ref['path'], str) and not PurePosixPath(ref['path']).is_absolute()
                     and str(PurePosixPath(ref['path'])) == ref['path']
                     and '..' not in PurePosixPath(ref['path']).parts
                     and type(ref['bytes']) is int and 0 <= ref['bytes'] <= LIMIT
                     and isinstance(ref['sha256'], str) and re.fullmatch('[a-f0-9]{64}', ref['sha256'])
                     and retained.refs.get(ref['path']) == ref, 'same retained ABI Git body required')
                body_fd = None; body_primary = None
                try:
                    body_fd, _, raw = open_lease(retained.out/ref['path'], self.check_budget)
                    need(len(raw) == ref['bytes'] and hashlib.sha256(raw).hexdigest() == ref['sha256'],
                         'retained ABI Git body differs')
                except BaseException as error:
                    body_primary = error
                    raise
                finally:
                    if body_fd is not None:
                        try:
                            os.close(body_fd)
                        except BaseException:
                            if body_primary is None:
                                raise
                need(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest() == row['gitBlobOid'],
                     'ABI helper full Git blob OID differs')
                path = source/relative
                fd, before, actual = open_lease(path, self.check_budget)
                self.leases[role] = (fd, path, before, ref['sha256'])
                need(actual == raw, 'actual ABI helper differs from retained Git source')
                bodies[role] = raw
            self.assert_current()
            for role, raw in bodies.items():
                module = types.ModuleType('xpod_held_abi_'+role)
                module.__file__ = str(source/HELPERS[role])
                exec(compile(raw, module.__file__, 'exec'), module.__dict__)
                self.modules[role] = module
            self.assert_current()
        except BaseException:
            try:
                self.close()
            except BaseException:
                pass
            raise

    def check_budget(self):
        self.retained.budget.check(10)

    def assert_current(self):
        need(not self.closed and set(self.leases) == set(HELPERS), 'complete live ABI helper custody required')
        for fd, path, before, digest in self.leases.values():
            raw = read_lease(fd, path, before, self.check_budget)
            need(hashlib.sha256(raw).hexdigest() == digest, 'held ABI helper bytes changed')

    def close(self):
        if self.closed:
            return
        self.closed = True
        primary = None
        for fd, _, _, _ in self.leases.values():
            try:
                os.close(fd)
            except BaseException as error:
                if primary is None:
                    primary = error
        if primary is not None:
            raise primary

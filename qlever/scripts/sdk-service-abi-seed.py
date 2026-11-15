"""Bounded seed generation using the one immutable reviewed smoke helper.

The parent supplies its existing private helper original/ledger and actual end.
This leaf does not provide source, binary, runtime ABI or release authority.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import stat
import sys
import time

FILE_MAXIMUM = 8*1024**2
HELPER_MAXIMUM = 4*1024**2


def need(ok, message):
    if not ok:
        raise ValueError(message)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def full_original(path, maximum, check):
    check(); need(path.is_absolute() and path.resolve(strict=True) == path,
                  'canonical fixed original required')
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
         and 0 < before.st_size <= maximum, 'bounded ordinary fixed original required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    primary = None
    try:
        need(identity(os.fstat(fd)) == identity(before), 'fixed original replaced before open')
        pieces = []; digest = hashlib.sha256(); count = 0
        while count < before.st_size:
            check(); block = os.read(fd, min(65536, before.st_size-count))
            need(bool(block), 'short fixed original')
            pieces.append(block); digest.update(block); count += len(block)
        need(identity(os.fstat(fd)) == identity(before) == identity(path.lstat()),
             'fixed original changed during full read')
        return b''.join(pieces), dict(bytes=count, sha256=digest.hexdigest(),
                                    identity=list(identity(before)))
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise


def worker(directory, helper_path, helper_sha, parent_end):
    need(type(parent_end) is float and math.isfinite(parent_end) and 0 < parent_end-time.monotonic() <= 120,
         'existing finite parent deadline required')
    check = lambda: need(time.monotonic() < parent_end, 'existing seed parent deadline exhausted')
    # Limits apply to both the database and each SQLite rollback journal file.
    # Their combined maximum was conservatively reserved by the parent.
    resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_MAXIMUM, FILE_MAXIMUM))
    root = Path(directory)
    need(root.is_absolute() and root.resolve(strict=True) == root
         and root.is_dir() and list(root.iterdir()) == [], 'fresh canonical seed directory required')
    directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    primary = None
    try:
        held = os.fstat(directory_fd); named = root.lstat()
        need(identity(held) == identity(named), 'seed directory named/held identity differs')
        raw, original = full_original(Path(helper_path), HELPER_MAXIMUM, check)
        need(original['sha256'] == helper_sha, 'immutable smoke helper digest differs')
        # Execute exactly the bytes read/hash-checked through the same helper FD.
        namespace = dict(__name__='fixed_reviewed_smoke_helper', __file__=helper_path)
        exec(compile(raw, helper_path, 'exec'), namespace)
        check(); os.fchdir(directory_fd)
        need(os.getcwd() == str(root), 'actual held seed cwd differs')
        namespace['create_smoke_database'](Path('abi.sqlite'))
        check(); after = os.fstat(directory_fd)
        need((held.st_dev, held.st_ino, held.st_mode) == (after.st_dev, after.st_ino, after.st_mode)
             and identity(after) == identity(root.lstat()), 'seed directory replaced during creation')
        need(sorted(entry.name for entry in root.iterdir()) == ['abi.sqlite'],
             'closed SQLite seed output required')
        _, ref = full_original(root/'abi.sqlite', FILE_MAXIMUM, check)
        print(json.dumps(dict(schemaVersion=1, helperOriginal=original,
            seedOriginal=ref, existingParentDeadline=parent_end,
            seedGenerated=True, serviceAbiVerified=False), sort_keys=True), flush=True)
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(directory_fd)
        except BaseException:
            if primary is None:
                raise


def generate(*, retained, helper_reference, worker_reference, assert_current, transport, control_collector):
    """Generate/register a seed once, under the original Retained contract."""
    assert_current(); budget = retained.budget; budget.check(10)
    need(isinstance(helper_reference, dict)
         and set(helper_reference) == {'path', 'bytes', 'sha256'}
         and retained.refs.get(helper_reference.get('path')) == helper_reference,
         'same private retained immutable helper original required')
    helper_path = retained.out/helper_reference['path']
    _, helper = full_original(helper_path, HELPER_MAXIMUM, lambda: budget.check(10))
    need(helper['bytes'] == helper_reference['bytes']
         and helper['sha256'] == helper_reference['sha256'], 'immutable helper ref differs')
    need(isinstance(worker_reference, dict)
         and set(worker_reference) == {'path', 'bytes', 'sha256'}
         and retained.refs.get(worker_reference.get('path')) == worker_reference,
         'same private retained seed worker original required')
    worker_raw, worker_original = full_original(retained.out/worker_reference['path'],
                    1024**2, lambda: budget.check(10))
    need(worker_original['bytes'] == worker_reference['bytes']
         and worker_original['sha256'] == worker_reference['sha256'],
         'immutable seed worker ref differs')
    worker_code = worker_raw.decode('utf-8')
    # New physical DB and rollback journal are charged before launching writes.
    seed_allocation = retained.reserve(2*FILE_MAXIMUM)
    control_allocation = retained.reserve(2*1024**2)
    directory = retained.out/'abi-seed'
    directory.mkdir(mode=0o700, exist_ok=False)
    held = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    before = os.fstat(held); primary = None
    try:
        end = min(budget.end-10, time.monotonic()+15)
        command = [sys.executable, '-I', '-S', '-B', '-c', worker_code,
                   '--worker', str(directory), str(helper_path), helper['sha256'], repr(end)]
        need(len(json.dumps(command).encode()) < 512*1024,
             'literal seed command fits pre-reserved receipt metadata')
        row = control_collector('abi-seed', command, retained,
                    retained.out, transport=transport, end=end)
        retained.settle(control_allocation, list(row.values()))
        assert_current(); budget.check(10)
        current = os.fstat(held)
        need((before.st_dev, before.st_ino, before.st_mode) ==
             (current.st_dev, current.st_ino, current.st_mode)
             and identity(current) == identity(directory.lstat()), 'seed directory lifetime differs')
        need(sorted(entry.name for entry in directory.iterdir()) == ['abi.sqlite'],
             'actual SQLite rollback journal absence and closed seed required')
        raw, seed = full_original(directory/'abi.sqlite', FILE_MAXIMUM, lambda: budget.check(10))
        stdout = retained.out/row['stdout']['path']
        observed = json.loads(full_original(stdout, 1024**2, lambda: budget.check(10))[0])
        need(observed.get('seedGenerated') is True
             and observed.get('existingParentDeadline') == end
             and observed.get('helperOriginal') == helper
             and observed.get('seedOriginal') == seed, 'actual seed worker output differs')
        reference = dict(path='abi-seed/abi.sqlite', bytes=seed['bytes'], sha256=seed['sha256'])
        # Actual waited worker + closed single-file output proves no physical
        # rollback journal remains. Register DB exactly once via sole settle.
        retained.settle(seed_allocation, [reference], {reference['path']: FILE_MAXIMUM})
        return dict(schemaVersion=1, kind='actual-bounded-service-abi-seed',
                    original=reference, helperOriginal=helper_reference, workerOriginal=worker_reference,
                    command=command, stage=row, existingParentDeadline=budget.end,
                    operationDeadline=end, serviceAbiVerified=False)
    except BaseException as error:
        primary = error
        # Failed allocations remain charged; partial DB/journal are not erased.
        raise
    finally:
        try:
            os.close(held)
        except BaseException:
            if primary is None:
                raise


if __name__ == '__main__':
    need(len(sys.argv) == 6 and sys.argv[1] == '--worker', 'fixed seed worker arguments required')
    worker(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]))

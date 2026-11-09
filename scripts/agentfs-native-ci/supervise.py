"""Own a producer/gate; publish evidence only after actual wait and log close."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import time

FRESH_BYTES = 4 * 1024**3
STOP_BYTES = 512 * 1024**2
TARGET_BYTES = 1536 * 1024**2


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def bounded_closed_raw(path, maximum, deadline=None):
    """Read only a closed, bounded regular original under its caller deadline."""
    def check():
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('parent absolute deadline exhausted during raw closure')
    check();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    identity=lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
    try:
        first=os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or first.st_size>maximum:
            raise ValueError('closed raw original exceeds caller byte bound')
        data=bytearray();digest=hashlib.sha256()
        while True:
            check();block=os.read(fd,65536)
            if not block:break
            if len(data)+len(block)>maximum:raise ValueError('closed raw original grew beyond caller bound')
            data.extend(block);digest.update(block)
        check()
        if len(data)!=first.st_size or identity(first)!=identity(os.fstat(fd)) or identity(first)!=identity(os.lstat(path)):
            raise ValueError('closed raw original identity changed')
        return digest.hexdigest(),bytes(data)
    finally:os.close(fd)

def allocated_bytes(directory):
    def walk_error(error):
        if not isinstance(error, FileNotFoundError):
            raise error

    seen, total = set(), 0
    for root, _, files in os.walk(directory, onerror=walk_error):
        for name in files:
            try:
                stat = os.lstat(os.path.join(root, name))
            except FileNotFoundError:
                # Compiler outputs may disappear between walk and lstat.
                continue
            identity = (stat.st_dev, stat.st_ino)
            if identity not in seen:
                seen.add(identity)
                total += stat.st_blocks * 512
    return total


def group_members(pgid):
    """Live Linux process-group observation. Distinguishes a true live
    descendant from a PID1-reparented zombie (state Z). Empty off Linux."""
    members = []
    try:
        names = os.listdir('/proc')
    except OSError:
        return members
    for name in names:
        if not name.isdigit():
            continue
        try:
            stat = Path('/proc', name, 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            state, ppid, pgrp = fields[0], int(fields[1]), int(fields[2])
        except (OSError, ValueError, IndexError):
            continue
        if pgrp == pgid:
            members.append({'pid': int(name), 'ppid': ppid, 'pgid': pgrp, 'state': state})
    return members


def run_stage(name, command, evidence, cwd, *, target=None, free=shutil.disk_usage,
              fresh_bytes=FRESH_BYTES, stop_bytes=STOP_BYTES, poll_seconds=1,
              environment=None, timeout=None, absolute_deadline=None, raw_limit_bytes=None, receipt_limit_bytes=None):
    """Run one producer in its own session, with a real Popen wait, a bounded
    deadline, the original continuous disk guard and a closed raw hash.

    Returns (receipt, raw_text). The raw text is read only after the log is
    closed; while the owned group has not been proven absent the text is not
    published (`None`) so a live descendant can never inject semantic bytes.
    Environment overrides are exact: callers pass a fully scoped mapping (the
    Node-only admission changes PATH alone).
    """
    if absolute_deadline is not None:
        if not isinstance(absolute_deadline,(int,float)) or not 0<absolute_deadline<float('inf'):
            raise ValueError('finite parent absolute deadline required')
        remaining=absolute_deadline-time.monotonic()
        # The existing worst-case cleanup has a 15s wait and 10s group check.
        # Reserve it inside this parent boundary rather than opening a new window.
        if remaining<=25:raise TimeoutError('parent deadline cannot fund owned cleanup')
        timeout=min(timeout,remaining-25) if timeout is not None else remaining-25
    if raw_limit_bytes is not None and (type(raw_limit_bytes) is not int or raw_limit_bytes<=0):
        raise ValueError('positive caller raw byte bound required')
    if receipt_limit_bytes is not None and (type(receipt_limit_bytes) is not int or receipt_limit_bytes <= 0):
        raise ValueError('positive caller receipt byte bound required')
    evidence = Path(evidence)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    raw_path = evidence / f'{name}.raw.log'
    before = free(evidence).free
    if before < fresh_bytes:
        raise RuntimeError(f'{name}: fresh capacity refused: {before} < {fresh_bytes}')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    monotonic = time.monotonic()
    reason = None
    # Original members are captured before any signal is sent: a post-kill
    # zombie is PID1's residue and cannot explain which processes the producer
    # actually left behind.
    before_members = None
    supervisor_error = None
    cleanup_errors = []
    group_absent = None

    def kill_group(sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        except OSError as error:
            cleanup_errors.append(f'{type(error).__name__}: {error}')

    def observe_group():
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return True
        except OSError as error:
            cleanup_errors.append(f'{type(error).__name__}: {error}')
            return None
        return False

    def snapshot_before_kill():
        nonlocal before_members
        if before_members is None:
            before_members = group_members(child.pid)

    with open(raw_path, 'xb') as raw:
        os.chmod(raw.name, 0o600)
        if absolute_deadline is not None and absolute_deadline-time.monotonic()<=25:
            raise TimeoutError('parent deadline expired before producer spawn')
        child = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE if raw_limit_bytes is not None else raw, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=environment)
        raw_count=0;raw_eof=raw_limit_bytes is None;raw_overflow=False
        if raw_limit_bytes is not None:os.set_blocking(child.stdout.fileno(),False)
        def drain():
            nonlocal raw_count,raw_eof,raw_overflow,reason
            if raw_limit_bytes is None or raw_eof:return
            for _ in range(16):
                try:block=os.read(child.stdout.fileno(),65536)
                except BlockingIOError:return
                if not block:raw_eof=True;return
                if raw_count+len(block)>raw_limit_bytes:
                    raw_overflow=True;reason=reason or 'raw byte budget';continue
                if raw_overflow:continue
                raw.write(block);raw_count+=len(block)
        try:
            while child.poll() is None:
                drain()
                if absolute_deadline is not None and time.monotonic() >= absolute_deadline-25:
                    reason = reason or 'parent absolute deadline'
                elif timeout is not None and time.monotonic() - monotonic >= timeout:
                    reason = 'producer deadline'
                elif free(evidence).free < stop_bytes:
                    reason = 'free-space floor'
                elif target and allocated_bytes(target) > TARGET_BYTES:
                    reason = 'target allocation budget'
                if reason:
                    snapshot_before_kill()
                    kill_group(signal.SIGTERM)
                    try:
                        child.wait(timeout=15 if absolute_deadline is None else max(0,min(15,absolute_deadline-time.monotonic())))
                    except subprocess.TimeoutExpired:
                        snapshot_before_kill()
                        kill_group(signal.SIGKILL)
                    break
                time.sleep(poll_seconds)
        except Exception as error:
            supervisor_error = f'{type(error).__name__}: {error}'
            reason = reason or 'supervisor observation failed'
        finally:
            if child.poll() is None:
                snapshot_before_kill()
                kill_group(signal.SIGKILL)
            try:
                code = child.wait(timeout=15 if absolute_deadline is None else max(0,min(15,absolute_deadline-time.monotonic())))
            except subprocess.TimeoutExpired as error:
                code = None
                cleanup_errors.append(f'{type(error).__name__}: {error}')
            # EPERM is unknown, never evidence of group absence.
            group_absent = observe_group()
            if group_absent is not True:
                reason = reason or ('owned descendant remained after parent wait' if group_absent is False
                                    else 'owned group absence unknown after parent wait')
                snapshot_before_kill()
                kill_group(signal.SIGKILL)
                deadline = time.monotonic() + 10 if absolute_deadline is None else min(time.monotonic()+10,absolute_deadline)
                while group_absent is False and time.monotonic() < deadline:
                    time.sleep(.1 if absolute_deadline is None else max(0,min(.1,absolute_deadline-time.monotonic())))
                    group_absent = observe_group()
            if raw_limit_bytes is not None:
                drain();child.stdout.close()
                if not raw_eof:reason=reason or 'owned raw pipe not closed'
        raw.flush();os.fsync(raw.fileno())
    bounded_hash=None;bounded_text=None
    if raw_limit_bytes is not None and code is not None and group_absent is True and raw_eof and not raw_overflow:
        try:
            bounded_hash,data=bounded_closed_raw(raw_path,raw_limit_bytes,absolute_deadline)
            bounded_text=data.decode('utf8',errors='replace')
        except Exception as error:
            supervisor_error=supervisor_error or f'{type(error).__name__}: {error}'
            reason=reason or 'raw closure exceeded caller budget'
    reserved = group_members(child.pid) if not group_absent else []
    result = dict(command=command, pid=child.pid, pgid=child.pid, actualWait=code is not None,
                  exit=code if code is not None and code >= 0 else None,
                  signal=-code if code is not None and code < 0 else None,
                  supervisorError=supervisor_error, cleanupErrors=cleanup_errors,
                  startedUTC=started, closedUTC=datetime.datetime.now(datetime.timezone.utc).isoformat() if code is not None and group_absent is True else None,
                  elapsedSeconds=time.monotonic() - monotonic, rawClosedBeforeHash=code is not None and group_absent is True and (raw_limit_bytes is None or bounded_hash is not None),
                  rawSHA256=(sha256(raw_path) if raw_limit_bytes is None else bounded_hash) if code is not None and group_absent is True else None, resourceStop=reason,
                  freshAvailableBytes=before, ownedGroupAbsentAfterWait=group_absent,
                  ownedGroupMembersBeforeStop=before_members or [],
                  ownedGroupMembers=reserved)
    if raw_limit_bytes is not None:result.update(rawByteLimit=raw_limit_bytes,retainedRawBytes=raw_count,rawOverflow=raw_overflow,actualRawPipeEof=raw_eof)
    if receipt_limit_bytes is None:
        with open(evidence / f'{name}.receipt.json', 'x') as output:
            os.chmod(output.name, 0o600)
            json.dump(result, output, indent=2)
    else:
        encoded = json.dumps(result, indent=2).encode()
        if len(encoded) > receipt_limit_bytes:
            # Cleanup and actual wait already happened. Never retain an oversized
            # snapshot or truncate it while claiming a complete successful gate.
            counts = {key: len(result[key]) for key in ('ownedGroupMembersBeforeStop','ownedGroupMembers')}
            result.update(resourceStop=result['resourceStop'] or 'caller receipt byte bound exceeded',
                          receiptSnapshotOverflow=True, unretainedSnapshotCounts=counts,
                          unretainedReceiptBytes=len(encoded), snapshotOriginalRetained=False)
            result['ownedGroupMembersBeforeStop'] = []
            result['ownedGroupMembers'] = []
            encoded = json.dumps(result, indent=2).encode()
        if len(encoded) > receipt_limit_bytes:
            raise RuntimeError('closed stage receipt exceeds caller retained allocation')
        if absolute_deadline is not None and time.monotonic() >= absolute_deadline:
            raise TimeoutError('parent end exhausted before receipt retention')
        with open(evidence / f'{name}.receipt.json', 'xb') as output:
            os.chmod(output.name, 0o600)
            for offset in range(0,len(encoded),65536):
                if absolute_deadline is not None and time.monotonic() >= absolute_deadline:
                    raise TimeoutError('parent end exhausted during receipt retention')
                output.write(encoded[offset:offset+65536])
            output.flush();os.fsync(output.fileno())
    raw_text = (raw_path.read_text(errors='replace') if raw_limit_bytes is None else bounded_text) if code is not None and group_absent is True else None
    return result, raw_text


def run_gate(name, command, evidence, cwd, **kwargs):
    """Supervised stage that must actually exit 0 with no owned descendant and
    no available raw bytes left behind by a live group."""
    result, _ = run_stage(name, command, evidence, cwd, **kwargs)
    if (result['exit'] != 0 or result['signal'] is not None or result['resourceStop']
            or not result['ownedGroupAbsentAfterWait']):
        raise RuntimeError(f"{name}: gate failed: exit={result['exit']}, signal={result['signal']}, "
                           f"resourceStop={result['resourceStop']}, groupAbsent={result['ownedGroupAbsentAfterWait']}")
    return result


def run_checked_stage(name, command, evidence, cwd, **kwargs):
    """Supervised producer whose raw bytes are returned only after the original
    exit/signal/resource/group/raw-closure gate has passed. Semantic callers
    (readelf/ldd/status) must use this, never a receipt-ignoring read."""
    receipt, text = run_stage(name, command, evidence, cwd, **kwargs)
    if (receipt['exit'] != 0 or receipt['signal'] is not None or receipt['resourceStop']
            or not receipt['ownedGroupAbsentAfterWait'] or text is None):
        raise RuntimeError(f"{name}: producer failed: exit={receipt['exit']}, "
                           f"signal={receipt['signal']}, resourceStop={receipt['resourceStop']}, "
                           f"groupAbsent={receipt['ownedGroupAbsentAfterWait']}")
    return receipt, text

"""Own a producer/gate; publish evidence only after actual wait and log close."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
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
              environment=None, timeout=None):
    """Run one producer in its own session, with a real Popen wait, a bounded
    deadline, the original continuous disk guard and a closed raw hash.

    Returns (receipt, raw_text). The raw text is read only after the log is
    closed; while the owned group has not been proven absent the text is not
    published (`None`) so a live descendant can never inject semantic bytes.
    Environment overrides are exact: callers pass a fully scoped mapping (the
    Node-only admission changes PATH alone).
    """
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
        child = subprocess.Popen(command, cwd=cwd, stdout=raw, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=environment)
        try:
            while child.poll() is None:
                if timeout is not None and time.monotonic() - monotonic >= timeout:
                    reason = 'producer deadline'
                elif free(evidence).free < stop_bytes:
                    reason = 'free-space floor'
                elif target and allocated_bytes(target) > TARGET_BYTES:
                    reason = 'target allocation budget'
                if reason:
                    snapshot_before_kill()
                    kill_group(signal.SIGTERM)
                    try:
                        child.wait(timeout=15)
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
                code = child.wait(timeout=15)
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
                deadline = time.monotonic() + 10
                while group_absent is False and time.monotonic() < deadline:
                    time.sleep(.1)
                    group_absent = observe_group()
    reserved = group_members(child.pid) if not group_absent else []
    result = dict(command=command, pid=child.pid, pgid=child.pid, actualWait=code is not None,
                  exit=code if code is not None and code >= 0 else None,
                  signal=-code if code is not None and code < 0 else None,
                  supervisorError=supervisor_error, cleanupErrors=cleanup_errors,
                  startedUTC=started, closedUTC=datetime.datetime.now(datetime.timezone.utc).isoformat() if code is not None and group_absent is True else None,
                  elapsedSeconds=time.monotonic() - monotonic, rawClosedBeforeHash=code is not None and group_absent is True,
                  rawSHA256=sha256(raw_path) if code is not None and group_absent is True else None, resourceStop=reason,
                  freshAvailableBytes=before, ownedGroupAbsentAfterWait=group_absent,
                  ownedGroupMembersBeforeStop=before_members or [],
                  ownedGroupMembers=reserved)
    with open(evidence / f'{name}.receipt.json', 'x') as output:
        os.chmod(output.name, 0o600)
        json.dump(result, output, indent=2)
    raw_text = raw_path.read_text(errors='replace') if code is not None and group_absent is True else None
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

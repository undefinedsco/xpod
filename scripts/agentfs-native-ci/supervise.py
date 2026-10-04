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
    seen, total = set(), 0
    for root, _, files in os.walk(directory):
        for name in files:
            stat = os.lstat(os.path.join(root, name))
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
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        snapshot_before_kill()
                        os.killpg(child.pid, signal.SIGKILL)
                    break
                time.sleep(poll_seconds)
        finally:
            if child.poll() is None:
                snapshot_before_kill()
                os.killpg(child.pid, signal.SIGKILL)
            code = child.wait()
            # A finished parent must not leave descendants writing the raw log.
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                group_absent = True
            else:
                group_absent = False
                reason = reason or 'owned descendant remained after parent wait'
                snapshot_before_kill()
                os.killpg(child.pid, signal.SIGKILL)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        os.killpg(child.pid, 0)
                    except ProcessLookupError:
                        group_absent = True
                        break
                    time.sleep(.1)
    reserved = group_members(child.pid) if not group_absent else []
    result = dict(command=command, pid=child.pid, pgid=child.pid, actualWait=True,
                  exit=code if code >= 0 else None, signal=-code if code < 0 else None,
                  startedUTC=started, closedUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  elapsedSeconds=time.monotonic() - monotonic, rawClosedBeforeHash=group_absent,
                  rawSHA256=sha256(raw_path) if group_absent else None, resourceStop=reason,
                  freshAvailableBytes=before, ownedGroupAbsentAfterWait=group_absent,
                  ownedGroupMembersBeforeStop=before_members or [],
                  ownedGroupMembers=reserved)
    with open(evidence / f'{name}.receipt.json', 'x') as output:
        os.chmod(output.name, 0o600)
        json.dump(result, output, indent=2)
    raw_text = raw_path.read_text(errors='replace') if group_absent else None
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

"""Own a single CI gate; publish evidence only after actual wait and log close."""
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


def run_gate(name, command, evidence, cwd, *, target=None, free=shutil.disk_usage,
             fresh_bytes=FRESH_BYTES, stop_bytes=STOP_BYTES, poll_seconds=1):
    evidence = Path(evidence)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    before = free(evidence).free
    if before < fresh_bytes:
        raise RuntimeError(f'{name}: fresh capacity refused: {before} < {fresh_bytes}')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    monotonic = time.monotonic()
    reason = None
    with open(evidence / f'{name}.raw.log', 'xb') as raw:
        os.chmod(raw.name, 0o600)
        child = subprocess.Popen(command, cwd=cwd, stdout=raw, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        try:
            while child.poll() is None:
                if free(evidence).free < stop_bytes:
                    reason = 'free-space floor'
                elif target and allocated_bytes(target) > TARGET_BYTES:
                    reason = 'target allocation budget'
                if reason:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                    break
                time.sleep(poll_seconds)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            code = child.wait()
            # A successful parent must not leave descendants writing the raw log.
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                group_absent = True
            else:
                group_absent = False
                reason = reason or 'owned descendant remained after parent wait'
                os.killpg(child.pid, signal.SIGKILL)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        os.killpg(child.pid, 0)
                    except ProcessLookupError:
                        group_absent = True
                        break
                    time.sleep(.1)
    result = dict(command=command, pid=child.pid, pgid=child.pid, actualWait=True,
                  exit=code if code >= 0 else None, signal=-code if code < 0 else None,
                  startedUTC=started, closedUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  elapsedSeconds=time.monotonic()-monotonic, rawClosedBeforeHash=group_absent,
                  rawSHA256=sha256(evidence / f'{name}.raw.log') if group_absent else None, resourceStop=reason,
                  freshAvailableBytes=before, ownedGroupAbsentAfterWait=group_absent)
    with open(evidence / f'{name}.receipt.json', 'x') as output:
        os.chmod(output.name, 0o600)
        json.dump(result, output, indent=2)
    if code != 0 or reason:
        raise RuntimeError(f'{name}: gate failed: exit={code}, resourceStop={reason}')
    return result

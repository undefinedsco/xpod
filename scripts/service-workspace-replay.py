"""Execute the fixed build in an independently prepared workspace.

Mechanical replay only. The private caller must first authenticate and stage
all inputs and tools; a successful receipt is never source authority.
"""
import importlib.util
import json
import math
import os
import signal
from pathlib import Path
import stat
import sys
import time

HERE = Path(__file__).resolve().parent

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

parent = load('workspace_replay_parent', HERE / 'service-pack-parent.py')
supervisor = load('workspace_replay_supervisor', HERE / 'agentfs-native-ci/supervise.py')
snapshots = parent.snapshots
LIMITS = parent.LIMITS
META = LIMITS['metadataBytes']
CEILING = 32 * META


def need(value, reason):
    if not value:
        raise ValueError('Service workspace replay: ' + reason)


def normalize(rows, check):
    need(isinstance(rows, (list, tuple)) and len(rows) <= LIMITS['members'], 'bounded outputs')
    result = {}
    total = metadata = 0
    for row in rows:
        check()
        need(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256', 'mode'}, 'output shape')
        name = row['path']
        need(isinstance(name, str) and name and len(name) <= 4096 and not name.startswith('/') and '\\' not in name and all(part not in ('', '.', '..') for part in name.split('/')) and all(32 <= ord(c) != 127 for c in name), 'output path')
        need(snapshots.is_generated(tuple(name.split('/'))) and name not in result, 'unique generated output')
        need(type(row['bytes']) is int and 0 <= row['bytes'] <= LIMITS['shardBytes'], 'output size')
        need(type(row['mode']) is int and 0 <= row['mode'] <= 0o777, 'output mode')
        need(isinstance(row['sha256'], str) and len(row['sha256']) == 64 and all(c in '0123456789abcdef' for c in row['sha256']), 'output SHA')
        total += row['bytes']
        metadata += len(name.encode()) + 128
        need(total <= LIMITS['sourceMaterialBytes'] and metadata <= META, 'aggregate output bounds')
        result[name] = dict(row)
    return result


def require_initial(root, check, charge_read_bytes=None):
    """Preexisting generated outputs are never replay inputs. The fixed UI roots
    are Git-tracked and authenticated by the private caller; any other
    generated output (notably component dist) proves a stale workspace."""
    for relative, _identity, _digest in snapshots.snapshot(root, check, generated=True, charge_read_bytes=charge_read_bytes)['rows']:
        parts = tuple(relative.split('/'))
        need(not any(name in parts for name in snapshots.GENERATED_NAMES) and any(parts[:len(scope)] == scope for scope in snapshots.GENERATED_ROOTS),
             'fresh workspace without generated outputs required')


def replay_workspace(root, evidence, environment, absolute_deadline, expected_outputs, check, reserve_bytes,
                    charge_read_bytes=None, retained_limit_bytes=None):
    """Real supervised commands, one deadline, exact full generated comparison.

    The expected rows are mechanical input, not provenance. This function does
    not issue or register any private capability or imply tool/input authority.
    Optional charge_read_bytes accounts actual snapshot reads; optional
    retained_limit_bytes (never above the existing ceiling) bounds the one
    caller reservation and the actual retained evidence total.
    """
    root, evidence = Path(root), Path(evidence)
    need(type(absolute_deadline) in (int, float) and math.isfinite(absolute_deadline), 'finite caller deadline')
    need(charge_read_bytes is None or callable(charge_read_bytes), 'shared read charge callback')
    limit = CEILING if retained_limit_bytes is None else retained_limit_bytes
    need(type(limit) is int and 0 < limit <= CEILING, 'bounded same-parent retained limit')
    def guard():
        check()
        if time.monotonic() >= absolute_deadline:
            raise TimeoutError('shared workspace replay deadline exhausted')
    def observe(generated=False):
        return snapshots.snapshot(root, guard, generated=generated, charge_read_bytes=charge_read_bytes)
    guard()
    need(root.is_absolute() and root.resolve(strict=True) == root and stat.S_ISDIR(os.lstat(root).st_mode), 'canonical root')
    need(evidence.is_absolute() and evidence.resolve() == evidence and evidence.parent == root / '.test-data' and evidence.name not in ('', '.', '..'), 'confined evidence directory')
    need(isinstance(environment, dict) and environment and all(isinstance(k, str) and k and '=' not in k and '\0' not in k and isinstance(v, str) and '\0' not in v for k, v in environment.items()) and bool(environment.get('PATH')), 'explicit exact child environment')
    env = dict(environment)
    expected = normalize(expected_outputs, guard)
    require_initial(root, guard, charge_read_bytes)
    before = observe()
    need({'package.json', 'bun.lock'} <= {r[0] for r in before['rows']}, 'manifest and immutable lock required')
    (root / '.test-data').mkdir(exist_ok=True)
    # Reserve all possible stage streams/receipts plus three snapshots from
    # the caller's existing shared ledger before the first evidence write.
    # This local ceiling is not an additional retained-byte allocation.
    streams = 2 * len(parent.BUILD_COMMANDS)
    reservation = (streams + 3) * META
    need(callable(reserve_bytes), 'shared retained-byte reservation required')
    if retained_limit_bytes is None:
        need(reservation <= limit, 'existing parent capacity cannot hold fixed stage evidence')
    # Default callers keep the historical single reservation; an explicit same-
    # parent limit reserves exactly that bounded ceiling instead.
    reserve_bytes(reservation if retained_limit_bytes is None else limit)
    guard()
    evidence.mkdir(exist_ok=False)
    receipts = []
    def charged():
        total = 0
        for file in evidence.iterdir():
            guard()
            info = os.lstat(file)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'regular retained originals')
            total += info.st_size
            need(total <= limit, 'shared retained evidence bound')
        return total
    def write(value, name):
        remaining = min(META, limit - charged())
        need(remaining > 0, 'same parent snapshot capacity exhausted')
        return snapshots.write_snapshot(evidence / name, value, guard, remaining)
    write(before, 'inputs.before.json')
    for name, argv in parent.BUILD_COMMANDS:
        guard()
        # Never raise the old META caps: divide only the remaining parent capacity
        # across the still-needed stream/receipt slots, requiring a nonzero floor.
        available = limit - charged()
        slots = max(1, streams - 2 * len(receipts))
        per_stage = min(META, available // (slots + 3))
        need(per_stage > 0, 'existing parent capacity cannot hold fixed stage evidence')
        receipt, _ = supervisor.run_stage(name, list(argv), evidence, root,
            environment=env, timeout=max(0, absolute_deadline - time.monotonic()),
            absolute_deadline=absolute_deadline, raw_limit_bytes=per_stage,
            receipt_limit_bytes=per_stage, stop_bytes=LIMITS['freeFloorBytes'])
        guard()
        need(parent.closed_receipt(receipt), 'actual build did not close: ' + name)
        charged()
        receipts.append(receipt)
    after = observe()
    need(before == after, 'source tree changed during replay')
    outputs = observe(generated=True)
    actual = normalize([dict(path=row[0], bytes=int(row[1][3]), sha256=row[2], mode=int(row[1][2]) & 0o777) for row in outputs['rows']], guard)
    need(actual == expected, 'complete generated output path/size/mode/SHA mismatch')
    write(after, 'inputs.after.json')
    write(outputs, 'outputs.after.json')
    total = charged()
    guard()
    return dict(outputs=[actual[name] for name in sorted(actual)], receipts=receipts, retainedBytes=total)


REQUEST_FIELDS = frozenset(['root', 'evidence', 'environment', 'remainingMs', 'expectedOutputs',
                            'remainingReadBytes', 'retainedLimitBytes'])


def main(raw):
    """Bounded JSON stdin bridge for the private TS parent. Mechanical only."""
    request = json.loads(raw)

    def shape(ok, reason):
        if not ok:
            raise ValueError('Service workspace replay request: ' + reason)

    shape(isinstance(request, dict) and set(request) == REQUEST_FIELDS, 'exact request fields')
    root, evidence = request['root'], request['evidence']
    shape(isinstance(root, str) and root, 'root string')
    shape(isinstance(evidence, str) and evidence, 'evidence string')
    remaining = request['remainingMs']
    shape(type(remaining) in (int, float) and math.isfinite(remaining) and remaining > 0, 'positive finite remainingMs')
    reads = request['remainingReadBytes']
    shape(type(reads) is int and 0 < reads <= LIMITS['sourceMaterialBytes'], 'bounded remainingReadBytes')
    retained = request['retainedLimitBytes']
    shape(type(retained) is int and 0 < retained <= CEILING, 'bounded retainedLimitBytes')
    expected = request['expectedOutputs']
    shape(isinstance(expected, list), 'expectedOutputs list')
    environment = request['environment']
    shape(isinstance(environment, dict) and environment, 'environment object')
    deadline = time.monotonic() + remaining / 1000.0
    used = [0]

    def charge(count):
        if charge is None or count < 0:
            raise ValueError('Service workspace replay request: invalid read charge')
        used[0] += count
        if used[0] > reads:
            raise ValueError('Service workspace replay request: shared read budget exhausted')

    def reserve(amount):
        if type(amount) is not int or amount <= 0 or amount > retained:
            raise ValueError('Service workspace replay request: reservation exceeds passed retained limit')

    result = replay_workspace(Path(root), Path(evidence), dict(environment), deadline, expected,
                              lambda: None, reserve, charge, retained)
    envelope = dict(outputs=result['outputs'], receipts=result['receipts'],
                    retainedBytes=result['retainedBytes'], readBytes=used[0])
    if used[0] > reads:
        raise ValueError('Service workspace replay request: shared read budget exhausted')
    return envelope


def read_request_file(name):
    """Exact request-file branch: one bounded nofollow held regular FD read."""
    need(isinstance(name, str) and name, 'request file path')
    named = os.lstat(name)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        first = os.fstat(fd)
        need(identity(first) == identity(named), 'same named request descriptor')
        need(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and first.st_size <= LIMITS['metadataBytes'],
             'bounded regular request file')
        raw = b''
        while len(raw) < first.st_size:
            block = os.read(fd, min(LIMITS['rangeBytes'], first.st_size - len(raw)))
            need(block, 'short request file')
            raw += block
        need(not os.read(fd, 1), 'request file size changed')
        after = os.fstat(fd)
        need(identity(after) == identity(first) == identity(os.lstat(name)),
             'request file changed while reading')
    finally:
        os.close(fd)
    return raw


if __name__ == '__main__':
    def cancelled(signum, frame):
        # Raise through run_stage's finally so its independently owned process
        # group is killed and waited before this observer terminates.
        raise InterruptedError('workspace replay interrupted by signal ' + str(signum))
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        # The owned-mode child runs with stdin ignored; the private parent passes
        # one exclusive request file through this exact branch only.
        if len(sys.argv) == 3 and sys.argv[1] == '--request-file':
            raw = read_request_file(sys.argv[2])
        elif len(sys.argv) == 1:
            raw = sys.stdin.buffer.read(LIMITS['metadataBytes'] + 1)
        else:
            raise ValueError('Service workspace replay request: exact CLI form required')
        if len(raw) > LIMITS['metadataBytes']:
            raise ValueError('Service workspace replay request: bounded request bytes required')
        output = json.dumps(main(raw), separators=(',', ':')).encode('utf-8')
        if len(output) > LIMITS['metadataBytes']:
            raise ValueError('Service workspace replay request: bounded response bytes required')
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
    except BaseException as failure:
        sys.stderr.write('Service workspace replay failed: ' + str(failure) + '\n')
        sys.exit(1)

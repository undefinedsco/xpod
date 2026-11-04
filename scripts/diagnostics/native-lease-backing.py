#!/usr/bin/env python3
"""Short Linux x64 lease-backing diagnostic (diagnostic only, not qualification).

One container entry point with three modes:
  generate  build the 7,526-file image corpus and its manifest
  populate  copy that corpus into the fresh ext4 named volume
  arm       run one A/B trial: canonical SdkLeaseSet.check, 200 fresh full
            checks after 2 warmups, plus identity/released/first-error controls

A = read-only corpus baked into the container image (overlay root).
B = read-only, byte-identical corpus on a fresh ext4 named volume.

The diagnostic uses a direct real-F_RDLCK row setup only to avoid O(N^2)
SdkLeaseSet.acquire(); product acquire is unchanged. It then forces the
unchanged canonical full check. Native backend is mandatory; no fallback.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import resource
import shutil
import stat
import sys
import sysconfig
import threading
import time
import traceback
from pathlib import Path

ROWS, SWEEPS, WARMUPS = 7526, 200, 2
CORPUS, VOLUME = '/probe/corpus', '/probe/volume'
MANIFEST, SRC = '/probe/corpus.manifest.json', '/src'
VARIANT = '/probe/variant.json'
HELPERS = SRC + '/scripts/diagnostics/native-lease-sweep.py'
LEASES = SRC + '/qlever/scripts/sdk-tool-lifetime-leases.py'


class Failure(RuntimeError):
    pass


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def load_helpers():
    spec = importlib.util.spec_from_file_location('backing_helpers', HELPERS)
    if spec is None or spec.loader is None:
        raise Failure('native-lease-sweep helpers unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest(root):
    entries = []
    modes, uids, gids = set(), set(), set()
    total = 0
    for path in sorted(Path(root).iterdir()):
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Failure('corpus member is not a single regular file')
        data = path.read_bytes()
        entries.append([path.name, info.st_size, info.st_mode & 0o7777,
                        info.st_uid, info.st_gid, hashlib.sha256(data).hexdigest()])
        total += len(data)
        modes.add(info.st_mode & 0o7777)
        uids.add(info.st_uid)
        gids.add(info.st_gid)
    return {
        'count': len(entries), 'bytes': total, 'modes': sorted(modes),
        'uids': sorted(uids), 'gids': sorted(gids),
        'hash': hashlib.sha256(json.dumps(
            entries, separators=(',', ':')).encode()).hexdigest(),
    }


def write_json(path, value):
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, sort_keys=True, indent=1)
        handle.write('\n')
    os.chmod(path, 0o600)


def print_json(value):
    print(json.dumps(value, sort_keys=True, separators=(',', ':')), flush=True)


def generate():
    os.makedirs(CORPUS, mode=0o755, exist_ok=False)
    payload = b'x' * 64
    for index in range(ROWS):
        fd = os.open(os.path.join(CORPUS, 'row%05d' % index),
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.write(fd, payload)
            os.fchmod(fd, 0o644)
            os.fchown(fd, 0, 0)
        finally:
            os.close(fd)
    value = manifest(CORPUS)
    write_json(MANIFEST, value)
    print_json({'ok': True, 'manifest': value})
    return 0


def populate():
    helpers = load_helpers()
    env = helpers.observe_environment(VOLUME)
    if env.get('sourceMountType') != 'ext4' or env.get('sourceMountPoint') != VOLUME:
        raise Failure('volume is not its own ext4 mount')
    if os.listdir(VOLUME):
        raise Failure('volume is not empty; refusing reuse')
    expected = json.loads(Path(MANIFEST).read_text())
    for path in sorted(Path(CORPUS).iterdir()):
        info = os.lstat(path)
        target = os.path.join(VOLUME, path.name)
        shutil.copyfile(path, target)
        os.chmod(target, info.st_mode & 0o7777)
        os.chown(target, info.st_uid, info.st_gid)
    actual = manifest(VOLUME)
    ok = actual == expected
    print_json({'ok': ok, 'manifest': actual, 'environment': env})
    return 0 if ok else 1


def start_background_threads(count):
    meta = {'requested': count, 'started': 0, 'waiting': 0,
            'aliveBeforeTiming': count == 0, 'stopped': count == 0, 'joined': count == 0}
    if count == 0:
        return None, meta
    stop = threading.Event()
    lock = threading.Lock()
    waiting = [0]
    def idle():
        with lock:
            waiting[0] += 1
        stop.wait()
    threads = [threading.Thread(target=idle, name='fanout-idle-%d' % i, daemon=True)
               for i in range(count)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with lock:
            ready = waiting[0]
        if ready == count:
            break
        time.sleep(0.01)
    meta['started'] = len(threads)
    meta['waiting'] = ready
    meta['aliveBeforeTiming'] = bool(ready == count and all(t.is_alive() for t in threads))
    if not meta['aliveBeforeTiming']:
        stop.set()
        for thread in threads:
            thread.join(timeout=5)
        raise Failure('background threads not alive and waiting')
    return (stop, threads), meta


def stop_background_threads(state, meta):
    if state is None:
        meta['stopped'] = True
        meta['joined'] = True
        return meta
    stop, threads = state
    stop.set()
    for thread in threads:
        thread.join(timeout=5)
    meta['stopped'] = True
    meta['joined'] = all(not thread.is_alive() for thread in threads)
    if not meta['joined']:
        raise Failure('background threads did not join')
    return meta


def install_rows(lease_set, corpus):
    owned = []
    try:
        for index, name in enumerate(sorted(os.listdir(corpus))):
            source = os.open(os.path.join(corpus, name),
                             os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                fd = fcntl.fcntl(source, getattr(fcntl, 'F_DUPFD_CLOEXEC', 1030), 0)
            finally:
                os.close(source)
            owned.append(fd)
            fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
            if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_UNLCK:
                raise Failure('row already leased')
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK:
                raise Failure('real read lease not held')
            info = os.fstat(fd)
            ident = (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                     info.st_mtime_ns, info.st_ctime_ns)
            key = (ident[0], ident[1])
            if key in lease_set._held:
                raise Failure('duplicate leased inode')
            lease_set._held[key] = {
                'fd': fd, 'token': {'leaseId': index + 1, 'identity': list(ident)},
            }
        lease_set._next_lease_id = ROWS + 1
        lease_set._plan = None
        lease_set._native_plan = None
        lease_set._native_plan_source = None
    except BaseException:
        for fd in owned:
            try:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        lease_set._held.clear()
        raise


def wrong_identity(ident):
    return ident[:3] + (ident[3] + 1,) + ident[4:]


def controls(lease_set, helpers, corpus):
    """Terminal controls: close the timed set before testing a fresh SIGIO owner."""
    pairs = tuple((row['fd'], tuple(row['token']['identity']))
                  for row in lease_set._held.values())
    first, second = ROWS // 5, ROWS // 3
    first_fd, first_ident = pairs[first]
    second_fd, second_ident = pairs[second]
    checks = []
    plan = list(pairs)
    plan[first] = (first_fd, wrong_identity(first_ident))
    checks.append(helpers.assert_verdict(
        'identityMismatch', lease_set._native.sweep(tuple(plan)),
        helpers.V_IDENTITY, first))
    lease_set.check()
    fcntl.fcntl(second_fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
    plan = list(pairs)
    plan[first] = (first_fd, wrong_identity(first_ident))
    checks.append(helpers.assert_verdict(
        'firstErrorIdentity', lease_set._native.sweep(tuple(plan)),
        helpers.V_IDENTITY, first))
    fcntl.fcntl(first_fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
    plan = list(pairs)
    plan[second] = (second_fd, wrong_identity(second_ident))
    checks.append(helpers.assert_verdict(
        'firstErrorLease', lease_set._native.sweep(tuple(plan)),
        helpers.V_LEASE, first))
    helpers.assert_full_check('releasedLeaseFull', lease_set, helpers.CAUSE_LEASE)
    for fd in (first_fd, second_fd):
        for key, row in list(lease_set._held.items()):
            if row['fd'] == fd:
                lease_set._held.pop(key, None)
                break
        os.close(fd)
    lease_set.close()
    # Rejections are sticky and SIGIO has exactly one owner. After closing the
    # timed set, use a fresh single-row set for the terminal full identity check.
    identity_fd = os.open(sorted(Path(corpus).iterdir())[first], os.O_RDONLY)
    identity_set = None
    try:
        identity_set = type(lease_set)(maximum=1)
        identity_set.acquire(identity_fd)
        row = next(iter(identity_set._held.values()))
        row['token']['identity'] = list(wrong_identity(tuple(row['token']['identity'])))
        identity_set._plan = identity_set._native_plan = identity_set._native_plan_source = None
        helpers.assert_full_check('identityFull', identity_set, helpers.CAUSE_IDENTITY)
    finally:
        try:
            if identity_set is not None:
                identity_set.close()
        finally:
            os.close(identity_fd)
    return {'checks': checks, 'fullIdentityRejected': True,
            'fullIdentityRows': 1, 'fullReleasedLeaseRejected': True, 'allOk': True}


def arm(args):
    started = time.monotonic()
    deadline = started + args.max_seconds
    corpus = CORPUS if args.arm == 'A' else VOLUME
    result = {'schemaVersion': 1, 'kind': 'native-lease-backing-arm',
              'ok': False, 'arm': args.arm, 'trial': args.trial,
              'order': args.order, 'rows': ROWS, 'sweeps': SWEEPS,
              'warmups': WARMUPS, 'startedAt': now(), 'completedAt': None,
              'error': None, 'controls': {}, 'checks': {}, 'timing': {},
              'resource': {}, 'environment': {}, 'rootEnvironment': {},
              'canonicalHashes': {}, 'native': {}, 'corpus': {}, 'closeError': None,
              'variant': {}, 'backgroundThreads': {}}
    lease_set = None
    try:
        helpers = load_helpers()
        expected = json.loads(Path(MANIFEST).read_text())
        actual = manifest(corpus)
        result['corpus'] = actual
        if actual != expected:
            raise Failure('corpus manifest differs from image manifest')
        variant = ({'workers': 4, 'source': 'backing-default'} if not Path(VARIANT).exists()
                   else json.loads(Path(VARIANT).read_text()))
        if variant.get('workers') not in (1, 2, 4):
            raise Failure('helper fanout variant differs')
        result['variant'] = variant
        env = helpers.observe_environment(corpus)
        root_env = helpers.observe_environment('/')
        result['environment'], result['rootEnvironment'] = env, root_env
        expected_fs = 'overlay' if args.arm == 'A' else 'ext4'
        expected_mount = '/' if args.arm == 'A' else VOLUME
        if (env.get('sourceMountType') != expected_fs
                or env.get('sourceMountPoint') != expected_mount
                or not env.get('sourceMountReadOnlyObserved')):
            raise Failure('corpus mount type/path/read-only differs')
        if (root_env.get('sourceMountType') != 'overlay'
                or not root_env.get('sourceMountReadOnlyObserved')):
            raise Failure('container root is not read-only overlay')
        if env.get('cgroupCpuMax') != '400000 100000':
            raise Failure('cgroup CPU is not exactly 4 CPUs')
        if env.get('cgroupMemoryMax') != '4294967296':
            raise Failure('cgroup memory is not exactly 4 GiB')
        if env.get('machine') not in ('x86_64', 'amd64'):
            raise Failure('not Linux x64')
        if not str(env.get('python', '')).startswith('3.13.'):
            raise Failure('not Python 3.13')
        hashes = helpers.hash_native_files(SRC)
        if not hashes or any(value is None for value in hashes.values()):
            raise Failure('canonical file hash unavailable')
        result['canonicalHashes'] = hashes
        leases = helpers.load_module('backing_leases', LEASES)
        lease_set = leases.SdkLeaseSet(maximum=ROWS + 16)
        if lease_set._native is None or lease_set._native_binding is None:
            raise Failure('native backend required; fallback refused')
        suffix = sysconfig.get_config_var('EXT_SUFFIX')
        native_dir = SRC + '/qlever/scripts/native/'
        elf = native_dir + 'lease_sweep_ext' + suffix
        receipt = json.loads(Path(native_dir + 'build.receipt.json').read_text())
        result['native'] = {
            'class': 'SdkLeaseSet', 'extensionLoaded': True, 'bindingLoaded': True,
            'elfSha256': helpers.sha256_file(elf),
            'sourceSha256': receipt.get('source', {}).get('sha256'),
            'elfReceiptSha256': receipt.get('output', {}).get('sha256'),
            'receiptSha256': helpers.sha256_file(native_dir + 'build.receipt.json'),
            'receiptInterpreter': receipt.get('interpreter'),
            'receiptCompiler': receipt.get('compiler'),
        }
        install_rows(lease_set, corpus)
        if len(lease_set._held) != ROWS:
            raise Failure('held lease count differs')
        if not all(len(row['token']['identity']) == 6 for row in lease_set._held.values()):
            raise Failure('six-field identity differs')
        lease_set.check()
        if len(lease_set._plan or ()) != ROWS or lease_set._native_plan is None:
            raise Failure('canonical full-set plan differs')
        result['checks'] = {
            'leaseCount': len(lease_set._held),
            'planRows': len(lease_set._plan or ()),
            'sixFieldIdentity': True,
            'realReadLeases': True,
            'nativePlanBuilt': lease_set._native_plan is not None,
        }
        if time.monotonic() > deadline:
            raise TimeoutError('arm deadline before timing')
        thread_state, thread_meta = start_background_threads(args.background_threads)
        result['backgroundThreads'] = thread_meta
        try:
            usage_before = resource.getrusage(resource.RUSAGE_SELF)
            timing = helpers.timed_batch(lease_set.check, SWEEPS, 1, warmup=WARMUPS)
            usage_after = resource.getrusage(resource.RUSAGE_SELF)
        finally:
            result['backgroundThreads'] = stop_background_threads(thread_state, thread_meta)
            thread_state = None
        result['timing'] = timing
        result['resource'] = {
            'userSeconds': usage_after.ru_utime - usage_before.ru_utime,
            'systemSeconds': usage_after.ru_stime - usage_before.ru_stime,
            'minorFaults': usage_after.ru_minflt - usage_before.ru_minflt,
        }
        if len(timing['allSecondsPerSweep']) != 1:
            raise Failure('trial timing count differs')
        if time.monotonic() > deadline:
            raise TimeoutError('arm deadline before controls')
        result['controls'] = controls(lease_set, helpers, corpus)
        result['ok'] = True
        result['completedAt'] = now()
    except BaseException as error:
        result['error'] = type(error).__name__ + ':' + str(error)[:400]
        result['completedAt'] = now()
        traceback.print_exc(file=sys.stderr)
    finally:
        if lease_set is not None:
            try:
                lease_set.close()
            except BaseException as error:
                result['closeError'] = type(error).__name__ + ':' + str(error)[:200]
        if result['ok'] and result['closeError'] is not None:
            result['ok'] = False
        print_json(result)
    return 0 if result['ok'] else 1


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['generate', 'populate', 'arm'])
    parser.add_argument('--arm', choices=['A', 'B'])
    parser.add_argument('--trial', type=int, default=1)
    parser.add_argument('--order', type=int, default=1)
    parser.add_argument('--max-seconds', type=int, default=240)
    parser.add_argument('--background-threads', type=int, choices=[0, 2], default=0)
    args = parser.parse_args(argv)
    try:
        if args.mode == 'generate':
            return generate()
        if args.mode == 'populate':
            return populate()
        if args.arm not in ('A', 'B'):
            parser.error('--arm A|B is required for arm')
        return arm(args)
    except Exception as error:
        print_json({'ok': False, 'mode': args.mode,
                    'error': type(error).__name__ + ':' + str(error)[:400]})
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

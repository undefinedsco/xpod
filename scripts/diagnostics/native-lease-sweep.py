#!/usr/bin/env python3
"""DIAGNOSTIC_NOT_QUALIFICATION.

Measure the canonical native lease sweep on a real Linux host and prove the
measurement itself is honest.

The report is written for EVERY outcome (success or failure) with the stage that
failed and a bounded reason. A failed control, build or provisioning attempt
exits NONZERO.

Scope: this is not an SDK build and not qualification. It does not model or
relax the CPython signal-callback / exception-identity contract. Every
F_GETLEASE, fstat, six identity field and first-error ordering rule is unchanged.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import time

# Native verdict codes, mirrored from lease_sweep_ext.c (V_OK/V_LEASE/V_IDENTITY/V_ERRNO).
V_OK, V_LEASE, V_IDENTITY, V_ERRNO = 0, 1, 2, 3
COMMAND_DEADLINE = None
# The shipped reject strings, mirrored from lease_sweep_binding.sweep_rows.
CAUSE_LEASE = 'read lease no longer held'
CAUSE_IDENTITY = 'leased inode identity changed'


class ControlFailure(Exception):
    """A negative control did not behave exactly as production requires."""


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def run_bounded(argv, timeout, **kwargs):
    """Bounded subprocess: a hung apt/compiler can never outlive the job."""
    if COMMAND_DEADLINE is not None:
        timeout = min(timeout, COMMAND_DEADLINE - time.monotonic())
        if timeout <= 0:
            raise SystemExit('diagnostic command budget exhausted')
    try:
        return subprocess.run(argv, capture_output=True, text=True,
                              timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        raise SystemExit('bounded command timed out after %ss: %s' % (timeout, argv))


def provision():
    """Install ONLY what the canonical helper needs, inside this container.

    Debian mirrors intermittently return 5xx mid-download, which can leave dpkg
    half-configured. That is transport, not code, so we retry a BOUNDED number of
    times and repair package state between attempts. A genuine dependency error
    still fails the run.
    """
    if not os.path.isfile('/etc/debian_version'):
        return
    install = ['apt-get', 'install', '-y', '-qq', '--fix-missing',
               '--no-install-recommends', 'python3-dev', 'clang-19', 'build-essential']
    last = ''
    for attempt in range(1, 4):
        run_bounded(['apt-get', 'update', '-qq'], 180)
        done = run_bounded(install, 300)
        if done.returncode == 0:
            return
        last = (done.stderr or '')[-1500:]
        run_bounded(['apt-get', 'install', '-f', '-y', '-qq'], 180)
        run_bounded(['dpkg', '--configure', '-a'], 180)
        time.sleep(2 * attempt)
    raise SystemExit('provision failed after bounded retries:\n' + last)


def load_module(name, path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def build_helper(source_root, out_dir, compiler):
    helper = os.path.join(source_root, 'qlever/scripts/native/build_native_helper.py')
    source = os.path.join(source_root, 'qlever/scripts/native/lease_sweep_ext.c')
    started = time.time()
    done = run_bounded([sys.executable, helper, source, out_dir, '--cc', compiler], 300)
    if done.returncode != 0:
        raise SystemExit('helper build failed:\n' + (done.stderr or '')[-2000:])
    extension = next((os.path.join(out_dir, n) for n in sorted(os.listdir(out_dir))
                      if n.endswith('.so')), None)
    receipt = os.path.join(out_dir, 'build.receipt.json')
    version = run_bounded([compiler, '--version'], 60)
    result = {'exit': done.returncode,
              'elapsedSeconds': round(time.time() - started, 3),
              'compiler': compiler,
              'compilerVersion': (version.stdout or '').splitlines()[:1],
              'sourceSha256': sha256_file(source),
              'extensionSha256': sha256_file(extension) if extension else None}
    if os.path.isfile(receipt):
        result['receiptSha256'] = sha256_file(receipt)
        try:
            with open(receipt) as handle:
                result['receiptInterpreter'] = json.load(handle).get('interpreter')
        except (OSError, ValueError):
            pass
    return result


def observe_environment(source_root):
    """Observed facts only. Nothing here is inferred or defaulted."""
    meta = {'python': platform.python_version(), 'platform': sys.platform,
            'machine': platform.machine(), 'cpuCount': os.cpu_count(),
            'kernel': platform.release()}
    if hasattr(os, 'sched_getaffinity'):
        meta['affinityCpus'] = len(os.sched_getaffinity(0))
    for key, path in (('cgroupCpuMax', '/sys/fs/cgroup/cpu.max'),
                      ('cgroupMemoryMax', '/sys/fs/cgroup/memory.max')):
        try:
            with open(path) as handle:
                meta[key] = handle.read().strip()
        except OSError:
            pass
    # Observe the REAL mount of the source tree instead of asserting it.
    try:
        with open('/proc/self/mountinfo') as handle:
            lines = handle.readlines()
        target = os.path.realpath(source_root)
        best = None
        for line in lines:
            halves = line.split(' - ', 1)
            fields = halves[0].split()
            if len(halves) != 2 or len(fields) < 6:
                continue
            filesystem = halves[1].split()
            if not filesystem:
                continue
            mount_point = fields[4]
            if target == mount_point or target.startswith(mount_point.rstrip('/') + '/'):
                if best is None or len(mount_point) > len(best[0]):
                    best = (mount_point, filesystem[0], fields[5].split(','))
        if best:
            meta['sourceMountPoint'] = best[0]
            meta['sourceMountType'] = best[1]
            meta['sourceMountOptions'] = best[2]
            meta['sourceMountReadOnlyObserved'] = 'ro' in best[2]
    except OSError:
        pass
    return meta


def hash_native_files(source_root):
    """Hash the ACTUAL helper/binding/builder/lease files used."""
    out = {}
    for rel in ('qlever/scripts/native/lease_sweep_ext.c',
                'qlever/scripts/native/lease_sweep_binding.py',
                'qlever/scripts/native/build_native_helper.py',
                'qlever/scripts/sdk-tool-lifetime-leases.py'):
        path = os.path.join(source_root, rel)
        out[rel] = sha256_file(path) if os.path.isfile(path) else None
    return out


def open_rows(tmpdir, count):
    """One DISTINCT file + DISTINCT open description per row. LeaseSet.acquire()
    takes the lease; pre-leasing here would make acquire reject the fd."""
    fds = []
    for i in range(count):
        path = os.path.join(tmpdir, 'row%05d' % i)
        with open(path, 'wb') as handle:
            handle.write(b'x' * 64)
        fds.append(os.open(path, os.O_RDONLY))
    return fds


def fresh_set(leases, tmpdir, count):
    import fcntl
    fds = open_rows(tmpdir, count)
    lease_set = leases.SdkLeaseSet(maximum=4096)
    for fd in fds:
        lease_set.acquire(fd)
    if len(lease_set._held) != count:
        raise ControlFailure('lease population mismatch')
    for row in lease_set._held.values():
        if fcntl.fcntl(row['fd'], fcntl.F_GETLEASE) != fcntl.F_RDLCK:
            raise ControlFailure('real read lease required')
    return lease_set, fds


def close_set(lease_set, fds):
    try:
        lease_set.close()
    except Exception:                     # noqa: BLE001 - cleanup must not mask
        pass
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def timed_batch(fn, iterations, trials, warmup=2):
    for _ in range(warmup):
        fn()
    per_sweep = []
    for _ in range(trials):
        started = time.perf_counter()
        for _ in range(iterations):
            fn()
        per_sweep.append((time.perf_counter() - started) / iterations)
    return {'iterations': iterations, 'trials': trials,
            'medianSecondsPerSweep': statistics.median(per_sweep),
            'minSecondsPerSweep': min(per_sweep),
            'maxSecondsPerSweep': max(per_sweep),
            'allSecondsPerSweep': per_sweep}


def sweep_verdict(lease_set, native):
    pairs = tuple((r['fd'], tuple(r['token']['identity']))
                  for r in lease_set._held.values())
    return native.sweep(pairs)


def assert_verdict(name, got, expect_code, expect_index):
    verdict, index, _errno = got
    if verdict != expect_code or index != expect_index:
        raise ControlFailure('%s: native verdict %r expected code=%r index=%r'
                             % (name, got, expect_code, expect_index))
    return {'control': name, 'nativeVerdict': verdict,
            'nativeIndex': index, 'expectedIndex': expect_index}


def assert_full_check(name, lease_set, expect_cause):
    """The full production check must raise LeaseError naming the SAME cause."""
    try:
        lease_set.check()
    except Exception as exc:              # noqa: BLE001 - classified
        observed = type(exc).__name__, str(exc)
    else:
        raise ControlFailure('%s: expected a rejection, got a clean pass' % name)
    kind, message = observed
    if kind != 'LeaseError':
        raise ControlFailure('%s: expected LeaseError, got %s (%s)'
                             % (name, kind, message[:120]))
    if expect_cause not in message:
        raise ControlFailure('%s: expected cause %r, got %r'
                             % (name, expect_cause, message[:160]))
    return kind


def measure(leases, rows, iterations, trials):
    import fcntl
    import shutil
    tmp = tempfile.mkdtemp(prefix='lease-sweep-')
    result = {'rows': rows, 'iterations': iterations, 'trials': trials}
    controls = []
    try:
        # ---------- timing (single set, batched) ----------
        lease_set, fds = fresh_set(leases, tmp, rows)
        try:
            native = lease_set._native
            if native is None:
                raise ControlFailure('native backend missing (no fallback accepted)')
            pairs = tuple((r['fd'], tuple(r['token']['identity']))
                          for r in lease_set._held.values())
            full = timed_batch(lease_set.check, iterations, trials)
            direct = timed_batch(lambda: native.sweep(pairs), iterations, trials)
            result['fullCheck'] = dict(
                full, microsecondsPerSweep=full['medianSecondsPerSweep'] * 1e6,
                microsecondsPerRow=full['medianSecondsPerSweep'] * 1e6 / rows)
            result['directNative'] = dict(
                direct, microsecondsPerSweep=direct['medianSecondsPerSweep'] * 1e6,
                microsecondsPerRow=direct['medianSecondsPerSweep'] * 1e6 / rows)
        finally:
            close_set(lease_set, fds)

        # ---------- clean sweep must pass ----------
        lease_set, fds = fresh_set(leases, tmp, rows)
        try:
            lease_set.check()
            controls.append({'control': 'cleanSweep', 'outcome': 'passed'})
        finally:
            close_set(lease_set, fds)

        # ---------- ONE unlocked lease: native verdict AND full cause ----------
        lease_set, fds = fresh_set(leases, tmp, rows)
        try:
            target = rows // 3
            row = list(lease_set._held.values())[target]
            fcntl.fcntl(row['fd'], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            controls.append(assert_verdict('oneUnlockedLease',
                                           sweep_verdict(lease_set, lease_set._native),
                                           V_LEASE, target))
            controls[-1]['fullCheckError'] = assert_full_check(
                'oneUnlockedLease', lease_set, CAUSE_LEASE)
        finally:
            close_set(lease_set, fds)

        # ---------- ONE real identity change via fchmod ----------
        # A clean check first PRIMES the frozen plan; the real fchmod then makes
        # the live fstat differ, so the unchanged plan must detect it.
        lease_set, fds = fresh_set(leases, tmp, rows)
        try:
            target = rows // 4
            lease_set.check()                      # prime _plan on valid state
            if lease_set._plan is None:
                raise ControlFailure('frozen plan was not primed')
            row = list(lease_set._held.values())[target]
            os.fchmod(row['fd'], (os.fstat(row['fd']).st_mode & 0o7777) ^ 0o100)
            controls.append(assert_verdict('oneIdentityMismatch',
                                           sweep_verdict(lease_set, lease_set._native),
                                           V_IDENTITY, target))
            controls[-1]['fullCheckError'] = assert_full_check(
                'oneIdentityMismatch', lease_set, CAUSE_IDENTITY)
        finally:
            close_set(lease_set, fds)

        # ---------- TWO faults, BOTH orderings: lowest index, exact cause ----------
        for name, order in (('twoErrors_unlockFirst', 'unlock'),
                            ('twoErrors_identityFirst', 'identity')):
            lease_set, fds = fresh_set(leases, tmp, rows)
            try:
                lease_set.check()                  # prime _plan
                if order == 'unlock':
                    unlock_at, identity_at = rows // 5, max(rows // 5 + 1, rows // 3)
                else:
                    identity_at, unlock_at = rows // 5, max(rows // 5 + 1, rows // 3)
                lowest = min(unlock_at, identity_at)
                fcntl.fcntl(list(lease_set._held.values())[unlock_at]['fd'],
                            fcntl.F_SETLEASE, fcntl.F_UNLCK)
                changed_fd = list(lease_set._held.values())[identity_at]['fd']
                os.fchmod(changed_fd, (os.fstat(changed_fd).st_mode & 0o7777) ^ 0o100)
                expect_code = V_LEASE if unlock_at == lowest else V_IDENTITY
                expect_cause = CAUSE_LEASE if unlock_at == lowest else CAUSE_IDENTITY
                controls.append(assert_verdict(name,
                                               sweep_verdict(lease_set, lease_set._native),
                                               expect_code, lowest))
                controls[-1]['fullCheckError'] = assert_full_check(
                    name, lease_set, expect_cause)
            finally:
                close_set(lease_set, fds)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    result['controls'] = controls
    result['allControlsPassed'] = True
    return result


def validate(args):
    """All input bounds are checked BEFORE any work."""
    rows = [r.strip() for r in args.rows.split(',')]
    if not 1 <= len(rows) <= 4:
        raise SystemExit('rows: 1..4 values required')
    parsed = []
    for value in rows:
        if not re.fullmatch(r'[0-9]+', value):
            raise SystemExit('rows: positive integers required, got %r' % value)
        number = int(value)
        if not 2 <= number <= 1024:
            raise SystemExit('rows: each value must be 2..1024, got %d' % number)
        parsed.append(number)
    if not 3 <= args.trials <= 9:
        raise SystemExit('trials: 3..9 required')
    if not 10 <= args.iterations <= 1000:
        raise SystemExit('iterations: 10..1000 required')
    if not re.fullmatch(r'[0-9a-f]{40}', args.git_sha):
        raise SystemExit('git-sha: exact 40 lowercase hex characters required')
    return parsed


def main(argv):
    global COMMAND_DEADLINE
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--rows', default='75,590')
    parser.add_argument('--trials', type=int, default=5)
    parser.add_argument('--iterations', type=int, default=500)
    parser.add_argument('--compiler', default='clang-19')
    parser.add_argument('--work-root', default=None)
    parser.add_argument('--provision', action='store_true')
    parser.add_argument('--platform-arch', default=platform.machine())
    args = parser.parse_args(argv)
    rows = validate(args)
    COMMAND_DEADLINE = time.monotonic() + 600

    report = {'schemaVersion': 3, 'kind': 'native-lease-sweep-diagnostic',
              'DIAGNOSTIC_NOT_QUALIFICATION': True,
              'gitShaDeclared': args.git_sha,
              # Explicitly declared by the workflow, NOT verified by this script:
              'sourceMountedReadOnlyDeclaredByWorkflow': True,
              'platformArchRequested': args.platform_arch,
              'stage': 'start'}
    stage = 'validate'
    work = None
    try:
        if args.provision:
            stage = 'provision'
            provision()
        stage = 'environment'
        report['environment'] = observe_environment(args.source_root)
        report['nativeFileHashes'] = hash_native_files(args.source_root)

        stage = 'prepare'
        work = os.path.abspath(args.work_root) if args.work_root else \
            tempfile.mkdtemp(prefix='lease-helper-')
        import shutil as _sh
        module_native = os.path.join(work, 'qlever/scripts/native')
        os.makedirs(module_native, exist_ok=True)
        for name in os.listdir(os.path.join(args.source_root, 'qlever/scripts/native')):
            if name.endswith(('.py', '.c')):
                _sh.copy2(os.path.join(args.source_root, 'qlever/scripts/native', name),
                          os.path.join(module_native, name))
        _sh.copy2(os.path.join(args.source_root,
                               'qlever/scripts/sdk-tool-lifetime-leases.py'),
                  os.path.join(work, 'qlever/scripts/sdk-tool-lifetime-leases.py'))

        stage = 'build'
        report['helperBuild'] = build_helper(args.source_root, module_native, args.compiler)

        stage = 'provenance'
        binding = load_module('diag_binding',
                              os.path.join(module_native, 'lease_sweep_binding.py'))
        binding.verify_provenance()
        report['provenanceVerified'] = True

        stage = 'measure'
        leases = load_module('diag_leases',
                             os.path.join(work, 'qlever/scripts/sdk-tool-lifetime-leases.py'))
        report['measurements'] = [measure(leases, n, args.iterations, args.trials)
                                  for n in rows]
        stage = 'done'
    except ControlFailure as exc:
        report['stage'] = stage
        report['failureReason'] = 'control_failed'
        report['failureDetail'] = str(exc)[:400]
        _write(args.report, report)
        raise SystemExit(3)
    except SystemExit as exc:
        report['stage'] = stage
        report['failureReason'] = 'stage_failed'
        report['failureDetail'] = str(exc)[:400]
        _write(args.report, report)
        raise
    except BaseException as exc:          # noqa: BLE001 - classified
        report['stage'] = stage
        report['failureReason'] = 'exception'
        report['failureDetail'] = '%s: %s' % (type(exc).__name__, str(exc)[:400])
        _write(args.report, report)
        raise SystemExit(4)
    finally:
        if work and not args.work_root:
            import shutil as _sh2
            _sh2.rmtree(work, ignore_errors=True)

    report['stage'] = stage
    _write(args.report, report)
    print(json.dumps({k: v for k, v in report.items() if k != 'measurements'}, indent=1))
    for m in report['measurements']:
        print('rows=%d full=%.1fus direct=%.1fus controls=%d'
              % (m['rows'], m['fullCheck']['microsecondsPerSweep'],
                 m['directNative']['microsecondsPerSweep'], len(m['controls'])))
    return 0


def _write(path, report):
    with open(path, 'w') as handle:
        json.dump(report, handle, indent=1, sort_keys=True)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

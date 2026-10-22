"""Independent owned service native protocol CID; no whole-service authority.

All command ownership and queries come from reviewed shared modules. The caller
supplies immutable modules and a seed already retained by the same parent.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import time

META = 1024**2
TMPFS_OPTIONS = 'rw,noexec,nosuid,nodev,size=8388608,mode=0700'
NATIVE_RUNTIME = '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'
FIXED_BOOTSTRAP = 'cp /seed/abi.sqlite /scratch/abi.sqlite; exec ' + NATIVE_RUNTIME + ' --sqlite-path /scratch/abi.sqlite'
ROLES = ('receipt', 'stdin', 'stdout', 'stderr')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def copy_seed(reference, retained, destination):
    need(isinstance(reference, dict) and set(reference) == {'path', 'bytes', 'sha256'}
         and retained.refs.get(reference.get('path')) == reference,
         'same retained seed original required')
    size = reference['bytes']
    need(type(size) is int and 0 < size <= 8*META, 'bounded smoke seed required')
    source = retained.out / reference['path']
    need(source.is_absolute() and source.resolve(strict=True) == source,
         'canonical retained seed required')
    retained.budget.check(10)
    value = source.lstat()
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_size == size,
         'ordinary exact seed required')
    # This is a second physical entity, charged before its first byte is written.
    retained.reserve(size)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    primary = None
    try:
        need(identity(os.fstat(fd)) == identity(value), 'seed replaced before open')
        digest = hashlib.sha256(); count = 0
        with destination.open('xb') as output:
            while count < size:
                retained.budget.check(10)
                block = os.read(fd, min(65536, size-count))
                need(bool(block), 'short smoke seed')
                need(output.write(block) == len(block), 'short smoke seed write')
                count += len(block); digest.update(block)
            output.flush(); os.fsync(output.fileno())
            written = identity(os.fstat(output.fileno()))
        need(count == size and digest.hexdigest() == reference['sha256'], 'seed full SHA differs')
        need(identity(os.fstat(fd)) == identity(value) == identity(source.lstat()),
             'seed input changed during copy')
        need(written == identity(destination.lstat()), 'seed output changed')
        ref = dict(path=str(destination.relative_to(retained.out)), bytes=size,
                   sha256=digest.hexdigest())
        retained.refs[ref['path']] = ref
        return ref
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise


def retain_failed_session(retained):
    """Register only complete bounded files already charged by the adapter.

    No reservation is refunded here; a missing/partial set never becomes success.
    """
    refs = []; errors = []
    for name in ('stdin.raw', 'stdout.raw', 'stderr.raw', 'result.original.json'):
        fd = None; primary = None
        try:
            retained.budget.check(0)
            path = retained.out/'abi-session'/name
            value = path.lstat()
            need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
                 and value.st_size <= META, 'bounded failed session original required')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            need(identity(os.fstat(fd)) == identity(value), 'failed session replaced')
            count = 0; digest = hashlib.sha256()
            while count < value.st_size:
                retained.budget.check(0)
                block = os.read(fd, min(65536, value.st_size-count))
                need(bool(block), 'short failed session original')
                count += len(block); digest.update(block)
            need(identity(os.fstat(fd)) == identity(value) == identity(path.lstat()),
                 'failed session original changed')
            ref = dict(path='abi-session/'+name, bytes=count, sha256=digest.hexdigest())
            retained.refs[ref['path']] = ref; refs.append(ref)
        except BaseException as error:
            primary = error
            errors.append(dict(path=name, errorClass=type(error).__name__))
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except BaseException as error:
                    errors.append(dict(path=name, errorClass=type(error).__name__))
    return dict(originals=refs, missingOrInvalid=errors, completeSuccess=False)


def capture_bounded_control(label, command, retained, source, *, transport, end):
    """Reuse the reviewed duplex transport for fixed Docker control commands.

    The caller has already reserved two MiB: one combined raw MiB and one
    receipt MiB. There is no protocol/query implementation in this function.
    """
    outer_end = retained.budget.end
    need(type(end) in (int, float) and type(outer_end) in (int, float)
         and math.isfinite(end) and math.isfinite(outer_end)
         and time.monotonic() < end <= outer_end, 'same finite control/outer parent intersection required')
    timing = dict(timingModel='actual-service-abi-parent-window-v1',
        startedUTCNs=str(time.time_ns()), startedMonotonicNs=str(time.monotonic_ns()),
        outerParentDeadlineMonotonicNs=str(int(outer_end*10**9)),
        operationDeadlineMonotonicNs=str(int(end*10**9)),
        completedUTCNs=None, completedMonotonicNs=None, rawClosedBeforeTiming=False)
    target = retained.out/'abi-control'/label
    target.mkdir(parents=True, mode=0o700, exist_ok=False)
    child = None; primary = None; refs = {}; errors = []
    receipt = dict(schemaVersion=1, command=list(command), cwdNotOverridden=True,
                   existingParentDeadline=retained.budget.end,
                   controlDeadline=end, success=False, **timing)
    try:
        child = transport.SmokeSession(command, parent_deadline=end,
            byte_limit=META, reserve=lambda amount: retained.budget.check(0),
            cleanup_seconds=1)
        # Docker controls consume no stdin and return arbitrary bounded stdout.
        child.process.stdin.close()
        while child.eof != {'stdout', 'stderr'} or child.process.poll() is None:
            child.pump(); child.buffer.clear()
        need(child.process.returncode == 0, 'actual Docker control failed')
    except BaseException as error:
        primary = error
        receipt.update(failureClass=type(error).__name__)
    finally:
        if child is not None:
            try:
                child.close()
            except BaseException as error:
                if primary is None:
                    primary = error
            receipt['hostProcessCleanup'] = child.cleanup
            cleanup = child.cleanup or {}
            if not (cleanup.get('actualRootWait') is True
                    and type(cleanup.get('actualRootReturnCode')) is int
                    and cleanup['actualRootReturnCode'] == 0
                    and cleanup.get('ownedGroupAbsent') is True
                    and cleanup.get('cleanupErrors') == []):
                if primary is None:
                    primary = ValueError('complete control actual wait/PGID cleanup required')
            for role, raw in child.raw.items():
                try:
                    path = target/(role+'.raw')
                    with path.open('xb') as stream:
                        need(stream.write(raw) == len(raw), 'short control original')
                        stream.flush(); os.fsync(stream.fileno())
                    ref = dict(path=str(path.relative_to(retained.out)), bytes=len(raw),
                               sha256=hashlib.sha256(raw).hexdigest())
                    refs[role] = ref
                except BaseException as error:
                    errors.append(type(error).__name__)
                    if primary is None:
                        primary = error
        try:
            cleanup = receipt.get('hostProcessCleanup', {})
            if (set(refs) == {'stdin','stdout','stderr'} and not errors
                    and cleanup.get('actualRootWait') is True
                    and cleanup.get('ownedGroupAbsent') is True
                    and cleanup.get('cleanupErrors') == []):
                complete_utc, complete_mono = time.time_ns(), time.monotonic_ns()
                need(int(receipt['startedMonotonicNs']) <= complete_mono <= int(receipt['operationDeadlineMonotonicNs'])
                     and int(receipt['startedUTCNs']) <= complete_utc,
                     'actual control completion exceeds original clock intersection')
                receipt.update(completedUTCNs=str(complete_utc), completedMonotonicNs=str(complete_mono), rawClosedBeforeTiming=True)
            elif primary is None:
                raise ValueError('closed control timing evidence required')
        except BaseException as error:
            if primary is None: primary = error
        receipt.update(success=primary is None, rawOriginals=refs, outputErrors=errors)
        try:
            raw = (json.dumps(receipt, sort_keys=True)+'\n').encode()
            need(len(raw) <= META, 'bounded control receipt required')
            path = target/'receipt.original.json'
            with path.open('xb') as stream:
                need(stream.write(raw) == len(raw), 'short control receipt')
                stream.flush(); os.fsync(stream.fileno())
            ref = dict(path=str(path.relative_to(retained.out)), bytes=len(raw),
                       sha256=hashlib.sha256(raw).hexdigest())
            refs['receipt'] = ref
        except BaseException as error:
            if primary is None:
                primary = error
    if primary is not None:
        # The complete allocation remains charged on failure. Register only
        # actually written refs without calling success settlement.
        for ref in refs.values():
            try:
                need(ref['path'] not in retained.refs, 'unique failed control original required')
                retained.refs[ref['path']] = ref
            except BaseException:
                pass  # Failure retention must not replace the command primary.
        raise primary
    need(set(refs) == set(ROLES), 'complete control originals required')
    return refs


def command_for(direct_commands, image_commands, role, image, name, nonce, cid, scratch):
    command = direct_commands.command(image_commands, role, image, name, nonce,
                                      cid=cid, scratch=scratch)
    if role == 'create':
        mount = 'type=bind,src=' + str(scratch) + ',dst=/scratch'
        need(command.count(mount) == 1, 'sole reviewed scratch mount required')
        need(command[-5:] == ['--entrypoint', NATIVE_RUNTIME, image,
                              '--sqlite-path', '/scratch/abi.sqlite'],
             'sole reviewed native entrypoint suffix required')
        prefix = [part.replace(',dst=/scratch', ',dst=/seed,readonly')
                  if part == mount else part for part in command[:-5]]
        command = [*prefix, '--tmpfs', '/scratch:' + TMPFS_OPTIONS,
                   '--entrypoint', '/bin/sh', image, '-ec', FIXED_BOOTSTRAP]
    return command


def collect(*, image, config, source, retained, seed_reference, expected_abi,
            image_commands, direct_commands, retained_session, host_session,
            helper, transport, replay, assert_current):
    """Collect one fresh CID axis using the original absolute parent deadline.

    image_commands is the existing service image module; direct_commands and
    retained_session are the reviewed adapters, not caller command factories.
    A protocol observation never asserts complete native/loader/source coverage.
    """
    budget = retained.budget
    need(isinstance(expected_abi, dict)
         and set(expected_abi) == {'abiVersion', 'adapterAbiVersion', 'physicalBackendAbiVersion'}
         and all(type(value) is int and value > 0 for value in expected_abi.values()),
         'exact source-derived ABI axes required')
    expected_abi = dict(expected_abi)
    need(isinstance(source, Path) and source.is_absolute(), 'actual source required')
    need(isinstance(config, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', config),
         'exact expected service config required')
    assert_current(); budget.check(10)
    nonce = secrets.token_hex(16); name = 'xpod-service-output-' + nonce
    scratch = retained.out / (name + '-scratch')
    scratch.mkdir(mode=0o700, exist_ok=False)
    cid = None; owned = False; absent = False; primary = None; seed_fd = None; session_started = False
    stages = []; failures = []; cleanup_errors = []
    result = dict(schemaVersion=1, kind='actual-service-native-protocol-session',
                  imageReferenceByDigest=image, configDigest=config,
                  containerName=name, ownerNonce=nonce, stages=stages,
                  cleanupErrors=cleanup_errors, releaseAccepted=False,
                  serviceAbiVerified=False, runtimeProtocolObserved=False,
                  pending=['candidate-native-loader-and-membership-unverified',
                           'whole-service-abi-unverified'])
    # Three cleanup operations plus final result cannot be consumed by protocol IO.
    cleanup_slots = [retained.reserve(2*META) for _ in range(5)]
    result_allocation = retained.reserve(META)
    scratch_reservation = retained.reserve(8*META)

    def stage(role, cleanup=False):
        nonlocal cid

        if not cleanup:
            assert_current()
        budget.check(0 if cleanup else 10)
        command = command_for(direct_commands, image_commands, role, image, name, nonce, cid, scratch)
        allocation = cleanup_slots.pop() if cleanup and cleanup_slots else retained.reserve(2*META)
        label = 'service-abi-' + str(len(stages)+len(failures)) + '-' + role
        try:
            import time
            end = min(budget.end-(0 if cleanup else 10),
                      time.monotonic()+(5 if cleanup else 15))
            row = capture_bounded_control(label, command, retained, source,
                                           transport=transport, end=end)
            refs = [row[key] for key in ROLES]
            retained.settle(allocation, refs)
            stages.append(dict(role=role, command=command, **row))
            return image_commands.outer.bounded_original(
                retained.out / row['stdout']['path'], META,
                lambda: budget.check(0 if cleanup else 10))
        except BaseException as error:
            # Failed command reservations remain charged; partial originals stay
            # in the owned output and are never described as complete evidence.
            failures.append(dict(role=role, errorClass=type(error).__name__))
            raise

    def inspect(raw, before=False):
        value = image_commands.inspect_output_container(raw, image, config, cid,
                    name, nonce, require_never_started=before)
        state = value.get('State', {})
        host = value.get('HostConfig', {})
        need(host.get('ReadonlyRootfs') is True and host.get('NetworkMode') == 'none'
             and host.get('Init') is True and host.get('PidsLimit') == 64
             and host.get('Memory') == 512*META
             and host.get('CapDrop') == ['ALL']
             and 'no-new-privileges' in host.get('SecurityOpt', [])
             and host.get('RestartPolicy', {}).get('Name') == 'no',
             'actual ABI isolation differs')
        mounts = value.get('Mounts')
        need(isinstance(mounts, list) and len(mounts) == 1
             and mounts[0].get('Type') == 'bind'
             and mounts[0].get('Source') == str(scratch)
             and mounts[0].get('Destination') == '/seed'
             and mounts[0].get('RW') is False, 'actual read-only seed mount differs')
        need(host.get('Tmpfs') == {'/scratch': TMPFS_OPTIONS},
             'actual kernel-bounded private scratch differs')
        if not before:
            need(state.get('Running') is False and state.get('Paused') is False
                 and state.get('Status') == 'exited' and state.get('Pid') == 0
                 and type(state.get('ExitCode')) is int and state['ExitCode'] == 0
                 and state.get('OOMKilled') is False, 'actual native terminal state differs')
        return value

    try:
        result['seedOriginal'] = copy_seed(seed_reference, retained, scratch/'abi.sqlite')
        seed_value = (scratch/'abi.sqlite').lstat()
        seed_fd = os.open(scratch/'abi.sqlite', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        need(identity(os.fstat(seed_fd)) == identity(seed_value), 'actual seed lease changed')
        raw = stage('create')
        need(re.fullmatch(b'[a-f0-9]{64}\n', raw), 'actual full new CID required')
        cid = raw.decode().strip(); result['containerId'] = cid
        raw = stage('inspect')
        image_commands.inspect_output_container(raw, image, config, cid, name, nonce,
                                               require_never_started=False)
        owned = True
        inspect(raw, before=True)
        assert_current(); budget.check(10)
        command = direct_commands.command(image_commands, 'execute', image, name,
                                           nonce, cid=cid, scratch=scratch)
        need(not (retained.out/'abi-session').exists() and not (retained.out/'abi-session').is_symlink(),
             'fresh independent session namespace required')
        protocol_end = min(budget.end-10, time.monotonic()+120)
        result['protocolDeadlineMonotonic'] = protocol_end
        session_started = True
        session = retained_session.observe(command, retained=retained,
            host_session=host_session, output=retained.out/'abi-session',
            helper=helper, transport=transport, replay=replay,
            expected_abi=expected_abi, parent_deadline=protocol_end)
        assert_current()
        observation = session.get('observation', {})
        cleanup = observation.get('hostProcessCleanup', {})
        need(observation.get('protocolObserved') is True
             and observation.get('expectedAbi') == expected_abi
             and cleanup.get('actualRootWait') is True
             and type(cleanup.get('actualRootReturnCode')) is int
             and cleanup['actualRootReturnCode'] == 0
             and cleanup.get('ownedGroupAbsent') is True
             and cleanup.get('cleanupErrors') == [], 'complete actual host protocol/wait required')
        refs = session.get('originals', [])
        need(isinstance(refs, list) and len(refs) == 4
             and {ref.get('path') for ref in refs} ==
                 {'abi-session/'+name for name in ('stdin.raw', 'stdout.raw', 'stderr.raw', 'result.original.json')}
             and all(retained.refs.get(ref['path']) == ref for ref in refs),
             'complete same-ledger protocol originals required')
        need(identity(os.fstat(seed_fd)) == identity(seed_value) == identity((scratch/'abi.sqlite').lstat()),
             'read-only seed lease changed during native protocol')
        digest = hashlib.sha256(); count = 0
        while count < result['seedOriginal']['bytes']:
            budget.check(10)
            block = os.pread(seed_fd, min(65536, result['seedOriginal']['bytes']-count), count)
            need(bool(block), 'short retained seed after native protocol')
            digest.update(block); count += len(block)
        need(digest.hexdigest() == result['seedOriginal']['sha256']
             and identity(os.fstat(seed_fd)) == identity(seed_value) == identity((scratch/'abi.sqlite').lstat()),
             'retained seed full SHA/identity changed after native protocol')
        result['session'] = session
        inspect(stage('inspect'))
        result['runtimeProtocolObserved'] = True
    except BaseException as error:
        primary = error
        result.update(failureClass=type(error).__name__, failureMessage=str(error)[:2048])
        if session_started:
            result['failedSessionOriginals'] = retain_failed_session(retained)
    finally:
        try:
            if not owned:
                # Even a create command failure may have created a CID. Recover
                # only by the sole builder's exact name + nonce label filter.
                raw = stage('cleanup-list', cleanup=True)
                need(re.fullmatch(b'(?:[a-f0-9]{64}\n)?', raw), 'unique owned recovery CID required')
                if raw:
                    cid = raw.decode().strip(); result['containerId'] = cid
                    image_commands.inspect_output_container(stage('cleanup-inspect', cleanup=True),
                        image, config, cid, name, nonce, require_never_started=False)
                    owned = True
                else:
                    absent = True
            if owned:
                # Recheck the exact ownership tuple immediately before removal.
                image_commands.inspect_output_container(stage('cleanup-inspect', cleanup=True),
                    image, config, cid, name, nonce, require_never_started=False)
                raw = stage('cleanup-remove', cleanup=True)
                need(raw.decode().strip() == cid, 'actual owned removal differs')
                need(stage('cleanup-confirm-absent', cleanup=True) == b'', 'owned ABI CID remains')
                absent = True
        except BaseException as error:
            cleanup_errors.append(dict(errorClass=type(error).__name__))
            if primary is None:
                primary = error
        if absent:
            try:
                # Sole own-CID removal/absence proves this kernel tmpfs no longer
                # exists. No other partial session/command reservation is freed.
                retained.settle(scratch_reservation, [])
                for unused in cleanup_slots:
                    retained.settle(unused, [])
                cleanup_slots.clear()
            except BaseException as error:
                cleanup_errors.append(dict(errorClass=type(error).__name__))
                if primary is None:
                    primary = error
        if seed_fd is not None:
            try:
                os.close(seed_fd)
            except BaseException as error:
                cleanup_errors.append(dict(errorClass=type(error).__name__))
                if primary is None:
                    primary = error
        result.update(ownedContainerAbsent=absent, failedStages=failures)
        try:
            raw = (json.dumps(result, sort_keys=True)+'\n').encode()
            need(len(raw) <= META, 'bounded service ABI result required')
            path = retained.out/'service-abi-session.original.json'
            with path.open('xb') as output:
                need(output.write(raw) == len(raw), 'short ABI result write')
                output.flush(); os.fsync(output.fileno())
            ref = dict(path=path.name, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            retained.settle(result_allocation, [ref])
            retained.refs[ref['path']] = ref
            result['resultOriginal'] = ref
        except BaseException as error:
            if primary is None:
                primary = error
    if primary is not None:
        raise primary
    need(absent and not cleanup_errors, 'complete ABI owned cleanup required')
    return result

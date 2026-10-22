"""Host-side bounded protocol observation over an already-owned command.

The caller owns immutable source, CID creation/inspection/removal and complete
native/loader membership. This module never issues whole-service qualification.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import time


def observe(command, *, helper, transport, replay, expected_abi, output,
            parent_deadline, outer_parent_deadline, reserve):
    if (not isinstance(output, Path) or not output.is_absolute() or
            output.parent.resolve(strict=True) != output.parent):
        raise ValueError('fresh canonical owned observation output required')
    if (type(parent_deadline) not in (int,float) or type(outer_parent_deadline) not in (int,float)
            or not math.isfinite(parent_deadline) or not math.isfinite(outer_parent_deadline)
            or not time.monotonic() < parent_deadline <= outer_parent_deadline):
        raise ValueError('same finite host/outer parent intersection required')
    timing = dict(timingModel='actual-service-abi-parent-window-v1',
        startedUTCNs=str(time.time_ns()), startedMonotonicNs=str(time.monotonic_ns()),
        outerParentDeadlineMonotonicNs=str(int(outer_parent_deadline*10**9)),
        operationDeadlineMonotonicNs=str(int(parent_deadline*10**9)),
        completedUTCNs=None, completedMonotonicNs=None, rawClosedBeforeTiming=False)
    output.mkdir(mode=0o700, exist_ok=False)
    child = None
    primary = None
    result = dict(schemaVersion=1, command=list(command), releaseAccepted=False,
                  serviceAbiVerified=False, protocolObserved=False, **timing,
                  scope='actual host protocol session only; CID, source, native and loader authority independent')
    def check():
        if time.monotonic() >= parent_deadline:
            raise TimeoutError('same existing ABI parent window exhausted')
    try:
        check()
        child = transport.SmokeProcess(command, expected_abi=expected_abi,
            parent_deadline=parent_deadline, byte_limit=1024**2,
            reserve=reserve, cleanup_seconds=2)
        with child:
            observed = helper._run_runtime_smoke_session(child)
        cleanup = child.session.cleanup
        if (not child.ready_checked or cleanup['actualRootWait'] is not True or
                cleanup.get('actualRootReturnCode') != 0 or
                cleanup['ownedGroupAbsent'] is not True or cleanup['cleanupErrors'] != []):
            raise ValueError('actual complete host wait and owned process cleanup required')
        raw = child.session.raw
        replayed = replay.replay_shared_smoke(helper, bytes(raw['stdin']),
            bytes(raw['stdout']), bytes(raw['stderr']), expected_abi, check)
        if observed != (expected_abi['adapterAbiVersion'], expected_abi['physicalBackendAbiVersion']):
            raise ValueError('actual ABI differs from source-derived declarations')
        result.update(protocolObserved=True, expectedAbi=dict(expected_abi), replay=replayed)
    except BaseException as error:
        primary = error
        result.update(failureClass=type(error).__name__, failureMessage=str(error)[:2048])
    finally:
        if child is not None:
            try:
                child.session.close()
            except BaseException as error:
                result['cleanupFailure'] = type(error).__name__
                if primary is None: primary = error
            result['hostProcessCleanup'] = child.session.cleanup
            refs = []
            output_errors = []
            for role, raw in child.session.raw.items():
                path = output / (role + '.raw')
                try:
                    with path.open('xb') as stream:
                        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
                    refs.append(dict(path=path.name, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
                except BaseException as error:
                    output_errors.append(dict(path=path.name, errorClass=type(error).__name__))
                    if primary is None: primary = error
            result['protocolOriginals'] = refs
            result['outputErrors'] = output_errors
            try:
                cleanup = child.session.cleanup or {}
                if (len(refs) == 3 and {ref['path'] for ref in refs} == {'stdin.raw','stdout.raw','stderr.raw'}
                        and not output_errors and cleanup.get('actualRootWait') is True
                        and cleanup.get('ownedGroupAbsent') is True and cleanup.get('cleanupErrors') == []):
                    complete_utc, complete_mono = time.time_ns(), time.monotonic_ns()
                    if not (int(result['startedMonotonicNs']) <= complete_mono <= int(result['operationDeadlineMonotonicNs'])
                            and int(result['startedUTCNs']) <= complete_utc):
                        raise TimeoutError('actual host completion exceeds original clock intersection')
                    result.update(completedUTCNs=str(complete_utc), completedMonotonicNs=str(complete_mono), rawClosedBeforeTiming=True)
                elif primary is None:
                    raise ValueError('closed host timing evidence required')
            except BaseException as error:
                if primary is None: primary = error
        try:
            with (output/'result.original.json').open('x') as stream:
                json.dump(result, stream, indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        except BaseException as error:
            if primary is None: primary = error
    if primary is not None: raise primary
    return result

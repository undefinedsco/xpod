"""Actual Bun role session transport for the xpod service ABI harness.

This is a mechanical protocol adapter only. It moves the existing finite smoke
session's bytes, never persists a file and never asserts qualification. The
caller keeps its already-reserved raw streams and separately validates the
membership capability and its references.
"""
import json
import math
import time

ROLES = ('bun-node-addon', 'bun-sqlite-extension', 'inngest-cli')
_BYTE_LIMIT = 1024**2
_CLEANUP_SECONDS = 2
_FRAME_KEYS = frozenset(('phase', 'role', 'nonce'))


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate key in actual role protocol JSON')
        value[key] = item
    return value


def _read_frame(session, phase, role, nonce):
    raw = session.readline()
    if type(raw) is not bytes or not raw.endswith(b'\n'):
        raise ValueError('complete actual role protocol line required')
    try:
        text = raw[:-1].decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('actual role protocol line is not UTF-8') from error
    value = json.loads(text, object_pairs_hook=_unique_object)
    if type(value) is not dict or frozenset(value) != _FRAME_KEYS:
        raise ValueError('exact actual role frame keys required')
    if type(value['phase']) is not str or value['phase'] != phase:
        raise ValueError('exact actual ' + phase + ' role frame required')
    if type(value['role']) is not str or value['role'] != role:
        raise ValueError('actual role frame reports a different role')
    if type(value['nonce']) is not str or value['nonce'] != nonce:
        raise ValueError('actual role frame reports a different nonce')
    return value


def _require_cleanup(cleanup):
    if (type(cleanup) is not dict
            or cleanup.get('actualRootWait') is not True
            or type(cleanup.get('actualRootReturnCode')) is not int
            or cleanup.get('actualRootReturnCode') != 0
            or cleanup.get('ownedGroupAbsent') is not True
            or cleanup.get('cleanupErrors') != []):
        raise ValueError('actual zero root wait and owned group absence required')


def observe(command, *, role, nonce, parent_deadline, reserve, transport,
            capture_membership, check, outer_parent_deadline=None):
    """Run one exact ready/membership/shutdown/closed role exchange.

    ``parent_deadline`` is the caller's existing absolute monotonic deadline;
    this adapter creates no timer and passes the value through unchanged.
    """
    if type(role) is not str or role not in ROLES:
        raise ValueError('source-bound service ABI role required')
    if type(nonce) is not str or not nonce:
        raise ValueError('owned nonce required')
    if (not callable(check) or not callable(capture_membership)
            or not callable(reserve)):
        raise ValueError('actual cancellation and membership callbacks required')
    if not hasattr(transport, 'SmokeSession'):
        raise ValueError('existing smoke transport required')
    check()
    outer = parent_deadline if outer_parent_deadline is None else outer_parent_deadline
    if type(outer) not in (int,float) or not math.isfinite(outer) or not time.monotonic()<parent_deadline<=outer:
        raise ValueError('same finite role/outer absolute deadline required')
    timing = dict(timingModel='actual-service-abi-parent-window-v1',
        startedUTCNs=str(time.time_ns()), startedMonotonicNs=str(time.monotonic_ns()),
        outerParentDeadlineMonotonicNs=str(int(outer*10**9)),
        operationDeadlineMonotonicNs=str(int(parent_deadline*10**9)))
    session = None
    primary = None
    try:
        session = transport.SmokeSession(command, parent_deadline=parent_deadline,
            byte_limit=_BYTE_LIMIT, reserve=reserve,
            cleanup_seconds=_CLEANUP_SECONDS)
        _read_frame(session, 'ready', role, nonce)
        check()
        membership = capture_membership()
        check()
        if not isinstance(membership, dict) or not membership:
            raise ValueError('nonempty membership adapter result required')
        shutdown = (json.dumps({'phase': 'shutdown', 'role': role,
            'nonce': nonce}, separators=(',', ':')) + '\n').encode('utf-8')
        session.write(shutdown)
        _read_frame(session, 'closed', role, nonce)
        returncode = session.finish()
        if type(returncode) is not int or returncode != 0:
            raise ValueError('actual Bun role session exited nonzero')
        raw = {name: bytes(session.raw[name])
               for name in ('stdin', 'stdout', 'stderr')}
    except BaseException as error:
        primary = error
        raise
    finally:
        if session is not None:
            try:
                session.close()
            except BaseException:
                if primary is None:
                    raise
    cleanup = session.cleanup
    _require_cleanup(cleanup)
    timing.update(completedUTCNs=str(time.time_ns()),completedMonotonicNs=str(time.monotonic_ns()),rawClosedBeforeTiming=True)
    return dict(command=list(command), role=role, nonce=nonce,
                membership=membership, cleanup=dict(cleanup), **timing, **raw)

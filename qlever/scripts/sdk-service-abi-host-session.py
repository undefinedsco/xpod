"""Host-side bounded protocol observation over an already-owned command.

The caller owns immutable source, CID creation/inspection/removal and complete
native/loader membership. This module never issues whole-service qualification.
"""
import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path
import threading
import time


MAX_MAPS = 8 * 1024**2
MAX_MEMBERS = 512
MAX_FILE = 8 * 1024**2
MAX_TOTAL = 8 * 1024**2
PREFIX = 'abi-membership'
DEFAULT_EXECUTABLE = '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'
PREFIX_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*')
LEDGER = threading.RLock()
LOADER = re.compile(r'(^|/)(ld-linux[^/]*\.so(?:\.[0-9]+)?|ld-musl[^/]*\.so(?:\.[0-9]+)?|ld-[0-9.]*\.so)$')
MAP_LINE = re.compile(r'^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+([0-9a-f]+)\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+(\S.*?))?\s*$')
NATIVE_SUFFIX = re.compile(r'\.(?:so(?:\.\d+)*|node)$')
REF_KEYS = {'path', 'bytes', 'sha256'}


def need(ok, message):
    if not ok:
        raise ValueError('Service ABI membership: ' + message)


def ident(value):
    return [value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _canonical_expected_executable(value):
    need(isinstance(value, str) and value.startswith('/') and not value.startswith('//')
         and value != '/' and not value.endswith('/') and '\x00' not in value
         and os.path.normpath(value) == value,
         'canonical absolute expected executable required')
    return value


def _canonical_original_prefix(value):
    need(isinstance(value, str) and PREFIX_NAME.fullmatch(value) is not None,
         'canonical safe relative original prefix required')
    return value


def plain_ref(value):
    return (isinstance(value, dict) and set(value) == REF_KEYS
            and isinstance(value.get('path'), str) and value['path']
            and type(value.get('bytes')) is int and value['bytes'] >= 0
            and isinstance(value.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', value['sha256']))


def _read_regular(path, maximum, check, expected=None, read_budget=None):
    """Read one actual regular file through a held descriptor, rejecting swaps.

    ``expected`` is the earlier named-stat identity joined to the kernel maps;
    it must match the reopened/held file, not merely a fresh lstat of the name.
    """
    value = os.lstat(path)
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and 0 < value.st_size <= maximum,
         'bounded single-link loaded original required: ' + path)
    if expected is not None:
        need(ident(value) == expected,
             'loaded original changed between named stat and held bytes: ' + path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    primary = None
    try:
        need(ident(os.fstat(fd)) == ident(value), 'loaded original replaced before open: ' + path)
        pieces = []
        digest = hashlib.sha256()
        count = 0
        while count < value.st_size:
            check()
            block = (read_budget.read if read_budget is not None else os.read)(fd, min(65536, value.st_size - count))
            need(bool(block), 'loaded original truncated: ' + path)
            pieces.append(block)
            digest.update(block)
            count += len(block)
        need(ident(os.fstat(fd)) == ident(value) == ident(os.lstat(path)),
             'loaded original changed during read: ' + path)
        return b''.join(pieces), digest.hexdigest(), value
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise


def _hash_regular(path, maximum, check, expected=None, read_budget=None):
    """Hash actual bytes of one system library without retaining a second copy.

    The reopened identity must equal the earlier named stat whose dev/inode was
    joined to the actual kernel maps; a swap in that gap is rejected.
    """
    value = os.lstat(path)
    need(stat.S_ISREG(value.st_mode) and value.st_nlink >= 1 and 0 < value.st_size <= maximum,
         'bounded actual system library required: ' + path)
    if expected is not None:
        need(ident(value) == expected,
             'system library changed between named stat and held bytes: ' + path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    primary = None
    try:
        need(ident(os.fstat(fd)) == ident(value), 'system library replaced before open: ' + path)
        digest = hashlib.sha256()
        count = 0
        while count < value.st_size:
            check()
            block = (read_budget.read if read_budget is not None else os.read)(fd, min(65536, value.st_size - count))
            need(bool(block), 'system library truncated: ' + path)
            digest.update(block)
            count += len(block)
        need(ident(os.fstat(fd)) == ident(value) == ident(os.lstat(path)),
             'system library changed during read: ' + path)
        return digest.hexdigest(), value
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise


def _retain_membership(retained, name, raw, maximum, check):
    """Register one full original through the existing bounded ledger.

    The existing retained ledger may be concurrently charging protocol streams,
    so its reviewed reserve/settle pair is serialized under one shared lock. A
    successful reservation is always settled by actual bytes; failures keep the
    charge rather than refunding an unproven allocation.
    """
    need(type(maximum) is int and 0 <= maximum <= MAX_FILE, 'bounded membership maximum')
    need(0 <= len(raw) <= maximum, 'membership original exceeds typed bound')
    lock = getattr(retained, 'ledger_lock', LEDGER)
    with lock:
        retained.budget.check(0)
        expected = dict(path=name, bytes=len(raw), sha256=sha(raw))
        if expected['path'] in retained.refs:
            need(retained.refs[expected['path']] == expected, 'same retained membership original required')
            return expected
        retained.reserve(len(raw))
        target = retained.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        need(target.parent.resolve(strict=True) == target.parent, 'canonical membership original parent')
        with target.open('xb') as stream:
            need(stream.write(raw) == len(raw), 'short membership original write')
            stream.flush()
            os.fsync(stream.fileno())
        retained.settle(len(raw), [expected], {name: maximum})
    return expected


def _read_maps(pid, proc_root, check, read_budget=None):
    path = os.path.join(proc_root, str(pid), 'maps')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        pieces = []
        count = 0
        while True:
            check()
            block = (read_budget.read if read_budget is not None else os.read)(fd, min(65536, MAX_MAPS + 1 - count))
            if not block:
                break
            count += len(block)
            need(count <= MAX_MAPS, 'actual process maps exceeded bound')
            pieces.append(block)
        return b''.join(pieces)
    finally:
        os.close(fd)


def _parse_maps(raw):
    """Parse complete kernel maps; only validated anonymous/bracket rows skip."""
    rows = []; selected = []; skipped = 0; anonymous = 0; seen_offsets = set()
    for line in raw.decode('utf-8').splitlines():
        if not line:
            continue
        match = MAP_LINE.match(line)
        need(bool(match), 'actual complete maps line required')
        start, end, perms, offset, major, minor, inode, path = match.groups()
        start, end, offset = int(start, 16), int(end, 16), int(offset, 16)
        need(0 <= start < end, 'actual nonempty mapping range')
        if path is None:
            # Real anonymous mappings have no pathname at all; they carry no
            # loaded-file identity and are never treated as a skipped member.
            anonymous += 1
            continue
        if path.startswith('['):
            need(path.endswith(']'), 'bracketed anonymous mapping format')
            anonymous += 1
            continue
        need(not path.endswith(' (deleted)'), 'deleted file-backed mapping cannot retain original bytes')
        need(os.path.isabs(path), 'absolute actual mapped path required')
        key = (path, start, end, offset, perms)
        need(key not in seen_offsets, 'duplicate actual maps line')
        seen_offsets.add(key)
        row = dict(path=path, start=start, end=end, offset=offset, permissions=perms,
                   devMajor=int(major, 16), devMinor=int(minor, 16), inode=int(inode))
        rows.append(row)
        executable = perms[2] == 'x'
        native = bool(NATIVE_SUFFIX.search(path)) or bool(LOADER.search(path))
        if executable or native:
            selected.append(row)
        else:
            skipped += 1
    need(bool(selected), 'at least one actual executable/native file mapping required')
    return dict(rows=rows, selected=selected, skipped=skipped, anonymous=anonymous)


def _exe(pid, proc_root):
    path = os.path.join(proc_root, str(pid), 'exe')
    try:
        return os.readlink(path)
    except OSError as error:
        raise ValueError('actual process executable link required') from error


def observe_process(pid, *, retained, proc_root='/proc',
                    runtime_roots=('/app', '/opt/xpod/qlever'),
                    container=None, check=None,
                    expected_executable=DEFAULT_EXECUTABLE,
                    original_prefix=PREFIX,
                    reference_runtime_members=False, read_budget=None, elf_module=None):
    """Retain one actual live process observation under the existing ledger.

    ``container`` is only a typed locator copied from the already-proven ABI
    session; it grants nothing. The receiver must still match it to the private
    runtime-artifact identity and protocol session. ``expected_executable`` and
    ``original_prefix`` are validated canonical declarations, but the former is
    only satisfied by the actual ``/proc/<pid>/exe`` file identity and bytes.
    """
    need(type(pid) is int and pid > 0, 'positive actual kernel pid required')
    need(isinstance(runtime_roots, (tuple, list)) and runtime_roots
         and all(isinstance(root, str) and root.startswith('/') and not root.endswith('/')
                 for root in runtime_roots), 'canonical runtime roots required')
    runtime_roots = tuple(runtime_roots)
    expected_executable = _canonical_expected_executable(expected_executable)
    original_prefix = _canonical_original_prefix(original_prefix)
    need(type(reference_runtime_members) is bool, 'explicit runtime reference mode required')
    need(not reference_runtime_members or (read_budget is not None and callable(read_budget.read)), 'one parent-owned shared read ledger required for runtime references')
    read_start = read_budget.consumed if read_budget is not None else None
    check = check or (lambda: None)
    check()
    raw = _read_maps(pid, proc_root, check, read_budget)
    maps_ref = _retain_membership(retained, original_prefix + '/maps.original', raw, MAX_MAPS, check)
    parsed = _parse_maps(raw)
    rows = parsed['selected']
    exe = _exe(pid, proc_root)
    need(os.path.isabs(exe), 'absolute actual executable required')
    need(exe == expected_executable, 'actual executable path differs from expected executable: ' + exe)
    root_prefix = os.path.join(proc_root, str(pid), 'root')
    need(os.path.isdir(root_prefix), 'actual live process root required')
    actual_executable = os.stat(os.path.join(proc_root, str(pid), 'exe'))
    try:
        declared_executable = os.stat(root_prefix + exe)
    except OSError as error:
        raise ValueError('actual executable is absent from the observed process root') from error
    need(stat.S_ISREG(actual_executable.st_mode)
         and ident(actual_executable) == ident(declared_executable),
         'actual executable file identity differs from named expected executable: ' + exe)
    by_path = {}
    for row in rows:
        by_path.setdefault(row['path'], []).append(row)
    need(len(by_path) <= MAX_MEMBERS, 'complete loaded member bound')
    members = []
    total = 0
    streamed = 0
    executable_identity = None
    for path, mapped in sorted(by_path.items()):
        check()
        value = os.stat(root_prefix + path, follow_symlinks=False)
        need(stat.S_ISREG(value.st_mode) and value.st_nlink >= 1,
             'loaded mapping must be one ordinary file: ' + path)
        inode = mapped[0]
        need(value.st_ino == inode['inode'] and os.makedev(inode['devMajor'], inode['devMinor']) == value.st_dev,
             'actual maps device/inode differs from named file: ' + path)
        need(all(item['inode'] == inode['inode'] and item['devMajor'] == inode['devMajor']
                 and item['devMinor'] == inode['devMinor'] for item in mapped),
             'same loaded path has different actual file identities')
        runtime_scope = any(path == root or path.startswith(root + '/') for root in runtime_roots)
        retain = bool(LOADER.search(path)) or (not reference_runtime_members and (runtime_scope or path == exe))
        expected = ident(value)
        if retain:
            raw_file, digest, before = _read_regular(root_prefix + path, MAX_FILE, check, expected, read_budget)
            need(ident(before) == expected,
                 'actual maps device/inode differs from held loaded bytes: ' + path)
            total += len(raw_file)
            need(total <= MAX_TOTAL, 'complete loaded runtime/loader bytes exceed bound')
            name = original_prefix + '/members/' + digest + '.original'
            original = _retain_membership(retained, name, raw_file, MAX_FILE, check)
            byte_count = len(raw_file)
        else:
            # This mode reuses the already-held service runtime originals.
            # Actual FD bytes are still hashed; the receiver must independently
            # join every product member to its private runtime-artifact reader.
            maximum = 128 * 1024**2 - streamed if reference_runtime_members else MAX_FILE
            digest, before = _hash_regular(root_prefix + path, maximum, check, expected, read_budget)
            need(ident(before) == expected,
                 'actual maps device/inode differs from held system bytes: ' + path)
            original = None
            byte_count = before.st_size
        if path == exe:
            executable_identity = ident(before)
        streamed += byte_count
        if reference_runtime_members:
            need(streamed <= 128 * 1024**2, 'same service member stream bound exceeded')
        members.append(dict(path=path, scope='runtime-sdk' if runtime_scope else 'loader-or-system',
                            type='file', mode=stat.S_IMODE(before.st_mode), bytes=byte_count,
                            sha256=digest, dev=before.st_dev, ino=before.st_ino,
                            mtimeNs=before.st_mtime_ns, ctimeNs=before.st_ctime_ns,
                            retained=retain, original=original,
                            mappings=[dict(start=item['start'], end=item['end'],
                                           offset=item['offset'], permissions=item['permissions'],
                                           devMajor=item['devMajor'], devMinor=item['devMinor'],
                                           inode=item['inode'])
                                      for item in sorted(mapped, key=lambda row: row['start'])]))
    names = {row['path'] for row in members}
    need(exe in names, 'actual executable must own a loaded file mapping')
    loaders = [row for row in members if LOADER.search(row['path'])]
    elf_loader = None
    if elf_module is not None:
        need(read_budget is not None and callable(getattr(elf_module, 'inspect_elf_loader', None)), 'shared ledger and source-bound ELF reader required')
        named = root_prefix + exe
        fd = os.open(named, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            held = os.fstat(fd)
            need(ident(held) == executable_identity == ident(os.lstat(named)), 'same mapped executable before ELF inspection')
            def read_elf(offset, length):
                check()
                need(os.lseek(fd, offset, os.SEEK_SET) == offset, 'exact ELF range offset')
                return read_budget.read(fd, length)
            elf_loader = elf_module.inspect_elf_loader(read_elf, held.st_size, check)
            need(ident(os.fstat(fd)) == executable_identity == ident(os.lstat(named)), 'same mapped executable after ELF inspection')
        finally:
            os.close(fd)
    if elf_loader is not None and elf_loader['kind'] == 'static':
        need(not loaders, 'static ELF must not invent a dynamic loader')
    else:
        need(len(loaders) == 1, 'exactly one actual loader interpreter required')
        need(loaders[0]['scope'] == 'loader-or-system', 'loader must be observed outside the runtime-artifact scope')
        need(any(mapping['permissions'][2] == 'x' for mapping in loaders[0]['mappings']), 'actual loader executable mapping required')
        if elf_loader is not None:
            named_loader = os.stat(root_prefix + elf_loader['interpreter'])
            need(named_loader.st_dev == loaders[0]['dev'] and named_loader.st_ino == loaders[0]['ino'], 'actual PT_INTERP identity must match mapped loader')
    executable = next(row for row in members if row['path'] == exe)
    expected_scope = 'runtime-sdk' if any(
        exe == root or exe.startswith(root + '/') for root in runtime_roots) else 'loader-or-system'
    need(executable['scope'] == expected_scope
         and (reference_runtime_members or executable['retained'] is True),
         'actual executable must be retained under its observed scope')
    observation = dict(schemaVersion=1, kind='actual-service-runtime-membership',
                       observation='actual-live-proc-maps-and-held-regular-file-bytes',
                       pid=pid, runtimeRoots=list(runtime_roots),
                       executableMappingPath=exe,
                       executablePath=exe, executableSha256=executable['sha256'],
                       loaderPath=loaders[0]['path'] if loaders else None, loaderSha256=loaders[0]['sha256'] if loaders else None,
                       mapsOriginal=maps_ref, mapsSha256=maps_ref['sha256'],
                       members=members, inventoryComplete=True,
                       allFileMappings=len(parsed['rows']),
                       selectedMappings=len(rows),
                       ignoredDataMappings=parsed['skipped'],
                       anonymousMappings=parsed['anonymous'],
                       retainedRuntimeAndLoaderBytes=total,
                       serviceAbiVerified=False,
                       pending=[])
    if elf_loader is not None:
        observation['elfLoader'] = elf_loader
    if reference_runtime_members:
        observation['runtimeArtifactReferences'] = True
        observation['streamedMemberBytes'] = streamed
    if read_budget is not None:
        observation['sharedReadBytes'] = dict(before=read_start, after=read_budget.consumed)
    if container is not None:
        need(isinstance(container, dict) and set(container) == {'containerId', 'configDigest', 'imageDigest'}
             and isinstance(container['containerId'], str)
             and re.fullmatch('[a-f0-9]{64}', container['containerId'])
             and re.fullmatch('sha256:[a-f0-9]{64}', container['configDigest'])
             and (re.fullmatch('sha256:[a-f0-9]{64}', container['imageDigest']) or
                  re.fullmatch('ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[a-f0-9]{64}', container['imageDigest'])),
             'exact already-proven ABI container locator required')
        observation['container'] = dict(container)
    encoded = json.dumps(observation, sort_keys=True).encode()
    need(len(encoded) <= 1024**2, 'bounded membership observation required')
    original = _retain_membership(retained, original_prefix + '/observation.original.json', encoded, 1024**2, check)
    return dict(observation=original, maps=maps_ref,
                members=[row['original'] for row in members if row['original'] is not None],
                serviceAbiVerified=False)


def find_container_pid(container_id, proc_root='/proc'):
    """Find exactly one live process by actual cgroup CID, never caller JSON."""
    need(isinstance(container_id, str) and re.fullmatch('[a-f0-9]{64}', container_id),
         'full actual owned container id required')
    matches = []
    for name in os.listdir(proc_root):
        if not name.isdigit():
            continue
        base = os.path.join(proc_root, name)
        try:
            with open(os.path.join(base, 'cmdline'), 'rb') as stream:
                cmdline = stream.read(65537)
            with open(os.path.join(base, 'cgroup'), 'rb') as stream:
                cgroup = stream.read(65537)
        except OSError:
            continue
        if len(cmdline) > 65536 or len(cgroup) > 65536:
            continue
        parts = cmdline.rstrip(b'\0').split(b'\0')
        if not any(part == b'/opt/xpod/qlever/bin/xpod_qlever_local_runtime' for part in parts):
            continue
        if b'/scratch/abi.sqlite' not in parts:
            continue
        if container_id.encode() not in cgroup:
            continue
        root = os.path.join(base, 'root')
        if not os.path.isfile(root + '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'):
            continue
        matches.append(int(name))
    need(len(matches) == 1, 'exactly one actual live process for the owned container cgroup required')
    return matches[0]


def container_pid_provider(container_id):
    """Return a live-PID resolver bound to one actual owned container ID."""
    need(isinstance(container_id, str) and re.fullmatch('[a-f0-9]{64}', container_id),
         'full actual owned container id required')
    return lambda: find_container_pid(container_id)


def role_container_pid_provider(container_id, expected_executable, *, read_budget,
                                check, proc_root='/proc'):
    """Resolve a live executable through actual owned cgroup and held read IO.

    The caller selects the executable from the source-bound role command. The
    subsequent membership observer separately joins /proc/exe to its named inode.
    No PID supplied by a report or Docker JSON is accepted here.
    """
    need(isinstance(container_id, str) and re.fullmatch('[a-f0-9]{64}', container_id),
         'full actual owned role container id required')
    need(isinstance(expected_executable, str) and expected_executable.startswith('/')
         and all(part not in ('', '.', '..') for part in expected_executable[1:].split('/'))
         and not any(ord(c) < 32 or ord(c) == 127 for c in expected_executable),
         'canonical actual role executable required')
    need(read_budget is not None and callable(check), 'same shared role read budget required')
    pattern = re.compile(rb'(?<![0-9a-f])' + container_id.encode() + rb'(?![0-9a-f])')

    def locate():
        matches = []
        check()
        for name in os.listdir(proc_root):
            check()
            if not name.isdigit():
                continue
            base = os.path.join(proc_root, name)
            # Only OS lookup failures are skippable. Cancellation/read-budget
            # failures propagate even when they use an OSError subclass.
            try:
                fd = os.open(os.path.join(base, 'cgroup'), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            try:
                data = read_budget.read(fd, 65536)
                extra = read_budget.read(fd, 1)
            finally:
                os.close(fd)
            if extra or not pattern.search(data):
                continue
            try:
                actual = os.readlink(os.path.join(base, 'exe'))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if actual == expected_executable:
                matches.append(int(name))
        need(len(matches) == 1, 'exactly one actual executable in owned role cgroup required')
        check()
        return matches[0]
    return locate


def observe(command, *, helper, transport, replay, expected_abi, output,
            parent_deadline, outer_parent_deadline, reserve, membership=None,
            membership_module=None, membership_container=None,
            membership_pid_provider=None, membership_read_budget=None,
            membership_elf_module=None, reference_runtime_members=False):
    """Retain one existing owned command's protocol and, when requested, the
    actual live PID maps/full loaded native/loader bytes of that same process.

    Membership observation is charged to the existing ledger and runs while the
    child is still alive. It grants no ABI/source authority by itself.
    """
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
    if membership is not None:
        if not hasattr(membership_module, 'observe_process'):
            raise ValueError('actual membership module required for same-ledger retention')
        if not callable(membership_pid_provider):
            raise ValueError('actual live container pid provider required')
    output.mkdir(mode=0o700, exist_ok=False)
    child = None
    primary = None
    membership_result = None
    result = dict(schemaVersion=1, command=list(command), releaseAccepted=False,
                  serviceAbiVerified=False, protocolObserved=False, **timing,
                  scope='actual host protocol session only; CID, source, native and loader authority independent')
    def check():
        if time.monotonic() >= parent_deadline:
            raise TimeoutError('same existing ABI parent window exhausted')
    try:
        check()
        def capture_membership():
            nonlocal membership_result
            if not child.ready_checked:
                raise ValueError('actual ready handshake required before membership')
            pid = membership_pid_provider()
            if type(pid) is not int or pid <= 0:
                raise ValueError('actual live owned ABI pid required')
            membership_result = membership_module.observe_process(
                pid, retained=membership, container=membership_container,
                check=check, read_budget=membership_read_budget,
                elf_module=membership_elf_module,
                reference_runtime_members=reference_runtime_members)
            if not membership_result or not membership_result.get('observation'):
                raise ValueError('complete same-process membership observation required')
        child = transport.SmokeProcess(command, expected_abi=expected_abi,
            parent_deadline=parent_deadline, byte_limit=1024**2,
            reserve=reserve, cleanup_seconds=2,
            pre_shutdown_hook=capture_membership if membership is not None else None)
        with child:
            observed = helper._run_runtime_smoke_session(child)
            if membership is not None:
                if not child.pre_shutdown_done:
                    raise ValueError('actual synchronous pre-shutdown membership hook did not run')
                if membership_result is None or not membership_result.get('observation'):
                    raise ValueError('complete same-process membership observation required')
                result['membership'] = membership_result
                result['membershipObserved'] = True
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

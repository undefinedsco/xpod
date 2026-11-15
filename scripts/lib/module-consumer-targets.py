"""Consumer adapters for the single TypeScript product-target authority."""
import json
import os
import pathlib
import shutil
import subprocess

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent


def require(value, message):
    if not value:
        raise ValueError(message)


def target(module_id, value, bun, host=False):
    args = [bun, str(SCRIPTS / 'module-product-targets.ts'), module_id, value]
    if host:
        args.append('--require-host')
    result = subprocess.run(args, text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, 'product target/host declaration rejected')
    row = json.loads(result.stdout)
    require(row.get('target') == value, 'target authority returned a different target')
    return row


def installed(package, declaration, module_id):
    require(package.get('name') == declaration['name'], 'installed target package name differs')
    module = package.get('xpodModule', {})
    require(module.get('id') == module_id and module.get('platform') == declaration['platform']
            and module.get('arch') == declaration['arch'], 'installed module platform/arch differs')


def native_files(package_root, package, target_name, bun, required, module_id):
    rows = package['xpodModule']['files']
    names = {row['path'] for row in rows}
    require(all(name in names for name in required), 'required installed native executable absent')
    require(all(row['mode'] & 0o111 for row in rows if row['path'] in required), 'required native file is not executable')
    magic = {b'\x7fELF', b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
             b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}
    selected = []
    for row in rows:
        if row['path'].startswith(('provenance/', 'licenses/')):
            continue
        file = package_root / row['path']
        with file.open('rb') as stream:
            head = stream.read(4)
        if head in magic or head[:2] == b'MZ' or row['path'] in required:
            require(file.is_file() and not file.is_symlink(), 'invalid installed native file')
            selected.append(dict(path=str(file), size=row['size'], sha256=row['sha256']))
    request = dict(module=module_id, target=target_name, files=selected)
    result = subprocess.run([bun, str(SCRIPTS / 'verify-module-consumer-native.ts')], input=json.dumps(request),
                            text=True, capture_output=True, timeout=30)
    require(result.returncode == 0, 'installed native format/target verification failed')
    checked = json.loads(result.stdout)
    require(checked.get('target') == target_name and len(checked.get('files', [])) == len(selected), 'native verification result mismatch')
    return checked


def sandbox(declaration, cycle, roots):
    if declaration['platform'] == 'darwin':
        executable = pathlib.Path('/usr/bin/sandbox-exec')
        require(executable.is_file(), 'sandbox-exec unavailable; no unsandboxed fallback')
        return [str(executable), '-f', str(cycle / 'deny.sb')]
    require(declaration['platform'] == 'linux', 'unsupported isolation platform')
    executable = shutil.which('bwrap')
    require(executable, 'bubblewrap unavailable; no unsandboxed fallback')
    # Mount namespace masks each known source; descendants inherit it. PID
    # isolation prevents /proc/<host-pid>/root from exposing the original mount.
    args = [executable, '--die-with-parent', '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/',
            '--proc', '/proc', '--dev', '/dev', '--bind', str(cycle), str(cycle), '--cap-drop', 'ALL']
    masked = []
    for root in sorted(roots, key=lambda p: len(str(p))):
        if any(root == parent or parent in root.parents for parent in masked):
            continue
        masked.append(root)
        args += ['--perms', '000', '--tmpfs', str(root)]
    return args + ['--']


def linux_service_pid(group, known, runtimes):
    """Locate the unique outer owned runtime, never signal the bwrap supervisor.

    The original CLI must receive TERM first to shut down its own descendants.
    Process identities must match the caller's current observed group snapshot.
    """
    output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,lstart='], text=True)
    rows = {}
    for line in output.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[2] == str(group):
            rows[int(parts[0])] = (int(parts[1]), parts[3])
    executables = {pathlib.Path(value).resolve(strict=True) for value in runtimes}
    candidates = set()
    for pid, (_parent, start) in rows.items():
        require(known.get(pid) == start, 'service process group identity changed')
        try:
            executable = (pathlib.Path('/proc') / str(pid) / 'exe').resolve(strict=True)
        except FileNotFoundError:
            continue
        if executable in executables:
            candidates.add(pid)
    outer = []
    for pid in candidates:
        ancestor = rows[pid][0]
        visited = {pid}
        while ancestor in rows:
            require(ancestor not in visited, 'cyclic service process ancestry')
            visited.add(ancestor)
            if ancestor in candidates:
                break
            ancestor = rows[ancestor][0]
        else:
            outer.append(pid)
    require(len(outer) == 1, 'unique owned service runtime required')
    require(os.getpgid(outer[0]) == group, 'service runtime left owned process group')
    return outer[0]

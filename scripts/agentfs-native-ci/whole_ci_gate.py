#!/usr/bin/env python3
"""Controlled CI whole-integration gate for the cache candidate.

Reuses scripts/agentfs-native-ci/supervise.py to run the ORIGINAL, unfiltered
`bun run test:integration` twice. Each run records the real producer
exit/signal, a closed raw-log SHA, process-group absence, the continuous disk
guard, unique lowercase XPOD_FULL_PROJECT/XPOD_FULL_RUN_ID, full tracked +
physical (source and loaded runtime dependency) before/after snapshots, and
that the exact project resource set is empty afterwards.

This is a development gate, not a release path.
"""
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import supervise  # existing owned supervisor API

ROOT = Path(os.environ.get('XPOD_WHOLE_ROOT', Path.cwd())).resolve()
EVIDENCE = Path(os.environ.get('XPOD_WHOLE_EVIDENCE', ROOT / '.test-data' / 'whole-ci')).resolve()
BUN = os.environ.get('XPOD_WHOLE_BUN', 'bun')
RUNS = int(os.environ.get('XPOD_WHOLE_RUNS', '2'))
FRESH_BYTES = 3 * 1024 ** 3
STOP_BYTES = 512 * 1024 ** 2
TIMEOUT = int(os.environ.get('XPOD_WHOLE_TIMEOUT', '5400'))
NONCE = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dt%H%M%Sz')

PATCHED = [
    'node_modules/@solid/community-server',
    'node_modules/@undefineds.co/drizzle-solid',
    'node_modules/jose',
    'node_modules/oidc-provider',
    'node_modules/@inrupt/solid-client-authn-browser',
    'node_modules/@inrupt/solid-client-authn-core',
]
RUNTIME_INPUTS = ['node_modules/drizzle-orm', 'node_modules/@undefineds.co/models']


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def tracked_snapshot():
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    digest, entries, count = hashlib.sha256(), {}, 0
    for rel in sorted(set(files) - {''}):
        path = ROOT / rel
        digest.update(rel.encode())
        if path.is_symlink():
            target = sha256_bytes(os.readlink(path).encode())
            digest.update(target.encode())
            entries[rel] = {'kind': 'symlink', 'targetSha256': target}
        elif path.is_file():
            body = sha256_file(path)
            digest.update(body.encode())
            entries[rel] = {'kind': 'file', 'size': path.stat().st_size, 'sha256': body}
        count += 1
    changed = {}
    for line in subprocess.check_output(
            ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd=ROOT).decode().split('\0'):
        if len(line) > 3:
            rel = line[3:]
            path = ROOT / rel
            if path.is_symlink():
                changed[rel] = {'kind': 'symlink', 'targetSha256': sha256_bytes(os.readlink(path).encode())}
            elif path.is_file():
                changed[rel] = {'kind': 'file', 'size': path.stat().st_size, 'sha256': sha256_file(path)}
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'status': subprocess.check_output(
                ['git', 'status', '--porcelain=v1', '--untracked-files=all'], cwd=ROOT).decode(),
            'trackedFileCount': count, 'trackedDigestSha256': digest.hexdigest(),
            'entries': entries, 'changed': changed}


def manifest_snapshot():
    packages = ROOT / 'packages'
    roots = (['dist', 'static', 'bin', 'config', 'patches', 'package.json', 'bun.lock',
              'tools/agentfs-pod/src', 'scripts/agentfs-native-ci']
             + [f'packages/{name}/dist' for name in sorted(os.listdir(packages))
                if (packages / name / 'dist').is_dir()]
             + RUNTIME_INPUTS + PATCHED)
    present, entries, combined = [], {}, hashlib.sha256()

    def record(rel, path):
        if path.is_symlink():
            value = sha256_bytes(os.readlink(path).encode())
            entries[rel] = {'kind': 'symlink', 'targetSha256': value}
        elif path.is_file():
            value = sha256_file(path)
            entries[rel] = {'kind': 'file', 'size': path.stat().st_size, 'sha256': value}
        else:
            return
        combined.update(rel.encode() + value.encode())

    for rel_root in roots:
        base = ROOT / rel_root
        if not base.exists() and not base.is_symlink():
            continue
        present.append(rel_root)
        if base.is_symlink() or base.is_file():
            record(rel_root, base)
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            for name in list(dirnames):
                if os.path.islink(os.path.join(dirpath, name)):
                    dirnames.remove(name)
            if os.path.islink(dirpath):
                continue
            for name in sorted(filenames):
                path = Path(dirpath) / name
                record(str(path.relative_to(ROOT)), path)
    return {'rootsRequested': roots, 'rootsPresent': present, 'fileCount': len(entries),
            'combinedDigestSha256': combined.hexdigest(), 'entries': entries}


def docker_root():
    try:
        value = subprocess.check_output(
            ['docker', 'info', '--format', '{{.DockerRootDir}}'], text=True).strip()
        if value:
            return value
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return '/var/lib/docker'


def free_bytes(*paths):
    """Continuous free guard over BOTH the evidence filesystem and the actual
    Docker storage mount. Returns the smaller of the two so a run stops before
    either floor is crossed. Linux-native, no colima identity assumption."""
    candidates = [shutil.disk_usage(path).free for path in paths]
    return collections.namedtuple('Usage', 'total used free')(0, 0, min(candidates))


def project_names(project):
    try:
        output = subprocess.check_output(
            ['docker', 'ps', '-a', '--filter', f'name={project}', '--format', '{{.Names}}'],
            text=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return [line for line in output.splitlines() if line.strip()]


def write_json(name, payload):
    path = EVIDENCE / name
    path.write_text(json.dumps(payload, indent=2) + '\n')
    os.chmod(path, 0o600)


def main():
    EVIDENCE.mkdir(mode=0o700, parents=True, exist_ok=True)
    docker_storage = docker_root()
    bun_version = subprocess.check_output([BUN, '--version'], text=True).strip()
    summary = {'nonce': NONCE, 'root': str(ROOT), 'evidence': str(EVIDENCE),
               'runsRequested': RUNS, 'bun': BUN, 'bunVersion': bun_version,
               'dockerRoot': docker_storage, 'freshBytes': FRESH_BYTES,
               'stopBytes': STOP_BYTES, 'timeoutSeconds': TIMEOUT, 'runs': []}
    write_json('gate-summary.json', summary)
    if bun_version != '1.4.2':
        raise SystemExit(f'official Bun 1.4.2 required, got {bun_version}')
    ok = True
    for index in range(1, RUNS + 1):
        tag = f'whole{index}'
        project = f'xpod-afs-cache-ci-{NONCE}-{index}'.lower()
        run_id = f'{NONCE}-{index}'.lower()
        source_before = tracked_snapshot()
        manifest_before = manifest_snapshot()
        write_json(f'SOURCE-BEFORE-{tag}.json', source_before)
        write_json(f'MANIFEST-BEFORE-{tag}.json', manifest_before)
        environment = dict(os.environ)
        environment['XPOD_FULL_PROJECT'] = project
        environment['XPOD_FULL_RUN_ID'] = run_id
        receipt, _ = supervise.run_stage(
            tag, [BUN, 'run', 'test:integration'], EVIDENCE, ROOT,
            free=lambda _evidence: free_bytes(EVIDENCE, docker_storage),
            fresh_bytes=FRESH_BYTES, stop_bytes=STOP_BYTES, timeout=TIMEOUT,
            environment=environment)
        source_after = tracked_snapshot()
        manifest_after = manifest_snapshot()
        write_json(f'SOURCE-AFTER-{tag}.json', source_after)
        write_json(f'MANIFEST-AFTER-{tag}.json', manifest_after)
        remaining = project_names(project)
        receipt.update({
            'project': project, 'runId': run_id,
            'sourceUnchanged': source_before['trackedDigestSha256'] == source_after['trackedDigestSha256']
            and source_before['status'] == source_after['status'],
            'manifestUnchanged': manifest_before['combinedDigestSha256'] == manifest_after['combinedDigestSha256'],
            'sourceBeforeDigest': source_before['trackedDigestSha256'],
            'sourceAfterDigest': source_after['trackedDigestSha256'],
            'manifestBeforeDigest': manifest_before['combinedDigestSha256'],
            'manifestAfterDigest': manifest_after['combinedDigestSha256'],
            'manifestBeforeCount': manifest_before['fileCount'],
            'manifestAfterCount': manifest_after['fileCount'],
            'projectResourceRemaining': remaining,
        })
        write_json(f'{tag}.receipt.json', receipt)
        passed = (receipt['exit'] == 0 and receipt['signal'] is None and receipt['resourceStop'] is None
                  and receipt['ownedGroupAbsentAfterWait'] and not remaining)
        summary['runs'].append({key: receipt[key] for key in (
            'project', 'runId', 'exit', 'signal', 'resourceStop', 'rawClosedBeforeHash', 'rawSHA256',
            'actualWait', 'ownedGroupAbsentAfterWait', 'sourceUnchanged', 'manifestUnchanged',
            'manifestBeforeCount', 'manifestAfterCount', 'projectResourceRemaining', 'elapsedSeconds') if key in receipt}
            | {'passed': passed})
        ok = ok and passed
        write_json('gate-summary.json', summary)
    summary['ok'] = ok
    write_json('gate-summary.json', summary)
    print(json.dumps(summary))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())

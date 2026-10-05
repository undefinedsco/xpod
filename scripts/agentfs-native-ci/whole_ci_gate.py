#!/usr/bin/env python3
"""Controlled CI whole-integration gate for the cache candidate.

Reuses scripts/agentfs-native-ci/supervise.py to run the ORIGINAL, unfiltered
`bun run test:integration` twice. Each run records the real producer
exit/signal, a closed raw-log SHA, process-group absence, the continuous disk
guard over both the evidence filesystem and the actual Docker storage mount,
unique lowercase XPOD_FULL_PROJECT/XPOD_FULL_RUN_ID, full tracked + physical
(source and loaded runtime dependency) before/after snapshots, and a bounded,
label-scoped cleanup proof. A pass requires every one of those, never just a
zero exit.

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
PROBE_TIMEOUT = int(os.environ.get('XPOD_WHOLE_PROBE_TIMEOUT', '15'))
NONCE = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dt%H%M%Sz')
COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

PATCHED = [
    'node_modules/@solid/community-server',
    'node_modules/@undefineds.co/drizzle-solid',
    'node_modules/jose',
    'node_modules/oidc-provider',
    'node_modules/@inrupt/solid-client-authn-browser',
    'node_modules/@inrupt/solid-client-authn-core',
]
RUNTIME_INPUTS = ['node_modules/drizzle-orm', 'node_modules/@undefineds.co/models']
REQUIRED_ROOTS = ['tools/agentfs-pod/src', 'package.json', 'bun.lock'] + RUNTIME_INPUTS + PATCHED


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def hash_tree(base, visited=None):
    """Hash every regular-file body under `base`, following symlinked files with
    their link target AND resolved body. Directory-symlink loops are bounded by
    a visited realpath set. Entries are keyed relative to `base`."""
    if visited is None:
        visited = set()
    entries, combined = {}, hashlib.sha256()

    def rec(rel, path):
        if path.is_symlink():
            target = os.readlink(path)
            real = os.path.realpath(path)
            resolved_digest, resolved_count = None, None
            if os.path.isdir(real):
                sub_entries, resolved_digest = hash_tree(Path(real), visited)
                resolved_count = len(sub_entries)
            elif os.path.isfile(real):
                resolved_digest, resolved_count = sha256_file(Path(real)), 1
            entries[rel] = {'kind': 'symlink', 'target': target, 'targetSha256': sha256_bytes(target.encode()),
                            'resolvedRealpath': real, 'resolvedFileCount': resolved_count,
                            'resolvedCombinedDigest': resolved_digest}
            combined.update(rel.encode() + (resolved_digest or '').encode())
            return
        if path.is_file():
            body = sha256_file(path)
            entries[rel] = {'kind': 'file', 'size': path.stat().st_size, 'sha256': body}
            combined.update(rel.encode() + body.encode())
            return
        if path.is_dir():
            real = os.path.realpath(path)
            if real in visited:
                return
            visited.add(real)
            for name in sorted(os.listdir(path)):
                rec(f'{rel}/{name}', path / name)

    for name in sorted(os.listdir(base)):
        rec(name, base / name)
    return entries, combined.hexdigest()


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
    present, entries, combined, missing_required = [], {}, hashlib.sha256(), []
    for rel_root in roots:
        base = ROOT / rel_root
        if not base.exists() and not base.is_symlink():
            entries[f'{rel_root}#missing'] = {'kind': 'missing'}
            if rel_root in REQUIRED_ROOTS:
                missing_required.append(rel_root)
            continue
        present.append(rel_root)
        if base.is_symlink():
            target = os.readlink(base)
            real = os.path.realpath(base)
            if os.path.isdir(real):
                sub_entries, sub_digest = hash_tree(Path(real))
                count = len(sub_entries)
            elif os.path.isfile(real):
                sub_digest, count = sha256_file(Path(real)), 1
            else:
                sub_digest, count = None, 0
            entries[rel_root] = {'kind': 'symlink', 'target': target, 'resolvedRealpath': real,
                                 'resolvedFileCount': count, 'resolvedCombinedDigest': sub_digest}
            combined.update(rel_root.encode() + (sub_digest or '').encode())
        elif base.is_file():
            body = sha256_file(base)
            entries[rel_root] = {'kind': 'file', 'size': base.stat().st_size, 'sha256': body}
            combined.update(rel_root.encode() + body.encode())
        else:
            sub_entries, sub_digest = hash_tree(base)
            for rel, value in sub_entries.items():
                entries[f'{rel_root}/{rel}'] = value
            combined.update(rel_root.encode() + sub_digest.encode())
    return {'rootsRequested': roots, 'rootsPresent': present, 'fileCount': len(entries),
            'combinedDigestSha256': combined.hexdigest(), 'missingRequired': missing_required,
            'entries': entries}


def docker_probe(argv):
    """Finite owned probe. Returns (known, stdout). Any error/timeout/nonzero is
    unknown -- never silently treated as empty."""
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_TIMEOUT)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False, None
    if result.returncode != 0:
        return False, None
    return True, result.stdout


def docker_storage_root():
    known, output = docker_probe(['docker', 'info', '--format', '{{.DockerRootDir}}'])
    if not known or not (output or '').strip():
        return None
    return output.strip()


def project_state(project):
    """Bounded, exact-label cleanup proof. Unknown is NEVER absence."""
    state, known = {}, True
    for kind, argv in (
        ('containers', ['docker', 'ps', '-a', '--filter', f'label={COMPOSE_PROJECT_LABEL}={project}', '--format', '{{.ID}}']),
        ('volumes', ['docker', 'volume', 'ls', '--filter', f'label={COMPOSE_PROJECT_LABEL}={project}', '--format', '{{.Name}}']),
        ('networks', ['docker', 'network', 'ls', '--filter', f'label={COMPOSE_PROJECT_LABEL}={project}', '--format', '{{.ID}}']),
    ):
        ok, output = docker_probe(argv)
        if not ok:
            known = False
            state[kind] = None
        else:
            state[kind] = [line for line in (output or '').splitlines() if line.strip()]
    empty = known and all(not (state.get(kind) or []) for kind in ('containers', 'volumes', 'networks'))
    return known, empty, state


def free_bytes(*paths):
    """Continuous free guard over BOTH the evidence filesystem and the actual
    Docker storage mount; the smaller of the two decides. Linux-native."""
    return collections.namedtuple('Usage', 'total used free')(
        0, 0, min(shutil.disk_usage(path).free for path in paths))


def gate_passed(receipt, source_unchanged, manifest_unchanged, cleanup_known, cleanup_empty):
    return (receipt.get('exit') == 0
            and receipt.get('signal') is None
            and receipt.get('resourceStop') is None
            and receipt.get('ownedGroupAbsentAfterWait') is True
            and receipt.get('rawClosedBeforeHash') is True
            and receipt.get('actualWait') is True
            and source_unchanged and manifest_unchanged
            and cleanup_known and cleanup_empty)


def write_json(name, payload):
    path = EVIDENCE / name
    path.write_text(json.dumps(payload, indent=2) + '\n')
    os.chmod(path, 0o600)


def self_test():
    base = {'exit': 0, 'signal': None, 'resourceStop': None,
            'ownedGroupAbsentAfterWait': True, 'rawClosedBeforeHash': True, 'actualWait': True}
    assert gate_passed(base, True, True, True, True)
    for mutated in (dict(base, rawClosedBeforeHash=False), dict(base, actualWait=False),
                    dict(base, exit=1), dict(base, signal=9), dict(base, resourceStop='floor'),
                    dict(base, ownedGroupAbsentAfterWait=False)):
        assert not gate_passed(mutated, True, True, True, True), mutated
    assert not gate_passed(base, False, True, True, True), 'source drift must fail'
    assert not gate_passed(base, True, False, True, True), 'manifest drift must fail'
    assert not gate_passed(base, True, True, False, True), 'cleanup unknown must fail'
    assert not gate_passed(base, True, True, True, False), 'cleanup non-empty must fail'
    print('whole_ci_gate self-test ok')


def main():
    if '--self-test' in sys.argv:
        self_test()
        return 0
    EVIDENCE.mkdir(mode=0o700, parents=True, exist_ok=True)
    storage = docker_storage_root()
    bun_version = subprocess.check_output([BUN, '--version'], text=True).strip()
    summary = {'nonce': NONCE, 'root': str(ROOT), 'evidence': str(EVIDENCE),
               'runsRequested': RUNS, 'bun': BUN, 'bunVersion': bun_version,
               'dockerRoot': storage, 'freshBytes': FRESH_BYTES, 'stopBytes': STOP_BYTES,
               'timeoutSeconds': TIMEOUT, 'probeTimeoutSeconds': PROBE_TIMEOUT, 'runs': []}
    write_json('gate-summary.json', summary)
    if bun_version != '1.4.2':
        raise SystemExit(f'official Bun 1.4.2 required, got {bun_version}')
    if storage is None:
        raise SystemExit('docker storage root is unknown; refusing to run (no guessed path)')
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
            free=lambda _evidence: free_bytes(EVIDENCE, storage),
            fresh_bytes=FRESH_BYTES, stop_bytes=STOP_BYTES, timeout=TIMEOUT,
            environment=environment)
        source_after = tracked_snapshot()
        manifest_after = manifest_snapshot()
        write_json(f'SOURCE-AFTER-{tag}.json', source_after)
        write_json(f'MANIFEST-AFTER-{tag}.json', manifest_after)
        source_unchanged = (source_before['trackedDigestSha256'] == source_after['trackedDigestSha256']
                            and source_before['status'] == source_after['status']
                            and source_before['head'] == source_after['head'])
        manifest_unchanged = (manifest_before['combinedDigestSha256'] == manifest_after['combinedDigestSha256']
                              and manifest_before['missingRequired'] == manifest_after['missingRequired'])
        cleanup_known, cleanup_empty, cleanup_state = project_state(project)
        passed = gate_passed(receipt, source_unchanged, manifest_unchanged, cleanup_known, cleanup_empty)
        receipt.update({
            'project': project, 'runId': run_id,
            'sourceUnchanged': source_unchanged, 'manifestUnchanged': manifest_unchanged,
            'sourceBeforeDigest': source_before['trackedDigestSha256'],
            'sourceAfterDigest': source_after['trackedDigestSha256'],
            'manifestBeforeDigest': manifest_before['combinedDigestSha256'],
            'manifestAfterDigest': manifest_after['combinedDigestSha256'],
            'manifestBeforeCount': manifest_before['fileCount'],
            'manifestAfterCount': manifest_after['fileCount'],
            'missingRequiredBefore': manifest_before['missingRequired'],
            'missingRequiredAfter': manifest_after['missingRequired'],
            'cleanupKnown': cleanup_known, 'cleanupEmpty': cleanup_empty,
            'projectResourceRemaining': cleanup_state, 'passed': passed,
        })
        write_json(f'{tag}.receipt.json', receipt)
        summary['runs'].append(receipt)
        ok = ok and passed
        write_json('gate-summary.json', summary)
    summary['ok'] = ok
    write_json('gate-summary.json', summary)
    print(json.dumps({'nonce': NONCE, 'ok': ok, 'bunVersion': bun_version, 'dockerRoot': storage,
                      'runs': [{k: run.get(k) for k in ('project', 'exit', 'signal', 'resourceStop',
                                                        'rawClosedBeforeHash', 'actualWait', 'sourceUnchanged',
                                                        'manifestUnchanged', 'missingRequiredAfter', 'cleanupKnown',
                                                        'cleanupEmpty', 'passed')} for run in summary['runs']]}))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Retain real normal-build-v1 local-runtime originals.

Consumer-side counterpart of the legacy ``sdk-service-native-runtime-host.py``.
An ordinary SDK has no legacy profile inputs.json and starts no ptrace/lease
observer, so this collector never asks for that contract. It retains exactly
what normal-build-v1 promises: the Git source recipe/tree, the canonical SDK
input hash and immutable SDK image, the immutable local-runtime image/config,
the complete runtime member inventory, and an actually executed and waited
functional smoke with separate original stdout, stderr and exit status.

The bounded supervisor, Git inventory, bounded Docker-copy helper and generic
command receipt are the existing reviewed implementations. The smoke driver
waits for each real reply before shutting down the asynchronous runtime.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / 'qlever/scripts/sdk-service-native-runtime-host.py'
VERIFIER = ROOT / 'qlever/scripts/verify-local-runtime-artifacts.py'
COMMANDS = ROOT / 'qlever/scripts/sdk-command-materials.py'
LIMITS = json.loads((ROOT / 'scripts/lib/module-artifact-limits.json').read_text())
META = LIMITS['metadataBytes']
SHA = re.compile(r'[a-f0-9]{64}')
SHA_REF = re.compile(r'.+@sha256:[a-f0-9]{64}')
PROOF_MODEL = 'normal-runtime-v1'
KIND = 'candidate-service-normal-runtime-originals'
RESULT_KIND = 'candidate-service-normal-runtime-host-result'
SOURCE_RECIPE = ('docker/qlever-local-runtime/Dockerfile',
                 'qlever/scripts/run-focused-native-build.sh',
                 'qlever/qlever.lock.json')
NON_CLAIMS = ('syscallSourceReadInventory', 'generatedInputCausality',
              'toolchainExecutionLifetime', 'kernelReadOnlyEnforcement')
SMOKE_CASES = json.loads((ROOT / 'scripts/lib/normal-local-runtime-smoke-cases.json').read_text())


def need(ok, message):
    if not ok:
        raise ValueError('Normal runtime originals: ' + message)


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def _load(path, name, attribute):
    path = Path(path)
    need(path.is_file() and not path.is_symlink(), 'existing reviewed helper required: ' + str(path))
    spec = importlib.util.spec_from_file_location(name, path)
    need(spec is not None and spec.loader is not None, 'helper importable: ' + str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, attribute, None)), 'helper API unavailable: ' + attribute)
    return module


def _positive(raw, label):
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError('Normal runtime originals: positive integer required: ' + label)
    need(0 < value <= 2 ** 53 - 1, 'bounded positive integer required: ' + label)
    return value


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='collect-normal-local-runtime-originals')
    for name in ('--source-sha', '--sdk-image', '--runtime-image', '--sdk-input-hash',
                 '--run-id', '--run-attempt', '--job', '--out', '--deadline-monotonic',
                 '--maximum-bytes'):
        parser.add_argument(name, required=True)
    parser.add_argument('--target', required=True, choices=('linux-x64', 'linux-arm64'))
    value = parser.parse_args(argv)
    need(re.fullmatch(r'[a-f0-9]{40}', value.source_sha), 'exact Git source SHA required')
    need(SHA_REF.fullmatch(value.sdk_image), 'immutable SDK image digest required')
    need(SHA_REF.fullmatch(value.runtime_image), 'immutable runtime image digest required')
    need(SHA.fullmatch(value.sdk_input_hash), 'canonical 64-hex SDK input hash required')
    value.run_id = _positive(value.run_id, 'run-id')
    value.run_attempt = _positive(value.run_attempt, 'run-attempt')
    need(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value.job), 'bounded job identity required')
    value.maximum_bytes = _positive(value.maximum_bytes, 'maximum-bytes')
    need(value.maximum_bytes <= 128 * 1024 * 1024, 'maximum bytes must be within 128MiB')
    try:
        value.deadline_monotonic = float(value.deadline_monotonic)
    except (TypeError, ValueError):
        raise ValueError('Normal runtime originals: finite monotonic deadline required')
    need(value.deadline_monotonic == value.deadline_monotonic
         and value.deadline_monotonic not in (float('inf'), float('-inf'))
         and value.deadline_monotonic > 0, 'finite monotonic deadline required')
    need(time.monotonic() < value.deadline_monotonic - 25, 'deadline cannot fund owned cleanup')
    out = Path(value.out)
    need(out.is_absolute() and out.parent.resolve(strict=True) == out.parent,
         'canonical new output parent required')
    need(not out.exists() and not out.is_symlink(), 'fresh non-linked output required')
    value.out = out
    return value


def ref(path, root):
    path, root = Path(path), Path(root).resolve(strict=True)
    need(path.is_file() and not path.is_symlink(), 'regular retained original required: ' + str(path))
    path = path.resolve(strict=True)
    need(path.is_relative_to(root), 'retained original outside owned output')
    data = path.read_bytes()
    return dict(path=path.relative_to(root).as_posix(), bytes=len(data),
                sha256=sha256_bytes(data))


def write_json(name, value, directory, budget):
    raw = json.dumps(value, sort_keys=True).encode()
    need(0 < len(raw) <= META, 'bounded JSON original required')
    budget.reserve(len(raw))
    path = Path(directory) / name
    need(not path.exists(), 'fresh JSON original required')
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return path


def smoke_input():
    return ''.join(json.dumps(case['request']) + '\n' for case in SMOKE_CASES)


def run_smoke_session(command):
    """Drive the real async runtime; EOF/shutdown would abort pending queries.

    The existing outer supervisor owns the deadline and process group. Its
    generic command child retains this driver's unmodified runtime stdout and
    inherited stderr and issues the receipt only after this function waits.
    """
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    pending = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)

    def line():
        while b'\n' not in pending:
            need(selector.select(10), 'runtime reply timed out')
            block = os.read(child.stdout.fileno(), 65536)
            need(block, 'runtime closed before its reply')
            pending.extend(block)
            need(len(pending) <= 4 * 1024 * 1024, 'bounded runtime reply required')
        raw, _, rest = pending.partition(b'\n')
        pending[:] = rest
        sys.stdout.buffer.write(raw + b'\n')
        sys.stdout.buffer.flush()
        return json.loads(raw)

    try:
        need(line().get('type') == 'ready', 'runtime ready message required')
        for raw in smoke_input().splitlines():
            request = json.loads(raw)
            child.stdin.write((raw + '\n').encode())
            child.stdin.flush()
            reply = line()
            need(reply.get('id') == request['id'] and reply.get('type') == 'result',
                 'runtime query reply required before shutdown: ' + request['id'])
        child.stdin.write(b'{"type":"shutdown"}\n')
        child.stdin.close()
        # All query replies have been read. Preserve any final protocol output
        # instead of silently discarding it; the inspector rejects error rows.
        while True:
            need(selector.select(10), 'runtime shutdown timed out')
            block = os.read(child.stdout.fileno(), 65536)
            if not block:
                break
            pending.extend(block)
            need(len(pending) <= 4 * 1024 * 1024, 'bounded final runtime output required')
        if pending:
            sys.stdout.buffer.write(pending)
            sys.stdout.buffer.flush()
        code = child.wait(timeout=10)
        need(code == 0, 'runtime exited unsuccessfully: ' + str(code))
        return 0
    finally:
        selector.close()
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)


def validate_smoke_receipt(receipt, stdout, stderr):
    need(receipt.get('schemaVersion') == 1 and receipt.get('actualWait') is True
         and receipt.get('signal') is None and receipt.get('exit') == 0
         and receipt.get('rawClosedBeforeHash') is True, 'actual closed smoke command required')
    need(isinstance(stderr, str), 'actual smoke stderr text required')
    try:
        lines = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError('Normal runtime originals: smoke stdout is not JSON lines: ' + str(error))
    ready = [row for row in lines if row.get('type') == 'ready']
    need(len(ready) == 1 and isinstance(ready[0].get('adapterAbiVersion'), int)
         and isinstance(ready[0].get('physicalBackendAbiVersion'), int),
         'actual ready/ABI smoke required')
    for case in SMOKE_CASES:
        query_id = case['request']['id']
        rows = [row for row in lines if row.get('id') == query_id]
        need(len(rows) == 1 and rows[0].get('type') == 'result', 'actual result required: ' + query_id)
        need(rows[0].get('result', {}).get('status') == 'ok', 'actual ok status required: ' + query_id)
        try:
            bindings = json.loads(rows[0]['result']['body'])['results']['bindings']
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError('Normal runtime originals: invalid SPARQL result body: ' + query_id) from error
        need(bindings == case['bindings'], 'exact semantic bindings required: ' + query_id)
    need(not [row for row in lines if row.get('type') == 'error'], 'smoke reported a protocol error')
    return dict(adapterAbiVersion=ready[0]['adapterAbiVersion'],
                physicalBackendAbiVersion=ready[0]['physicalBackendAbiVersion'],
                resultIds=[case['request']['id'] for case in SMOKE_CASES])


def collect(value):
    host = _load(HOST, 'xpod_normal_native_host', 'git_source_inventory')
    supervise = host.load_supervise()
    inner = host.load_inner()
    verifier = _load(VERIFIER, 'xpod_normal_runtime_verifier', 'create_smoke_database')
    budget = host.PeakBudget(value.maximum_bytes, value.deadline_monotonic)
    out = value.out
    nonce = hashlib.sha256((str(out) + str(os.getpid()) + str(time.monotonic_ns())).encode()).hexdigest()[:16]
    evidence = host.EVIDENCE_ROOT / ('normal-' + nonce)
    evidence.mkdir(parents=True, mode=0o700, exist_ok=False)
    created = False
    runtime_cid = None
    smoke_name = 'xpod-normal-runtime-smoke-' + nonce
    smoke_started = False
    # Fund cleanup before doing work; cleanup may use the reserved deadline
    # tail even after the work budget has expired.
    budget.reserve(2 * (4096 + 65536))
    def cleanup_stage(name, command, evidence, cwd, **kwargs):
        kwargs['environment'] = dict(os.environ, LANG='C')
        return supervise.run_stage(name, command, evidence, cwd, **kwargs)
    try:
        def stage(name, command, evidence, cwd, **kwargs):
            raw_limit = kwargs.pop('raw_limit_bytes', 65536)
            receipt_limit = kwargs.pop('receipt_limit_bytes', 65536)
            budget.reserve(raw_limit + receipt_limit)
            kwargs['environment'] = dict(os.environ, LANG='C', **{
                key: val for key, val in kwargs.get('environment', {}).items()
                if key not in ('PATH', 'LANG')})
            return supervise.run_stage(name, command, evidence, cwd,
                                       raw_limit_bytes=raw_limit,
                                       receipt_limit_bytes=receipt_limit, **kwargs)

        head = host.git_head(ROOT, stage=stage, budget=budget, evidence=evidence)
        need(head == value.source_sha, 'actual repository Git SHA differs from supplied source SHA')
        inventory = host.git_source_inventory(ROOT, stage=stage, budget=budget, evidence=evidence)
        # The shared helper already retains each mode with its guarded hash.
        out.mkdir(mode=0o700)
        created = True
        inventory_path = write_json('source-inventory.json', inventory, out, budget)
        recipe = {}
        for name in SOURCE_RECIPE:
            path = ROOT / name
            need(path.is_file() and not path.is_symlink(), 'actual tracked recipe required: ' + name)
            recipe[name] = sha256_bytes(path.read_bytes())
        tree_receipt, tree_text = stage(
            'normal-git-tree', ['git', '-C', str(ROOT), 'rev-parse', 'HEAD:qlever'], evidence, ROOT,
            absolute_deadline=budget.deadline, raw_limit_bytes=1024,
            receipt_limit_bytes=65536,
            environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        need(tree_receipt['exit'] == 0 and tree_receipt['actualWait'] is True
             and tree_receipt['ownedGroupAbsentAfterWait'] is True
             and tree_text is not None, 'actual qlever tree identity required')
        qlever_tree = tree_text.strip()
        need(re.fullmatch(r'[a-f0-9]{40}', qlever_tree), 'actual qlever tree SHA required')
        recipe['qleverTree'] = qlever_tree
        profile_receipt, profile_text = stage(
            'normal-profile',
            ['python3', str(ROOT / 'qlever/scripts/qlever_compiler_profile.py'),
             'sdk-profile', 'service-trixie'], evidence, ROOT,
            absolute_deadline=budget.deadline, raw_limit_bytes=65536,
            receipt_limit_bytes=65536,
            environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        need(profile_receipt['exit'] == 0 and profile_receipt['actualWait'] is True
             and profile_receipt['ownedGroupAbsentAfterWait'] is True
             and profile_text is not None, 'actual service profile required')
        profile = json.loads(profile_text)
        need(profile.get('name') == 'service-trixie', 'actual service-trixie profile required')

        pulled, _ = stage('normal-runtime-pull',
                          ['docker', 'pull', value.runtime_image], evidence, ROOT,
                          absolute_deadline=budget.deadline, raw_limit_bytes=1024 * 1024,
                          receipt_limit_bytes=65536)
        need(pulled['exit'] == 0 and pulled['ownedGroupAbsentAfterWait'] is True,
             'immutable runtime pull failed')
        runtime_config = host.inspect_image(value.runtime_image, stage=stage,
                                            budget=budget, evidence=evidence)
        runtime_cid = host.create_container('xpod-normal-runtime-copy-' + nonce,
                                            value.runtime_image, stage=stage,
                                            budget=budget, evidence=evidence)
        runtime_root = out / 'artifact' / 'runtime'
        limit = budget.remaining() - 2 * 65536
        need(limit > 0, 'shared remaining cannot fund runtime copy')
        copied, _ = stage(
            'normal-runtime-copy',
            ['python3', str(ROOT / 'qlever/scripts/produce-linux-runtime-archive.py'),
             '--bounded-copy', runtime_cid, '/opt/xpod/qlever', str(runtime_root),
             str(limit)],
            evidence, ROOT, absolute_deadline=budget.deadline,
            raw_limit_bytes=8192, receipt_limit_bytes=65536)
        need(copied['exit'] == 0 and copied['actualWait'] is True
             and copied['ownedGroupAbsentAfterWait'] is True,
             'actual bounded runtime copy required')
        host.remove_container(runtime_cid, stage=stage, evidence=evidence,
                              deadline=value.deadline_monotonic)
        runtime_cid = None
        members = inner.manifest(str(runtime_root), check=budget.check,
                                 maximum=budget.remaining(), roots=(str(runtime_root),))
        budget.reserve(sum(row['bytes'] for row in members.values() if row['type'] == 'file'))
        need(members.get('bin/xpod_qlever_local_runtime', {}).get('type') == 'file',
             'actual runtime executable member required')

        smoke_dir = out / 'smoke'
        smoke_dir.mkdir(mode=0o700)
        database = smoke_dir / 'runtime-smoke.sqlite'
        verifier.create_smoke_database(database)
        os.chmod(database, 0o666)
        # The smoke runs as the SAME owning uid/gid as this collector, so the
        # 0700 smoke directory (and the SQLite file inside it) stays readable to
        # the runtime without relaxing its mode. The image's default user is
        # root, which a real Linux kernel refuses to let write a 0700 non-root
        # bind mount under --cap-drop ALL; a Mac bind mount hides that.
        smoke_user = f'{os.getuid()}:{os.getgid()}'
        command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
                   '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                   '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                   '--user', smoke_user,
                   '--name', smoke_name,
                   '--mount', 'type=bind,src=' + str(smoke_dir) + ',dst=/data',
                   value.runtime_image, '--sqlite-path', '/data/runtime-smoke.sqlite']
        driver = ['python3', '-B', str(Path(__file__).resolve()), '--smoke-session',
                  json.dumps(command)]
        child_dir = out / 'smoke' / 'child'
        child_dir.mkdir(mode=0o700)
        smoke_started = True
        smoke, _ = stage('normal-runtime-smoke',
                         [sys.executable, '-B', str(COMMANDS), '--exec-child',
                          str(child_dir), json.dumps(driver)], evidence, ROOT,
                         absolute_deadline=value.deadline_monotonic,
                         raw_limit_bytes=min(4 * 1024 * 1024, budget.remaining()),
                         receipt_limit_bytes=65536,
                         environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        need(smoke['exit'] == 0 and smoke['signal'] is None and smoke['actualWait'] is True
             and smoke['ownedGroupAbsentAfterWait'] is True,
             'actual functional smoke must close successfully')
        smoke_started = False
        receipt_path = child_dir / 'command.receipt.json'
        need(receipt_path.is_file() and not receipt_path.is_symlink(),
             'actual closed command receipt required')
        command_receipt = json.loads(receipt_path.read_text())
        stdout = (child_dir / 'stdout.raw').read_text(errors='replace')
        stderr = (child_dir / 'stderr.raw').read_text(errors='replace')
        facts = validate_smoke_receipt(command_receipt, stdout, stderr)

        smoke_evidence = dict(
            schemaVersion=1, kind='normal-local-runtime-functional-smoke',
            proofModel=PROOF_MODEL, command=command, exit=command_receipt['exit'],
            signal=command_receipt['signal'], actualWait=command_receipt['actualWait'],
            rawClosedBeforeHash=command_receipt['rawClosedBeforeHash'],
            ownedGroupAbsentAfterWait=smoke['ownedGroupAbsentAfterWait'],
            stdout=ref(child_dir / 'stdout.raw', out),
            stderr=ref(child_dir / 'stderr.raw', out),
            commandReceipt=ref(receipt_path, out), facts=facts,
            scope=('actual container functional/ABI/protocol execution with separate '
                   'closed stdout/stderr; no legacy syscall trace claim'))
        smoke_path = write_json('functional-smoke.json', smoke_evidence, out, budget)

        master = dict(
            schemaVersion=1, kind=KIND, proofModel=PROOF_MODEL,
            runtimeImage=value.runtime_image, runtimeConfigDigest=runtime_config,
            identity=dict(sourceSha=value.source_sha, runId=value.run_id,
                          runAttempt=value.run_attempt, job=value.job,
                          target=value.target, sdkProfile='service-trixie',
                          sdkImage=value.sdk_image, runtimeImage=value.runtime_image,
                          runtimeConfigDigest=runtime_config,
                          sdkInputHash=value.sdk_input_hash),
            sdkInputHash=value.sdk_input_hash, recipe=recipe,
            profile=dict(name=profile['name'], identity=profile.get('identity'),
                         dockerfile=profile.get('dockerfile'),
                         runtimeDockerfile=profile.get('runtime_dockerfile')),
            sourceInventory=ref(inventory_path, out),
            runtimeRoot='artifact/runtime', runtimeMembers=members,
            smoke=dict(evidence=ref(smoke_path, out),
                       commandReceipt=smoke_evidence['commandReceipt'],
                       stdout=smoke_evidence['stdout'],
                       stderr=smoke_evidence['stderr']),
            guarantees={name: False for name in NON_CLAIMS},
            nonClaims=list(NON_CLAIMS), releaseAccepted=False, pending=[],
            scope=('normal-runtime-v1 binds the exact Git source recipe/tree, canonical '
                   'SDK input hash and immutable SDK image, immutable runtime image/config, '
                   'the complete runtime member inventory and an actually executed functional '
                   'smoke. It does NOT prove syscall source reads, generated-input causality, '
                   'toolchain execution lifetime or kernel read-only enforcement.'))
        files = []
        for path in sorted(out.rglob('*')):
            budget.check()
            if path.is_file() and path.name != 'materials.json':
                files.append(ref(path, out))
        need(files, 'nonempty normal original inventory required')
        master['originals'] = files
        master['retainedOriginalBytes'] = sum(row['bytes'] for row in files)
        master_path = write_json('materials.next', master, out, budget)
        master_path.replace(out / 'materials.json')
        # The replaced intermediate must not be mistaken for a retained original.
        need(not (out / 'materials.next').exists(), 'normal master replacement left an intermediate')
        master_raw = (out / 'materials.json').read_bytes()
        return dict(schemaVersion=1, kind=RESULT_KIND, proofModel=PROOF_MODEL,
                    sourceSha=value.source_sha, sdkImage=value.sdk_image,
                    runtimeImage=value.runtime_image,
                    runtimeConfigDigest=runtime_config,
                    sdkInputHash=value.sdk_input_hash, runId=value.run_id,
                    runAttempt=value.run_attempt, job=value.job,
                    master=dict(path='materials.json', bytes=len(master_raw),
                                sha256=sha256_bytes(master_raw)),
                    smoke=dict(exit=command_receipt['exit'],
                               actualWait=command_receipt['actualWait'],
                               stdout=smoke_evidence['stdout'],
                               stderr=smoke_evidence['stderr']),
                    peakBytes=budget.bytes, maximumBytes=budget.maximum,
                    pending=[])
    except BaseException:
        if created:
            # Preserve the actual child streams for the failure-only diagnostic
            # artifact. A partial run must never leave an admissible master.
            for name in ('materials.next', 'materials.json'):
                (out / name).unlink(missing_ok=True)
        raise
    finally:
        if smoke_started:
            removed, text = cleanup_stage(
                'normal-owned-smoke-cleanup',
                ['docker', 'rm', '--force', '--volumes', smoke_name], evidence, ROOT,
                absolute_deadline=value.deadline_monotonic, raw_limit_bytes=4096,
                receipt_limit_bytes=65536)
            need(removed['actualWait'] and removed['ownedGroupAbsentAfterWait']
                 and (removed['exit'] == 0 or (removed['exit'] == 1
                      and 'No such container' in (text or ''))),
                 'owned smoke container cleanup failed')
        if runtime_cid:
            host.remove_container(runtime_cid, stage=cleanup_stage, evidence=evidence,
                                  deadline=value.deadline_monotonic)


def main(argv=None):
    if argv is None and len(sys.argv) == 3 and sys.argv[1] == '--smoke-session':
        return run_smoke_session(json.loads(sys.argv[2]))
    value = parse_args(argv)
    result = collect(value)
    sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as error:
        sys.stderr.write('normal runtime originals: ' + str(error)[:1024] + '\n')
        raise SystemExit(1)

"""Host supervisor for the inner native-runtime producer.

This CLI owns exactly one fresh runtime-copy container and one fresh
build-inputs container per invocation. Every docker invocation goes through
the existing bounded ``scripts/agentfs-native-ci/supervise.py`` stage, except
the tar extraction itself. No caller command is accepted; the fixed inner CLI
is executed with fixed roots. Source identities remain receiver-verified data,
never a host-issued true claim.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
ROOT_NOTICE = re.compile(r'^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$', re.I)
DOCKERFILE = 'docker/qlever-local-runtime/Dockerfile'
TARGET = 'build-inputs'
INNER = '/workspace/xpod/qlever/scripts/sdk-service-native-runtime-originals.py'
# V13: the workspace COPY scope includes the repository's authoritative ancestor
# LICENSE (there is no qlever/LICENSE), so the host Git inventory must enumerate
# it too; otherwise the TS contributor map cannot bind `workspace:LICENSE` and
# every real notice would stay unbound.
SOURCE_DIRS = ('LICENSE',
               'qlever/cmake', 'qlever/include', 'qlever/qlever.lock.json', 'qlever/patches',
               'qlever/qlever_adapter', 'qlever/qlever_local_runtime', 'qlever/rdf_protocol',
               'qlever/rdf_sqlite_backend', 'qlever/scripts', 'docker/qlever-local-runtime/Dockerfile')
RUNTIME_SOURCE = '/opt/xpod/qlever'
PROFILE = '/opt/qlever-sdk/profile/inputs.json'
INPUTS_MOUNT = '/run/xpod-native-inputs'
OUT_MOUNT = '/out'
MIB = 1024 ** 2
SHA = re.compile(r'[a-f0-9]{64}')
SHA_REF = re.compile(r'.+@sha256:[a-f0-9]{64}')
MAXIMUM = 128 * MIB
META = json.loads((ROOT / 'scripts/lib/module-artifact-limits.json').read_text())['metadataBytes']
EVIDENCE_ROOT = ROOT / '.test-data/service-qualification/native-runtime'
TARGET_PATH = ROOT / DOCKERFILE


def need(ok, message):
    if not ok:
        raise ValueError('Native runtime host: ' + message)


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def load_inner():
    spec = importlib.util.spec_from_file_location(
        'xpod_native_inner', ROOT / 'qlever/scripts/sdk-service-native-runtime-originals.py')
    need(spec is not None and spec.loader is not None, 'inner producer module required')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, 'manifest', None)), 'inner manifest API required')
    return module


def load_supervise():
    sys.path.insert(0, str(ROOT / 'scripts/agentfs-native-ci'))
    import supervise  # noqa: E402
    need(callable(supervise.run_stage) and callable(supervise.run_checked_stage),
         'existing supervisor required')
    return supervise


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog='sdk-service-native-runtime-host',
        description='Run the fixed inner native producer in fresh owned containers.')
    for name in ('--source-sha', '--sdk-image', '--runtime-image', '--run-id',
                 '--run-attempt', '--job', '--out', '--deadline-monotonic', '--maximum-bytes'):
        parser.add_argument(name, required=True)
    value = parser.parse_args(argv)
    need(re.fullmatch(r'[a-f0-9]{40}', value.source_sha), 'exact Git source SHA required')
    need(SHA_REF.fullmatch(value.sdk_image), 'immutable SDK image digest required')
    need(SHA_REF.fullmatch(value.runtime_image), 'immutable runtime image digest required')
    for name in ('run_id', 'run_attempt'):
        setattr(value, name, _positive(getattr(value, name), name))
    need(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value.job), 'bounded job identity required')
    value.maximum_bytes = _positive(value.maximum_bytes, 'maximum-bytes')
    need(value.maximum_bytes <= MAXIMUM, 'maximum bytes must be within 128MiB')
    value.deadline_monotonic = _deadline(value.deadline_monotonic)
    need(time.monotonic() < value.deadline_monotonic - 25, 'deadline cannot fund owned cleanup')
    out = Path(value.out)
    need(out.is_absolute() and out.parent.resolve(strict=True) == out.parent,
         'canonical new output parent required')
    need(not out.exists() and not out.is_symlink(), 'fresh non-linked output required')
    value.out = out
    return value


def _positive(raw, label):
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError('Native runtime host: positive integer required: ' + label)
    need(0 < value <= 2 ** 53 - 1, 'bounded positive integer required: ' + label)
    return value


def _deadline(raw):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError('Native runtime host: finite monotonic deadline required')
    need(value == value and value not in (float('inf'), float('-inf')) and value > 0,
         'finite monotonic deadline required')
    return value


class PeakBudget:
    """One shared byte/deadline ledger; peak equals total charged bodies."""
    def __init__(self, maximum, deadline):
        need(0 < maximum <= MAXIMUM, 'bounded host maximum required')
        self.maximum = maximum
        self.deadline = deadline
        self.bytes = 0

    def check(self):
        need(time.monotonic() < self.deadline - 25, 'shared host deadline exhausted')
        need(self.bytes <= self.maximum, 'shared host byte budget exceeded')

    def remaining(self):
        self.check()
        return self.maximum - self.bytes

    def reserve(self, count):
        need(type(count) is int and count >= 0, 'bounded reservation required')
        self.check()
        need(self.bytes + count <= self.maximum, 'shared host byte budget exceeded')
        self.bytes += count


def git_head(repo, *, stage, budget, evidence):
    budget.check()
    receipt, text = stage('host-git-head', ['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                          evidence, repo, absolute_deadline=budget.deadline,
                          raw_limit_bytes=1024, receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True and text is not None,
         'actual Git HEAD command required')
    return text.strip()

def git_source_inventory(repo, *, stage, budget, evidence):
    """Enumerate actual Git-tracked files in the Dockerfile-copied source dirs."""
    budget.check()
    receipt, text = stage('host-git-ls-files',
                          ['git', '-C', str(repo), 'ls-files', '-z', '--', *SOURCE_DIRS],
                          evidence, repo, absolute_deadline=budget.deadline,
                          raw_limit_bytes=min(8 * MIB, budget.remaining()),
                          receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True and text is not None,
         'actual tracked source enumeration required')
    names = [name for name in text.split('\0') if name]
    need(names and len(names) <= 100000, 'bounded tracked source set required')
    rows = []
    total = 0
    for name in sorted(names):
        budget.check()
        need(not name.startswith('/') and '..' not in name.split('/'),
             'safe tracked source path required')
        path = repo / name
        value = os.lstat(path)
        need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1,
             'actual single-link tracked regular source required: ' + name)
        total += value.st_size
        need(total <= budget.remaining(), 'source inventory exceeds shared budget')
        digest = hashlib.sha256()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            held = (value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
            need(identity(os.fstat(fd)) == held, 'tracked source replaced before read')
            count = 0
            while True:
                budget.check()
                block = os.read(fd, 65536)
                if not block:
                    break
                count += len(block)
                digest.update(block)
            need(count == value.st_size and identity(os.fstat(fd)) == held == identity(os.lstat(path)), 'tracked source changed while hashing: ' + name)
        finally:
            os.close(fd)
        rows.append(dict(path='./' + name, bytes=count, mode=stat.S_IMODE(value.st_mode),
                         sha256=digest.hexdigest()))
    return rows


def write_json(name, value, *, directory, budget):
    raw = json.dumps(value, sort_keys=True).encode()
    need(0 < len(raw) <= META, 'bounded host input JSON required')
    budget.reserve(len(raw))
    path = directory / name
    need(not path.exists(), 'fresh host input path required')
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return dict(path=str(path), bytes=len(raw), sha256=sha256_bytes(raw))


def inspect_image(image, *, stage, budget, evidence):
    budget.check()
    receipt, text = stage('host-runtime-inspect',
                          ['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
                          evidence, ROOT, absolute_deadline=budget.deadline,
                          raw_limit_bytes=4096, receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True and text is not None,
         'actual runtime image inspect required')
    config = text.strip()
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', config), 'actual runtime config digest required')
    return config


def create_container(name, image, *, stage, budget, evidence):
    budget.check()
    receipt, text = stage('host-runtime-create',
                          ['docker', 'create', '--pull=never', '--name', name,
                           '--network', 'none', '--cap-drop', 'ALL',
                           '--security-opt', 'no-new-privileges', image],
                          evidence, ROOT, absolute_deadline=budget.deadline,
                          raw_limit_bytes=4096, receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True and text is not None,
         'actual owned runtime container creation required')
    cid = text.strip()
    need(re.fullmatch(r'[a-f0-9]{64}', cid), 'actual full container id required')
    return cid


def capture_runtime(cid, destination, *, stage, budget, evidence, inner):
    budget.check()
    limit = budget.remaining() - 65536
    need(limit > 0, 'shared remaining cannot fund runtime copy')
    receipt, _ = stage('host-runtime-copy',
        ['python3', str(ROOT / 'qlever/scripts/produce-linux-runtime-archive.py'),
         '--bounded-copy', cid, RUNTIME_SOURCE, str(destination), str(limit)],
        evidence, ROOT, absolute_deadline=budget.deadline,
        raw_limit_bytes=8192, receipt_limit_bytes=65536)
    need(receipt['exit'] == 0 and receipt['actualWait'] and receipt['ownedGroupAbsentAfterWait'],
         'actual bounded runtime copy required')
    actual = inner.manifest(str(destination), check=budget.check, maximum=budget.remaining(), roots=(str(destination),))
    size = sum(row['bytes'] for row in actual.values() if row['type'] == 'file')
    budget.reserve(size)
    return dict(manifest=actual, treeBytes=size)


def _load_archive_helper():
    path = ROOT / 'qlever/scripts/produce-linux-runtime-archive.py'
    need(path.is_file(), 'existing bounded Docker copy helper required')
    spec = importlib.util.spec_from_file_location('xpod_archive_helper', path)
    need(spec is not None and spec.loader is not None, 'archive helper importable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, 'bounded_copy_members', None)),
         'existing bounded tar extraction helper required')
    return module


SOURCE_MANIFEST_LIMIT = 4 * MIB


def build_inputs(*, source_sha, sdk_image, tag, stage, budget, evidence):
    budget.check()
    build_context = ROOT
    command = ['docker', 'build', '--file', str(TARGET_PATH), '--target', TARGET,
               '--build-arg', 'XPOD_QLEVER_PRIOR_SDK_IMAGE=' + sdk_image,
               '--tag', tag, str(build_context)]
    receipt, _ = stage('host-build-inputs', command, evidence, ROOT,
                       absolute_deadline=budget.deadline,
                       raw_limit_bytes=min(4 * MIB, budget.remaining()),
                       receipt_limit_bytes=64 * 1024,
                       environment={'PATH': '/usr/bin:/bin', 'LANG': 'C',
                                    'DOCKER_BUILDKIT': '1'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True,
         'actual build-inputs image required (Dockerfile target must exist)')
    return receipt


def create_builder(name, image, *, repo, inputs, out, source_sha, sdk_image,
                   runtime_image, runtime_config, run_id, run_attempt, job,
                   inner_maximum, deadline, stage, budget, evidence):
    budget.check()
    command = ['docker', 'create', '--init', '--name', name,
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--security-opt', 'seccomp=unconfined',
               '--cap-add', 'SYS_PTRACE', '--cap-add', 'SETPCAP',
               '--mount', 'type=bind,src=' + str(repo) + ',dst=/workspace/xpod,readonly',
               '--mount', 'type=bind,src=' + str(inputs) + ',dst=' + INPUTS_MOUNT + ',readonly',
               '--mount', 'type=bind,src=' + str(out) + ',dst=' + OUT_MOUNT,
               '--workdir', '/workspace/xpod', '--entrypoint', 'python3',
               image, '-I', '-S', '-B', INNER,
               '--out', OUT_MOUNT + '/artifact',
               '--source-inventory', INPUTS_MOUNT + '/source-inventory.json',
               '--runtime-manifest', INPUTS_MOUNT + '/runtime-manifest.json',
               '--source-sha', source_sha, '--sdk-image', sdk_image,
               '--runtime-image', runtime_image,
               '--runtime-config-digest', runtime_config,
               '--run-id', str(run_id), '--run-attempt', str(run_attempt),
               '--job', job, '--maximum-bytes', str(inner_maximum),
               '--deadline-monotonic', repr(deadline)]
    receipt, text = stage('host-builder-create', command, evidence, ROOT,
                          absolute_deadline=budget.deadline,
                          raw_limit_bytes=4096, receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    need(receipt['exit'] == 0 and receipt['actualWait'] is True
         and receipt['ownedGroupAbsentAfterWait'] is True and text is not None,
         'actual fixed inner builder container creation required')
    cid = text.strip()
    need(re.fullmatch(r'[a-f0-9]{64}', cid), 'actual builder container id required')
    return cid


def remove_container(cid, *, stage, evidence, deadline):
    if not cid:
        return None
    try:
        receipt, _ = stage('host-owned-remove-' + cid[:12], ['docker', 'rm', '--force', '--volumes', cid],
                          evidence, ROOT, absolute_deadline=deadline,
                          raw_limit_bytes=4096, receipt_limit_bytes=64 * 1024,
                          environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        need(receipt['exit'] == 0 and receipt['actualWait'] and receipt['ownedGroupAbsentAfterWait'], 'owned container cleanup failed')
        return receipt
    except BaseException:
        raise


def run(value):
    supervise = load_supervise()
    inner = load_inner()
    budget = PeakBudget(value.maximum_bytes, value.deadline_monotonic)
    nonce = hashlib.sha256((str(value.out) + str(os.getpid()) + str(time.monotonic_ns())).encode()).hexdigest()[:16]
    evidence = EVIDENCE_ROOT / ('host-' + nonce)
    evidence.mkdir(parents=True, mode=0o700, exist_ok=False)
    out = value.out
    export = out.parent / ('.xpod-native-export-' + nonce)
    export.mkdir(mode=0o700, exist_ok=False)
    inputs = out.parent / ('.xpod-native-inputs-' + nonce)
    inputs.mkdir(mode=0o700, exist_ok=False)
    expected = out.parent / ('.xpod-native-expected-' + nonce)
    runtime_cid = None
    builder_cid = None
    receipt = None
    primary = None
    producer_pending = []
    def stage(name, command, evidence, cwd, **kwargs):
        # Reserve both closed outputs BEFORE the supervisor starts writing.
        raw_limit = kwargs.pop('raw_limit_bytes', 65536)
        receipt_limit = kwargs.pop('receipt_limit_bytes', 65536)
        budget.reserve(raw_limit + receipt_limit)
        kwargs['environment'] = dict(os.environ, LANG='C', **{key: val for key, val in kwargs.get('environment', {}).items() if key != 'PATH' and key != 'LANG'})
        return supervise.run_stage(name, command, evidence, cwd,
            raw_limit_bytes=raw_limit, receipt_limit_bytes=receipt_limit, **kwargs)
    try:
        head = git_head(ROOT, stage=stage, budget=budget, evidence=evidence)
        need(head == value.source_sha, 'actual repository Git SHA differs from supplied source SHA')
        need(TARGET_PATH.is_file() and not TARGET_PATH.is_symlink(),
             'actual qlever-local-runtime Dockerfile required')
        source_inventory = git_source_inventory(ROOT, stage=stage, budget=budget, evidence=evidence)
        inventory_row = write_json('source-inventory.json', source_inventory,
                                   directory=inputs, budget=budget)
        pulled, _ = stage('host-runtime-pull', ['docker', 'pull', value.runtime_image], evidence, ROOT,
                          absolute_deadline=budget.deadline, raw_limit_bytes=1024 * 1024,
                          receipt_limit_bytes=65536)
        need(pulled['exit'] == 0 and pulled['ownedGroupAbsentAfterWait'], 'immutable runtime pull failed')
        runtime_config = inspect_image(value.runtime_image, stage=stage,
                                       budget=budget, evidence=evidence)
        runtime_cid = create_container('xpod-native-runtime-copy-' + nonce,
                                       value.runtime_image, stage=stage,
                                       budget=budget, evidence=evidence)
        capture = capture_runtime(runtime_cid, expected, stage=stage,
                                  budget=budget, evidence=evidence, inner=inner)
        runtime_row = write_json('runtime-manifest.json', capture['manifest'],
                                 directory=inputs, budget=budget)
        # Notice selection/copy is executed by the fixed build program itself
        # (run-focused-native-build.sh) from the authenticated roots already
        # present in that environment, so the published image and the observed
        # replay derive the identical notice members. The host supplies no
        # caller list, plan file, extra mount or environment knob.
        producer_pending = []
        tag = 'xpod-native-build-inputs:' + nonce
        build_inputs(source_sha=value.source_sha, sdk_image=value.sdk_image,
                     tag=tag, stage=stage, budget=budget, evidence=evidence)
        inner_maximum = budget.remaining() - 8 * MIB
        need(inner_maximum >= 1024, 'shared remaining cannot fund inner producer')
        # The staged notices directory is bind-mounted read-only into the
        # builder so the plan's containerSourcePath rows resolve to the same
        # authenticated bytes verified above.
        builder_cid = create_builder('xpod-native-build-' + nonce, tag,
                                     repo=ROOT, inputs=inputs, out=export,
                                     source_sha=value.source_sha,
                                     sdk_image=value.sdk_image,
                                     runtime_image=value.runtime_image,
                                     runtime_config=runtime_config,
                                     run_id=value.run_id, run_attempt=value.run_attempt,
                                     job=value.job, inner_maximum=inner_maximum,
                                     deadline=value.deadline_monotonic, stage=stage,
                                     budget=budget, evidence=evidence)
        start = ['docker', 'start', '--attach', builder_cid]
        receipt, _ = stage('host-builder-start', start, evidence, ROOT,
                           absolute_deadline=value.deadline_monotonic,
                           raw_limit_bytes=min(2 * MIB, budget.remaining()),
                           receipt_limit_bytes=64 * 1024,
                           environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        need(receipt['exit'] == 0 and receipt['actualWait'] is True
             and receipt['ownedGroupAbsentAfterWait'] is True,
             'actual inner builder wait required')
        # P2 transport plane: the producer writes the exact P1 receipt bytes
        # next to its own --out, which is this export directory bind-mounted at
        # /out. The host therefore reads /out/notices.receipt.json without
        # reinterpreting the program's in-image roots as host paths.
        receipt_path = export / inner.RECEIPT_NAME
        if receipt_path.is_file() and not receipt_path.is_symlink():
            raw_receipt = receipt_path.read_bytes()
            need(0 < len(raw_receipt) <= META, 'bounded build notice receipt required')
            build_receipt = json.loads(raw_receipt)
            # P1 declaration check: the receipt's roots are IN-IMAGE build
            # paths, so they must equal the fixed program contract constants
            # (single authority: the inner producer module), never the host's
            # own mount names. Comparing them to /out would reject every real
            # receipt and was the durable C1 defect.
            need(build_receipt.get('schemaVersion') == 1
                 and build_receipt.get('kind') == 'fixed-native-build-notice-copy'
                 and build_receipt.get('outputRoot') == inner.PROGRAM_OUTPUT_ROOT
                 and build_receipt.get('artifactRoot') == inner.PROGRAM_ARTIFACT_ROOT
                 and isinstance(build_receipt.get('rows'), list)
                 and isinstance(build_receipt.get('pending'), list),
                 'actual fixed build notice receipt required')
            producer_pending.extend(str(row) for row in build_receipt['pending'])
        else:
            producer_pending.append('fixed-build-notice-receipt-absent')
        (export / 'artifact').rename(out)
        master_path = out / 'materials.json'
        need(master_path.is_file() and not master_path.is_symlink(),
             'actual inner master artifact required')
        budget.check()
        master_raw = master_path.read_bytes()
        need(0 < len(master_raw) <= META, 'bounded inner master required')
        artifact_bytes = sum(path.stat().st_size for path in out.rglob('*') if path.is_file())
        budget.reserve(artifact_bytes)
        master = json.loads(master_raw)
        need(master.get('schemaVersion') == 1
             and master.get('kind') == 'candidate-service-native-runtime-originals',
             'actual inner master kind required')
        identity = master.get('identity') or {}
        need(identity.get('sourceSha') == value.source_sha
             and identity.get('runId') == value.run_id
             and identity.get('runAttempt') == value.run_attempt
             and identity.get('job') == value.job
             and identity.get('sdkImage') == value.sdk_image
             and identity.get('runtimeImage') == value.runtime_image
             and identity.get('runtimeConfigDigest') == runtime_config,
             'inner master identity differs from host inputs')
        need(master.get('sourceFactsVerified') is not True
             and master.get('sourceAuthorityVerified') is not True,
             'host never accepts inner source authority booleans')
        owned_runtime, owned_builder = runtime_cid, builder_cid
        remove_container(builder_cid, stage=stage, evidence=evidence, deadline=value.deadline_monotonic)
        builder_cid = None
        remove_container(runtime_cid, stage=stage, evidence=evidence, deadline=value.deadline_monotonic)
        runtime_cid = None
        # Include the actual closed host command originals in the same artifact;
        # they are not replaced by a producer's success boolean.
        host_dir = out / 'host'
        host_dir.mkdir(mode=0o700)
        host_rows = []
        for original in sorted(evidence.iterdir()):
            need(original.is_file() and not original.is_symlink(), 'regular closed host original required')
            size, digest = inner._stream(str(original), check=budget.check, maximum=budget.maximum)
            budget.reserve(size)
            destination = host_dir / original.name
            copied_size, copied_digest = inner._retain_copy(str(original), destination, check=budget.check, maximum=size)
            need((size, digest) == (copied_size, copied_digest), 'host original changed during retention')
            host_rows.append(dict(path='host/' + original.name, bytes=size, sha256=digest, scope='build-trace'))
        master['hostIdentity'] = dict(runtimeContainerId=owned_runtime, buildContainerId=owned_builder)
        # Durable host-scope pending: stdout is not uploaded, so record the
        # authenticated-scope limitations inside the retained master that the
        # workflow uploads and the TS observer reads.
        master['hostPending'] = sorted(set(producer_pending))
        master['hostOriginals'] = host_rows
        master['originals'].extend(host_rows)
        master['retainedOriginalBytes'] = sum(row['bytes'] for row in master['originals'])
        master_raw = json.dumps(master, sort_keys=True).encode()
        need(len(master_raw) <= META, 'complete host master exceeds metadata limit')
        budget.reserve(len(master_raw))
        replacement = out / 'materials.next'
        with replacement.open('xb') as stream:
            stream.write(master_raw); stream.flush(); os.fsync(stream.fileno())
        replacement.replace(master_path)
        return dict(schemaVersion=1, kind='candidate-service-native-runtime-host-result',
                    sourceSha=value.source_sha, sdkImage=value.sdk_image,
                    runtimeImage=value.runtime_image,
                    runtimeConfigDigest=runtime_config,
                    runId=value.run_id, runAttempt=value.run_attempt, job=value.job,
                    master=dict(path='materials.json', bytes=len(master_raw),
                                sha256=sha256_bytes(master_raw)),
                    sourceInventoryOriginal=inventory_row,
                    runtimeManifestOriginal=runtime_row,
                    runtimeCopyBytes=capture['copiedBytes'],
                    runtimeTarBytes=capture['tarBytes'],
                    hostStageReceipt=dict(path=str(Path(evidence) / 'host-builder-start.receipt.json'),
                                          rawLimitBytes=receipt.get('rawByteLimit'),
                                          retainedRawBytes=receipt.get('retainedRawBytes'),
                                          actualWait=receipt['actualWait'],
                                          exit=receipt['exit']),
                    peakBytes=budget.bytes, maximumBytes=budget.maximum,
                    sourceFactsVerified=False, sourceAuthorityVerified=False,
                    pending=['private-receiver-source-and-sdk-identity-join',
                             'official-apt-libsqlite3-dev-source-acquisition',
                             'multirole-native-execution-load-originals',
                             *producer_pending])
    except BaseException as error:
        primary = error
        raise
    finally:
        if builder_cid:
            remove_container(builder_cid, stage=stage, evidence=evidence,
                             deadline=value.deadline_monotonic)
        if runtime_cid:
            remove_container(runtime_cid, stage=stage, evidence=evidence,
                             deadline=value.deadline_monotonic)
        # Inputs are host-owned temporary bodies under the shared byte budget.
        for directory in (inputs, expected, export):
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=True)
        if primary is not None:
            try:
                raw = json.dumps(dict(schemaVersion=1,
                                      failureClass=type(primary).__name__,
                                      message=str(primary)[:1024],
                                      sourceFactsVerified=False,
                                      sourceAuthorityVerified=False),
                                 sort_keys=True).encode()
                if len(raw) <= budget.remaining():
                    budget.reserve(len(raw))
                    (evidence / 'host-failure.original.json').write_bytes(raw)
            except BaseException:
                pass


def main(argv=None):
    value = parse_args(argv)
    result = run(value)
    sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as error:
        sys.stderr.write('native runtime host: ' + str(error)[:1024] + '\n')
        raise SystemExit(1)

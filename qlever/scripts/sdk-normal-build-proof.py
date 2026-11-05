"""Normal-build-v1 SDK proof, retained-proof lookup and originals collection.

The ordinary route compiles the same QLever SDK sources and runs the same linked
adapter/runtime gates without the ptrace/lease observer. Its provenance is an
exact canonical input identity, an immutable OCI digest, a retained GitHub
artifact origin and actual functional-gate receipts. It deliberately does NOT
claim per-syscall source reads, generated-input causality or process/lease
lifetime.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LIMITS = json.loads((ROOT / 'scripts/lib/module-artifact-limits.json').read_text())
MODEL = 'normal-build-v1'
PROOF_NAME = 'normal-build-proof.json'
INDEX_NAME = 'normal-build-index.json'
MASTER_NAME = 'materials.json'
PENDING = 'qlever-sdk-normal-build-syscall-source-causality-not-proven'
GATES = json.loads((ROOT / 'scripts/lib/independent-admission/normal-sdk-gates.json').read_text())
GUARANTEES = {
    'syscallSourceReadInventory': False,
    'generatedInputCausality': False,
    'toolchainExecutionLifetime': False,
    'kernelReadOnlyEnforcement': False,
}
RECIPE_FILES = (
    '.github/workflows/candidate.yml',
    '.github/workflows/publish-qlever-runtime-sdk.yml',
    '.dockerignore',
    'scripts/lib/module-artifact-limits.json',
    'scripts/lib/independent-admission/normal-sdk-gates.json',
    'scripts/agentfs-native-ci/supervise.py',
    'docker/qlever-runtime-sdk/Dockerfile.normal',
    'docker/qlever-runtime-sdk/Dockerfile.normal.incremental',
    'docker/qlever-local-runtime/Dockerfile',
    'qlever/qlever.lock.json',
    'qlever/scripts/apply-patches.py',
    'qlever/scripts/build-qlever-runtime-sdk.sh',
    'qlever/scripts/qlever_compiler_profile.py',
    'qlever/scripts/sync-patched-source.py',
    'qlever/scripts/check-qlever-real-adapter-build.cjs',
    'qlever/scripts/check-qlever-real-runtime.cjs',
    'qlever/scripts/check-qlever-upstream-patches.cjs',
)
HEX40 = re.compile(r'^[a-f0-9]{40}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
DIGEST = re.compile(r'^sha256:([a-f0-9]{64})$')
IMMUTABLE_IMAGE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:([a-f0-9]{64})$')
IMAGE = re.compile(r'^ghcr\.io/undefinedsco/xpod-qlever-sdk@sha256:([a-f0-9]{64})$')
SAFE_PATH = re.compile(r'^[A-Za-z0-9_./-]+$')

_spec = importlib.util.spec_from_file_location('sdk_image_originals', HERE / 'sdk-image-originals.py')
image_originals = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(image_originals)
commands = image_originals.commands
budgets = image_originals.budgets


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def need(value, why):
    if not value:
        raise ValueError('normal SDK build: ' + why)


def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args], text=True, stderr=subprocess.PIPE).strip()


def committed(source, commit, path):
    return subprocess.check_output(['git', '-C', str(source), 'show', commit + ':' + path], stderr=subprocess.PIPE)


def identity_body(source, source_commit, profile, target, profile_identity, dockerfile, prior_sdk_digest=None):
    need(HEX40.match(source_commit), 'exact 40-hex source commit required')
    need(SAFE_PATH.match(dockerfile) and '..' not in dockerfile.split('/'), 'safe Dockerfile path required')
    if prior_sdk_digest:
        need(DIGEST.match(prior_sdk_digest), 'immutable prior SDK digest required')
    recipe_dockerfile = dockerfile + ('.incremental' if prior_sdk_digest else '')
    body = {
        'schemaVersion': 1,
        'model': MODEL,
        'sdkProfile': profile,
        'target': target,
        'sdkProfileIdentity': profile_identity,
        'qleverTree': git(source, 'rev-parse', source_commit + ':qlever'),
        'sdkRecipeTree': git(source, 'rev-parse', source_commit + ':docker/qlever-runtime-sdk'),
        'files': {},
    }
    need(HEX40.match(body['qleverTree']) and HEX40.match(body['sdkRecipeTree']), 'actual Git tree identities required')
    for path in RECIPE_FILES:
        body['files'][path] = sha256(committed(source, source_commit, path))
    need(dockerfile in body['files'] and recipe_dockerfile in body['files'], 'normal recipe is not a declared input')
    lock = json.loads(committed(source, source_commit, 'qlever/qlever.lock.json'))
    body['sourceLock'] = {key: lock[key] for key in ('repository', 'commit', 'patchSeriesSha256')}
    dockerfile_bytes = committed(source, source_commit, dockerfile).decode()
    base = re.search(r'XPOD_QLEVER_SDK_BASE_IMAGE=([^\s]+)', dockerfile_bytes)
    need(base and IMMUTABLE_IMAGE.match(base.group(1) or ''), 'immutable full SDK base image reference required')
    profile_row = json.loads(subprocess.check_output(
        [sys.executable, str(ROOT / 'qlever/scripts/qlever_compiler_profile.py'), 'sdk-profile', profile], text=True))
    need(profile_row.get('name') == profile, 'declared SDK profile differs')
    body['toolchain'] = {
        'profile': profile,
        'distribution': profile_row.get('distribution'),
        'compiler': profile_row.get('cxx'),
        'linker': profile_row.get('linker_program'),
        'baseImage': base.group(1),
        'generator': 'Ninja',
        'recipe': 'build-qlever-runtime-sdk.sh all + linked-verification',
    }
    body['recipe'] = {'kind': 'incremental' if prior_sdk_digest else 'cold',
                      'dockerfile': recipe_dockerfile, 'priorImage': prior_sdk_digest or None}
    body['inputHash'] = sha256(canonical(body))
    return body


def write_outputs(values):
    target = os.environ.get('GITHUB_OUTPUT')
    if not target:
        return
    with open(target, 'a') as output:
        for key, value in values.items():
            output.write(str(key) + '=' + str(value) + '\n')


def command_identity(args):
    body = identity_body(Path(args.source).resolve(), args.source_commit, args.profile, args.target,
                         args.profile_identity, args.dockerfile, args.prior_sdk_digest)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(body, sort_keys=True, indent=2) + '\n')
    write_outputs({'tag': 'qlever-inputs-' + body['inputHash'], 'input_hash': body['inputHash'],
                   'identity_path': str(out), 'dockerfile_sha256': body['files'][args.dockerfile]})
    return body


def api_json(url, token, maximum=4 * 1024 ** 2):
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token,
                                                   'Accept': 'application/vnd.github+json',
                                                   'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(maximum + 1)
    need(len(data) <= maximum, 'GitHub API bound exceeded')
    return json.loads(data)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *args):
        redirected = super().redirect_request(request, *args)
        if redirected is not None and urllib.parse.urlparse(redirected.full_url).hostname != 'api.github.com':
            redirected.remove_header('Authorization')
        return redirected


def download(url, token, destination, maximum=16 * 1024 ** 2):
    opener = urllib.request.build_opener(SafeRedirect)
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token,
                                                   'Accept': 'application/vnd.github+json'})
    with opener.open(request, timeout=60) as response, open(destination, 'xb') as stream:
        digest = hashlib.sha256()
        size = 0
        while True:
            block = response.read(min(65536, maximum - size + 1))
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'artifact ZIP byte budget exceeded')
            digest.update(block)
            stream.write(block)
    return digest.hexdigest(), size


def candidate(args):
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    need(token, 'GH_TOKEN or GITHUB_TOKEN required for retained proof lookup')
    repository = args.repository
    need(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'GitHub repository required')
    profile, target, input_hash = args.profile, args.target, args.input_hash
    need(HEX64.match(input_hash), '64-hex input identity required')
    name = 'qlever-sdk-normal-proof-' + profile + '-' + target + '-' + input_hash
    base = 'https://api.github.com/repos/' + repository + '/actions/artifacts'
    rows = []
    page = 1
    while True:
        payload = api_json(base + '?' + urllib.parse.urlencode({'name': name, 'per_page': 100, 'page': page}), token)
        rows.extend(payload.get('artifacts') or [])
        need(len(rows) <= 300, 'retained proof artifact scan bound')
        if len(payload.get('artifacts') or []) < 100:
            break
        page += 1
    candidates = [row for row in rows if row.get('name') == name and row.get('expired') is False]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    if not candidates:
        write_outputs({'found': 'false', 'input_hash': input_hash})
        return {'found': False, 'inputHash': input_hash}
    candidates.sort(key=lambda row: row.get('created_at', ''), reverse=True)
    errors = []
    for row in candidates:
        try:
            archive = out / 'proof.zip'
            if archive.exists():
                archive.unlink()
            digest, size = download('https://api.github.com/repos/' + repository + '/actions/artifacts/' + str(row['id']) + '/zip', token, archive)
            expected = str(row.get('digest', ''))
            need(expected == 'sha256:' + digest, 'downloaded proof artifact digest differs')
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
                need(names == [INDEX_NAME], 'normal proof artifact must contain exactly the index')
                raw = bundle.read(INDEX_NAME)
            need(len(raw) <= 1024 ** 2, 'normal proof index bound exceeded')
            index = json.loads(raw)
            need(isinstance(index, dict) and index.get('schemaVersion') == 1
                 and index.get('kind') == 'qlever-sdk-normal-build-proof-index' and index.get('model') == MODEL
                 and index.get('inputHash') == input_hash and index.get('sdkProfile') == profile and index.get('target') == target,
                 'retained normal candidate index differs')
            value = {'schemaVersion': 1, 'kind': 'qlever-sdk-normal-candidate', 'inputHash': input_hash,
                     'proofArtifact': {'id': row['id'], 'name': name, 'digest': digest, 'created_at': row.get('created_at')},
                     'index': index}
            target_file = out / 'candidate.json'
            target_file.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
            write_outputs({'found': 'true', 'candidate_path': str(target_file), 'input_hash': input_hash})
            return value
        except Exception as error:
            errors.append(type(error).__name__ + ': ' + str(error))
    raise ValueError('retained normal SDK candidate is malformed: ' + '; '.join(errors))


def validate_linked_receipt(receipt, source, source_commit, input_hash):
    need(receipt.get('schemaVersion') == 1 and receipt.get('kind') == 'qlever-sdk-normal-linked-verification'
         and receipt.get('model') == MODEL and receipt.get('status') == 'success', 'linked verification receipt differs')
    need(receipt.get('inputHash') == input_hash, 'linked verification input hash differs')
    checks = receipt.get('checks')
    expected = GATES['linkedChecks']
    need(isinstance(checks, list) and [(row.get('name'), row.get('path')) for row in checks] ==
         [(row['name'], row['path']) for row in expected], 'linked verification check set differs')
    for row, canonical in zip(checks, expected):
        need(row.get('path') == canonical['path'] and row.get('sha256') == sha256(committed(source, source_commit, canonical['path'])),
             'linked verification script bytes differ')
    return checks


def collect(args):
    source = Path(args.source).resolve()
    need(source.is_dir() and (source / '.git').exists(), 'canonical source checkout required')
    need(HEX40.match(args.source_commit), '40-hex source commit required')
    need(os.environ.get('GITHUB_SHA') == args.source_commit, 'GITHUB_SHA must equal the collected SDK source')
    identity = json.loads(Path(args.identity).read_text())
    need(identity.get('model') == MODEL and identity.get('inputHash') == args.input_hash
         and HEX64.match(args.input_hash), 'canonical input identity differs')
    recipe = identity.get('recipe', {})
    need(recipe.get('dockerfile') == args.dockerfile and (recipe.get('priorImage') or None) == (args.prior_sdk_digest or None),
         'canonical input identity recipe/prior differs from the actual build mode')
    image_ref = args.image
    match = IMAGE.match(image_ref)
    need(match, 'exact GHCR SDK digest required')
    out = Path(args.out).resolve()
    need(out.parent == Path(os.environ['RUNNER_TEMP']).resolve() and out.name == 'sdk-normal-originals', 'fixed owned output required')
    need(not out.exists(), 'fresh normal SDK original output required')
    budget = budgets.ExecutionBudget(args.deadline)
    os.chdir(source)
    image_originals.capture_context(out, args.deadline)
    observed = image_originals.registry_originals(image_ref, args.target, out / 'image', budget=budget)
    stages = []

    def capture(name, command, timeout=120):
        row = commands.capture(name, command, out, source, timeout=budget.timeout(timeout, 600),
                               resource_profile='observation')
        stages.append(row)
        return row

    create = capture('normal-image-create', ['docker', 'create', '--entrypoint', '/bin/true', image_ref])
    cid = (out / create['stdout']['path']).read_text().strip()
    need(re.fullmatch(r'[a-f0-9]{64}', cid), 'actual image container identity required')
    try:
        capture('normal-image-linked-extract', ['docker', 'cp', cid + ':/opt/qlever-sdk/build/.xpod-linked-verification.json',
                                                str(out / 'linked-verification.original.json')])
    finally:
        capture('normal-image-remove', ['docker', 'rm', '--force', cid])
        absent = capture('normal-image-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + cid])
        need(not (out / absent['stdout']['path']).read_text().strip(), 'owned image container remains')
    linked_path = out / 'linked-verification.original.json'
    linked = json.loads(linked_path.read_text())
    validate_linked_receipt(linked, source, args.source_commit, args.input_hash)
    linked_ref = commands.ref(linked_path, out)
    smoke = capture('normal-image-smoke', [*GATES['smoke']['commandPrefixBeforeImage'], image_ref,
            *GATES['smoke']['commandSuffixAfterImage']], timeout=180)
    proof = {
        'schemaVersion': 1,
        'kind': 'qlever-sdk-normal-build-proof',
        'model': MODEL,
        'inputHash': args.input_hash,
        'inputIdentity': identity,
        'sdkProfile': args.profile,
        'target': args.target,
        'sdk': {'sourceSha': args.source_commit, 'runHeadSha': args.run_head_sha,
                'runId': int(os.environ['GITHUB_RUN_ID']), 'runAttempt': int(os.environ['GITHUB_RUN_ATTEMPT'])},
        'image': {key: observed[key] for key in ('referenceByDigest', 'manifestDigest', 'configDigest', 'platform',
                                                'manifestOriginal', 'configOriginal') if key in observed},
        'buildRecipe': {'kind': recipe['kind'], 'dockerfile': args.dockerfile,
                        'dockerfileSha256': identity['files'][args.dockerfile],
                        'priorImage': recipe.get('priorImage'), 'recipe': 'build-qlever-runtime-sdk.sh all'},
        'gates': [
            {'name': 'linked-adapter-runtime', 'receipt': linked_ref},
            {'name': 'image-smoke', 'receipt': smoke['receipt'], 'stdout': smoke['stdout'], 'stderr': smoke['stderr']},
        ],
        'guarantees': GUARANTEES,
        'scope': ('normal-build-v1 binds the canonical input identity, immutable OCI image, retained GitHub '
                  'artifact origin and actual linked/smoke gates. It does NOT prove syscall source reads, '
                  'generated-input causality, toolchain execution lifetime or kernel read-only enforcement.'),
    }
    proof_path = out / PROOF_NAME
    proof_path.write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    proof_ref = commands.ref(proof_path, out)
    normal = {
        'schemaVersion': 1,
        'model': MODEL,
        'inputHash': args.input_hash,
        'inputIdentity': identity,
        'sourceCommit': args.source_commit,
        'buildRecipe': proof['buildRecipe'],
        'dockerfile': {'path': args.dockerfile, 'sha256': identity['files'][args.dockerfile]},
        'proof': proof_ref,
        'gates': proof['gates'],
        'guarantees': GUARANTEES,
        'scope': proof['scope'],
    }
    originals = []
    for path in sorted(out.rglob('*')):
        budget.check(300)
        if path.is_file():
            originals.append(commands.ref(path, out))
    master = {
        'schemaVersion': 1,
        'kind': 'qlever-linux-sdk-originals',
        'buildExecutionModel': MODEL,
        'identity': {'sourceSha': args.source_commit, 'runHeadSha': args.run_head_sha,
                     'runId': int(os.environ['GITHUB_RUN_ID']), 'runAttempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
                     'target': args.target, 'sdkProfile': args.profile},
        'image': observed,
        'sourceContext': commands.ref(out / 'context-originals.json', out),
        'normalBuild': normal,
        'stages': stages,
        'originals': originals,
        'releaseAccepted': False,
        'pending': [PENDING],
        'scope': 'Normal-build-v1 actual image/input/gate originals; syscall read/generation/lifetime proof is explicitly absent',
    }
    master_path = out / MASTER_NAME
    master_path.write_text(json.dumps(master, sort_keys=True, indent=2) + '\n')
    master_ref = commands.ref(master_path, out)
    write_outputs({'master_sha256': master_ref['sha256'], 'master_bytes': master_ref['bytes'],
                   'proof_sha256': proof_ref['sha256'], 'proof_bytes': proof_ref['bytes'],
                   'input_hash': args.input_hash})
    return master


def index_command(args):
    proof = json.loads(Path(args.proof).read_text())
    need(proof.get('model') == MODEL and proof.get('kind') == 'qlever-sdk-normal-build-proof', 'normal proof differs')
    raw_digest = str(args.artifact_digest)
    digest = raw_digest[7:] if raw_digest.startswith('sha256:') else raw_digest
    need(HEX64.match(digest) and type(args.artifact_id) is int and args.artifact_id > 0, 'uploaded artifact tuple required')
    need(type(args.master_bytes) is int and 0 < args.master_bytes <= 8 * 1024 ** 2
         and HEX64.match(args.master_sha256), 'master tuple required')
    proof_bytes = Path(args.proof).read_bytes()
    value = dict(proof, kind='qlever-sdk-normal-build-proof-index',
                 proof={'path': PROOF_NAME, 'bytes': len(proof_bytes), 'sha256': sha256(proof_bytes)},
                 artifact={'id': args.artifact_id, 'digest': digest,
                           'master': {'path': MASTER_NAME, 'bytes': args.master_bytes, 'sha256': args.master_sha256}})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    target = out / INDEX_NAME
    target.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    ref = commands.ref(target, out)
    write_outputs({'index_path': str(target), 'index_sha256': ref['sha256'], 'index_bytes': ref['bytes']})
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['identity', 'candidate', 'collect', 'index'])
    parser.add_argument('--source')
    parser.add_argument('--source-commit')
    parser.add_argument('--profile')
    parser.add_argument('--target')
    parser.add_argument('--profile-identity')
    parser.add_argument('--dockerfile');parser.add_argument('--prior-sdk-digest')
    parser.add_argument('--out')
    parser.add_argument('--identity')
    parser.add_argument('--deadline', type=float)
    parser.add_argument('--repository')
    parser.add_argument('--input-hash')
    parser.add_argument('--image')
    parser.add_argument('--run-head-sha')
    parser.add_argument('--proof')
    parser.add_argument('--artifact-id', type=int)
    parser.add_argument('--artifact-digest')
    parser.add_argument('--master-bytes', type=int)
    parser.add_argument('--master-sha256')
    args = parser.parse_args()
    if args.mode == 'identity':
        command_identity(args)
    elif args.mode == 'candidate':
        candidate(args)
    elif args.mode == 'collect':
        collect(args)
    else:
        index_command(args)

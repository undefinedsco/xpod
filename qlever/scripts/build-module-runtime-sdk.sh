#!/usr/bin/env bash
set -Eeuo pipefail
component_root=${XPOD_RDF_COMPONENT_ROOT:-/components}
qlever_root="$component_root/qlever"
[[ ${XPOD_QLEVER_CMAKE_C_COMPILER:-} == gcc-12 && ${XPOD_QLEVER_CMAKE_CXX_COMPILER:-} == g++-12 ]] \
  || { echo 'module Bookworm SDK requires the declared GCC12 pair; no fallback' >&2; exit 64; }
python3 - "$qlever_root" <<'PY'
import hashlib, json, os, pathlib, platform, shutil, subprocess, sys
root = pathlib.Path(sys.argv[1]); profile = pathlib.Path('/opt/qlever-sdk/profile'); profile.mkdir(parents=True, exist_ok=True)
release = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
if release.get('ID', '').strip('"') != 'debian' or release.get('VERSION_CODENAME', '').strip('"') != 'bookworm':
    raise RuntimeError('Module SDK requires an actual Debian Bookworm interior')
if platform.machine() not in ['x86_64', 'aarch64'] or subprocess.check_output(['getconf', 'GNU_LIBC_VERSION'], text=True).strip() != 'glibc 2.36':
    raise RuntimeError('Module SDK native architecture/glibc baseline mismatch')
for compiler in ['gcc-12', 'g++-12']:
    if not subprocess.check_output([compiler, '-dumpfullversion'], text=True).strip().startswith('12.'):
        raise RuntimeError('Actual compiler is not GCC12')
packages = {}
for name, prefix in [('libboost1.81-dev', '1.81.'), ('libboost-url1.81-dev', '1.81.'), ('libicu-dev', '72.'), ('libssl-dev', '3.')]:
    value = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', name], text=True)
    if not value.startswith(prefix): raise RuntimeError('Unexpected module dependency version: ' + name)
    packages[name] = value
def hashfile(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            digest.update(block)
    return digest.hexdigest()
keyring = pathlib.Path('/usr/share/keyrings/debian-archive-keyring.gpg')
indices = list(pathlib.Path('/var/lib/apt/lists').glob('*InRelease'))
if not indices: raise RuntimeError('Authenticated Debian release originals absent')
signed = []
for index in sorted(indices):
    subprocess.run(['gpgv', '--keyring', str(keyring), str(index)], check=True)
    destination = profile / 'apt' / index.name; destination.parent.mkdir(exist_ok=True); shutil.copyfile(index, destination)
    signed.append(dict(path='apt/' + index.name, sha256=hashfile(index), bytes=index.stat().st_size))
index_hashes = {p.name: hashfile(p) for p in sorted(pathlib.Path('/var/lib/apt/lists').glob('*Packages*')) if p.is_file()}
if not index_hashes: raise RuntimeError('Authenticated package index cache absent')
ledger = subprocess.check_output(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], text=True)
(profile / 'dpkg-packages.txt').write_text(ledger)
recipes = ['build-module-runtime-sdk.sh', 'build-qlever-runtime-sdk.sh', 'qlever_compiler_profile.py', 'validate-prior-sdk.py', 'run-focused-native-build.sh']
base = os.environ.get('XPOD_QLEVER_SDK_BASE_IMAGE', '')
if '@sha256:' not in base: raise RuntimeError('Immutable module base identity required')
metadata = dict(schemaVersion=1, profile='module-bookworm-gcc12', baseImage=base, machine=platform.machine(), glibc='2.36',
    dependencyVersions=packages, packageLedgerSha256=hashfile(profile / 'dpkg-packages.txt'), keyringSha256=hashfile(keyring),
    signedReleaseOriginals=signed, packageIndexHashes=index_hashes,
    recipeHashes={name:hashfile(root / 'scripts' / name) for name in recipes}, dockerfileSha256=hashfile(profile / 'Dockerfile'), runtimeDockerfileSha256=hashfile(profile / 'runtime.Dockerfile'),
    lockSha256=hashfile(root / 'qlever.lock.json'))
(profile / 'inputs.json').write_text(json.dumps(metadata, sort_keys=True, indent=2) + '\n')
PY
exec bash "$qlever_root/scripts/build-qlever-runtime-sdk.sh" "$@"

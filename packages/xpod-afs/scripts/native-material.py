"""Verify an original native CI archive, then materialize its exact payload.

This is an AFS module reuse profile. It does not relax or invoke the preview
whole-source equivalence gate and does not claim a native rebuild of the module.
"""
import hashlib, importlib.util, io, json, pathlib, subprocess, sys, tarfile, zipfile

root, archive, pins_path, target, destination = map(pathlib.Path, sys.argv[1:])
target = str(target)
os_name, arch = target.split('-')
if os_name not in ['darwin', 'linux'] or arch not in ['arm64', 'x64']:
    raise RuntimeError('Unsupported admitted native target')
pins = json.loads(pins_path.read_text())
spec = importlib.util.spec_from_file_location('native_accept', root / 'scripts/agentfs-native-ci/accept.py')
accept = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(root / 'scripts/agentfs-native-ci'))
spec.loader.exec_module(accept)
# One authoritative gate verifies binary architecture/ABI, source-kit, suites
# and closed receipts for the requested native target. Old callers keep arm64
# via the foundation API default; this module always passes explicit arch.
facts = accept.verify_reuse_archive(archive, pins, os_name, arch)
if facts.get('target') != target or facts.get('arch') != arch or facts.get('productHead') != pins['PRODUCT_SHA']:
    raise RuntimeError('Native target or source authority mismatch')

# Complete native helper input tree, including locks, recipe and patches.
inputs = subprocess.check_output(['git', 'ls-tree', '-rz', pins['PRODUCT_SHA'], 'tools/agentfs-pod'], cwd=root)
rows = []
expected_names = set()
for row in inputs.split(b'\0'):
    if not row:
        continue
    meta, name = row.split(b'\t', 1)
    mode, kind, oid = meta.split()
    assert kind == b'blob'
    name = name.decode()
    expected_names.add(name)
    expected = subprocess.check_output(['git', 'cat-file', 'blob', oid.decode()], cwd=root)
    current = (root / name).read_bytes()
    assert current == expected, 'Native input bytes changed: ' + name
    rows.append({'path': name, 'mode': mode.decode(), 'sha256': hashlib.sha256(current).hexdigest()})
assert expected_names == set(subprocess.check_output(['git', 'ls-files', 'tools/agentfs-pod'], cwd=root, text=True).splitlines())

with zipfile.ZipFile(archive) as zipped:
    packages = [n for n in zipped.namelist() if n.endswith('-' + target + '.tar.gz')]
    if len(packages) != 1:
        raise RuntimeError('Expected one exact admitted target archive')
    package = packages[0]
    with tarfile.open(fileobj=io.BytesIO(zipped.read(package)), mode='r:gz') as tar:
        for member in tar.getmembers():
            name = member.name.removeprefix('./').removeprefix('install/')
            selected = name == 'helper/agentfs-pod' or name.startswith(('licenses/native/', 'licenses/agentfs/', 'licenses/xpod/')) or name in ['sources/native-source.tar.gz', 'sources/native-source.json', 'sources/native-source-build.json']
            if not selected or member.isdir():
                continue
            assert member.isfile() and not member.issym() and not member.islnk()
            parts = pathlib.PurePosixPath(name).parts
            assert parts and all(p not in ['.', '..'] for p in parts) and not name.startswith('/')
            dest = destination / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open('xb') as output:
                output.write(tar.extractfile(member).read())
            dest.chmod(0o755 if name == 'helper/agentfs-pod' else 0o644)
    helper = destination / 'helper/agentfs-pod'
    if hashlib.sha256(helper.read_bytes()).hexdigest() != facts['helperSHA256']:
        raise RuntimeError('Materialized helper differs from admitted payload')
    provenance = destination / 'provenance'
    provenance.mkdir(exist_ok=True)
    for source, output in [('native-receipt.json', 'native-build.receipt.json'), ('source-kit.json', 'native-source-kit.json')]:
        with (provenance / output).open('xb') as material:
            material.write(zipped.read(source))
    base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).strip())
    facts.update(nativeBuildSourceSHA=pins['PRODUCT_SHA'], moduleSourceSHA=None if dirty else base, baseCommit=base, moduleSourceDirty=dirty, nativeInputFiles=rows,
                 profile='module-reuses-original-native-build', previewWholeSourceReuseGateClaimed=False)
    with (provenance / 'native-reuse.json').open('x') as material:
        material.write(json.dumps(facts, indent=2) + '\n')
print(json.dumps({'target': target, 'helperSHA256': facts['helperSHA256'], 'nativeBuildSourceSHA': pins['PRODUCT_SHA'], 'nativeInputs': len(rows)}))

"""Hash-verify then extract ONLY the two selected members of the pinned QLever artifact.

DIAGNOSTIC_NOT_QUALIFICATION.

This is a CONSUMER SELECTION for the non-qualification launch diagnostic, not a
reduction of what the full publication carries: the complete original ZIP is
retained untouched, and nothing is repacked or truncated.

The exact pinned sha256 already authenticates every byte of the archive, so no
arbitrary member-count or total-size ceiling is imposed. Extraction is limited
instead by ACTUAL IDENTITY: exactly one regular top-level
`qlever-local-runtime-darwin-arm64.tar.gz` and exactly one regular top-level
`qlever-local-acceptance.json`. Everything else (native-materials/, source kits,
companion proofs, raw logs) is deliberately NOT extracted.
"""
import hashlib
import json
import os
import sys
import zipfile

EXPECTED_ARTIFACT_ID = '13912079864'
SELECTED = ('qlever-local-runtime-darwin-arm64.tar.gz', 'qlever-local-acceptance.json')
# Layout the desktop build consumes: the untouched ORIGINAL zip, the original tar,
# the raw acceptance, and the runtime tree (tar-extracted, unchanged bytes) whose
# `manifest.json` sits at that tree's root.
ACKNOWLEDGE_LAYOUT = 'qlever-desktop-materials-v1'


def fail(message: str) -> 'NoReturn':  # type: ignore[name-defined]
    # Fixed message only: never echo untrusted archive metadata.
    print(f'QLever artifact rejected: {message}', file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def metadata_authority(meta: dict, expected_sha: str, artifact_id: str,
                       expected_source=None) -> dict:
    if len(expected_sha) != 64 or any(c not in '0123456789abcdef' for c in expected_sha):
        fail('artifact digest is not sha256')
    source = (meta.get('workflow_run') or {}).get('head_sha')
    if (not isinstance(source, str) or len(source) != 40
            or any(c not in '0123456789abcdef' for c in source)):
        fail('artifact source is not a full commit sha')
    if (str(meta.get('id')) != artifact_id or meta.get('expired') is not False
            or meta.get('name') != f'qlever-local-runtime-darwin-arm64-{source}'
            or str(meta.get('digest', '')).removeprefix('sha256:') != expected_sha
            or (expected_source is not None and source != expected_source)):
        fail('artifact metadata differs from producer coordinates')
    return {'sourceSha': source, 'artifactId': artifact_id,
            'digest': f'sha256:{expected_sha}', 'target': 'darwin-arm64'}


def main(zip_path: str, destination: str, expected_sha: str, meta_path: str,
         expected_artifact_id: str = EXPECTED_ARTIFACT_ID) -> int:
    # 1. Metadata must name the expected artifact id (defence in depth).
    try:
        with open(meta_path) as handle:
            meta = json.load(handle)
    except (OSError, ValueError):
        fail('metadata unreadable')
    authority = metadata_authority(meta, expected_sha, expected_artifact_id)

    # 2. The DOWNLOADED bytes must hash to the pinned digest before extraction.
    if not os.path.isfile(zip_path):
        fail('downloaded archive is missing')
    if sha256_file(zip_path) != expected_sha:
        fail('downloaded archive sha256 does not match the pinned digest')

    # 3. Select the exact two members and validate their identity/type.
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        fail('downloaded archive is not a zip')

    try:
        inventory = {}
        for info in archive.infolist():
            name = info.filename
            # The diagnostic consumes top-level files only: a nested path can never be
            # one of the selected members, so it is ignored rather than extracted.
            if name not in SELECTED:
                continue
            if name in inventory:
                fail('selected member appears more than once')
            if info.is_dir():
                fail('selected member is a directory')
            mode = (info.external_attr >> 16) & 0o170000
            if mode and mode != 0o100000:
                fail('selected member is not a regular file')
            # Path constant: no separators, no traversal, no absolute path.
            if '/' in name or '\\' in name or name.startswith('.') or '..' in name:
                fail('selected member path is not a constant top-level name')
            inventory[name] = info

        for name in SELECTED:
            if name not in inventory:
                fail('selected member is missing')

        root = os.path.realpath(destination)
        os.makedirs(root, exist_ok=True)
        written = []
        for name in SELECTED:
            info = inventory[name]
            target = os.path.realpath(os.path.join(root, name))
            if os.path.dirname(target) != root:
                fail('selected member escapes the destination')
            with archive.open(info) as source, open(target, 'wb') as sink:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    sink.write(chunk)
            if os.path.getsize(target) != info.file_size:
                fail('selected member size differs from the archive record')
            written.append((name, info.file_size, sha256_file(target)))

        for name, size, digest in written:
            print(f'extracted {name} bytes={size} sha256={digest}')

    finally:
        archive.close()

    # Preserve the ORIGINAL zip byte-for-byte next to the materials and extract
    # the ORIGINAL tar (never re-tarred) into runtime/ so manifest.json is real.
    import shutil
    import tarfile
    shutil.copyfile(zip_path, os.path.join(root, 'qlever-native-artifact.zip'))
    runtime = os.path.join(root, 'runtime')
    os.makedirs(runtime, exist_ok=True)
    tar_path = os.path.join(root, 'qlever-local-runtime-darwin-arm64.tar.gz')
    with tarfile.open(tar_path) as archive:
        seen = set()
        for member in archive.getmembers():
            name = member.name[2:] if member.name.startswith('./') else member.name
            if not name or name.startswith('/') or '..' in name.split('/'):
                fail('original tar member path is unsafe')
            if not (member.isfile() or member.isdir()):
                fail('original tar member is not a regular file')
            if name in seen:
                fail('original tar member appears more than once')
            seen.add(name)
            target = os.path.realpath(os.path.join(runtime, name))
            if not (target == os.path.realpath(runtime) or target.startswith(os.path.realpath(runtime) + os.sep)):
                fail('original tar member escapes the runtime root')
            if member.isdir():
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with archive.extractfile(member) as source, open(target, 'wb') as sink:
                    sink.write(source.read())
                os.chmod(target, member.mode & 0o777)
    if not os.path.isfile(os.path.join(runtime, 'manifest.json')):
        fail('original runtime manifest is missing')
    with open(os.path.join(root, 'layout.json'), 'w') as handle:
        json.dump({'schemaVersion': 1, 'kind': ACKNOWLEDGE_LAYOUT}, handle)
    with open(os.path.join(root, 'qlever-native-authority.json'), 'w') as handle:
        json.dump(authority, handle, indent=2)
        handle.write('\n')
    print('desktop materials prepared')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(*sys.argv[1:]))

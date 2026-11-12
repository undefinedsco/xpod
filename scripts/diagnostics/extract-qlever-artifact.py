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


def main(zip_path: str, destination: str, expected_sha: str, meta_path: str) -> int:
    # 1. Metadata must name the expected artifact id (defence in depth).
    try:
        meta = json.load(open(meta_path))
    except (OSError, ValueError):
        fail('metadata unreadable')
    if str(meta.get('id')) != EXPECTED_ARTIFACT_ID:
        fail('artifact id differs from the pinned id')

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
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))

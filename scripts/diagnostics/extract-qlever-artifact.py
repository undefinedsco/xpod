"""Hash-verify then safely extract the pinned QLever runtime artifact.

DIAGNOSTIC_NOT_QUALIFICATION.

The retained GitHub metadata digest only proves what the API *says*. The bytes
actually downloaded are hashed here and must match the pinned sha256 EXACTLY
before anything is extracted. Extraction is then restricted: only regular files,
no traversal, no links, bounded member count and total uncompressed size.
"""
import hashlib
import json
import os
import sys
import zipfile

# Actual artifact metadata reports ~358MB uncompressed; allow modest headroom.
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 4096
EXPECTED_ARTIFACT_ID = '13912079864'


def fail(message: str) -> 'NoReturn':  # type: ignore[name-defined]
    # Never print raw untrusted metadata: a fixed message only.
    print(f'QLever artifact rejected: {message}', file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main(zip_path: str, destination: str, expected_sha: str, meta_path: str) -> int:
    # 1. The metadata must already name the expected artifact id (defence in depth).
    try:
        meta = json.load(open(meta_path))
    except (OSError, ValueError):
        fail('metadata unreadable')
    if str(meta.get('id')) != EXPECTED_ARTIFACT_ID:
        fail('artifact id differs from the pinned id')

    # 2. The DOWNLOADED bytes must hash to the pinned digest before extraction.
    if not os.path.isfile(zip_path):
        fail('downloaded archive is missing')
    actual = sha256_file(zip_path)
    if actual != expected_sha:
        fail('downloaded archive sha256 does not match the pinned digest')

    # 3. Bounded, type-safe, traversal-safe extraction.
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        fail('downloaded archive is not a zip')
    members = archive.infolist()
    if len(members) > MAX_MEMBERS:
        fail('too many archive members')
    total = 0
    planned = []
    for member in members:
        name = member.filename
        if not name or name.startswith('/') or '..' in name.split('/') or '\\' in name:
            fail('archive member path is unsafe')
        # Reject links and any non-regular entry.
        mode = (member.external_attr >> 16) & 0o170000
        if mode and mode not in (0o100000, 0o040000):
            fail('archive member is not a regular file')
        if member.is_dir():
            continue
        total += member.file_size
        if total > MAX_TOTAL_BYTES:
            fail('archive uncompressed size exceeds the bound')
        planned.append(member)

    os.makedirs(destination, exist_ok=True)
    for member in planned:
        target = os.path.realpath(os.path.join(destination, member.filename))
        root = os.path.realpath(destination)
        if not (target == root or target.startswith(root + os.sep)):
            fail('archive member escapes the destination')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(member) as source, open(target, 'wb') as sink:
            remaining = member.file_size
            while remaining > 0:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                sink.write(chunk)
            if remaining != 0:
                fail('archive member was truncated')
    print(f'QLever artifact extracted: {len(planned)} files, {total} bytes')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))

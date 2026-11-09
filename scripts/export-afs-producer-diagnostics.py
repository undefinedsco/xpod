"""Bounded diagnostic snapshots of fixed normal AFS producer phase originals.

The canonical supervisor combines stdout and stderr into one raw original. This
export preserves that stream identity; it does not invent separate streams or
claim closure from a snapshot. No recursive directory or environment export.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

BLOCK = 65536
SNAPSHOT = 262144
ORIGINAL = 32 * 1024 * 1024
TOTAL = 4 * 1024 * 1024


def export(repo, product, environment=None):
    repo, product = Path(repo).resolve(), Path(product)
    if product.parent != repo / '.test-data' or not re.fullmatch(r'afs-product-[1-9][0-9]*-[1-9][0-9]*-(?:darwin|linux)-(?:arm64|x64)', product.name):
        raise ValueError('fixed normal AFS producer output required')
    if product.parent.is_symlink() or product.is_symlink() or not product.is_dir() or product.resolve() != product:
        raise ValueError('ordinary producer output required')
    destination = product / 'diagnostics'
    destination.mkdir(mode=0o700)
    spec = importlib.util.spec_from_file_location('diagnostic_afs_producer', repo / 'scripts/afs-module-producer.py')
    producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)
    phases = [name for name, _, _ in producer.phase_plan(repo, product, '0.0.0', product.name.rsplit('-', 2)[-2] + '-' + product.name.rsplit('-', 1)[-1])]
    names = ['producer.receipt.json'] + ['evidence/' + name + suffix for name in phases for suffix in ('.receipt.json', '.raw.log')]
    environment = os.environ if environment is None else environment
    secrets = [value.encode() for key, value in environment.items() if re.search(r'TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY', key, re.I) and len(value) >= 8]
    if any(len(value) > BLOCK for value in secrets):
        raise ValueError('credential comparison byte bound')
    rows, used = [], 0
    for name in names:
        source = product / name
        if '/' in name and (source.parent.is_symlink() or not source.parent.is_dir()):
            rows.append(dict(original=name, state='nonordinary-evidence-directory')); continue
        if not source.exists():
            rows.append(dict(original=name, state='absent')); continue
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > ORIGINAL:
                rows.append(dict(original=name, state='original-byte-bound')); continue
            digest, kept, size, tail, credential = hashlib.sha256(), bytearray(), 0, b'', False
            while True:
                chunk = os.read(fd, BLOCK)
                if not chunk:
                    break
                size += len(chunk)
                if size > ORIGINAL:
                    raise ValueError('diagnostic original grew beyond bound')
                digest.update(chunk)
                scan = tail + chunk
                credential = credential or any(secret in scan for secret in secrets)
                tail = scan[-BLOCK:]
                kept.extend(chunk[:max(0, SNAPSHOT - len(kept))])
            after = os.fstat(fd)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != before.st_size:
                rows.append(dict(original=name, state='changed-during-read')); continue
            if credential:
                rows.append(dict(original=name, state='credential-content-withheld')); continue
            if used + len(kept) > TOTAL:
                rows.append(dict(original=name, state='total-snapshot-bound')); continue
            output = destination / name
            output.parent.mkdir(mode=0o700, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(kept)
            used += len(kept)
            rows.append(dict(original=name, originalBytes=size, originalSha256=digest.hexdigest(),
                             snapshot=name, snapshotBytes=len(kept), snapshotSha256=hashlib.sha256(kept).hexdigest(),
                             completeOriginal=len(kept) == size, stream='combined-stdout-stderr' if name.endswith('.raw.log') else 'receipt'))
        finally:
            os.close(fd)
    summary = dict(schemaVersion=1, kind='fixed-afs-producer-diagnostics', diagnosticOnly=True,
                   snapshotPerFileBytes=SNAPSHOT, snapshotTotalBytes=TOTAL, files=rows,
                   note='Snapshots grant no producer/source/native admission; original closure requires actual receipt and complete matching raw.')
    with (destination / 'summary.json').open('x') as stream:
        json.dump(summary, stream, indent=2)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', required=True)
    args = parser.parse_args()
    result = export(Path(__file__).resolve().parent.parent, Path(args.product))
    print(json.dumps(dict(kind=result['kind'], files=len(result['files']))))

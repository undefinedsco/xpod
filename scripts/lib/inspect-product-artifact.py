"""Inspect a GitHub artifact ZIP; optionally copy explicit bounded members.

Uses the same stdlib zipfile/duplicate-name approach as agentfs-native-ci/accept.py.
Selected members are copied as original bytes; inner archives are never expanded
or executed. This is transport inventory, not product or release admission.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile
import shutil
import time
from contextlib import nullcontext

MODULE_LIMITS = json.loads((pathlib.Path(__file__).resolve().parent / 'module-artifact-limits.json').read_text())


def source_original_path(path):
    return path in {
        'cleanup.json', 'client.tgz', 'cli.tgz', 'input.json', 'inventory.json',
        'phases.jsonl', 'producer-index.json', 'preparation.json', 'result.json',
        'source-materials-inputs.json',
        'source-inputs.json', 'source-manifests/cli.package.json',
        'source-manifests/client.package.json',
    } or re.fullmatch(r'source-capture-(?:before|after)\.(?:receipt\.json|request\.json|(?:stdout|stderr)\.raw\.log)', path) is not None or re.fullmatch(r'phase-[0-9]{3}\.(?:receipt\.json|build\.json|(?:stdout|stderr)\.raw\.log)', path) is not None \
        or re.fullmatch(r'phase-[0-9]{3}\.metafiles/[A-Za-z0-9_-]+\.json', path) is not None


def inspect(archive, expected, packed_limit, expanded_limit, member_limit, selections=None, destination=None, legacy=False, source_originals=False, module_source_originals=False, module_material_originals=False, registry_consumer_originals=False, native_material_originals=False):
    if sum((legacy, source_originals, module_source_originals, module_material_originals, registry_consumer_originals, native_material_originals)) > 1:
        raise ValueError('conflicting projection modes')
    if selections is not None and type(selections) is not list:
        raise ValueError('projection selections must be an array')
    selected = {}
    for row in selections or []:
        allowed_destination = (row.get('destination') == row.get('path') and source_original_path(row.get('path', ''))) if source_originals and type(row) is dict else None
        if module_source_originals and type(row) is dict:
            name = row.get('path')
            allowed_destination = (type(name) is str and row.get('destination') == name
                                   and (name == 'producer.receipt.json' or re.fullmatch(r'evidence/[a-z0-9-]+\.receipt\.json', name) is not None))
        if module_material_originals and type(row) is dict:
            name = row.get('path')
            allowed_destination = (type(name) is str and row.get('destination') == name and re.fullmatch(r'source-materials/(?:materials\.json|(?:source|dependencies|toolchain)-[0-9]{4}\.tar|(?:source|dependencies|toolchain)-inventory-[0-9]{4}\.json|outputs-[0-9]{4}\.json)', name) is not None)
        if (registry_consumer_originals or native_material_originals) and type(row) is dict:
            name = row.get('path')
            allowed_destination = type(name) is str and row.get('destination') == name and re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name) is not None
        if not source_originals and not module_source_originals and not module_material_originals and not registry_consumer_originals and not native_material_originals and type(row) is dict:
            allowed_destination = ((row['destination'] == row['path'] and (row['path'] == 'supply-index.original.json' or row['path'].startswith(('cli/', 'afs/', 'producer/')))) if legacy else row['destination'] in ('producer.receipt.json', 'product.tgz', 'pack.raw.log', 'result.json', 'inventory.json', 'source-inputs.json', 'preparation.json', 'producer-index.json', 'input.json', 'cli.tgz', 'client.tgz', 'cli.package.json', 'client.package.json'))
        if (type(row) is not dict or set(row) != {'path', 'destination', 'bytes', 'sha256'} or row['path'] in selected
                or not allowed_destination
                or type(row['bytes']) is not int or row['bytes'] < 0
                or len(row['sha256']) != 64):
            raise ValueError('invalid exact projection selection')
        selected[row['path']] = row
    if module_source_originals and sum(row['bytes'] for row in selected.values()) > 8 * 1024 * 1024:
        raise ValueError('module receipt projection byte bound')
    if module_material_originals and (len(selected) > MODULE_LIMITS['sourceMaterialFiles'] or sum(row['bytes'] for row in selected.values()) > MODULE_LIMITS['sourceMaterialBytes'] or any(row['bytes'] > (MODULE_LIMITS['shardBytes'] if row['path'].endswith('.tar') else MODULE_LIMITS['metadataBytes']) for row in selected.values())):
        raise ValueError('module material projection byte bound')
    if registry_consumer_originals and (len(selected) > 2100 or sum(row['bytes'] for row in selected.values()) > 72 * 1024 ** 2 or any(row['bytes'] > 16 * 1024 ** 2 for row in selected.values())):
        raise ValueError('registry original projection byte bound')
    if native_material_originals and (len(selected) > MODULE_LIMITS['members'] or sum(row['bytes'] for row in selected.values()) > MODULE_LIMITS['expandedBytes'] or any(row['bytes'] > MODULE_LIMITS['shardBytes'] for row in selected.values())):
        raise ValueError('native original projection byte bound')
    deadline = time.monotonic() + MODULE_LIMITS['timeoutMs'] / 1000 if (module_material_originals or native_material_originals) else None
    if len({row['destination'] for row in selected.values()}) != len(selected):
        raise ValueError('duplicate projection destination')
    named_before = os.lstat(archive)
    if not stat.S_ISREG(named_before.st_mode) or named_before.st_nlink != 1:
        raise ValueError('artifact must be an ordinary file with one link')
    if legacy:
        for parent in pathlib.Path(archive).absolute().parents:
            if parent.is_symlink():
                raise ValueError('linked artifact ancestor')
    fd = os.open(archive, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > packed_limit
                or (before.st_dev, before.st_ino) != (named_before.st_dev, named_before.st_ino)):
            raise ValueError('artifact packed bound or type')
        digest = hashlib.sha256()
        while chunk := source.read(65536):
            digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('artifact ZIP digest changed')
        source.seek(0)
        # Preflight stdlib's small EOCD/ZIP64 record before ZipFile materializes
        # the central directory. Bound metadata as well as member payloads.
        end = zipfile._EndRecData(source)
        if (not end or end[zipfile._ECD_ENTRIES_TOTAL] > member_limit
                or end[zipfile._ECD_SIZE] > min(packed_limit, 16 * 1024 * 1024)
                or end[zipfile._ECD_DISK_NUMBER] != 0 or end[zipfile._ECD_DISK_START] != 0):
            raise ValueError('artifact central directory bound')
        source.seek(0)
        with zipfile.ZipFile(source) as archive_zip:
            entries = archive_zip.infolist()
            if not entries or len(entries) > member_limit:
                raise ValueError('artifact member bound')
            names = set()
            files = set()
            expanded = 0
            for entry in entries:
                name = entry.filename
                normalized = name[:-1] if entry.is_dir() else name
                parts = normalized.split('/')
                mode = entry.external_attr >> 16
                if (entry.orig_filename != name or not normalized or name.startswith('/') or '\\' in name or ':' in name
                        or any(ord(c) < 32 or ord(c) == 127 for c in name)
                        or any(p in ('', '.', '..') for p in parts)
                        or normalized in names or entry.flag_bits & 1
                        or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        or stat.S_IFMT(mode) not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)):
                    raise ValueError('unsafe artifact ZIP member')
                names.add(normalized)
                if not entry.is_dir():
                    files.add(normalized)
                expanded += entry.file_size
                if (legacy and entry.file_size > 8 * 1024 * 1024) or expanded > expanded_limit:
                    raise ValueError('artifact expanded bound')
            if any('/'.join(pathlib.PurePosixPath(name).parts[:i]) in files
                   for name in names for i in range(1, len(pathlib.PurePosixPath(name).parts))):
                raise ValueError('artifact file/directory conflict')
            if not set(selected).issubset(files):
                raise ValueError('selected ordinary member missing')
            inventory = []
            actual_expanded = 0
            for entry in entries:
                digest = hashlib.sha256()
                size = 0
                row = selected.get(entry.filename)
                if row and entry.file_size != row['bytes']:
                    raise ValueError('projection declared size mismatch')
                if row and (legacy or source_originals or module_source_originals or module_material_originals or registry_consumer_originals or native_material_originals):
                    parent = pathlib.Path(destination) / pathlib.PurePosixPath(row['destination']).parent
                    parent.mkdir(parents=True, exist_ok=True)
                    for ancestor in [parent, *parent.parents]:
                        if ancestor.is_symlink():
                            raise ValueError('linked projection ancestor')
                        if ancestor == pathlib.Path(destination):
                            break
                output = open(pathlib.Path(destination) / row['destination'], 'xb') if row else None
                with (output if output else nullcontext()), archive_zip.open(entry) as member:
                    while chunk := member.read(65536):
                        if deadline is not None and (time.monotonic() >= deadline or (output and shutil.disk_usage(destination).free < MODULE_LIMITS['freeFloorBytes'] + MODULE_LIMITS['queueReserveBytes'] + len(chunk))):
                            raise ValueError('module material time/disk floor bound')
                        size += len(chunk)
                        actual_expanded += len(chunk)
                        if size > entry.file_size or actual_expanded > expanded_limit:
                            raise ValueError('artifact actual expanded bound')
                        digest.update(chunk)
                        if output:
                            output.write(chunk)
                if size != entry.file_size or (entry.is_dir() and size):
                    raise ValueError('artifact member size mismatch')
                if row:
                    if digest.hexdigest() != row['sha256']:
                        raise ValueError('projection member hash mismatch')
                    os.chmod(pathlib.Path(destination) / row['destination'], 0o400)
                inventory.append({'path': entry.filename, 'kind': 'directory' if entry.is_dir() else 'file',
                                  'bytes': size, 'sha256': digest.hexdigest(), 'mode': (entry.external_attr >> 16) & 0o777})
        after = os.fstat(source.fileno())
        named_after = os.lstat(archive)
        # Windows path stat may expose birth time as ctime while fstat exposes
        # change time (CPython #157671). Check each view over time, not against
        # the other view's ctime. Identity/size/mtime still bind both views.
        def stable(value):
            return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if (not stat.S_ISREG(named_after.st_mode) or named_after.st_nlink != 1
                or stable(named_before) != stable(named_after)
                or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (named_after.st_dev, named_after.st_ino, named_after.st_size, named_after.st_mtime_ns)):
            raise ValueError('artifact name changed during inspection')
        if stable(before) != stable(after):
            raise ValueError('artifact changed during inspection')
        result = {'members': inventory, 'expandedBytes': actual_expanded,
                  'selectedMembersProjected': len(selected), 'innerArchiveExpanded': False}
        # Preserve the original no-write acquisition contract. Projection callers
        # use the explicit count instead of an ambiguous extracted:false flag.
        if not selected:
            result['extracted'] = False
        return result


if __name__ == '__main__':
    if len(sys.argv) > 6 and sys.argv[6] == '--selection-stdin':
        request = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(request) > 8 * 1024 * 1024:
            raise ValueError('projection stdin request bound')
        selections = json.loads(request.decode('utf-8'))
    else:
        selections = json.loads(sys.argv[6]) if len(sys.argv) > 6 else None
    destination = sys.argv[7] if len(sys.argv) > 7 else None
    mode = sys.argv[8] if len(sys.argv) > 8 else None
    if mode not in (None, 'legacy-root-normal-supply', 'independent-source-originals', 'module-source-originals', 'module-material-originals', 'registry-consumer-originals', 'native-material-originals'):
        raise ValueError('unknown projection mode')
    print(json.dumps(inspect(sys.argv[1], sys.argv[2], *map(int, sys.argv[3:6]), selections, destination,
                             mode == 'legacy-root-normal-supply', mode == 'independent-source-originals', mode == 'module-source-originals', mode == 'module-material-originals', mode == 'registry-consumer-originals', mode == 'native-material-originals')))

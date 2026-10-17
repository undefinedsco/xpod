"""Stream a registered native ZIP's tar member; never extract or execute input.

Only the enclosing private native custody capability may authorize these facts.
"""
import hashlib
import json
import stat
import sys
import tarfile
import zipfile


def safe(name):
    return bool(name) and not name.startswith('/') and '\\' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name) and all(part not in ('', '.', '..') for part in name.split('/'))


def scan(zip_path, archive_member, domain):
    if domain not in ('runtime', 'source') or not safe(archive_member):
        raise ValueError('Native tar profile invalid')
    rows, names, total = [], set(), 0
    with zipfile.ZipFile(zip_path) as outer:
        matches = [item for item in outer.infolist() if item.filename == archive_member]
        if len(matches) != 1 or matches[0].is_dir() or matches[0].file_size > 512 * 1024**2:
            raise ValueError('Unique bounded native tar original required')
        with outer.open(matches[0]) as stream, tarfile.open(fileobj=stream, mode='r|gz' if domain == 'runtime' else 'r|') as archive:
            for item in archive:
                name = item.name.removeprefix('./').rstrip('/')
                if item.isdir() and name in ('', '.'):
                    continue
                if not safe(name) or name in names or len(names) >= 25000:
                    raise ValueError('Unsafe or duplicate native tar member')
                names.add(name)
                if item.isdir():
                    continue
                if item.isfile():
                    total += item.size
                    if item.size < 0 or total > (1024 if domain == 'runtime' else 512) * 1024**2:
                        raise ValueError('Native tar expanded bound')
                    digest, count = hashlib.sha256(), 0
                    with archive.extractfile(item) as original:
                        for block in iter(lambda: original.read(65536), b''):
                            digest.update(block)
                            count += len(block)
                    if count != item.size:
                        raise ValueError('Native tar original truncated')
                    rows.append(dict(path=name, sizeBytes=count, sha256=digest.hexdigest()))
                elif domain == 'source' and item.issym():
                    raw = item.linkname.encode('utf-8')
                    if not item.linkname or len(raw) > 4096 or item.linkname.startswith('/') or '\\' in item.linkname:
                        raise ValueError('Unsafe native source link object')
                    rows.append(dict(path=name, type='symlink', linkTarget=item.linkname, mode=stat.S_IMODE(item.mode),
                                     sizeBytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
                else:
                    raise ValueError('Unsupported native tar member type')
    files = {row['path']: row for row in rows}
    for name in files:
        parts = name.split('/')
        if any('/'.join(parts[:i]) in files for i in range(1, len(parts))):
            raise ValueError('Native tar ordinary/link member used as directory')
    if not files:
        raise ValueError('Native tar originals empty')
    for row in rows:
        if row.get('type') != 'symlink':
            continue
        parts = row['path'].split('/')
        count = 2 if parts[0] == 'fetchcontent' else 1
        if parts[0] not in ('engine', 'workspace', 'fetchcontent') or len(parts) <= count:
            raise ValueError('Native source link namespace invalid')
        namespace = '/'.join(parts[:count])
        pending, resolved, visited = parts[count:], [], set()
        while pending:
            part = pending.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                if not resolved:
                    raise ValueError('Native source link escapes namespace')
                resolved.pop()
                continue
            candidate = namespace + '/' + '/'.join([*resolved, part])
            target = files.get(candidate)
            if target and target.get('type') == 'symlink':
                if candidate in visited or len(visited) >= 40:
                    raise ValueError('Native source link cycle')
                visited.add(candidate)
                pending = target['linkTarget'].split('/') + pending
            else:
                if candidate not in files and not any(name.startswith(candidate + '/') for name in files):
                    raise ValueError('Native source link target absent')
                if pending and candidate in files:
                    raise ValueError('Native source link traverses ordinary file')
                resolved.append(part)
    return sorted(rows, key=lambda row: row['path'])


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Native ZIP, exact tar member and fixed profile required')
    encoded = json.dumps(scan(*sys.argv[1:]), separators=(',', ':'))
    if len(encoded.encode()) > 8 * 1024**2:
        raise ValueError('Native tar result metadata bound')
    print(encoded)

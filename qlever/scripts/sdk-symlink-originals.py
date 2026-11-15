"""Readlink originals captured before compilation, with independent after observations."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat

METADATA_LIMIT=4*1024**2

def identity(value):
    fields=['st_dev','st_ino','st_mode']
    if not stat.S_ISDIR(value.st_mode):fields+=['st_size','st_mtime_ns','st_ctime_ns','st_nlink']
    return {key:str(getattr(value,key)) for key in fields}

def observe(paths,records,check):
    queue=[Path(os.path.abspath(path)) for path in paths];visited=set()
    while queue:
        value=queue.pop();check()
        for path in [value,*value.parents]:
            if str(path) in visited:continue
            visited.add(str(path))
            before=path.lstat()
            if not stat.S_ISLNK(before.st_mode):continue
            target=os.readlink(path);raw=os.fsencode(target)
            # Preserve the original bytes, never only the resolved destination.
            target_text=raw.decode('utf-8')
            resolved=path.resolve(strict=True);target_identity=identity(resolved.stat())
            row=dict(originalPath=str(path),linkTarget=target_text,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),
                readlinkBase64=base64.b64encode(raw).decode('ascii'),linkIdentity=identity(before),
                resolvedTarget=str(resolved),targetIdentity=target_identity)
            if identity(path.lstat())!=row['linkIdentity'] or os.readlink(path)!=target or identity(resolved.stat())!=target_identity:
                raise ValueError('SDK symlink changed during observation')
            if str(path) in records and records[str(path)]!=row:raise ValueError('SDK symlink candidate changed before compile')
            records[str(path)]=row
            if len(records)>100000:raise ValueError('SDK symlink original count budget')
            queue.append(path.parent/target)
    return records

def compare(before,after,selected=()):
    pending=[]
    for value in selected:
        lexical=Path(os.path.abspath(value))
        for candidate in [lexical,*lexical.parents]:
            if str(candidate) in before and str(candidate) not in after:
                raise ValueError('SDK symlink removed during compile: '+str(candidate))
    for path,row in after.items():
        if path not in before:pending.append(dict(path=path,reason='symlink-original-unavailable-before-compile'))
        elif before[path]!=row:raise ValueError('SDK symlink differs from before compile: '+path)
    return pending

def save(path,records,bindings=None,check=lambda:None):
    # Bound metadata before serialization; callers also include these bytes in source budget.
    encoder=json.JSONEncoder(sort_keys=True,ensure_ascii=True)
    size=0
    with Path(path).open('x') as output:
        for chunk in encoder.iterencode(dict(schemaVersion=1,kind='sdk-readlink-originals',links=[records[key] for key in sorted(records)],inputBindings=bindings or {})):
            check()
            size+=len(chunk.encode('ascii'))
            if size>METADATA_LIMIT:raise ValueError('SDK symlink metadata byte budget')
            output.write(chunk)
    return size

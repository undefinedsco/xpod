"""Small original/identity helpers. SDK payload snapshots use 64KiB streaming."""
import hashlib
import json
import os
from pathlib import Path
import stat
MAX=16*1024**2
def sha(data):return hashlib.sha256(data).hexdigest()
def put(path,data):
    assert len(data)<=MAX,'fixed tiny original bound'
    with path.open('xb') as file:file.write(data)
    return dict(path=path.name,bytes=len(data),sha256=sha(data))
def jsonfile(path,value):
    data=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();assert len(data)<=4*1024**2
    return put(path,data)
def identity(st):return [st.st_dev,st.st_ino,st.st_mode,st.st_size,st.st_mtime_ns,st.st_ctime_ns]
def original_fd(fd,path):
    before=os.fstat(fd);assert stat.S_ISREG(before.st_mode) and before.st_size<=MAX
    chunks=[];size=0
    while True:
        chunk=os.pread(fd,65536,size)
        if not chunk:break
        size+=len(chunk);assert size<=MAX;chunks.append(chunk)
    assert identity(before)==identity(os.fstat(fd))==identity(os.stat(path,follow_symlinks=False))
    return b''.join(chunks),identity(before)
def original(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:return original_fd(fd,path)
    finally:os.close(fd)
def readonly(path,mounts):
    resolved=str(Path(path).resolve());matches=[]
    for line in mounts.decode().splitlines():
        fields=line.split();mount=fields[4].replace('\\040',' ')
        if resolved==mount or resolved.startswith(mount.rstrip('/')+'/'):matches.append((len(mount),mount,fields[5].split(',')))
    assert matches,'mount not found'
    _,mount,options=max(matches)
    assert 'ro' in options,'actual input mount is writable: '+resolved
    return mount


def effective_readonly(path,mounts,*,resolve_local=True):
    """Linux VFS mount ro OR filesystem superblock ro, longest actual mount."""
    resolved=str(Path(path).resolve()) if resolve_local else str(path);assert resolved.startswith('/') and os.path.normpath(resolved)==resolved,'canonical observed source path required'
    matches=[]
    for line in mounts.decode('utf-8','strict').splitlines():
        fields=line.split();separator=fields.index('-');assert separator>=6 and len(fields)>separator+3,'kernel mountinfo field layout'
        mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
        if resolved==mount or resolved.startswith(mount.rstrip('/')+'/'):
            matches.append((len(mount),mount,fields[5].split(','),fields[separator+3].split(',')))
    assert matches,'source mount missing from actual kernel mountinfo'
    _,mount,mount_options,super_options=max(matches)
    assert 'ro' in mount_options or 'ro' in super_options,'source provider is writable'
    return dict(mount=mount,mountOptions=mount_options,superblockOptions=super_options)

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


RAW_RECORD_MODEL='schema-indexed-ndjson-v1'
RAW_RECORD_LIMIT=65536


def _raw_schema(keys):
    assert type(keys) is list and 0<len(keys)<=256,'bounded raw schema keys'
    assert all(type(key) is str and 0<len(key)<=128 for key in keys),'bounded raw schema key'
    assert keys==sorted(set(keys)),'unique canonical raw schema keys'
    return tuple(keys)


def _raw_schema_overhead(keys):
    return sum(len(json.dumps(key))+2 for key in keys)+2+2*max(0,len(keys)-1)


def _raw_decoded_bound(row,overhead,wire_size):
    if overhead+2*wire_size>RAW_RECORD_LIMIT:
        assert len((json.dumps(row,sort_keys=True)+'\n').encode())<=RAW_RECORD_LIMIT,'decoded raw record range bound'


class IndexedRawEncoder:
    """Lossless key dictionaries only; every physical byte remains charged."""
    def __init__(self):
        self.schemas={};self.overheads=[];self.started=False;self.metadata_bytes=0
    def encode(self,row):
        assert type(row) is dict,'raw record object required'
        keys=tuple(sorted(row));parts=[]
        def wire(value):return (json.dumps(value,separators=(',',':'))+'\n').encode()
        if not self.started:parts.append(wire([RAW_RECORD_MODEL]))
        index=self.schemas.get(keys)
        if index is None:
            _raw_schema(list(keys))
            assert len(self.schemas)<256,'raw schema count bound'
            index=len(self.schemas);definition=wire(['schema',index,list(keys)])
            assert self.metadata_bytes+len(definition)<=4*1024**2,'raw schema metadata bound'
            parts.append(definition)
        data=wire(['row',index,[row[key]for key in keys]])
        overhead=self.overheads[index] if index<len(self.overheads) else _raw_schema_overhead(keys)
        _raw_decoded_bound(row,overhead,len(data));parts.append(data)
        assert sum(map(len,parts))<=RAW_RECORD_LIMIT,'actual raw emit bundle range bound'
        if keys not in self.schemas:
            self.schemas[keys]=index;self.overheads.append(overhead);self.metadata_bytes+=len(definition)
        self.started=True
        return parts


class RawRecordDecoder:
    """One phase, including all its shards; format rows never become events."""
    def __init__(self):
        self.mode=None;self.schemas=[];self.overheads=[];self.unique=set();self.pending=None
        self.bundle_bytes=0;self.metadata_bytes=0;self.rows=0
    @property
    def model(self):return RAW_RECORD_MODEL if self.mode=='indexed' else None
    def feed(self,raw):
        assert type(raw) is bytes and raw.endswith(b'\n') and len(raw)<=RAW_RECORD_LIMIT,'physical raw record range bound'
        value=json.loads(raw)
        if self.mode is None:
            if value==[RAW_RECORD_MODEL]:
                self.mode='indexed';self.bundle_bytes=len(raw);return None
            self.mode='legacy'
        if self.mode=='legacy':
            assert type(value) is dict,'legacy raw record object required'
            self.rows+=1;return value
        self.bundle_bytes+=len(raw)
        assert self.bundle_bytes<=RAW_RECORD_LIMIT,'actual raw emit bundle range bound'
        assert type(value) is list and len(value)==3,'indexed raw record shape'
        kind,index,payload=value
        assert type(index) is int,'raw schema index integer required'
        if kind=='schema':
            assert self.pending is None and index==len(self.schemas)<256,'sequential bounded raw schema definition'
            keys=_raw_schema(payload);assert keys not in self.unique,'duplicate raw schema definition'
            self.metadata_bytes+=len(raw);assert self.metadata_bytes<=4*1024**2,'raw schema metadata bound'
            self.schemas.append(keys);self.overheads.append(_raw_schema_overhead(keys));self.unique.add(keys);self.pending=index;return None
        assert kind=='row' and 0<=index<len(self.schemas),'known raw row schema required'
        assert self.pending is None or self.pending==index,'new raw schema must be used immediately'
        keys=self.schemas[index]
        assert type(payload) is list and len(payload)==len(keys),'exact raw row value count'
        row=dict(zip(keys,payload));_raw_decoded_bound(row,self.overheads[index],len(raw))
        self.pending=None;self.bundle_bytes=0;self.rows+=1;return row
    def finish(self):
        assert self.pending is None and (self.mode!='indexed' or self.rows>0 and self.bundle_bytes==0),'incomplete indexed raw stream'


def decoded_raw_records(lines):
    decoder=RawRecordDecoder()
    for raw in lines:
        row=decoder.feed(raw)
        if row is not None:yield row
    decoder.finish()

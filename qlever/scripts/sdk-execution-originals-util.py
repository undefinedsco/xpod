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
RAW_RECORD_MODEL_V2='schema-indexed-ndjson-v2'
RAW_RECORD_LIMIT=65536
RAW_V2_CONSTANT_FIELDS=('kind','phase','arch')
RAW_V2_DELTA_FIELDS=('sequence','observedUnixNs','observedMonotonicNs')


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
        self.mode=None;self.schemas=[];self.overheads=[];self.unique=[]
        self.pending=None;self.last={}
        self.bundle_bytes=0;self.metadata_bytes=0;self.rows=0
    @property
    def model(self):
        return RAW_RECORD_MODEL if self.mode=='indexed' else RAW_RECORD_MODEL_V2 if self.mode=='indexed-v2' else None
    def feed(self,raw):
        assert type(raw) is bytes and raw.endswith(b'\n') and len(raw)<=RAW_RECORD_LIMIT,'physical raw record range bound'
        value=json.loads(raw)
        if self.mode is None:
            if value==[RAW_RECORD_MODEL]:
                self.mode='indexed';self.bundle_bytes=len(raw);return None
            if value==[RAW_RECORD_MODEL_V2]:
                self.mode='indexed-v2';self.bundle_bytes=len(raw);return None
            self.mode='legacy'
        if self.mode=='legacy':
            assert type(value) is dict,'legacy raw record object required'
            self.rows+=1;return value
        if self.mode=='indexed-v2':
            self.bundle_bytes+=len(raw)
            assert self.bundle_bytes<=RAW_RECORD_LIMIT,'actual raw emit bundle range bound'
            return _raw_v2_feed(self,value,len(raw))
        self.bundle_bytes+=len(raw)
        assert self.bundle_bytes<=RAW_RECORD_LIMIT,'actual raw emit bundle range bound'
        assert type(value) is list and len(value)==3,'indexed raw record shape'
        kind,index,payload=value
        assert type(index) is int,'raw schema index integer required'
        if kind=='schema':
            assert self.pending is None and index==len(self.schemas)<256,'sequential bounded raw schema definition'
            keys=_raw_schema(payload);assert keys not in self.unique,'duplicate raw schema definition'
            self.metadata_bytes+=len(raw);assert self.metadata_bytes<=4*1024**2,'raw schema metadata bound'
            self.schemas.append(keys);self.overheads.append(_raw_schema_overhead(keys));self.unique.append(keys);self.pending=index;return None
        assert kind=='row' and 0<=index<len(self.schemas),'known raw row schema required'
        assert self.pending is None or self.pending==index,'new raw schema must be used immediately'
        keys=self.schemas[index]
        assert type(payload) is list and len(payload)==len(keys),'exact raw row value count'
        row=dict(zip(keys,payload));_raw_decoded_bound(row,self.overheads[index],len(raw))
        self.pending=None;self.bundle_bytes=0;self.rows+=1;return row
    def finish(self):
        assert self.pending is None and (self.mode not in ('indexed','indexed-v2') or self.rows>0 and self.bundle_bytes==0),'incomplete indexed raw stream'


def decoded_raw_records(lines):
    decoder=RawRecordDecoder()
    for raw in lines:
        row=decoder.feed(raw)
        if row is not None:yield row
    decoder.finish()




def _raw_v2_type(value):
    if type(value) is str:return 'str'
    if type(value) is int:return 'int'
    if type(value) is bool:return 'bool'
    if type(value) is list:return 'array'
    if type(value) is dict:return 'object'
    return 'invalid'


def _raw_v2_name(name):
    assert type(name) is str and 0<len(name)<=64 and name.isascii() and name.isidentifier(),'bounded raw v2 declaration name'
    assert not name.startswith('_'),'reserved raw v2 declaration name'


def _raw_v2_constant(value):
    assert type(value) in (str,int) and type(value) is not bool,'raw v2 constant string or exact integer required'
    if type(value) is str:assert len(value)<=RAW_RECORD_LIMIT,'bounded raw v2 constant string'
    return value


def _raw_v2_decimal(value):
    """Canonical decimal text exactly, including arbitrary precision."""
    try:number=int(value)
    except (TypeError,ValueError):return False
    return str(number)==value


def _raw_v2_delta_type(value):
    if type(value) is int:return 'int'
    if type(value) is str and _raw_v2_decimal(value):return 'str'
    return None


def _raw_v2_schema_object(definition):
    """Validate a schema declaration; return constants, deltas and fields."""
    assert type(definition) is dict and definition,'raw v2 schema declaration object required'
    assert set(definition)<={'fields','constants','deltas'},'unknown raw v2 schema section'
    fields=definition.get('fields');constants=definition.get('constants',{});deltas=definition.get('deltas',{})
    assert type(fields) is list and fields==sorted(set(fields)),'canonical raw v2 field declaration required'
    assert 0<len(fields)<=256,'bounded raw v2 declared field count'
    for name in fields:_raw_v2_name(name)
    assert type(constants) is dict and type(deltas) is dict,'raw v2 schema sections must be objects'
    for name in constants:_raw_v2_name(name)
    for name in deltas:_raw_v2_name(name)
    for name,kind in deltas.items():
        assert type(kind) is str and kind in ('int','str'),'unknown raw v2 delta type declaration'
    assert not (set(constants)&set(deltas)),'raw v2 field declared twice'
    assert set(constants)<=set(fields) and set(deltas)<=set(fields),'raw v2 declaration outside field list'
    assert set(constants)<=set(RAW_V2_CONSTANT_FIELDS),'undeclared raw v2 constant field'
    assert set(deltas)<=set(RAW_V2_DELTA_FIELDS),'undeclared raw v2 delta field'
    return ({name:_raw_v2_constant(value)for name,value in constants.items()},
            dict(deltas),tuple(fields))


def _raw_v2_schema_overhead(definition,fields):
    return len(json.dumps(definition,separators=(',',':')).encode())+sum(len(json.dumps(name))+2 for name in fields)+2+2*max(0,len(fields)-1)


def _raw_v2_check_row(row,constants,deltas,fields):
    assert type(row) is dict and tuple(sorted(row))==fields,'raw v2 record fields changed'
    for name,value in constants.items():
        assert type(row[name]) is type(value) and row[name]==value,'raw v2 constant field changed value or type'
    for name,kind in deltas.items():
        value=row[name]
        if kind=='int':assert type(value) is int,'raw v2 delta field requires exact integer'
        else:assert type(value) is str and _raw_v2_decimal(value),'raw v2 delta field requires canonical decimal string'


class IndexedRawEncoderV2:
    """Lossless v2: declared constants plus exact signed integer deltas.

    A schema declares constant fields (kind/phase/arch, string or exact int)
    and delta fields (sequence/observedUnixNs/observedMonotonicNs). The first
    row of a schema carries absolute integers for those delta fields; later
    rows carry exact value-minus-previous integers, including negative ones.
    Canonical decimal timestamp strings are declared with type 'str' and
    delta-encoded as exact integers; integer deltas are declared 'int'. The
    declared type is part of the schema key, so both never share a schema.
    Noncanonical strings and all other fields are emitted verbatim.
    """
    model=RAW_RECORD_MODEL_V2
    def __init__(self):
        self.schemas={};self.overheads=[];self.last={}
        self.started=False;self.metadata_bytes=0;self.rows=0
    def encode(self,row):
        assert type(row) is dict,'raw v2 record object required'
        fields=tuple(sorted(row));assert fields and len(fields)<=256,'bounded raw v2 record fields'
        constants={};deltas={}
        for name in fields:
            value=row[name]
            if name in RAW_V2_CONSTANT_FIELDS and _raw_v2_type(value) in ('str','int'):constants[name]=value
            elif name in RAW_V2_DELTA_FIELDS:
                kind=_raw_v2_delta_type(value)
                if kind is not None:deltas[name]=kind
        key=(tuple(sorted((name,_raw_v2_type(value),value)for name,value in constants.items())),tuple(sorted(deltas.items())),fields)
        def wire(value):return (json.dumps(value,separators=(',',':'))+'\n').encode()
        parts=[wire([RAW_RECORD_MODEL_V2])] if not self.started else []
        index=self.schemas.get(key);definition=None
        if index is None:
            assert len(self.schemas)<256,'raw v2 schema count bound'
            index=len(self.schemas)
            definition={'fields':list(fields)}
            if constants:definition['constants']=constants
            if deltas:definition['deltas']=dict(deltas)
            line=wire(['schema',index,definition])
            assert len(line)<=RAW_RECORD_LIMIT,'raw v2 schema wire bound'
            assert self.metadata_bytes+len(line)<=4*1024**2,'raw v2 schema metadata bound'
            parts.append(line)
        _raw_v2_check_row(row,constants,deltas,fields)
        base=self.last.get(index,{});payload=[]
        for name in fields:
            if name in constants:continue
            if name in deltas:
                absolute=int(row[name]);previous=base.get(name)
                payload.append(absolute if previous is None else absolute-previous)
            else:payload.append(row[name])
        line=wire(['row',index,payload])
        overhead=self.overheads[index] if definition is None else _raw_v2_schema_overhead(definition,fields)
        _raw_decoded_bound(row,overhead,len(line))
        assert len((json.dumps(row,sort_keys=True)+'\n').encode())<=RAW_RECORD_LIMIT,'expanded raw v2 record range bound'
        parts.append(line)
        assert sum(map(len,parts))<=RAW_RECORD_LIMIT,'actual raw v2 emit bundle range bound'
        if definition is not None:
            self.schemas[key]=index;self.overheads.append(overhead);self.metadata_bytes+=len(parts[-2])
        self.last[index]={name:int(row[name])for name in deltas}
        self.started=True;self.rows+=1
        return parts


def _raw_v2_feed(decoder,value,wire_size):
    """Feed one schema or row record of an already-detected v2 stream."""
    assert type(value) is list and len(value)==3,'indexed raw v2 record shape'
    kind,index,payload=value
    assert type(index) is int and type(index) is not bool,'raw v2 schema index integer required'
    if kind=='schema':
        assert decoder.pending is None and index==len(decoder.schemas)<256,'sequential bounded raw v2 schema definition'
        definition=payload;constants,deltas,fields=_raw_v2_schema_object(definition)
        signature=(tuple(sorted((name,_raw_v2_type(value),value)for name,value in constants.items())),tuple(sorted(deltas.items())),fields)
        assert signature not in decoder.unique,'duplicate raw v2 schema definition'
        decoder.metadata_bytes+=wire_size
        assert decoder.metadata_bytes<=4*1024**2,'raw v2 schema metadata bound'
        decoder.schemas.append((constants,deltas,fields));decoder.unique.append(signature)
        decoder.overheads.append(_raw_v2_schema_overhead(definition,fields))
        decoder.pending=index
        return None
    assert kind=='row' and 0<=index<len(decoder.schemas),'known raw v2 row schema required'
    assert decoder.pending is None or decoder.pending==index,'new raw v2 schema must be used immediately'
    constants,deltas,fields=decoder.schemas[index]
    assert type(payload) is list and len(payload)==len(fields)-len(constants),'exact raw v2 row value count'
    row={};previous=decoder.last.get(index,{});position=0
    for name in fields:
        if name in constants:row[name]=constants[name]
        else:
            value=payload[position];position+=1
            if name in deltas:
                assert type(value) is int and type(value) is not bool,'raw v2 delta field requires exact integer'
                absolute=value if name not in previous else previous[name]+value
                assert type(absolute) is int,'raw v2 exact integer delta'
                row[name]=absolute if deltas[name]=='int' else str(absolute)
            else:row[name]=value
    _raw_decoded_bound(row,decoder.overheads[index],wire_size)
    assert len((json.dumps(row,sort_keys=True)+'\n').encode())<=RAW_RECORD_LIMIT,'expanded raw v2 record range bound'
    decoder.last[index]={name:int(row[name])for name in deltas}
    decoder.pending=None;decoder.bundle_bytes=0;decoder.rows+=1
    return row

"""Bounded Git PACK/tree/preimage mechanics; no origin or patch approval issuer."""
import base64
import hashlib
import re
import json
from pathlib import Path
import struct
import zlib

LIMITS=json.loads((Path(__file__).resolve().parents[2]/'scripts/lib/module-artifact-limits.json').read_text())
CHUNK=LIMITS['rangeBytes']
MAX_SOURCE=LIMITS['sourceMaterialBytes']
MAX_PACK=LIMITS['shardBytes']
MAX_OBJECT=LIMITS['shardBytes']
MAX_METADATA=LIMITS['metadataBytes']
MAX_MEMBERS=LIMITS['sourceMembers']

def need(value,reason):
    if not value:raise ValueError('SDK Git originals: '+reason)

def canonical(path):
    return isinstance(path,str) and path and not path.startswith('/') and not any(ord(c)<32 or ord(c)==127 or c=='\\' for c in path) and all(part not in ('','.','..') for part in path.split('/'))

def gitlink_repositories(raw, links):
    """One strict .gitmodules interpretation shared by acquisition and replay."""
    import configparser
    from urllib.parse import urlsplit
    need(isinstance(raw,bytes) and len(raw)<=MAX_METADATA,'bounded Gitmodules original')
    parser=configparser.ConfigParser(interpolation=None,strict=True)
    parser.optionxform=str
    parser.read_string(raw.decode('utf-8',errors='strict'))
    need(not parser.defaults(),'Gitmodules defaults refused')
    result={}
    for section in parser.sections():
        need(section.startswith('submodule "') and section.endswith('"') and len(section)>12 and not any(c in section[11:-1] for c in ('"', chr(92), chr(10), chr(13))),'Gitmodules section')
        row=dict(parser[section]);need({'path','url'}<=set(row)<= {'path','url','branch'},'Gitmodules declared path/URL/branch fields')
        # Git's optional tracking branch is metadata only. Acquisition always
        # checks out the parent tree's exact child OID; never run submodule update.
        if 'branch' in row:
            branch=row['branch']
            need(branch=='.' or (0<len(branch)<=1024 and not branch.startswith(('-', '/', '.')) and not branch.endswith(('/', '.')) and not any(value in branch for value in ('..','@{','//')) and all(not part.endswith('.lock') and part for part in branch.split('/')) and not any(ord(c)<=32 or ord(c)==127 or c in '~^:?*['+chr(92) for c in branch)), 'Gitmodules literal tracking branch metadata')
        path=row['path'];url=row['url'];parsed=urlsplit(url)
        need(canonical(path) and '.git' not in path.split('/') and path not in result,'Gitmodules canonical unique path')
        need(parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password and not parsed.port and not parsed.query and not parsed.fragment and parsed.netloc==parsed.hostname and parsed.path.startswith('/') and canonical(parsed.path[1:]) and all(ord(c)>32 for c in url),'Gitmodules credential-free absolute HTTPS repository')
        result[path]=url
    need(set(result)=={row['path'] for row in links},'Gitmodules/tree exact Gitlink universe')
    return result

def verify_git_originals(stream,commit,tree_listing,object_ids,inventory,check,retain_paths=(),gitlinks=None):
    need(isinstance(commit,str) and re.fullmatch('[a-f0-9]{40}',commit),'locked SHA1 commit required')
    need(isinstance(tree_listing,bytes) and len(tree_listing)<=MAX_METADATA,'bounded raw tree listing required')
    need(isinstance(object_ids,list) and 0<len(object_ids)<=MAX_MEMBERS and len(set(object_ids))==len(object_ids) and all(isinstance(oid,str) and re.fullmatch('[a-f0-9]{40}',oid) for oid in object_ids),'unique exact object ID set required')
    need(isinstance(inventory,list) and len(inventory)<=MAX_MEMBERS,'bounded prepatch inventory required')
    expected={}
    need(gitlinks is None or isinstance(gitlinks,list) and len(gitlinks)<=MAX_MEMBERS,'bounded Gitlink records required')
    expected_links={}
    for row in gitlinks or []:
        need(isinstance(row,dict) and canonical(row.get('path')) and row['path'] not in expected_links and row.get('mode')=='160000' and isinstance(row.get('commitOid'),str) and re.fullmatch('[a-f0-9]{40}',row['commitOid']),'canonical unique Gitlink required')
        expected_links[row['path']]=row['commitOid']
    for row in inventory:
        need(isinstance(row,dict) and canonical(row.get('path')) and row['path'] not in expected and row.get('mode') in ('100644','100755','120000'),'canonical unique prepatch row required')
        expected[row['path']]=row
    symlinks={row.get('blobOid') for row in inventory if row['mode']=='120000'}
    retain_oids={row.get('blobOid') for row in inventory if row['path'] in retain_paths}
    retain_sizes={row.get('bytes') for row in inventory if row['path'] in retain_paths}
    symlink_sizes={row.get('bytes') for row in inventory if row['mode']=='120000'}
    class Reader:
        def __init__(self):self.buffer=b'';self.total=0;self.sha=hashlib.sha1();self.full=hashlib.sha256()
        def peek(self):
            check()
            if not self.buffer:
                self.buffer=stream.read(CHUNK);need(isinstance(self.buffer,bytes) and len(self.buffer)<=CHUNK,'bounded pack stream required')
            return self.buffer
        def take(self,count,digest=True):
            out=[]
            while count:
                block=self.peek();need(block,'truncated pack');part=block[:count];self.buffer=block[len(part):];count-=len(part);out.append(part)
                self.total+=len(part);need(self.total<=MAX_PACK,'pack byte bound');self.full.update(part)
                if digest:self.sha.update(part)
            return b''.join(out)
    reader=Reader();header=reader.take(12);magic,version,count=struct.unpack('>4sII',header)
    need(magic==b'PACK' and version in (2,3) and count==len(object_ids),'pack header/version/object count differs')
    objects={};metadata_bytes=0;expanded=0
    for _ in range(count):
        first=reader.take(1)[0];kind=(first>>4)&7;size=first&15;shift=4;byte=first;header_bytes=1
        need(kind in (1,2,3),'delta/tag/unsupported pack object forbidden')
        while byte&128:
            byte=reader.take(1)[0];header_bytes+=1;need(header_bytes<=10,'pack object size encoding bound');size|=(byte&127)<<shift;shift+=7
        need(size<=MAX_OBJECT and expanded+size<=MAX_SOURCE,'expanded upstream source bound');expanded+=size
        typename={1:'commit',2:'tree',3:'blob'}[kind];oid_hash=hashlib.sha1((typename+' '+str(size)+'\0').encode());content_hash=hashlib.sha256();decoder=zlib.decompressobj();written=0;parts=[]
        # Only tree/commit/readlink originals need retained bytes. Ordinary blobs
        # are fully hashed while streaming, never buffered as the complete tree.
        keep=kind!=3
        keep=keep or size in symlink_sizes or size in retain_sizes
        if keep:metadata_bytes+=size;need(size<=MAX_METADATA and metadata_bytes<=16*1024**2,'tree/commit/readlink cache bound')
        while not decoder.eof:
            data=reader.peek();need(data,'truncated object compression');plain=decoder.decompress(data,CHUNK)
            remaining=decoder.unused_data if decoder.eof else decoder.unconsumed_tail
            used=len(data)-len(remaining);need(used>0 or plain,'stalled object compression');reader.take(used)
            written+=len(plain);need(written<=size,'inflated object exceeds declared length');oid_hash.update(plain);content_hash.update(plain)
            if keep:parts.append(plain)
        need(written==size,'object declared length differs');oid=oid_hash.hexdigest();need(oid not in objects,'duplicate pack object')
        if kind==3 and oid not in symlinks and oid not in retain_oids:
            if keep:metadata_bytes-=size
            keep=False
        objects[oid]=dict(kind=kind,bytes=size,sha256=content_hash.hexdigest(),raw=b''.join(parts) if keep else None)
    expected_pack_hash=reader.sha.digest();need(reader.take(20,False)==expected_pack_hash,'pack checksum differs');need(not reader.peek(),'trailing pack bytes')
    need(set(objects)==set(object_ids),'actual pack object ID universe differs')
    locked=objects.get(commit);need(locked and locked['kind']==1,'locked commit original absent')
    first=locked['raw'].split(b'\n',1)[0];need(re.fullmatch(b'tree [a-f0-9]{40}',first),'commit root tree header required');root=first[5:].decode()
    reached={commit};files={};listing=[];trees=set();actual_links={}
    def walk(oid,prefix='',depth=0,ancestors=frozenset()):
        check();need(depth<=120 and oid not in ancestors,'tree cycle/depth bound');tree=objects.get(oid);need(tree and tree['kind']==2,'referenced tree original absent');reached.add(oid);trees.add(oid)
        data=tree['raw'];at=0;names=set()
        while at<len(data):
            space=data.find(b' ',at);zero=data.find(b'\0',space+1);need(space>at and zero>space+1 and zero+21<=len(data),'raw tree entry encoding')
            mode=data[at:space];name=data[space+1:zero].decode('utf-8');target=data[zero+1:zero+21].hex();at=zero+21
            need('/' not in name and canonical(name) and name not in names,'canonical unique raw tree name');names.add(name);relative=prefix+name
            need(mode in (b'40000',b'100644',b'100755',b'120000') or gitlinks is not None and mode==b'160000','gitlink/unsupported Git mode forbidden')
            typename='tree' if mode==b'40000' else ('commit' if mode==b'160000' else 'blob');formatted=b'040000' if typename=='tree' else mode
            listing.append(formatted+b' '+typename.encode()+b' '+target.encode()+b'\t'+relative.encode()+b'\0')
            if typename=='tree':walk(target,relative+'/',depth+1,ancestors|{oid})
            elif typename=='commit':actual_links[relative]=target
            else:
                blob=objects.get(target);need(blob and blob['kind']==3,'referenced blob original absent');reached.add(target)
                files[relative]=dict(path=relative,mode=mode.decode(),blobOid=target,bytes=blob['bytes'],sha256=blob['sha256'])
                if mode==b'120000':
                    need(isinstance(blob['raw'],bytes),'actual readlink preimage bytes unavailable')
                    files[relative]['readlinkBase64']=base64.b64encode(blob['raw']).decode()
    walk(root)
    need(reached==set(objects),'pack contains unrelated objects or missing closure')
    need(actual_links==expected_links,'parent raw tree Gitlink path/OID universe differs')
    need(b''.join(listing)==tree_listing,'actual raw ls-tree listing differs from commit/tree objects')
    need(set(files)==set(expected),'prepatch path universe differs from locked tree')
    for name,row in files.items():need(all(expected[name].get(key)==value for key,value in row.items()),'prepatch bytes/mode/blob/readlink differs: '+name)
    result=dict(verified=True,scope='locked Git commit/tree/blob and prepatch byte closure only; patch/origin authority separate',commit=commit,commitBytes=locked['bytes'],commitSha256=locked['sha256'],rootTreeOid=root,objects=len(objects),files=len(files),packBytes=reader.total,packSha256=reader.full.hexdigest(),expandedBytes=expanded)

    if gitlinks is not None:result['gitlinks']=[dict(path=path,mode='160000',commitOid=oid) for path,oid in sorted(actual_links.items())]

    if retain_paths:
        need(set(retain_paths)<=set(files),'patch target absent from pinned tree')
        result['_prepatchRows']=files
        result['_retainedPreimages']={name:objects[files[name]['blobOid']]['raw'] for name in retain_paths}
    return result

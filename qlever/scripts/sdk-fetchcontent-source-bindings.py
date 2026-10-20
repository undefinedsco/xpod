"""FetchContent source originals to physical inventory; no network or candidate code."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bindings=load('sdk-git-source-bindings');archive_guard=load('sdk-debian-binary-originals')
LIMITS=bindings.LIMITS
need=bindings.need

def physical_rows(index,shards):
    need(index.get('schemaVersion')==1 and type(index.get('files')) is int and type(index.get('bytes')) is int,'physical inventory schema')
    rows={};total=0
    for shard in shards:
        need(shard.get('schemaVersion')==1 and isinstance(shard.get('files'),list),'physical shard schema')
        for row in shard['files']:
            name=row.get('path');need(bindings.canonical(name) and name not in rows,'physical path unique canonical')
            need(row.get('kind') in ('file','symlink') and type(row.get('bytes')) is int and 0<=row['bytes']<=LIMITS['shardBytes'] and type(row.get('mode')) is int and 0<=row['mode']<=0o7777,'physical row type/bound')
            need(isinstance(row.get('sha256'),str) and len(row['sha256'])==64,'physical digest required')
            rows[name]=row;total+=row['bytes'];need(len(rows)<=LIMITS['sourceMembers'] and total<=LIMITS['sourceMaterialBytes'],'physical aggregate bound')
    need(len(rows)==index['files'] and total==index['bytes'],'physical inventory totals differ');return rows

def verify_git(original,declaration,rows,small,member,check,empty_directories=None):
    need(original.get('schemaVersion')==1 and original.get('kind')=='qlever-sdk-dependency-git-originals' and original.get('repository')==declaration.get('repository') and original.get('commit')==declaration.get('commit') and original.get('objectFormat')=='sha1' and original.get('objectIdsFormat')=='ascii-sorted-unique-sha1-lf','declared Git originals differ')
    inventory=json.loads(small(original['prepatchInventory']));need(inventory.get('schemaVersion')==1 and isinstance(inventory.get('files'),list),'Git preimage schema')
    links=inventory.get('gitlinks')
    if links is not None:
        need(isinstance(links,list) and len(links)<=LIMITS['sourceMembers'],'bounded Gitlink collection')
        need(isinstance(empty_directories,list) and len(empty_directories)<=LIMITS['sourceMembers'],'actual empty directory inventory required')
        empty={}
        for item in empty_directories:
            identity=item.get('identityDecimal');need(bindings.canonical(item.get('path')) and item['path'] not in empty and isinstance(identity,list) and len(identity)==6 and all(isinstance(value,str) and value.isdecimal() for value in identity),'canonical unique empty directory identity')
            empty[item['path']]=identity
        for link in links:
            path=link.get('path');need(bindings.canonical(path) and link.get('state')=='unmaterialized-empty-directory' and empty.get(path)==link.get('identityDecimal'),'Gitlink actual empty checkout identity differs')
            need(not any(name==path or name.startswith(path+'/') for name in rows),'Gitlink source materialized without child source originals')
    ids_raw=small(original['objectIds']);ids=ids_raw.decode('ascii').splitlines();need(ids_raw==('\n'.join(sorted(set(ids)))+'\n').encode(),'exact sorted object IDs')
    commit=small(original['commitOriginal']);need(hashlib.sha1(('commit '+str(len(commit))+'\0').encode()+commit).hexdigest()==declaration['commit'],'declared commit original differs')
    with member(original['objectPack']) as stream:result=bindings.verify_git_originals(stream,declaration['commit'],small(original['treeListing']),ids,inventory['files'],check,gitlinks=links)
    need(result['rootTreeOid']==original.get('rootTree') and result['commitSha256']==hashlib.sha256(commit).hexdigest() and result['packBytes']==original['objectPack']['bytes'] and result['packSha256']==original['objectPack']['sha256'],'registered Git root/pack differs')
    actual={path:row for path,row in rows.items() if path!='.git' and not path.startswith('.git/')};expected={row['path']:row for row in inventory['files']}
    need(set(actual)==set(expected),'physical non-Git-metadata universe differs from commit tree')
    for path,row in expected.items():
        check();physical=actual[path];mode=row['mode'];kind='symlink' if mode=='120000' else 'file';permissions=0o777 if kind=='symlink' else (0o755 if mode=='100755' else 0o644)
        need(physical['kind']==kind and physical['mode']==permissions and physical['bytes']==row['bytes'] and physical['sha256']==row['sha256'],'physical Git blob bytes/mode differ: '+path)
        if kind=='symlink':need(base64.b64decode(row['readlinkBase64'],validate=True)==physical.get('target','').encode(),'physical Git readlink differs')
    return dict(files=len(actual),gitMetadataFiles=len(rows)-len(actual),unmaterializedGitlinks=result.get('gitlinks',[]),scope='declared Git commit/tree/blob bytes to non-.git physical files; independent repository authority and mutable .git metadata excluded')

def verify_url(original,declaration,rows,member,check):
    need(original.get('schemaVersion')==1 and original.get('kind')=='qlever-sdk-dependency-archive-originals' and all(original.get(key)==declaration.get(key) for key in ('url','algorithm','digest')) and declaration.get('algorithm')=='sha3_224','declared URL hash originals differ')
    archive=original['archive'];need(archive['bytes']<=LIMITS['shardBytes'],'archive member bound');seen={};members=set();root=None;digest=hashlib.new(declaration['algorithm'])
    # Read authenticated packed bytes once for the independent immutable declaration digest.
    with member(archive) as stream:
        for block in iter(lambda:stream.read(LIMITS['rangeBytes']),b''):check();digest.update(block)
    need(digest.hexdigest()==declaration['digest'],'immutable URL digest differs')
    with member(archive) as stream:
        decoded=archive_guard.BoundedReader(archive_guard.codec(stream,archive['path']),LIMITS['sourceMaterialBytes'],check);guarded=archive_guard.TarHeaderGuard(decoded,dict(bytes=0,members=0),check)
        with tarfile.open(fileobj=guarded,mode='r|',bufsize=LIMITS['rangeBytes']) as tar:
            for item in tar:
                check();name=item.name.removeprefix('./').rstrip('/');need(bindings.canonical(name) and '.git' not in name.split('/'),'canonical URL archive path')
                need(name not in members,'unique URL archive member');members.add(name);need(len(members)<=LIMITS['sourceMembers'],'archive member bound');parts=name.split('/');root=root or parts[0];need(parts[0]==root,'single-root archive required')
                if len(parts)==1:need(item.isdir(),'archive root directory required');continue
                path='/'.join(parts[1:]);need(path not in seen,'duplicate URL path')
                if item.isdir():continue
                need(item.isfile() and item.size<=LIMITS['shardBytes'],'regular bounded URL files only');sha=hashlib.sha256();count=0
                with tar.extractfile(item) as content:
                    for block in iter(lambda:content.read(LIMITS['rangeBytes']),b''):check();count+=len(block);need(count<=item.size,'URL member growth');sha.update(block)
                need(count==item.size,'URL member truncated');seen[path]=dict(kind='file',mode=item.mode&0o777,bytes=count,sha256=sha.hexdigest());need(len(seen)<=LIMITS['sourceMembers'],'URL member count bound')
        while guarded.read(LIMITS['rangeBytes']):check()
    need(set(rows)==set(seen),'physical URL path universe differs')
    for path,row in seen.items():need(all(rows[path].get(key)==value for key,value in row.items()),'physical URL file differs: '+path)
    return dict(files=len(seen),scope='immutable declared URL archive digest and all unpacked regular file bytes/modes only; HTTPS repository authority separate')

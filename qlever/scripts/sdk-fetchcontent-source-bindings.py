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
NOTICE=__import__('re').compile(r'^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$',__import__('re').I)

def selected_contract(paths):
    need(isinstance(paths,(list,tuple)) and len(paths)<=LIMITS['sourceMembers'],'bounded selected paths')
    clean=[]
    for name in paths:
        need(bindings.canonical(name) and '.git' not in name.split('/') and name not in clean,'canonical unique selected source required');clean.append(name)
    return clean

def ancestor_notices(selected,rows,check):
    by_directory={};found=set()
    for candidate in rows:
        check();parent=candidate.rsplit('/',1)[0] if '/' in candidate else ''
        if NOTICE.fullmatch(candidate.rsplit('/',1)[-1]):by_directory.setdefault(parent,[]).append(candidate)
    for name in selected:
        directory=name.rsplit('/',1)[0] if '/' in name else ''
        while True:
            check();found.update(by_directory.get(directory,()))
            if not directory:break
            directory=directory.rsplit('/',1)[0] if '/' in directory else ''
    return sorted(found)

def reserve_selection(paths,rows,budget,check):
    # Reserve the complete selected raw/encoded universe before PACK retention
    # or tar extraction; recursive dependencies share this same accumulator.
    for name in paths:
        check();row=rows.get(name)
        need(row is not None and type(row.get('bytes')) is int and row['bytes']>=0,'selected actual member required')
        need((row.get('mode') in ('100644','100755') or (row.get('kind')=='file' and type(row.get('mode')) is int and 0<=row['mode']<=0o777)),'selected regular source required')
        budget['retained']=budget.get('retained',0)+row['bytes']
        budget['planned']=budget.get('planned',0)+4*((row['bytes']+2)//3)+len(name.encode())+256
        need(budget['retained']<=LIMITS['metadataBytes'] and budget['planned']<=LIMITS['metadataBytes'],'selected retained source bound')

def selected_rows(paths,requested,payloads,modes,budget,prefix=''):
    rows=[]
    for name in paths:
        need(name in payloads and name in modes and (modes[name] in ('100644','100755') or (type(modes[name]) is int and 0<=modes[name]<=0o777)),'selected regular actual source required')
        mode=modes[name];mode=(int(mode,8)&0o777) if isinstance(mode,str) else mode
        data=payloads[name];sha=hashlib.sha256(data).hexdigest();encoded=len(base64.b64encode(data))
        budget['bytes']+=len(data);budget['encoded']+=encoded+len(name)+64
        need(budget['bytes']<=LIMITS['metadataBytes'] and budget['encoded']<=LIMITS['metadataBytes'],'selected source metadata bound')
        rows.append(dict(path=prefix+name,mode=mode,bytes=len(data),sha256=sha,base64=base64.b64encode(data).decode(),requested=name in requested))
    return rows

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

def verify_git(original,declaration,rows,small,member,check,empty_directories=None,_ancestors=(),_count=None,selected_paths=(),_budget=None):
    key=(declaration.get("repository"),declaration.get("commit"))
    need(len(_ancestors)<16 and key not in _ancestors,"recursive Gitlink depth/cycle")
    if _count is None:_count=[0]
    _count[0]+=1;need(_count[0]<=LIMITS["sourceMembers"],"recursive Gitlink count bound")
    need(original.get('schemaVersion')==1 and original.get('kind')=='qlever-sdk-dependency-git-originals' and original.get('repository')==declaration.get('repository') and original.get('commit')==declaration.get('commit') and original.get('objectFormat')=='sha1' and original.get('objectIdsFormat')=='ascii-sorted-unique-sha1-lf','declared Git originals differ')
    inventory=json.loads(small(original['prepatchInventory']));need(inventory.get('schemaVersion')==1 and isinstance(inventory.get('files'),list),'Git preimage schema')
    links=inventory.get('gitlinks')
    children=original.get('materializedGitlinks')
    if children is not None:need(isinstance(children,list) and len(children)<=LIMITS['sourceMembers'],'bounded materialized Gitlinks')
    if links is not None and children is None:
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
    requested=selected_contract(selected_paths);budget={'bytes':0,'encoded':0} if _budget is None else _budget
    earlier_rows={row['path']:row for row in inventory['files']}
    child_prefixes=tuple(row.get('path','')+'/' for row in (children or []))
    notices=tuple(name for name in ancestor_notices(requested,earlier_rows,check) if name not in requested)
    retained=tuple(dict.fromkeys((('.gitmodules',) if links and children is not None else ())+tuple(name for name in requested if not name.startswith(child_prefixes))+notices))
    reserve_selection([name for name in retained if name!='.gitmodules' or name in requested or name in notices],earlier_rows,budget,check)
    with member(original['objectPack']) as stream:result=bindings.verify_git_originals(stream,declaration['commit'],small(original['treeListing']),ids,inventory['files'],check,gitlinks=links,retain_paths=retained)
    need(result['rootTreeOid']==original.get('rootTree') and result['commitSha256']==hashlib.sha256(commit).hexdigest() and result['packBytes']==original['objectPack']['bytes'] and result['packSha256']==original['objectPack']['sha256'],'registered Git root/pack differs')
    child_paths=set();child_files=0;child_metadata=0;unmaterialized=result.get('gitlinks',[]);nested_selected=[]
    if children is not None:
        expected_links={row['path']:row for row in (links or [])}
        need(len(children)==len(expected_links) and {row.get('path') for row in children}==set(expected_links),'complete unique child Gitlink originals')
        repositories=bindings.gitlink_repositories(result['_retainedPreimages']['.gitmodules'],links) if links else {}
        unmaterialized=[]
        for child in children:
            check();path=child['path'];link=expected_links[path]
            need(set(child)=={'path','repository','commit','original'} and child['repository']==repositories[path] and child['commit']==link['commitOid'],'child Gitlink repository/commit binding')
            subset={name[len(path)+1:]:row for name,row in rows.items() if name.startswith(path+'/')}
            need(subset and path not in rows,'materialized child physical universe required')
            child_paths.update(name for name in rows if name.startswith(path+'/'))
            nested=json.loads(small(child['original']))
            need(nested.get('sourceRoot')==original.get('sourceRoot','')+'/'+path,'child original actual source root differs')
            empties=[dict(item,path=item['path'][len(path)+1:]) for item in (empty_directories or []) if item['path'].startswith(path+'/')]
            proof=verify_git(nested,child,subset,small,member,check,empties,(*_ancestors,key),_count,selected_paths=[name[len(path)+1:] for name in requested if name.startswith(path+'/')],_budget=budget)
            child_files+=proof['files'];child_metadata+=proof['gitMetadataFiles'];nested_selected.extend(dict(item,path=path+'/'+item['path']) for item in proof.get('selectedOriginals',[]))
            unmaterialized.extend(dict(item,path=path+'/'+item['path']) for item in proof['unmaterializedGitlinks'])
    actual={path:row for path,row in rows.items() if path not in child_paths and path!='.git' and not path.startswith('.git/')};expected={row['path']:row for row in inventory['files']}
    need(set(actual)==set(expected),'physical non-Git-metadata universe differs from commit tree')
    for path,row in expected.items():
        check();physical=actual[path];mode=row['mode'];kind='symlink' if mode=='120000' else 'file';permissions=0o777 if kind=='symlink' else (0o755 if mode=='100755' else 0o644)
        need(physical['kind']==kind and physical['mode']==permissions and physical['bytes']==row['bytes'] and physical['sha256']==row['sha256'],'physical Git blob bytes/mode differ: '+path)
        if kind=='symlink':need(base64.b64decode(row['readlinkBase64'],validate=True)==physical.get('target','').encode(),'physical Git readlink differs')
    report=dict(files=len(actual)+child_files,gitMetadataFiles=len(rows)-len(actual)-len(child_paths)+child_metadata,unmaterializedGitlinks=unmaterialized,scope='declared Git commit/tree/blob bytes to non-.git physical files; independent repository authority and mutable .git metadata excluded')
    if requested:
        local=[name for name in requested if not name.startswith(child_prefixes)]
        chosen=local+list(notices)
        payloads={name:result['_retainedPreimages'][name] for name in chosen}
        modes={name:actual[name]['mode'] for name in chosen}
        rows_out=selected_rows(chosen,set(requested),payloads,modes,budget)
        # Nested child selected responses already hold child-relative paths;
        # prefix exactly once here, at recursion return.
        rows_out.extend(nested_selected)
        need(set(requested)<={row['path'] for row in rows_out},'requested nested source absent')
        need(len({row['path'] for row in rows_out})==len(rows_out),'selected source path duplicate')
        report['selectedOriginals']=rows_out
    return report

def verify_url(original,declaration,rows,member,check,selected_paths=(),_budget=None):
    need(original.get('schemaVersion')==1 and original.get('kind')=='qlever-sdk-dependency-archive-originals' and all(original.get(key)==declaration.get(key) for key in ('url','algorithm','digest')) and declaration.get('algorithm')=='sha3_224','declared URL hash originals differ')
    requested=selected_contract(selected_paths);budget={'bytes':0,'encoded':0} if _budget is None else _budget
    retained={};archive=original['archive'];need(archive['bytes']<=LIMITS['shardBytes'],'archive member bound');seen={};members=set();root=None;digest=hashlib.new(declaration['algorithm'])
    retain=set(requested)|set(ancestor_notices(requested,rows,check))
    reserve_selection(sorted(retain),rows,budget,check)
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
                need(item.sparse is None and not any(key.startswith('GNU.sparse') for key in item.pax_headers),'sparse URL member rejected')
                need(item.isfile() and item.size<=LIMITS['shardBytes'],'regular bounded URL files only');sha=hashlib.sha256();count=0;parts=[]
                keep=path in retain
                need(not keep or item.size==rows[path]['bytes'],'selected retained URL size differs')
                with tar.extractfile(item) as content:
                    for block in iter(lambda:content.read(LIMITS['rangeBytes']),b''):
                        check();count+=len(block);need(count<=item.size,'URL member growth');sha.update(block)
                        if keep:parts.append(block)
                need(count==item.size,'URL member truncated');seen[path]=dict(kind='file',mode=item.mode&0o777,bytes=count,sha256=sha.hexdigest());need(len(seen)<=LIMITS['sourceMembers'],'URL member count bound')
                if keep:retained[path]=b''.join(parts)
        while guarded.read(LIMITS['rangeBytes']):check()
    need(set(rows)==set(seen),'physical URL path universe differs')
    for path,row in seen.items():need(all(rows[path].get(key)==value for key,value in row.items()),'physical URL file differs: '+path)
    report=dict(files=len(seen),scope='immutable declared URL archive digest and all unpacked regular file bytes/modes only; HTTPS repository authority separate')
    if requested:
        chosen=list(requested)+sorted(name for name in retain-{*requested} if NOTICE.fullmatch(name.rsplit('/',1)[-1]))
        need(set(chosen)<=set(retained) and all(seen[name]['kind']=='file' for name in chosen),'selected regular actual URL source required')
        report['selectedOriginals']=selected_rows(chosen,set(requested),retained,{name:seen[name]['mode'] for name in chosen},budget)
    return report

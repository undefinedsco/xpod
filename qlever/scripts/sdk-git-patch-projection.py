"""Reviewed text patch projection using only the controller Git, never candidate code."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time

LIMITS=json.loads((Path(__file__).resolve().parents[2]/'scripts/lib/module-artifact-limits.json').read_text())

def patch_targets(raw):
    """The actual reviewed recipe's Git/unified headers, with hunk-aware parsing.
    Ordinary ---/+++ files and their tab-separated timestamps are supported.
    File creation/deletion/rename/binary/mode changes remain out of scope.
    """
    def need(value,reason):
        if not value:raise ValueError('SDK reviewed patch headers: '+reason)
    need(isinstance(raw,bytes) and raw.endswith(b'\n') and len(raw)<=LIMITS['metadataBytes'],'bounded complete patch original required')
    def name(value,prefix):
        parts=value.split(b'\t',1);path=parts[0]
        if len(parts)==2:need(re.fullmatch(rb'[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?: [+-][0-9]{4})?',parts[1]),'unsupported header timestamp')
        need(path.startswith(prefix) and not any(byte<=32 or byte==127 or byte in (34,92) for byte in path),'canonical unquoted header path required')
        text=path[len(prefix):].decode('utf-8');need(text and all(part not in ('','.','..') and part.lower()!='.git' for part in text.split('/')),'unsafe patch path')
        return text
    targets=[];git_pair=None;old=None;current=None;old_left=new_left=0;hunks=0;previous_hunk=False
    for line in raw.split(b'\n')[:-1]:
        if old_left or new_left:
            if line==b'\\ No newline at end of file':continue
            if line==b'':line=b' '  # Git accepts an unprefixed empty context line.
            need(line[:1] in (b' ',b'-',b'+'),'invalid unified hunk data')
            if line[:1]!=b'+':old_left-=1
            if line[:1]!=b'-':new_left-=1
            need(old_left>=0 and new_left>=0,'unified hunk counts differ');previous_hunk=True;continue
        if line==b'\\ No newline at end of file':need(previous_hunk,'unexpected no-newline marker');continue
        if line.startswith(b'@@ '):
            need(current is not None and old is None,'hunk without paired file headers')
            match=re.fullmatch(rb'@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@(?: .*)?',line)
            need(match,'unsupported unified hunk header');old_left=int(match[1] or b'1');new_left=int(match[2] or b'1');need(old_left+new_left>0,'empty unified hunk');hunks+=1;previous_hunk=True;continue
        if line.startswith(b'diff --git '):
            need(old is None and git_pair is None and (current is None or hunks>0),'unclosed previous file header')
            match=re.fullmatch(rb'diff --git (a/[^ ]+) (b/[^ ]+)',line);need(match,'quoted/unsafe Git diff header')
            git_pair=(name(match[1],b'a/'),name(match[2],b'b/'));need(git_pair[0]==git_pair[1],'renamed patch target unsupported');current=None;hunks=0;previous_hunk=False;continue
        if line.startswith(b'index '):need(git_pair is not None and old is None and re.fullmatch(rb'index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?',line),'unsupported index/mode header');continue
        if line.startswith(b'--- '):
            need(old is None and (current is None or hunks>0),'unclosed file patch');old=name(line[4:],b'a/');current=None;hunks=0;previous_hunk=False;continue
        if line.startswith(b'+++ '):
            need(old is not None,'new file header without old header');new=name(line[4:],b'b/');need(old==new and (git_pair is None or git_pair==(old,new)),'old/new patch target mismatch')
            need(new not in targets,'duplicate file patch header');targets.append(new);current=new;old=None;git_pair=None;continue
        need((not line or line.startswith(b' ')) and current is not None and hunks>0,'unsupported patch operation/header')
    need(targets and not old_left and not new_left and old is None and git_pair is None and hunks>0,'incomplete file patch/hunk')
    return targets

def project(preimages,pre_rows,patches,post,git,deadline,check,selected_paths=None):
    def need(value,reason):
        if not value:raise ValueError('SDK reviewed patch projection: '+reason)
    targets=set()
    for patch in patches:
        for name in patch_targets(patch['bytes']):
            need(name in preimages and pre_rows[name]['mode'] in ('100644','100755'),'actual regular pinned patch preimage required');targets.add(name)
    requested=[] if selected_paths is None else list(selected_paths)
    need(len(requested)<=LIMITS['sourceMembers'] and len(set(requested))==len(requested),'bounded unique selected paths required')
    for name in requested:
        need(isinstance(name,str) and name and not name.startswith('/') and '\\' not in name and all(part not in ('','.','..') for part in name.split('/')),'canonical selected path required')
        need(name in preimages and pre_rows.get(name,{}).get('mode') in ('100644','100755'),'regular retained selected source required')
    need(post.get('schemaVersion')==1 and isinstance(post.get('files'),list) and post.get('addedPaths')==[] and post.get('deletedPaths')==[],'exact unchanged path set required by current reviewed patch recipe')
    actual={row['path']:row for row in post['files']};need(len(actual)==len(post['files']) and set(actual)==set(pre_rows),'postpatch full path set differs')
    for name in requested:need(name in actual and actual[name].get('mode') in ('100644','100755'),'regular selected postpatch file required')
    need(shutil.disk_usage(tempfile.gettempdir()).free-sum(len(value) for value in preimages.values())>=LIMITS['freeFloorBytes'],'controller patch workspace disk floor')
    with tempfile.TemporaryDirectory(prefix='sdk-reviewed-patch-') as folder:
        root=Path(folder)
        for name in sorted(targets):
            check();file=root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(preimages[name]);file.chmod(int(pre_rows[name]['mode'],8)&0o7777)
        for patch in patches:
            check();remaining=deadline-time.monotonic();need(remaining>0,'shared patch deadline exhausted')
            env=dict(PATH='/usr/bin:/bin',HOME=folder,LANG='C.UTF-8',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_SYSTEM='/dev/null',GIT_ATTR_NOSYSTEM='1',GIT_CEILING_DIRECTORIES=str(root.parent))
            argv=[git,'-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','apply','--whitespace=nowarn','-']
            # Git apply is a fixed data transform; no candidate build/apply script,
            # repository config, filters, hooks or executable source is invoked.
            result=subprocess.run(argv,cwd=root,input=patch['bytes'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=remaining)
            need(result.returncode==0 and len(result.stdout)+len(result.stderr)<=LIMITS['metadataBytes'],'exact reviewed patch application failed')
        actual_paths={str(file.relative_to(root)) for file in root.rglob('*') if not file.is_dir() or file.is_symlink()}
        need(actual_paths==targets,'reviewed transform created/deleted unregistered workspace path')
        for name,prior in pre_rows.items():
            check();expected=dict(prior)
            if name in targets:
                file=root/name;info=file.lstat();need(stat.S_ISREG(info.st_mode),'patch transform produced nonregular file')
                need(info.st_size<=LIMITS['metadataBytes'],'bounded patched file required');raw=file.read_bytes();need(len(raw)<=LIMITS['metadataBytes'],'bounded patched file required')
                expected.update(blobOid=hashlib.sha1(('blob '+str(len(raw))+'\0').encode()+raw).hexdigest(),mode=format(stat.S_IMODE(info.st_mode)|stat.S_IFREG,'06o'),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
            need(all(actual[name].get(key)==value for key,value in expected.items()),'postpatch projection bytes/mode differ: '+name)
        # Selection reads happen only after every complete-path/byte check passed.
        selected=[];total=0
        for name in requested:
            check();row=actual[name]
            if name in targets:
                file=root/name;info=file.lstat();need(stat.S_ISREG(info.st_mode),'selected output is nonregular')
                need(info.st_size<=LIMITS['metadataBytes'],'bounded selected output required');raw=file.read_bytes()
            else:
                raw=preimages[name]
            need(len(raw)==row['bytes'] and hashlib.sha256(raw).hexdigest()==row['sha256'],'selected actual bytes differ from verified postpatch row')
            total+=len(raw);need(total<=LIMITS['metadataBytes'],'cumulative selected original bytes bound')
            selected.append(dict(path=name,mode=0o755 if row['mode']=='100755' else 0o644,bytes=len(raw),sha256=row['sha256'],base64=base64.b64encode(raw).decode('ascii')))
    result=dict(verified=True,patchedPaths=sorted(targets),addedPaths=[],deletedPaths=[],scope='immutable reviewed current text series applied exactly once to pinned Git preimages')
    if requested:
        need(len(json.dumps(selected,separators=(',',':')).encode())<=LIMITS['metadataBytes'],'selected originals JSON/base64 metadata bound')
        result['selectedOriginals']=selected
    return result

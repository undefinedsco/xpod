"""Fixed SDK ZIP Git-object reader; never extracts or executes candidate members."""
import base64
import hashlib
import re
import importlib.util
import json
from pathlib import Path
import sys
import time

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
zip_originals=load('sdk-zip-originals');bindings=load('sdk-git-source-bindings');projection=load('sdk-git-patch-projection');LIMITS=zip_originals.LIMITS

def observe(archive_path,plan):
    remaining=plan['remainingMilliseconds'];bindings.need(isinstance(remaining,(int,float)) and 0<remaining<=LIMITS['timeoutMs'],'bounded remaining Git observation window required')
    deadline=time.monotonic()+remaining/1000
    def check():bindings.need(time.monotonic()<deadline,'Git source observation deadline')
    with zip_originals.registered_zip_originals(archive_path,'inner/upstream-source/',check) as member:
        def small(ref):
            bindings.need(ref['bytes']<=LIMITS['metadataBytes'],'bounded Git metadata original required')
            with member(ref) as stream:raw=stream.read(LIMITS['metadataBytes']+1)
            bindings.need(len(raw)==ref['bytes'] and hashlib.sha256(raw).hexdigest()==ref['sha256'],'Git metadata original bytes differ');return raw
        listing=small(plan['treeListing']);ids_raw=small(plan['objectIds']);ids=ids_raw.decode('ascii').splitlines();inventory=json.loads(small(plan['prepatchInventory']))
        bindings.need(ids_raw==('\n'.join(sorted(set(ids)))+'\n').encode(),'sorted unique ASCII SHA1 objectIds with LF required')
        bindings.need(inventory.get('schemaVersion')==1 and isinstance(inventory.get('files'),list),'prepatch inventory schema required')
        commit_raw=small(plan['commitOriginal'])
        bindings.need(hashlib.sha1(('commit '+str(len(commit_raw))+'\0').encode()+commit_raw).hexdigest()==plan['commit'],'actual locked commit original differs')
        patches=[];targets=set()
        for item in plan['reviewedPatches']:
            raw=base64.b64decode(item['base64'],validate=True);bindings.need(small(item['file'])==raw,'actual patch differs from immutable reviewed bytes')
            patches.append(dict(name=item['name'],bytes=raw))
            targets.update(projection.patch_targets(raw))
        bindings.need(small(plan['patchSeries'])==base64.b64decode(plan['reviewedSeriesBase64'],validate=True),'actual patch series original differs')
        with member(plan['objectPack']) as stream:result=bindings.verify_git_originals(stream,plan['commit'],listing,ids,inventory['files'],check,targets)
        post=json.loads(small(plan['postpatchInventory']));post.update(addedPaths=plan['addedPaths'],deletedPaths=plan['deletedPaths'])
        result['patchProjection']=projection.project(result.pop('_retainedPreimages'),result.pop('_prepatchRows'),patches,post,plan['gitExecutable'],deadline,check)

        bindings.need(result['rootTreeOid']==plan['rootTree'] and result['commitBytes']==len(commit_raw) and result['commitSha256']==hashlib.sha256(commit_raw).hexdigest(),'commit/root-tree originals differ from pack')
        bindings.need(result['packBytes']==plan['objectPack']['bytes'] and result['packSha256']==plan['objectPack']['sha256'],'registered whole Git pack original differs')
    return result

if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Fixed SDK ZIP path required')
    raw=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);bindings.need(len(raw)<=LIMITS['metadataBytes'],'bounded Git observer plan required')
    print(json.dumps(observe(sys.argv[1],json.loads(raw)),separators=(',',':')))

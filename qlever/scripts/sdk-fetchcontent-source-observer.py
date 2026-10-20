"""Same retained SDK ZIP FetchContent scanner. No extraction or candidate execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
zip_originals=load('sdk-zip-originals');sources=load('sdk-fetchcontent-source-bindings');shared=load('sdk-generation-multiprocess-bindings');LIMITS=sources.LIMITS

def rooted_metadata_references(value):
    """Project producer-relative metadata refs; physical inventory rows stay untouched."""
    if isinstance(value,list):return [rooted_metadata_references(item) for item in value]
    if not isinstance(value,dict):return value
    if {'path','bytes','sha256'}<=value.keys():
        path=value['path'];sources.need(isinstance(path,str) and path.startswith('fetchcontent/') and all(part not in ('','.', '..') for part in path.split('/')) and '\\' not in path,'canonical producer-relative FetchContent reference required')
        return dict(value,path='inner/'+path)
    return {key:rooted_metadata_references(item) for key,item in value.items()}

def observe(path,plan):
    remaining=plan['remainingMilliseconds'];sources.need(type(remaining) in (int,float) and 0<remaining<=LIMITS['timeoutMs'],'bounded remaining window');deadline=time.monotonic()+remaining/1000;charged=0
    def check():sources.need(time.monotonic()<deadline,'FetchContent source shared deadline')
    with zip_originals.registered_zip_originals(path,'inner/fetchcontent/',check) as raw_member:
        import contextlib
        @contextlib.contextmanager
        def member(ref):
            nonlocal charged
            sources.need(type(ref.get('bytes')) is int and 0<=ref['bytes']<=LIMITS['shardBytes'],'bounded original reference');charged+=ref['bytes'];sources.need(charged<=LIMITS['sourceMaterialBytes'],'source scan actual read aggregate')
            with raw_member(ref) as stream:
                class Reader:
                    def __init__(self):self.count=0;self.hash=hashlib.sha256()
                    def read(self,size):
                        check();sources.need(type(size) is int and 0<=size<=LIMITS['rangeBytes'],'range bounded original read');data=stream.read(size);self.count+=len(data);sources.need(self.count<=ref['bytes'],'original grew');self.hash.update(data);return data
                reader=Reader();yield reader
                sources.need(reader.read(1)==b'' and reader.count==ref['bytes'] and reader.hash.hexdigest()==ref['sha256'],'complete registered original fullSHA differs')
        def small(ref):
            sources.need(ref['bytes']<=LIMITS['metadataBytes'],'bounded source metadata');parts=[]
            with member(ref) as stream:
                for block in iter(lambda:stream.read(LIMITS['rangeBytes']),b''):parts.append(block)
            return b''.join(parts)
        collection=rooted_metadata_references(json.loads(small(plan['collection'])));sources.need(collection.get('schemaVersion')==1 and collection.get('kind')=='qlever-sdk-fetchcontent-prepared-originals' and collection.get('sourceRoot')=='/opt/qlever-sdk/source' and collection.get('dependenciesRoot')=='/opt/qlever-sdk/dependencies','fixed collection roots')
        declaration=small(collection['declarationSource']['file']);sources.need(hashlib.sha256(declaration).hexdigest()==plan['declarationSha256'],'actual source declaration binding differs')
        records=plan['inputRecords'];sources.need(isinstance(records,list) and len(records)<=LIMITS['sourceMembers'],'bounded actual dependency input records');selected_paths=set();joined=set();unresolved=[];read_captures=0;origin_unresolved=set()
        for item in records:
            name=item.get('path');sources.need(isinstance(name,str) and name.startswith('/opt/qlever-sdk/dependencies/') and name not in selected_paths,'unique actual dependency path');selected_paths.add(name)
            sources.need(sources.bindings.canonical(name.removeprefix('/opt/qlever-sdk/dependencies/')) and type(item.get('bytes')) is int and 0<=item['bytes']<=LIMITS['shardBytes'] and type(item.get('mode')) is int and 0<=item['mode']<=0o7777,'canonical bounded dependency input data');sources.need(type(item.get('selected')) is bool and type(item.get('captures')) is int and item['captures']>=0 and (item['selected'] or item['captures']>0),'actual selected/captured dependency role required');read_captures+=item['captures']
        observed=plan.get('dependencySourceReadOriginals')
        if read_captures:
            seal=plan['sourceReferenceSeal'];sources.need(seal['collection']==plan['collection'] and seal['declaration']==collection['declarationSource']['file'] and seal['cache']==collection['cmakeCache'],'actual dependency read metadata seal differs');expected={key:dict(bytes=seal[key]['bytes'],sha256=seal[key]['sha256']) for key in ['prepared','collection','declaration','cache']}
            sources.need(observed==expected,'actual dependency read registration differs from private source originals')
        declarations=shared.parse_fetchcontent_declarations(declaration.decode());dependencies=collection['dependencies'];sources.need([row['declaration'] for row in dependencies]==declarations,'complete actual declaration universe differs');results=[]
        sources.need(collection.get('cmakeCachePath')=='/opt/qlever-sdk/dependencies/sources.cmake','fixed generated CMake cache path required');cache=small(collection['cmakeCache']);sources.need(cache.decode()==shared.fetchcontent_source_bindings(dependencies),'actual CMake cache projection differs');cache_selected=0
        for item in records:
            if item['path']==collection['cmakeCachePath']:
                sources.need(type(item.get('bytes')) is int and item['bytes']==len(cache) and item.get('sha256')==hashlib.sha256(cache).hexdigest() and type(item.get('mode')) is int and item['mode']==0o644,'actual selected generated CMake cache bytes/mode differ');joined.add(item['path']);cache_selected+=int(item['selected'])
        for row in dependencies:
            check();sources.need(row['name']==row['declaration']['name'] and row['sourceRoot']=='/opt/qlever-sdk/dependencies/'+row['name'] and row['sourceOriginals']['kind']==row['declaration']['method'],'exact declared source identity')
            index=rooted_metadata_references(json.loads(small(row['sourceInventory'])));sources.need(isinstance(index.get('shards'),list) and len(index['shards'])<=LIMITS['sourceMaterialFiles'],'bounded physical shard set');physical=sources.physical_rows(index,(json.loads(small(ref)) for ref in index['shards']));original=rooted_metadata_references(json.loads(small(row['sourceOriginals']['file'])))
            for item in records:
                prefix=row['sourceRoot']+'/'
                if item['path'].startswith(prefix):
                    relative=item['path'][len(prefix):];expected=physical.get(relative);sources.need(expected and expected['kind']=='file' and all(item.get(key)==expected[key] for key in ('bytes','sha256','mode')),'actual selected shard file differs from prepared source');joined.add(item['path'])
                    if row['declaration']['method']=='git' and (relative=='.git' or relative.startswith('.git/')):
                        unresolved.append('qlever-sdk-FetchContent-selected-Git-metadata-source-unresolved:'+item['path'])
                        if item['captures']:origin_unresolved.add(item['path'])
            if row['declaration']['method']=='git':result=sources.verify_git(original,row['declaration'],physical,small,member,check,index.get('emptyDirectories'))
            else:result=sources.verify_url(original,row['declaration'],physical,member,check)
            for link in result.get('unmaterializedGitlinks',[]):
                unresolved.append('qlever-sdk-FetchContent-unmaterialized-Gitlink-source-unresolved:'+row['sourceRoot']+'/'+link['path']+'@'+link['commitOid'])
            results.append(dict(name=row['name'],method=row['declaration']['method'],**result))
    sources.need(joined==selected_paths,'actual selected dependency universe incomplete');check();return dict(selectedInputs=sum(item['selected'] for item in records),selectedGeneratedCacheInputs=cache_selected,observedDependencyReadCaptures=read_captures,dependencySourceReadOriginsVerified=not origin_unresolved,kind='qlever-sdk-FetchContent-source-byte-mechanics',dependencies=results,declaredSourceByteClosureVerified=True,overallSourceAuthorityVerified=False,pending=unresolved)

if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Fixed retained SDK ZIP path required')
    data=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);sources.need(len(data)<=LIMITS['metadataBytes'],'bounded source plan');print(json.dumps(observe(sys.argv[1],json.loads(data)),separators=(',',':')))

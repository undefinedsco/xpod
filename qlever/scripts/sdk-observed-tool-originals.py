"""Join retained tool descriptors to existing verified execution and input bytes.

Pure mechanics only. The controller supplies the existing private observations;
this helper never executes candidate code or issues source/toolchain authority.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

spec=importlib.util.spec_from_file_location('tool_zip',Path(__file__).with_name('sdk-zip-originals.py'))
zip_originals=importlib.util.module_from_spec(spec);spec.loader.exec_module(zip_originals)
raw_spec=importlib.util.spec_from_file_location('tool_raw_records',Path(__file__).with_name('sdk-execution-originals-util.py'))
raw_records=importlib.util.module_from_spec(raw_spec);raw_spec.loader.exec_module(raw_records)
bindings_spec=importlib.util.spec_from_file_location('tool_capture_bindings',Path(__file__).with_name('sdk-generation-multiprocess-bindings.py'))
bindings=importlib.util.module_from_spec(bindings_spec);bindings_spec.loader.exec_module(bindings)
LIMITS=zip_originals.LIMITS
need=zip_originals.need

def observe(archive_path,plan):
    remaining=plan['remainingMilliseconds'];need(type(remaining) in (int,float) and 0<remaining<=LIMITS['timeoutMs'],'shared tool observation deadline')
    end=time.monotonic()+remaining/1000
    def check():need(time.monotonic()<end,'shared tool observation deadline exhausted')
    phases=plan['phases'];need([phase['name'] for phase in phases]==['configure','compile'],'exact execution phase set')
    after={row['originalPath']:row for row in plan['verifiedRows']};need(len(after)==len(plan['verifiedRows'])<=LIMITS['sourceMembers'],'unique verified after rows')
    expected=plan['verifiedToolSnapshots'];need(len(expected)<=LIMITS['sourceMembers'],'bounded private tool snapshots')
    expected_by_name={Path(row['original']['path']).name:row for row in expected};need(len(expected_by_name)==len(expected),'unique private tool capture names')
    output=[];pending=[];seen=set();charged=set();total=0
    with zip_originals.registered_zip_originals(archive_path,'inner/toolchain-execution/',check) as member:
        def stream(ref):
            nonlocal total
            check();need(type(ref['bytes']) is int and 0<=ref['bytes']<=LIMITS['shardBytes'],'bounded original role')
            if ref['path'] not in charged:
                total+=ref['bytes'];charged.add(ref['path']);need(total<=LIMITS['sourceMaterialBytes'],'shared tool-original byte bound')
            digest=hashlib.sha256();count=0
            with member(ref) as source:
                while True:
                    check();block=source.read(LIMITS['rangeBytes'])
                    if not block:break
                    count+=len(block);need(count<=ref['bytes'],'original grew beyond registered bytes');digest.update(block);yield block
            need(count==ref['bytes'] and digest.hexdigest()==ref['sha256'],'whole tool original SHA/size differs')
        def small(ref):
            need(ref['bytes']<=LIMITS['metadataBytes'],'bounded tool metadata original')
            return json.loads(b''.join(stream(ref)))
        for phase in phases:
            captures={}
            for ref in phase['captures']['indexes']:
                index=small(ref);need(index.get('schemaVersion')==1 and isinstance(index.get('files'),list),'capture index schema')
                for row in index['files']:
                    name=bindings.capture_inventory_name(row['path'])
                    need(name not in captures,'unique same-phase registered capture')
                    captures[name]=row
            need(len(captures)==phase['captures']['files'] and sum(row['bytes'] for row in captures.values())==phase['captures']['bytes'],'complete phase capture count/bytes')
            descriptors={};summary=phase.get('toolFileSnapshots')
            need(summary is not None,'observed tool descriptor indexes unavailable')
            for ref in summary['indexes']:
                index=small(ref);need(index.get('schemaVersion')==1 and isinstance(index.get('rows'),list),'tool descriptor index schema')
                for row in index['rows']:
                    original=row['original'];name=Path(original['path']).name;identity=row['identity']
                    need(row['phase']==phase['name'] and row['sourceKind']=='actual-tool-file-fd-snapshot' and row['role']=='observed-tool-file' and row['rawEventKind']=='toolchain-original','fixed tool descriptor phase/role')
                    need(type(row['captureSequence']) is int and row['captureSequence']>0 and len(identity)==6 and all(type(v) is int for v in identity),'exact integer stop identity/sequence')
                    need(row['actualMode']==identity[2] and identity[2]&0o170000==0o100000 and identity[3]==original['bytes'],'actual regular mode/size differs')
                    need(isinstance(row['actualOriginalPath'],str) and row['actualOriginalPath'].startswith('/') and zip_originals.safe(row['actualOriginalPath'][1:]),'canonical actual tool path')
                    need(name not in descriptors and name not in seen and captures.get(name)==original,'same-phase parent capture missing/duplicated')
                    descriptors[name]=row
            need(len(descriptors)==summary['files'] and sum(row['original']['bytes'] for row in descriptors.values())==summary['bytes'],'complete tool descriptor count/bytes')
            raw_tools={};line=bytearray();last_sequence=0;decoder=raw_records.RawRecordDecoder()
            for ref in phase['rawTraceShards']:
                for block in stream(ref):
                    line.extend(block)
                    while True:
                        at=line.find(b'\n')
                        if at<0:break
                        need(at+1<=LIMITS['rangeBytes'],'bounded raw event record');row=decoder.feed(bytes(line[:at+1]));del line[:at+1]
                        if row is None:continue
                        need(row['phase']==phase['name'] and type(row['sequence']) is int and row['sequence']>last_sequence,'ordered same-phase actual raw events');last_sequence=row['sequence']
                        if row.get('kind')=='toolchain-original' and row.get('captureKind')=='file':
                            original=row['original'];name=Path(original['path']).name
                            need(original['path']==name and name not in raw_tools,'unique raw tool role');raw_tools[name]=row
                    need(len(line)<=LIMITS['rangeBytes'],'unfinished raw event bound')
            need(not line,'raw event final newline');decoder.finish()
            need(set(raw_tools)==set(descriptors),'raw/descriptor closed tool universe differs')
            for name,row in descriptors.items():
                check();raw=raw_tools[name];ref=row['original'];trusted=expected_by_name.get(name)
                need(raw['sequence']==row['captureSequence'] and raw['observedPath']==row['actualOriginalPath'] and raw['identity']==row['identity'] and raw['original']==dict(ref,path=name),'exact descriptor/raw stop identity differs')
                need(trusted is not None and trusted['observedPath']==raw['observedPath'] and trusted['original']==raw['original'],'existing private execution snapshot differs')
                # The previous private execution parser already classified these
                # raw events. Rehash the retained payload; metadata alone is not bytes.
                for _ in stream(ref):pass
                seen.add(name);selected=after.get(row['actualOriginalPath']);actual=(ref['bytes'],ref['sha256'],row['actualMode']&0o7777)
                if selected is None:pending.append(dict(path=row['actualOriginalPath'],reason='observed-tool-file-missing-from-after-full-shard'));continue
                if (selected['bytes'],selected['sha256'],selected['mode'])!=actual:pending.append(dict(path=row['actualOriginalPath'],reason='observed-tool-file-differs-from-after-full-shard'));continue
                output.append(dict(path=row['actualOriginalPath'],bytes=actual[0],sha256=actual[1],mode=actual[2],phase=phase['name'],captureSequence=row['captureSequence'],identityDecimal=[str(v) for v in row['identity']],observedBeforeCompile=False))
        need(seen==set(expected_by_name),'private/raw tool snapshot closed universe differs');check()
    return dict(schemaVersion=1,kind='sdk-observed-tool-after-shard-byte-mechanics',files=output,pending=pending,wholeToolchainVerified=False,sourceClosureVerified=False)

if __name__=='__main__':
    raw=sys.stdin.buffer.read(LIMITS['metadataBytes']+1);need(len(raw)<=LIMITS['metadataBytes'] and len(sys.argv)==2,'bounded fixed tool observation plan')
    print(json.dumps(observe(sys.argv[1],json.loads(raw)),separators=(',',':')))

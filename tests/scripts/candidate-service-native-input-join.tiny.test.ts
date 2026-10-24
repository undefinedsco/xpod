import{test,expect}from'bun:test';
import{joinNativeInputSnapshots}from'../../scripts/lib/independent-admission/candidate-service-native-input-join';
import{createHash}from'node:crypto';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const row=(path:string,value:string,mode=0o644)=>({path,bytes:Buffer.byteLength(value),sha256:sha(value),mode});
test('exact Git/SDK/Debian rows cover reads and tools',()=>{
 const git=row('/workspace/xpod/qlever/rdf_protocol/include/xpod_rdf_physical_backend.h','header',0o644);
 const sdk=row('/opt/qlever-sdk/build/libengine.a','sdk-archive',0o644);
 const deb=row('/usr/lib/x86_64-linux-gnu/libsqlite3.so','debian-lib',0o755);
 const result=joinNativeInputSnapshots({reads:[git,sdk,deb],tools:[sdk,deb],git:[git],sdk:[sdk],debian:[deb]});
 expect(result.covered).toHaveLength(5);
 expect(result.unresolved).toEqual([]);
 expect(result.covered.map(value=>value.via)).toEqual(['git','sdk','debian','sdk','debian']);
 expect(result.sourceAuthorityVerified).toBe(false);
});
test('wrong bytes/hash/mode leave actual unresolved rows',()=>{
 const git=row('/workspace/xpod/a.h','content');
 const badBytes={...git,bytes:(git.bytes as number)+1};
 const badHash={...git,sha256:'0'.repeat(64)};
 const badMode={...git,mode:0o600};
 const result=joinNativeInputSnapshots({reads:[badBytes,badHash,badMode],git:[git]});
 expect(result.covered).toEqual([]);
 expect(result.unresolved).toHaveLength(3);
 expect(result.unresolved.every(value=>value.reason==='no-authenticated-source')).toBe(true);
});
test('missing archive/header exact paths stay unresolved, including tools',()=>{
 const archive=row('/opt/qlever-sdk/build/libmissing.a','archive');
 const header=row('/workspace/xpod/missing.h','header');
 const result=joinNativeInputSnapshots({reads:[archive,header],tools:[archive,header],git:[],sdk:[],debian:[]});
 expect(result.covered).toEqual([]);
 expect(result.unresolved.map(value=>value.path)).toEqual(['/opt/qlever-sdk/build/libmissing.a','/workspace/xpod/missing.h','/opt/qlever-sdk/build/libmissing.a','/workspace/xpod/missing.h']);
 expect(result.unresolved.filter(value=>value.kind==='tools').every(value=>value.reason==='no-authenticated-tool-source')).toBe(true);
});
test('generated read accepted but generated tool rejected',()=>{
 const generated=row('/opt/xpod/qlever/generated/oracle.cc','generated-source');
 const result=joinNativeInputSnapshots({reads:[generated],tools:[generated],generated:[generated]});
 expect(result.covered).toHaveLength(1);expect(result.covered[0]).toMatchObject({path:generated.path,kind:'reads',via:'generated'});
 expect(result.unresolved).toHaveLength(1);expect(result.unresolved[0]).toMatchObject({path:generated.path,kind:'tools',reason:'generated-row-cannot-authorize-tool'});
});
test('multiple mutable reads of one path with different contents are preserved',()=>{
 const first=row('/tmp/x','one');
 const second=row('/tmp/x','two');
 const result=joinNativeInputSnapshots({reads:[first,second],generated:[first,second]});
 expect(result.covered).toHaveLength(2);
 expect(result.covered.map(value=>value.sha256)).toEqual([first.sha256,second.sha256]);
 expect(result.unresolved).toEqual([]);
});
test('conflicting authority declarations are rejected; distinct generated versions accepted',()=>{
 const a=row('/workspace/xpod/a','a');
 const b=row('/workspace/xpod/a','b');
 expect(()=>joinNativeInputSnapshots({reads:[],git:[a,b]})).toThrow('git conflicts');
 expect(()=>joinNativeInputSnapshots({reads:[],sdk:[a,b]})).toThrow('sdk conflicts');
 expect(()=>joinNativeInputSnapshots({reads:[],debian:[a,b]})).toThrow('debian conflicts');
 const result=joinNativeInputSnapshots({reads:[],generated:[a,b]});
 expect(result.covered).toEqual([]);
 expect(result.unresolved).toEqual([]);
});
test('malformed paths, bytes, modes and hashes are rejected',()=>{
 for(const path of['relative','','/','/a/../b','/a//b','/a/','/a\\b','/a\0b']){
  expect(()=>joinNativeInputSnapshots({reads:[{path,bytes:1,sha256:'a'.repeat(64),mode:0o644}]})).toThrow();
 }
 const malformed:any[]=[{bytes:1.5},{bytes:-1},{mode:-1},{mode:0o10000},{sha256:'A'.repeat(64)},{sha256:'a'.repeat(63)}];
 for(const bad of malformed){
  expect(()=>joinNativeInputSnapshots({reads:[{...row('/a','x'),...bad}]})).toThrow();
 }
});
test('caller mutation after join does not affect frozen output',()=>{
 const git=row('/workspace/xpod/a','a');
 const reads=[git];
 const result=joinNativeInputSnapshots({reads,git:[git]});
 reads.push(row('/workspace/xpod/b','b'));
 git.bytes=999;
 expect(result.covered).toHaveLength(1);
 expect(result.covered[0]!.bytes).toBe(1);
 expect(Object.isFrozen(result)).toBe(true);
 expect(Object.isFrozen(result.covered[0])).toBe(true);
 expect(()=>{(result.covered[0] as any).bytes=2;}).toThrow();
});

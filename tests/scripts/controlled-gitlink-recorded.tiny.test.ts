import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import policy from '../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import {assertControlledInngestGitlinkOriginal as inspect,controlledInngestOriginalPins} from '../../scripts/lib/inngest-controlled-materials';
const digest=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function fixture(){
 const p=structuredClone(policy),dependency=p.sourceDependencies[0]!,ref=dependency.gitlinkEvidence.original;
 const raw=readFileSync(new URL('../../'+ref.path,import.meta.url));
 const gitlinkOriginal:any={kind:dependency.gitlinkEvidence.kind,trackedOriginal:{...ref},url:'https://api.github.com/repos/'+p.repository+'/contents/'+dependency.destination+'?ref='+p.sourceCommit,bytes:raw.length,sha256:digest(raw),encoding:'base64',content:raw.toString('base64')};
 return {p,dependency,http:{url:dependency.source.url,status:200,bytes:dependency.source.bytes,sha256:dependency.source.sha256,gitlinkOriginal}};
}
test('reviewed immutable Gitlink bytes retain the complete fifth archive without claiming a new HTTP request',()=>{
 const f=fixture();expect(inspect(f.p,f.dependency,f.http)).toBeUndefined();expect(f.http.gitlinkOriginal.status).toBeUndefined();expect(controlledInngestOriginalPins(f.p,'darwin-arm64').length).toBe(5);
 const raw=Buffer.from(f.http.gitlinkOriginal.content,'base64');expect(raw.length).toBe(f.dependency.gitlinkEvidence.original.bytes);expect(digest(raw)).toBe(f.dependency.gitlinkEvidence.original.sha256);
});
test('new recipe refuses altered original/ref, parent/path/repository/commit and fresh-HTTP substitution',()=>{
 for(const change of ['kind','ref','bytes','sha','content','parent','archive','fresh','extra-status','actual-parent','actual-commit','actual-path','actual-repository']){
  const f=fixture(),v=f.http.gitlinkOriginal;
  if(change==='kind')v.kind='caller-cache';else if(change==='ref')v.trackedOriginal.path='other.json';else if(change==='bytes')v.bytes++;else if(change==='sha')v.sha256='0'.repeat(64);else if(change==='content')v.content=Buffer.from('{}').toString('base64');else if(change==='parent')f.p.sourceCommit='0'.repeat(40);else if(change==='archive')f.http.sha256='0'.repeat(64);else if(change==='fresh'){delete v.kind;delete v.trackedOriginal;v.status=200;}else if(change==='extra-status')v.status=200;
  else {const raw=JSON.parse(Buffer.from(v.content,'base64').toString());if(change==='actual-parent')raw.url+='wrong';if(change==='actual-commit')raw.sha='0'.repeat(40);if(change==='actual-path')raw.path='other';if(change==='actual-repository')raw.submodule_git_url='git@github.com:other/repo.git';const bytes=Buffer.from(JSON.stringify(raw));Object.assign(v,{bytes:bytes.length,sha256:digest(bytes),content:bytes.toString('base64')});Object.assign(f.dependency.gitlinkEvidence.original,{bytes:v.bytes,sha256:v.sha256});Object.assign(v.trackedOriginal,f.dependency.gitlinkEvidence.original);}
  expect(()=>inspect(f.p,f.dependency,f.http)).toThrow();
 }
});
test('historical no-evidence recipe still requires actual HTTP200 and refuses the new kind',()=>{
 const f=fixture(),old:any=structuredClone(f.dependency);delete old.gitlinkEvidence;
 expect(()=>inspect(f.p,old,f.http)).toThrow();const value={...f.http.gitlinkOriginal,status:200};delete value.kind;delete value.trackedOriginal;
 expect(inspect(f.p,old,{...f.http,gitlinkOriginal:value})).toBeUndefined();expect(()=>inspect(f.p,old,{...f.http,gitlinkOriginal:{...value,status:403}})).toThrow();
});

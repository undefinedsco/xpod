import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectNativeGitInputGrants} from '../../scripts/lib/independent-admission/candidate-service-native-grant';
import {LEGAL_GRANT_TEMPLATE_PATHS,verifyMitGrantText,explicitLicenseConflicts} from '../../scripts/lib/independent-admission/legal-admission';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const template=readFileSync(LEGAL_GRANT_TEMPLATE_PATHS.mit),license=Buffer.from(template.toString().replace(/<year>/gu,'2026').replace(/<copyright holders>/gu,'Example Authors'));
const source=Buffer.from('int main(){return 0;}\n');
function fixture(){
 const files=new Map([['LICENSE',license],['src/main.cpp',source]]),member={path:'opt/xpod/qlever/bin/main',bytes:3,sha256:sha(Buffer.from('elf'))};
 return{inputs:[{path:'/workspace/xpod/src/main.cpp',bytes:source.length,sha256:sha(source),mode:0o644,kind:'reads' as const,via:'git' as const}],source:{sourceSha:'a'.repeat(40),trackedPaths:[...files.keys()],readTracked:(name:string)=>files.get(name)!}as any,artifact:{members:[member,{path:'opt/xpod/qlever/LICENSE',bytes:license.length,sha256:sha(license)}]}as any,memberPath:member.path,readTracked:(name:string)=>files.get(name)!,budget:{check(){},remainingMs(){return 10000;},remainingReadBytes(){return 100000;},chargeReadBytes(_n:number){}},check(){},verifyGrant:(raw:Buffer)=>verifyMitGrantText(raw,template),declarations:explicitLicenseConflicts};
}
test('actual Git input terms and retained original notice cover compiled output mechanics',()=>{expect(inspectNativeGitInputGrants(fixture()).covered).toBe(true);});
test('missing retained notice or changed contributing input never acquires coverage',()=>{
 const f=fixture();f.artifact.members.pop();expect(inspectNativeGitInputGrants(f).covered).toBe(false);
 const changed=fixture();changed.inputs[0]!.sha256='0'.repeat(64);expect(()=>inspectNativeGitInputGrants(changed)).toThrow('input changed');
});
test('SDK or Debian input requires its actual package scope, not the project license',()=>{
 const f=fixture();(f.inputs[0] as any).via='sdk';const result=inspectNativeGitInputGrants(f);expect(result.covered).toBe(false);expect(result.pending.some(row=>row.includes('sdk input'))).toBe(true);
});

test('same parent charges every direct and scoped parser read; exhausted budget cannot cover',()=>{
 const f=fixture();let actual=0,charged=0;const read=f.readTracked;f.readTracked=(name:string)=>{const b=read(name);actual+=b.length;f.budget.chargeReadBytes(b.length);return b;};f.budget.chargeReadBytes=n=>{charged+=n;};
 expect(inspectNativeGitInputGrants(f).covered).toBe(true);expect(charged).toBe(actual);expect(charged).toBeGreaterThan(license.length+source.length);
 const empty=fixture();let reads=0;empty.readTracked=()=>{reads++;return source;};empty.budget.remainingReadBytes=()=>0;expect(()=>inspectNativeGitInputGrants(empty)).toThrow('shared read budget');expect(reads).toBe(0);
 const expired=fixture();expired.budget.remainingMs=()=>0;expect(()=>inspectNativeGitInputGrants(expired)).toThrow('shared deadline');
});

/** Synthetic payloads test staging byte checks; they never issue a private cap. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=Buffer.from('tiny synthetic source archive');
vi.mock('../../packages/xpod-api/scripts/inngest-controlled-build-policy.json',()=>({default:{sourceKind:'xpod-controlled-inngest-build-v1',targets:['linux-arm64'],sourceCommit:'0d75b0b305010b5e90a627703e9d1df4464b1e39',source:{file:'inngest-source.tar.gz',bytes:29,sha256:'filler',url:'https://fixture.invalid/source'},tools:{}}}));
// Import actual policy mock object to install the fixture digest explicitly.
import policy from '../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import {assertControlledInngestStage,prepareControlledInngestPlacement} from '../../packages/xpod-api/scripts/controlled-native-material';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const dirs:string[]=[];
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const dir=mkdtempSync(path.join(root,'.test-data/controlled-placement-'));dirs.push(dir);
 const ref=(name:string,b:Buffer)=>{mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});writeFileSync(path.join(dir,name),b,{flag:'wx'});return {path:name,bytes:b.length,sha256:digest(b)};};
 policy.source.bytes=source.length;policy.source.sha256=digest(source);
 const elf=Buffer.alloc(64);Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(elf);elf.writeUInt16LE(183,18);
 const binary=ref('products/inngest',elf);chmodSync(path.join(dir,binary.path),0o755);
 const license=ref('source/LICENSE.md',Buffer.from('synthetic terms'));const archive=ref('originals/inngest-source.tar.gz',source);const inputs=ref('inputs.original.json',Buffer.from('{}'));const http=ref('inngest-source.tar.gz.http.original.json',Buffer.from(JSON.stringify({url:policy.source.url,status:200,bytes:archive.bytes,sha256:archive.sha256})));const preparation=ref('preparation.original.json',Buffer.from(JSON.stringify({sourceKind:policy.sourceKind,sourceCommit:policy.sourceCommit,originals:[archive],acquisitionOriginals:[http]})));
 const group=()=>({archives:[],inventories:[]});const collection={schemaVersion:1,sourceKind:policy.sourceKind,target:'linux-arm64',sourceCommit:policy.sourceCommit,binary,license,sourceArchive:archive,preparation,inputs,originals:{source:group(),dependencies:group(),toolchain:group()},generated:{originals:group(),removedOriginals:[],changedCount:0,removedCount:0}};
 ref('controlled-build-materials.json',Buffer.from(JSON.stringify(collection)));return {dir,collection};
}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('controlled Inngest producer placement',()=>{
 it('returns explicit pre-bin placements and keeps official asset identity absent',()=>{const f=fixture();const p=prepareControlledInngestPlacement(f.dir,'linux-arm64');expect(p.placements[0].destination).toBe('node_modules/inngest-cli/bin/inngest');expect(p.index.schemaVersion).toBe(2);expect('officialArchiveSHA256' in p.index).toBe(false);p.assertCurrent();});
 it('checks the same pre-bin placements at pack without adopting replacement bytes',()=>{const f=fixture();const p=prepareControlledInngestPlacement(f.dir,'linux-arm64');const stage=mkdtempSync(path.join(root,'.test-data/controlled-stage-'));dirs.push(stage);for(const placement of p.placements){const file=path.join(stage,placement.destination);mkdirSync(path.dirname(file),{recursive:true});copyFileSync(placement.source,file);chmodSync(file,placement.mode);}const index=path.join(stage,p.indexDestination);mkdirSync(path.dirname(index),{recursive:true});writeFileSync(index,JSON.stringify(p.index));assertControlledInngestStage(p,stage);writeFileSync(path.join(stage,p.placements[0].destination),Buffer.alloc(64));expect(()=>assertControlledInngestStage(p,stage)).toThrow();});
 it('rejects changed retained binary and continued custody mutation',()=>{const f=fixture();const p=prepareControlledInngestPlacement(f.dir,'linux-arm64');writeFileSync(path.join(f.dir,'products/inngest'),Buffer.alloc(64));expect(()=>p.assertCurrent()).toThrow();expect(()=>prepareControlledInngestPlacement(f.dir,'linux-arm64')).toThrow();});
 it('rejects historical official identity and wrong target rather than fallback',()=>{const f=fixture();expect(()=>prepareControlledInngestPlacement(f.dir,'linux-x64')).toThrow();f.collection.sourceKind='official-release';writeFileSync(path.join(f.dir,'controlled-build-materials.json'),JSON.stringify(f.collection));expect(()=>prepareControlledInngestPlacement(f.dir,'linux-arm64')).toThrow();});
});

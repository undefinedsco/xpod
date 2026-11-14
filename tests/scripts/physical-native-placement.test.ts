import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {preparePhysicalNativePlacements} from '../../scripts/lib/physical-module-native-placement';
import {stagePhysicalService} from '../../scripts/lib/physical-module-stage';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function fixture(){const parent=path.resolve('.test-data/physical-native-placement');fs.mkdirSync(parent,{recursive:true});const root=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-'))),stage=root+'/stage',source=root+'/compiled';fs.writeFileSync(source,'actual compiled bytes');let valid=true;const destination='node_modules/tool/bin/tool';const file={source,destination,bytes:21,sha256:hash('actual compiled bytes'),mode:0o755};const batch={sourceKind:'controlled-test-build-v1',target:process.platform+'-'+process.arch,placements:[file],indexDestination:'provenance/native/tool/index.json',index:{schemaVersion:2,sourceKind:'controlled-test-build-v1',target:process.platform+'-'+process.arch,binary:{path:destination,bytes:file.bytes,sha256:file.sha256}},assertCurrent(){if(!valid)throw Error('custody revoked');}};return{root,stage,batch,revoke(){valid=false;},close(){fs.rmSync(root,{recursive:true,force:true});}};}
it('copies exact compiled bytes during package inventory, leaving root dependencies unchanged',()=>{
 const f=fixture();try{const put=(name:string,value:string)=>{const p=path.join(f.root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);};
  put('package.json',JSON.stringify({name:'fixture',version:'1.0.0'}));put('LICENSE','fixture');put('src/api/main.ts',"import tool from 'tool';console.log(tool);");put('node_modules/tool/package.json',JSON.stringify({name:'tool',version:'1.0.0',main:'index.js',bin:{tool:'bin/tool'}}));put('node_modules/tool/index.js','module.exports=1');put('node_modules/tool/bin/tool','original dependency');
  stagePhysicalService(f.root,f.stage,['src/api/main.ts','node_modules/tool/index.js'],{entry:'src/api/main.ts',moduleId:'api',nativePlacements:[f.batch],validateInputs(){}});
  expect(fs.readFileSync(f.root+'/node_modules/tool/bin/tool','utf8')).toBe('original dependency');expect(fs.readFileSync(f.stage+'/'+f.batch.placements[0]!.destination,'utf8')).toBe('actual compiled bytes');
  const records=fs.readdirSync(f.stage+'/provenance/packages').map(name=>JSON.parse(fs.readFileSync(f.stage+'/provenance/packages/'+name,'utf8')));expect(records.find(row=>row.name==='tool').files.find((row:any)=>row.path==='bin/tool').sha256).toBe(f.batch.placements[0]!.sha256);expect(fs.existsSync(f.stage+'/'+f.batch.indexDestination)).toBe(true);
 }finally{f.close();}
});
it('rejects JSON/no-verifier, revoked or changed source, and an unbound index',()=>{const f=fixture();try{expect(()=>preparePhysicalNativePlacements(f.stage,[{...f.batch,assertCurrent:undefined} as any])).toThrow();expect(()=>preparePhysicalNativePlacements(f.stage,[{...f.batch,index:{...f.batch.index,binary:{...f.batch.index.binary,sha256:'0'.repeat(64)}}}])).toThrow('index must bind');f.revoke();expect(()=>preparePhysicalNativePlacements(f.stage,[f.batch])).toThrow('revoked');}finally{f.close();}
});
it('does not seal an unused or post-copy changed placement',()=>{const f=fixture();try{fs.mkdirSync(f.stage);const hook=preparePhysicalNativePlacements(f.stage,[f.batch]);expect(()=>hook.finalize()).toThrow('not reached');const dest=f.stage+'/'+f.batch.placements[0]!.destination;hook.copy(f.batch.placements[0]!.destination,dest);fs.writeFileSync(dest,'changed staged bytes');expect(()=>hook.finalize()).toThrow('changed');}finally{f.close();}});

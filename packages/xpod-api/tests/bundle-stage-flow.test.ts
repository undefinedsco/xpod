import { apiTestRepoRoot, API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { buildWithBun } from '../scripts/bun-build-api';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildApiBundleProducts, bundleFile } from '../scripts/bundle-products';
import { prepareApiBundleStage, attachApiSourcekit, verifyApiStageMaterials } from '../scripts/bundle-stage';
import { staticSourcePaths, apiStaticProductRoots, materializeApiStaticProducts } from '../scripts/static-material';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';
import { packPhysicalModule } from '../../../scripts/lib/physical-module-archive';

test('normal API bundle stage and archive callbacks require strict receipts, static products and streamed originals', async () => {
  const parent=path.resolve('.test-data/api-normal-bundle-flow');fs.mkdirSync(parent,{recursive:true});
  const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-'))),root=base+'/input',build=root+'/packages/xpod-api/dist',stage=base+'/stage';
  const put=(file:string,body:string)=>{fs.mkdirSync(path.dirname(root+'/'+file),{recursive:true});fs.writeFileSync(root+'/'+file,body);};
  const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
  try{
    put('package.json',JSON.stringify({name:'fixture',version:'1.0.0',engines:{node:'>=22 <27'}}));put('bun.lock','fixture');put('LICENSE','fixture');put('.gitignore','packages/xpod-api/dist/\n');
    put('packages/xpod-api/package.json',JSON.stringify({name:'fixture-api',version:'1.0.0',dependencies:{},devDependencies:{}}));put('ui/package.json','{}');
    put('src/runtime/package-root.ts',"export function findPackageRoot(dir:string){return dir;}export const PACKAGE_ROOT=findPackageRoot(__dirname);");
    put('src/api/main.ts',"import '../runtime/package-root';import './runs/PiAgentRuntimeDriver';console.log('fixture');");
    put('src/api/runs/PiAgentRuntimeDriver.ts',"import path from 'node:path';import {PACKAGE_ROOT} from '../../runtime/package-root';export class PiAgentRuntimeDriver {constructor(private options={workerPath:undefined}){}private resolveWorkerPath(){if(this.options.workerPath){return this.options.workerPath;}return path.join(__dirname,`PiAgentRuntimeWorker${path.extname(__filename)}`);}}");
    put('src/api/runs/PiAgentRuntimeWorker.ts',"import './PiAgentRuntimeDriver';import '../../runtime/package-root';async function main(){}if(require.main===module){main().catch(error=>{process.exitCode=1;});}");
    put('src/storage/ObservableResourceStore.ts',"import {PassthroughStore} from '@solid/community-server';export class ObservableResourceStore extends PassthroughStore{}");
    for(const file of ['packages/xpod-cli/src/module-catalog.ts','packages/xpod-cli/src/manifest.ts','packages/xpod-cli/src/source-materials.ts','scripts/lib/helper.ts','scripts/agentfs-native-ci/supervise.py','docs/testing/api-bundle-materials.md','docs/testing/physical-module-native-materials.md'])put(file,'fixture');
    for(const target of ['dashboard','settings'])put('static/'+target+'/index.html',target);
    const packTool=await buildWithBun({entrypoints:[path.join(apiTestRepoRoot,'packages/xpod-api/scripts/pack.ts')],target:'node',format:'esm'});assert(packTool.success,String(packTool.logs));put('packages/xpod-api/scripts/pack.mjs',await packTool.outputs[0].text());
    for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])assert.equal(spawnSync('git',args,{cwd:root}).status,0);
    fs.mkdirSync(build,{recursive:true});
    await buildApiBundleProducts(root,build,[]);
    const rows=(files:string[])=>files.map(file=>{const bytes=fs.readFileSync(root+'/'+file);return {path:file,bytes:bytes.length,sha256:sha(bytes)};});
    const roots=apiStaticProductRoots(root,build);
    const builds=roots.map(binding=>{const bytes=Buffer.from('controlled static fixture '+binding.target);fs.writeFileSync(build+'/static-'+binding.target+'.raw.log',bytes);put(binding.sourceRoot+'/index.html','built '+binding.target);return {command:['bun','run','build:'+binding.target,'--outDir',path.join(root,binding.sourceRoot)],exitCode:0,rawSHA256:sha(bytes)};});
    const assets=roots.map(binding=>{const row=rows([binding.sourceRoot+'/index.html'])[0];return {path:binding.destinationRoot+'/index.html',sourcePath:row.path,bytes:row.bytes,sha256:row.sha256};});
    fs.writeFileSync(build+'/static-products.json',JSON.stringify({schemaVersion:2,sourceCommit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),roots,builds,sources:rows(staticSourcePaths(root)),assets}));
    put('packages/xpod-api/.test-data/ignored-fixture','not source material');put('packages/xpod-api/.env.local','not a real secret');
    const plan=prepareApiBundleStage(root,build);
    stagePhysicalService(root,stage,plan.inputs,{entry:'src/api/main.ts',moduleId:'api',runtimePackages:plan.runtimePackages,runtimePackageImports:plan.runtimeImports,
      bundle:{files:plan.files,verify:()=>{prepareApiBundleStage(root,build);}},materializeResources:output=>materializeApiStaticProducts(root,build,output),validateInputs:()=>{}});
    assert(fs.existsSync(stage+'/dist/PiAgentRuntimeWorker.mjs'));
    assert.throws(()=>verifyApiStageMaterials(root,build,stage),/ENOENT/);
    attachApiSourcekit(root,stage,plan);verifyApiStageMaterials(root,build,stage);
    const sourceIndex=JSON.parse(fs.readFileSync(stage+'/provenance/sourcekits/source-kit.json','utf8'));assert(!sourceIndex.files.some((row:any)=>row.path.includes('/.test-data/')||row.path.endsWith('/.env.local')));
    fs.writeFileSync(stage+'/source/unapproved.tmp','not approved');assert.throws(()=>verifyApiStageMaterials(root,build,stage),/Unapproved/);fs.unlinkSync(stage+'/source/unapproved.tmp');
    const canonicalSource=stage+'/source/src/api/main.ts',canonicalSourceBytes=fs.readFileSync(canonicalSource);fs.appendFileSync(canonicalSource,'drift');assert.throws(()=>verifyApiStageMaterials(root,build,stage),/drifted staged API source/);fs.writeFileSync(canonicalSource,canonicalSourceBytes);
    fs.writeFileSync(stage+'/NOTICE','controlled original fixture');fs.mkdirSync(stage+'/provenance/terms');fs.writeFileSync(stage+'/provenance/terms/index.json',JSON.stringify({schemaVersion:1,status:'original-material-collection',legalClearance:false,entries:[]}));
    const publicationPath=stage+'/provenance/publication.json',publicationBytes=fs.readFileSync(publicationPath),publication=JSON.parse(publicationBytes.toString());publication.mode='release';fs.writeFileSync(publicationPath,JSON.stringify(publication));
    // A valid strict bundle must still stop at the independent native-material argument gate.
    verifyApiStageMaterials(root,build,stage);
    const nativeDenied=spawnSync('bun',[root+'/packages/xpod-api/scripts/pack.mjs',stage,base+'/native-denied.tgz'],{cwd:root,encoding:'utf8'});
    assert.equal(nativeDenied.status,1,nativeDenied.stderr);assert.match(nativeDenied.stderr,/requires explicit external native materials root/);assert.equal(fs.existsSync(base+'/native-denied.tgz'),false);assert.equal(fs.existsSync(stage+'/provenance/source-inventory.json'),false);
    fs.writeFileSync(publicationPath,publicationBytes);
    let finalCallback=0;
    packPhysicalModule(stage,base+'/fixture.tgz',{moduleId:'api',entry:'entry.mjs',verifyArchiveMaterials:()=>{finalCallback++;assert(JSON.parse(fs.readFileSync(stage+'/package.json','utf8')).xpodModule);verifyApiStageMaterials(root,build,stage);}});
    assert.equal(finalCallback,1);
    const receiptFile=build+'/bundle-products.json',receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8')),originalReceipt=fs.readFileSync(receiptFile);
    const runtime=build+'/'+receipt.products[0].implementation.path,original=fs.readFileSync(runtime);fs.writeFileSync(runtime,'await import(process.argv[2]);');receipt.products[0].implementation=bundleFile(build,receipt.products[0].implementation.path);fs.writeFileSync(receiptFile,JSON.stringify(receipt));
    assert.throws(()=>prepareApiBundleStage(root,build),/Unqualified API dynamic/);fs.writeFileSync(runtime,original);fs.writeFileSync(receiptFile,originalReceipt);
    fs.appendFileSync(stage+'/static/dashboard/index.html','drift');
    assert.throws(()=>packPhysicalModule(stage,base+'/rejected.tgz',{moduleId:'api',entry:'entry.mjs',verifyArchiveMaterials:()=>verifyApiStageMaterials(root,build,stage)}),/static asset drift/);assert.equal(fs.existsSync(base+'/rejected.tgz'),false);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
}, API_BUILD_INTEGRATION_TIMEOUT_MS);

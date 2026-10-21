/** Real native collector WeakMap/range reader; upstream origin only is simulated.
 * This is not a GitHub/source capability qualification or image positive. */
import {test,expect} from 'bun:test';
import {mockModule} from './bun-module-mock';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const origin={},facts:any={sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),runId:1,runAttempt:1,artifactId:1,workflowPath:'.github/workflows/publish-qlever-runtime-sdk.yml',target:'linux-x64'};
mockModule('../../scripts/lib/independent-admission/github-origin',()=>({githubOriginFacts:(v:unknown)=>v===origin?facts:undefined,githubOriginOriginals:()=>[],isNativeGitHubOrigin:(v:unknown)=>v===origin,isCandidateServiceImageGitHubOrigin:()=>false,isQleverSdkGitHubOrigin:()=>true}));
mockModule('../../scripts/acquire-independent-product-input',()=>({verifyAcquiredMetadata:()=>{}}));
test('actual issued native view keeps its shared four-pass-plus-1MiB range ceiling',async()=>{
 const parent=resolve('.test-data/service-native-range-budget');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'actual-')),previous=process.env.TMPDIR;process.env.TMPDIR=root;
 const {collectNativeAdmissionOriginals,nativeOriginalsView,compactCollectedNativeOriginals}=await import('../../scripts/lib/independent-admission/native-original-collector');let cap:unknown;
 try{
  const archive=join(root,'artifact.zip');execFileSync('/usr/bin/python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('payload.bin',b'X'*(1024*1024))",archive]);const bytes=readFileSync(archive);facts.artifactSha256=createHash('sha256').update(bytes).digest('hex');
  const inventory=JSON.parse(execFileSync('/usr/bin/python3',[resolve('scripts/lib/inspect-product-artifact.py'),archive,facts.artifactSha256,String(4*1024**3),String(4*1024**3),'100000']).toString());
  writeFileSync(join(root,'receipt.json'),JSON.stringify({expectedSourceSha:facts.sourceSha,runHeadSha:facts.runHeadSha,runId:1,runAttempt:1,artifactId:1,workflowPath:facts.workflowPath,archive:{path:'artifact.zip',sha256:facts.artifactSha256,bytes:bytes.length},metadata:[],inventory}));
  cap=await collectNativeAdmissionOriginals({githubOrigin:origin as any,acquisitionRoot:root});const view=nativeOriginalsView(cap)!;expect(view).toBeDefined();expect(nativeOriginalsView(JSON.parse('{}'))).toBeUndefined();
  let returned=0;for(let i=0;i<5;i++){const raw=view.readOriginal('payload.bin',1024**2);expect(raw.length).toBe(1024**2);returned+=raw.length;}
  expect(returned).toBe(inventory.expandedBytes*4+1024**2);expect(()=>view.readOriginalRange('payload.bin',0,1)).toThrow('aggregate range/time budget');
 }finally{if(cap)compactCollectedNativeOriginals(cap);if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;rmSync(root,{recursive:true,force:true});}
});

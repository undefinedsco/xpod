#!/usr/bin/env bun
'use strict';
/** One fixed normal-producer dependency recipe; no independent admission. */
const {spawnSync,execFileSync}=require('node:child_process');
const {openSync,readSync,fstatSync,closeSync,lstatSync,constants}=require('node:fs');
const path=require('node:path');
const {isDeepStrictEqual:equal}=require('node:util');
const limits=require('./lib/module-artifact-limits.json');
const {deriveApiInstallSelection}=require('./lib/api-install-selection.cjs');
const {immutableApiGraphInput}=require('./plan-api-install-selection.cjs');
function readBoundedJsonOriginal(file){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>BigInt(limits.metadataBytes))throw Error('Bounded regular retained preselection required');
  const data=Buffer.alloc(Number(before.size));let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,Math.min(limits.rangeBytes,data.length-offset),offset);if(!n)throw Error('Preselection truncated');offset+=n;}
  const after=fstatSync(fd,{bigint:true}),named=lstatSync(file,{bigint:true});if(['dev','ino','mode','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]||before[key]!==named[key]))throw Error('Preselection changed');return JSON.parse(data.toString());
 }finally{closeSync(fd);}
}
function verifiedSelection(sourceSha,target,file,root=process.cwd()){
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==sourceSha)throw Error('Actual producer source differs');
 const input=immutableApiGraphInput(sourceSha,target,root),selection=deriveApiInstallSelection(input);
 if(!equal(selection,readBoundedJsonOriginal(file)))throw Error('Retained preselection differs from immutable projection');return {input,selection};
}
async function checkedGraph(sourceSha,target,file,root=process.cwd()){
 const {input,selection}=verifiedSelection(sourceSha,target,file,root);const {deriveApiProducerGraph}=await import('./lib/api-producer-graph.ts');const graph=deriveApiProducerGraph({...input,workspaceMode:'api-ui-root-minimal-v2'});
 if(!equal(graph.installSelection,selection)||!equal(graph.isolatedInstall.argv,selection.install))throw Error('Postinstall full graph differs from preselection');return {input,selection,graph};
}
module.exports={readBoundedJsonOriginal,verifiedSelection,checkedGraph};
if(require.main===module)(async()=>{
 const [action,sha,target,file,...extra]=process.argv.slice(2);if(extra.length||!['install','verify'].includes(action)||!file||!path.isAbsolute(file)||!globalThis.Bun)throw Error('Fixed Bun install or verify arguments required');
 if(action==='install'){
  const {selection}=verifiedSelection(sha,target,file);const result=spawnSync(process.execPath,selection.install.slice(1),{stdio:'inherit',env:process.env});if(result.error)throw result.error;if(result.signal)throw Error('Frozen install signalled: '+result.signal);if(result.status!==0)process.exit(result.status??1);
 }else{const {graph}=await checkedGraph(sha,target,file);process.stdout.write(JSON.stringify(graph)+'\n');}
})().catch(error=>{console.error(error);process.exitCode=1;});

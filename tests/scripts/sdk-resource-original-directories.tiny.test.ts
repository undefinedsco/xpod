import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {preflightPublicationResources} from '../../scripts/lib/independent-admission/publication-resource-preflight';
const native={sourceSha:'a'.repeat(40),runHeadSha:'b'.repeat(40),runId:4,runAttempt:1,artifactId:81,artifactSha256:'c'.repeat(64)},sdk={...native,artifactId:82,artifactSha256:'d'.repeat(64)};
const transport=(async(url)=>{const row=String(url).endsWith('/82')?sdk:native;return new Response(JSON.stringify({id:row.artifactId,expired:false,digest:'sha256:'+row.artifactSha256,size_in_bytes:123,workflow_run:{id:4,head_sha:row.runHeadSha}}));}) as typeof fetch;
test('native and SDK preflight cannot overwrite one report; owned distinct children retain both originals',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'sdk-resource-'));
 try{
  const bad=path.join(root,'same-root');fs.mkdirSync(bad);await preflightPublicationResources({selectors:[native],output:bad},transport);
  const first=fs.readFileSync(path.join(bad,'publication-resource-preflight.json'));
  await expect(preflightPublicationResources({selectors:[sdk],output:bad},transport)).rejects.toThrow('EEXIST');
  expect(fs.readFileSync(path.join(bad,'publication-resource-preflight.json'))).toEqual(first);
  for(const [directory,row] of [['native-resources',native],['sdk-resources',sdk]] as const){
   const output=path.join(root,directory);fs.mkdirSync(output);
   await preflightPublicationResources({selectors:[row],output,reservationDirectory:root},transport);
   expect(fs.existsSync(path.join(output,'publication-resource-preflight.json'))).toBe(true);
   expect(fs.existsSync(path.join(output,`resource-artifact-${row.artifactId}.original.json`))).toBe(true);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

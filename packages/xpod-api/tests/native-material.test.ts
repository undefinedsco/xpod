import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('native material rejects release digest drift before writing provenance',()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'native-'));
 try {
  const stage=path.join(root,'stage'), evidence=path.join(root,'evidence');mkdirSync(path.join(stage,'node_modules/inngest-cli'),{recursive:true});mkdirSync(evidence);
  writeFileSync(path.join(stage,'node_modules/inngest-cli/package.json'),JSON.stringify({name:'inngest-cli',version:'1.40.0'}));
  writeFileSync(path.join(evidence,'inngest-release.raw.json'),JSON.stringify({tag_name:'v1.40.0',assets:[{name:`inngest_1.40.0_${process.platform}_${process.arch==='x64'?'amd64':process.arch}.tar.gz`,digest:'sha256:'+'0'.repeat(64)}]}));
  writeFileSync(path.join(evidence,'inngest-tag.raw.json'),JSON.stringify({object:{type:'commit',sha:'1'.repeat(40)}}));
  writeFileSync(path.join(evidence,`inngest-official-${process.platform}-${process.arch}.tar.gz`),'wrong original archive');
  const r=spawnSync('bun',[path.resolve('packages/xpod-api/scripts/native-material.ts'),stage,evidence],{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stderr,/Official archive digest mismatch/);assert.equal(existsSync(path.join(stage,'provenance')),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

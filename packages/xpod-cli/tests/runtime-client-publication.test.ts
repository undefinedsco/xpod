import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collectPublishedRuntimeClient } from '../scripts/producer-materials';
import { verifyProducerSourceArchive } from '../src/producer-source';

test('runtime publication binds normal packed bytes while preserving raw workspace source manifest', async () => {
  const base=path.resolve(import.meta.dir,'../.test-data/runtime-client-publication');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(path.join(base,'case-'));
  try {
    const client=path.join(root,'packages/client'),cli=path.join(root,'packages/cli');mkdirSync(path.join(client,'dist'),{recursive:true});mkdirSync(cli,{recursive:true});
    writeFileSync(path.join(root,'package.json'),JSON.stringify({private:true,workspaces:['packages/*']}));
    writeFileSync(path.join(cli,'package.json'),JSON.stringify({name:'@undefineds.co/xpod-cli',version:'1.2.3'}));
    const raw=JSON.stringify({name:'@undefineds.co/xpod-client',version:'1.0.0',files:['dist'],devDependencies:{'@undefineds.co/xpod-cli':'workspace:*'}});
    writeFileSync(path.join(client,'package.json'),raw);writeFileSync(path.join(client,'dist/index.js'),'export const value=1;');
    const installed=spawnSync('bun',['install','--ignore-scripts','--offline'],{cwd:root});expect(installed.status).toBe(0);
    const published=collectPublishedRuntimeClient(client,path.join(root,'publication'));
    expect(readFileSync(path.join(client,'package.json'),'utf8')).toBe(raw);
    const manifest=spawnSync('tar',['-xOf',published.archive,'package/package.json']);expect(manifest.status).toBe(0);
    expect(JSON.parse(manifest.stdout.toString()).devDependencies['@undefineds.co/xpod-cli']).toBe('1.2.3');
    const declared=published.files.find(file=>file.path==='package.json')!;
    expect(declared.sha256).toBe(createHash('sha256').update(manifest.stdout).digest('hex'));
    expect(declared.sha256).not.toBe(createHash('sha256').update(raw).digest('hex'));
    await verifyProducerSourceArchive({archive:published.archive,inventory:published.inventory});
    const changed=JSON.parse(readFileSync(published.inventory,'utf8'));changed.files.find((file:{path:string})=>file.path==='package/dist/index.js').sha256='0'.repeat(64);
    writeFileSync(published.inventory,JSON.stringify(changed));
    await expect(verifyProducerSourceArchive({archive:published.archive,inventory:published.inventory})).rejects.toThrow('differs');
  }finally{rmSync(root,{recursive:true,force:true});}
});

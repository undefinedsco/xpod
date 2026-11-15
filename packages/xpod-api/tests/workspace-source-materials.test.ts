import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { apiOriginalSourceRoots, prepareApiBundleStage } from '../scripts/bundle-stage';
import { canonicalSourcePaths } from '../scripts/static-material';

test('workspace material includes authoritative source plus bound dist and complete nested distributions', () => {
  const parent=path.resolve('.test-data/api-workspace-originals');fs.mkdirSync(parent,{recursive:true});const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-'))),root=base+'/input';
  const put=(file:string,body:string)=>{fs.mkdirSync(path.dirname(root+'/'+file),{recursive:true});fs.writeFileSync(root+'/'+file,body);};
  try{
    put('package.json','{"name":"fixture","version":"1.0.0"}');put('bun.lock','fixture');put('scripts/lib/helper.ts','fixture');put('.gitignore','**/dist/\n**/node_modules/\n');put('ui/package.json','{}');put('packages/xpod-api/package.json','{"name":"api","version":"1.0.0"}');
    for(const file of ['LICENSE','packages/xpod-cli/src/module-catalog.ts','packages/xpod-cli/src/manifest.ts','packages/xpod-cli/src/source-materials.ts','docs/testing/api-bundle-materials.md','docs/testing/physical-module-native-materials.md','scripts/agentfs-native-ci/supervise.py'])put(file,'fixture');
    put('packages/afs/package.json','{"name":"afs","version":"1.0.0"}');put('packages/afs/src/source.ts','export const original=1;');put('packages/afs/dist/library.cjs','module.exports=1;');
    put('packages/consumer/package.json','{"name":"consumer","version":"1.0.0"}');put('packages/consumer/node_modules/nested/package.json','{"name":"nested","version":"2.0.0"}');put('packages/consumer/node_modules/nested/index.js','module.exports=2;');put('packages/consumer/node_modules/nested/original-extra.txt','whole distribution');
    for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])assert.equal(spawnSync('git',args,{cwd:root}).status,0);
    put('packages/afs/untracked.ts','export const original=2;');
    for(const file of ['packages/afs/.test-data/temporary','packages/afs/logs/runtime','packages/afs/local/user-data','packages/afs/.env.local','packages/afs/private.key'])put(file,'must not archive');
    const plan={inputs:['packages/afs/dist/library.cjs','packages/consumer/node_modules/nested/index.js'],runtimeImports:[],runtimePackages:[],receipt:{runtimePackageManifest:{path:'packages/xpod-api/package.json'}}} as unknown as ReturnType<typeof prepareApiBundleStage>;
    const roots=apiOriginalSourceRoots(root,plan),canonical=roots[0].files!;
    for(const file of ['packages/afs/src/source.ts','packages/afs/untracked.ts','packages/afs/dist/library.cjs'])assert(canonical.includes(file),file);
    assert(!canonical.some(file=>file.includes('/node_modules/')||file.includes('/.test-data/')||file.includes('/logs/')||file.includes('/local/')||file.endsWith('.key')||file.includes('/.env')));
    const nested=roots.find(row=>row.directory===root+'/packages/consumer/node_modules/nested');assert(nested);assert.equal(nested.files,undefined);
    const standalone=canonicalSourcePaths(root,['packages/afs']);assert(standalone.includes('packages/afs/untracked.ts'));assert(!standalone.some(file=>file.includes('/dist/')));
    assert.throws(()=>canonicalSourcePaths(root,['packages\\afs']),/Unsafe/);
    fs.symlinkSync(root+'/packages/afs/src/source.ts',root+'/packages/afs/src/link.ts');assert.throws(()=>canonicalSourcePaths(root,['packages/afs']),/symlink/);fs.unlinkSync(root+'/packages/afs/src/link.ts');
    fs.mkdirSync(base+'/foreign');fs.writeFileSync(base+'/foreign/package.json','{"name":"foreign","version":"1.0.0"}');fs.symlinkSync(base+'/foreign',root+'/packages/foreign');
    assert.throws(()=>apiOriginalSourceRoots(root,plan),/symlink|authority/);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

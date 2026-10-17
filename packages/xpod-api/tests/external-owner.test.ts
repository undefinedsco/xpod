import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiRuntimeImportDeclarations, runtimeImportBindings } from '../scripts/bundle-products';

test('external declarations bind every actual importing owner and require observer ownership', () => {
  const parent = path.resolve('.test-data/api-external-owner'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'input-'));
  const put = (file: string, value: string) => {fs.mkdirSync(path.dirname(path.join(root,file)), {recursive: true});fs.writeFileSync(path.join(root,file), value);};
  const solid = '@comunica/query-sparql-solid';
  const observers = ['@comunica/actor-query-result-serialize-sparql-json', '@comunica/actor-query-result-serialize-stats'];
  try {
    const source = `import * as json from '${observers[0]}';import * as stats from '${observers[1]}';export const create=()=>import('${solid}');`;
    put('package.json', JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{[solid]:'4.0.2'}}));
    put('src/runtime/configure.ts', source);
    put('node_modules/orm/package.json',JSON.stringify({name:'orm',version:'1.0.0',peerDependencies:{[solid]:'^4.0.2'},peerDependenciesMeta:{[solid]:{optional:true}}}));
    put('node_modules/orm/index.js',`import {createRequire} from 'node:module';const load=createRequire(import.meta.url);export const create=()=>load('${solid}');`);
    for (const name of [solid, ...observers]) put('node_modules/'+name+'/package.json',JSON.stringify({name,version:name===solid?'4.0.2':'4.5.0',main:'index.js'}));
    const metadata = {inputs:{'src/runtime/configure.ts':{imports:[solid,...observers].map(name=>({path:name,external:true}))},'node_modules/orm/index.js':{imports:[{path:solid,external:true}]}},outputs:{}};
    assert.throws(()=>runtimeImportBindings(root,metadata,[solid,...observers]), /not declared by its actual owner/);
    put('package.json',JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{[solid]:'4.0.2',...Object.fromEntries(observers.map(name=>[name,'^4.5.0']))}}));
    const bindings=runtimeImportBindings(root,metadata,[solid,...observers]);
    assert.equal(bindings.filter(row=>row.specifier===solid).length,2);
    assert.deepEqual(bindings.filter(row=>observers.includes(row.specifier)).map(row=>row.from),['src/runtime/configure.ts','src/runtime/configure.ts']);
    assert.equal(bindings.find(row=>row.from==='node_modules/orm/index.js')!.ownerManifest,'node_modules/orm/package.json');
    assert(bindings.every(row=>/^[a-f0-9]{64}$/.test(row.ownerManifestSHA256)&&/^[a-f0-9]{64}$/.test(row.resolvedManifestSHA256)));
    for(const name of [solid,...observers,'awilix','@ai-sdk/provider-utils']) assert(apiRuntimeImportDeclarations.some(row=>row.specifier===name&&row.externalize));
    put('node_modules/'+solid+'/package.json',JSON.stringify({name:solid,version:'5.0.0'}));
    assert.throws(()=>runtimeImportBindings(root,metadata,[solid]), /version drift/);
    assert.equal(fs.readFileSync(path.join(root,'src/runtime/configure.ts'),'utf8'),source);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

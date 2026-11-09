const {test}=require('node:test');
const assert=require('node:assert/strict');
const {removeWorkspaceDependenciesManifest,projectExposedRuntimeDependency,projectPackedManifest,projectServicePackManifest}=require('../../scripts/run-npm-pack.cjs');
const {sanitizeManifest}=require('../../scripts/prepare-package-manifest.cjs');

test('service manifest projection keeps unrelated fields and composes actual existing prepack/catalog authority without mutating input',()=>{
 const root={name:'@undefineds.co/xpod',version:'1.2.3-rc.41',description:'preserved',workspaces:{packages:['packages/*'],catalog:{external:'^2.0.0'}},scripts:{prepack:'owned',start:'run'},dependencies:{external:'catalog:','@undefineds.co/xpod-client':'workspace:*'},optionalDependencies:{promoted:'^1.0.0'},devDependencies:{builder:'1.0.0'},peerDependencies:{unknown:'workspace:*'},custom:{proof:'ordinary data'}};
 const snapshot=JSON.stringify(root),sanitized=sanitizeManifest(root);
 const dependencies=[{name:'patched',patchedRuntime:true,version:'7.8.9'},{name:'@undefineds.co/xpod-client',patchedRuntime:false}];
 const projected=projectServicePackManifest(sanitized,[{name:'promoted',range:'^3.0.0',optional:false,bundled:false,newRoot:false},{name:'leaf',range:'^4.0.0',optional:true,bundled:false,newRoot:true}],dependencies);
 assert.deepEqual(projected.dependencies,{external:'^2.0.0',promoted:'^3.0.0',patched:'7.8.9','@undefineds.co/xpod-client':'file:./runtime-packages/-undefineds.co-xpod-client.tgz'});
 assert.deepEqual(projected.optionalDependencies,{leaf:'^4.0.0'});assert.deepEqual(projected.overrides,{'@undefineds.co/xpod-client':'file:./runtime-packages/-undefineds.co-xpod-client.tgz'});assert.deepEqual(projected.bundledDependencies,['patched']);
 assert.equal(projected.version,'1.2.3-rc.41');assert.equal(projected.description,'preserved');assert.deepEqual(projected.custom,root.custom);assert.deepEqual(projected.bin,{'xpod-service':'./dist/runtime/service-entry.js'});assert.equal(projected.xpodArtifactProfile,'service');assert.equal(projected.scripts,undefined);assert.equal(projected.devDependencies,undefined);assert.equal(projected.workspaces,undefined);assert.deepEqual(projected.peerDependencies,{});assert.equal(JSON.stringify(root),snapshot);
});
test('compat projection preserves public package version edges and scripts rather than emitting service file references',()=>{
 const input={name:'root',version:'1',scripts:{start:'unchanged'},dependencies:{external:'^1'},bundledDependencies:['existing']};
 const output=projectPackedManifest(input,[{name:'public',version:'2.3.4',patchedRuntime:false},{name:'patched',version:'5.6.7',patchedRuntime:true}],'compat');
 assert.deepEqual(output.dependencies,{external:'^1',public:'2.3.4',patched:'5.6.7'});assert.deepEqual(output.bundledDependencies,['existing','public','patched']);assert.deepEqual(output.scripts,input.scripts);assert.equal(output.xpodArtifactProfile,undefined);assert.deepEqual(input.bundledDependencies,['existing']);
});
test('projection requires actual installed/public versions and unique selected inputs, and never infers versions from image output',()=>{
 for(const entries of [[{name:'patched',patchedRuntime:true}],[{name:'public',patchedRuntime:false}],[{name:'same',version:'1'},{name:'same',version:'2'}]])assert.throws(()=>projectPackedManifest({},entries,'compat'),/actual|Actual/);
 assert.throws(()=>projectPackedManifest({},[],'unknown'),/Unsupported/);
 const root={optionalDependencies:{optional:'^1'},dependencies:{fixed:'^1'}};
 const projected=projectExposedRuntimeDependency(root,{name:'optional',range:'^2',optional:true,bundled:false,newRoot:false});assert.deepEqual(projected,root);
 assert.equal(removeWorkspaceDependenciesManifest({dependencies:{'arbitrary-workspace':'workspace:^',external:'^1'}}).dependencies.external,'^1');
});
test('retained CLI arguments never initialize observation from the pure manifest projection',()=>{
 const original=process.argv,create= require('node:fs').mkdirSync;let writes=0;
 process.argv=['node','/app/scripts/run-npm-pack.cjs','.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals','a'.repeat(40),String(Date.now()+60000),String(120*1024**2)];
 require('node:fs').mkdirSync=(...args)=>{writes++;throw Error('pure projection attempted filesystem write');};
 try{assert.equal(projectPackedManifest({name:'fixture',version:'1.0.0'},[],'service').version,'1.0.0');assert.equal(writes,0);}finally{process.argv=original;require('node:fs').mkdirSync=create;}
});

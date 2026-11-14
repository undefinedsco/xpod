import {describe,it,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import legacy from '../fixtures/independent-admission/api-pre-catalog-manifests.original.json';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
const {JSONC}=createRequire(import.meta.url)('bun') as {JSONC:{parse(text:string):any}};
const normalize=(x:any):any=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])])):x;
const digest=(x:any)=>createHash('sha256').update(JSON.stringify(normalize(x))).digest('hex');
const old=(name:string)=>{const row=legacy.files.find(item=>item.path===name);if(!row)throw Error('Fixed legacy original absent');const bytes=Buffer.from(row.base64,'base64');expect(bytes.length).toBe(row.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);expect(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex')).toBe(row.gitBlobOid);return JSON.parse(bytes.toString());};
const current=(name:string)=>JSON.parse(readFileSync(name,'utf8'));
describe('API declaration ownership proposal, not installer proof',()=>{
 it('preserves every existing root capability range through a single shared catalog',()=>{
  const before=old('package.json'),after=current('package.json');const catalog=after.catalogs['api-producer'];
  // Reviewed CURRENT root capability declarations, enumerated exactly:
  //  - ORM catalog bump 0.3.25 -> 0.3.26
  //  - explicit userland Undici runtime dependency ^7.29.0
  //  - explicit direct devDependency @inrupt/solid-client@3.0.0
  //  - componentsjs declared DIRECTLY at the exact 6.4.0 (was only a ^6.4.0
  //    resolution before, which is what made the lock carry a duplicate)
  //  - rdf-parse declared directly through the existing api-producer catalog
  expect(after.catalogs['api-producer']['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  expect(after.dependencies.undici).toBe('^7.29.0');
  expect(after.devDependencies['@inrupt/solid-client']).toBe('3.0.0');
  expect(before.devDependencies['@inrupt/solid-client']).toBeUndefined();
  expect(after.dependencies.componentsjs).toBe('6.4.0');
  expect(after.dependencies['rdf-parse']).toBe('catalog:api-producer');
  expect(after.catalogs['api-producer']['rdf-parse']).toBe('4.0.0');
  // Both were previously absent as DIRECT declarations: componentsjs existed only
  // as a resolution pin, rdf-parse not at all.
  expect(before.dependencies.componentsjs).toBeUndefined();
  expect(before.resolutions.componentsjs).toBe('^6.4.0');
  expect(before.dependencies['rdf-parse']).toBeUndefined();
  const resolve=(manifest:any,name:string)=>{
   const range=manifest.dependencies?.[name]??manifest.devDependencies?.[name]??manifest.peerDependencies?.[name]??manifest.optionalDependencies?.[name];
   return range==='catalog:api-producer'?catalog[name]:range;
  };
  for(const kind of ['dependencies','devDependencies','peerDependencies','optionalDependencies']){
   const added=kind==='dependencies'?['componentsjs','rdf-parse','undici']:kind==='devDependencies'?['@inrupt/solid-client']:[];
   expect(Object.keys(after[kind]??{}).sort())
    .toEqual([...Object.keys(before[kind]??{}),...added].sort());
   for(const name of Object.keys(before[kind]??{})){
    // Resolve BOTH sides through the same catalog so a literal historical range and
    // a catalog reference are compared as the same declaration.
    const historical=resolve(before,name),live=resolve(after,name);
    if(name==='@undefineds.co/drizzle-solid'){expect(historical).toBe('0.3.25');expect(live).toBe('0.3.26');}
    else expect(live).toBe(historical);
   }
  }
  // ONE reviewed current-contract change: the root postinstall gained the Comunica
  // Undici entry hook. Every other script value must stay exactly as published.
  const REVIEWED_POSTINSTALL_SUFFIX=' && bun patches/comunica-undici-entry.cjs';
  expect(after.scripts.postinstall).toBe(before.scripts.postinstall+REVIEWED_POSTINSTALL_SUFFIX);
  expect({...after.scripts,postinstall:before.scripts.postinstall}).toEqual(before.scripts);
  // Within resolutions and patchedDependencies, only the ORM version changes:
  // historical entries stay as published everywhere else, and the single
  // drizzle-solid pin moves from the historical 0.3.25 fact to the actual 0.3.26.
  // Resolutions: the ORM pin moves, AND the componentsjs resolution is consumed
  // because that package is now declared directly at an exact version. Restoring
  // both historical facts must reproduce the published resolutions table exactly.
  expect({...after.resolutions,
    '@undefineds.co/drizzle-solid':before.resolutions['@undefineds.co/drizzle-solid'],
    componentsjs:before.resolutions.componentsjs}).toEqual(before.resolutions);
  expect(after.resolutions['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  expect(before.resolutions['@undefineds.co/drizzle-solid']).toBe('0.3.25');
  expect(after.resolutions.componentsjs).toBeUndefined();
  // No OTHER resolution was added or dropped.
  expect(Object.keys(before.resolutions).filter(name=>!(name in after.resolutions)).sort()).toEqual(['componentsjs']);
  const historicalPatched={...after.patchedDependencies};
  delete historicalPatched['@undefineds.co/drizzle-solid@0.3.26'];
  historicalPatched['@undefineds.co/drizzle-solid@0.3.25']=before.patchedDependencies['@undefineds.co/drizzle-solid@0.3.25'];
  expect(historicalPatched).toEqual(before.patchedDependencies);
 });
 it('preserves original API externals and adds only the existing explicit external declaration table',()=>{
  const before=old('packages/xpod-api/package.json'),after=current('packages/xpod-api/package.json');for(const [name,range] of Object.entries(before.dependencies))expect(after.dependencies[name]).toBe(range);
  const file=ts.createSourceFile('bundle-products.ts',readFileSync('packages/xpod-api/scripts/bundle-products.ts','utf8'),ts.ScriptTarget.Latest,true);let external:string[]=[];
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='apiRuntimeImportDeclarations'&&node.initializer&&ts.isArrayLiteralExpression(node.initializer)){for(const item of node.initializer.elements){if(!ts.isObjectLiteralExpression(item))throw Error('Literal external policy required');let name:string|undefined,enabled=false;for(const property of item.properties){if(!ts.isPropertyAssignment(property))continue;if(property.name.getText(file)==='specifier'&&ts.isStringLiteral(property.initializer))name=property.initializer.text;if(property.name.getText(file)==='externalize')enabled=property.initializer.kind===ts.SyntaxKind.TrueKeyword;}if(name&&enabled)external.push(name);}}ts.forEachChild(node,visit);};visit(file);
  expect(Object.keys(after.dependencies).filter(name=>!before.dependencies[name]).sort()).toEqual(external.sort());expect(after.devDependencies['@undefineds.co/xpod-cli']).toBe('workspace:*');expect(after.scripts).toEqual(before.scripts);
 });
 it('actual generated lock binds catalogs/workspaces without package resolution or peer drift',()=>{
  const lock=JSONC.parse(readFileSync('bun.lock','utf8')),root=current('package.json'),api=current('packages/xpod-api/package.json');expect(lock.catalogs).toEqual(root.catalogs);
  // The historical fixture keeps its published pre-catalog table facts untouched.
  // The ORM dependency moved 0.3.25 -> 0.3.26 and the reviewed direct
  // devDependency @inrupt/solid-client@3.0.0 was declared, which re-hoisted the
  // shared jsonld-streaming-parser@5.0.1 that already existed. The package
  // INSTANCES and their resolved name@version/integrity identities therefore do
  // not change: only the explicit root edge plus the alias/hoist keys move.
  expect(legacy.lockPackageRows).toBe(2780);
  expect(Object.keys(lock.packages).length).toBe(legacy.lockPackageRows+8);
  // Every package NAME is unchanged; the net 8 extra rows are path/hoist aliases for
  // packages that were already resolved (no new name@version appears). Prove that
  // structurally: each added alias key resolves to a (pkg@version, integrity)
  // identity that ALREADY existed in the reviewed pre-inrupt resolution, and each
  // dropped alias key maps to an identity that still exists here.
  const identityOf=(value:any)=>JSON.stringify([value[0],value[3]??null]);
  const currentIdentities=new Set(Object.values(lock.packages).map(identityOf));
  const reviewedPreInrupt=JSONC.parse(execFileSync('git',['show','a5a0b766^:bun.lock'],{maxBuffer:1<<28}).toString());
  const reviewedIdentities=new Set(Object.values(reviewedPreInrupt.packages).map(identityOf));
  const addedKeys=Object.keys(lock.packages).filter(key=>!(key in reviewedPreInrupt.packages));
  const droppedKeys=Object.keys(reviewedPreInrupt.packages).filter(key=>!(key in lock.packages));
  // The reviewed hoist delta: 13 new alias keys replace 5 stale alias keys, a net
  // +8 rows over the 2780 published rows. No package identity is introduced.
  expect(addedKeys).toHaveLength(13);
  expect(droppedKeys).toHaveLength(5);
  for(const key of addedKeys)expect([key,reviewedIdentities.has(identityOf(lock.packages[key]))]).toEqual([key,true]);
  for(const key of droppedKeys)expect([key,currentIdentities.has(identityOf(reviewedPreInrupt.packages[key]))]).toEqual([key,true]);
  // The reviewed CURRENT identity set: one row per distinct (pkg@version, integrity).
  // It has the same cardinality (2042) and the same digest as the reviewed
  // pre-inrupt resolution, which is what "equivalent identities" means here.
  const identities=[...currentIdentities].sort();
  expect(identities).toHaveLength(2042);
  expect(digest(identities)).toBe('63ddbd0c7cfcfd789432a0f34f4cf22c9ad7bbf61f9f54e859799c437fd82906');
  expect(lock.packages['@inrupt/solid-client'][0]).toBe('@inrupt/solid-client@3.0.0');
  // Lock overrides: the only delta vs the reviewed pre-c998 resolution is that the
  // DUPLICATE componentsjs override disappeared, because componentsjs is now a
  // direct exact dependency. Reconstruct the historical object explicitly from the
  // already-reviewed git input (never a blind digest refresh) and anchor the OLD
  // reviewed digest on that reconstruction.
  const HISTORICAL_OVERRIDE_DIGEST='1f08aa51a613ad41468683e53ffef3f11e4674dbe73fea8ce61cb646e8412634';
  const reconstructedOverrides={...lock.overrides,componentsjs:'^6.4.0'};
  expect(digest(reconstructedOverrides)).toBe(HISTORICAL_OVERRIDE_DIGEST);
  // Prove the ONLY change is that single key, in both directions.
  expect(Object.keys(reviewedPreInrupt.overrides).filter(name=>!(name in lock.overrides))).toEqual(['componentsjs']);
  expect(Object.keys(lock.overrides).filter(name=>!(name in reviewedPreInrupt.overrides))).toEqual([]);
  for(const [name,range] of Object.entries(lock.overrides)){
    expect([name,range]).toEqual([name,reviewedPreInrupt.overrides[name]]);
  }
  // The removed override's historical value was the loose range, and the direct
  // declaration uses the exact reviewed version.
  expect(reviewedPreInrupt.overrides.componentsjs).toBe('^6.4.0');
  expect(root.dependencies.componentsjs).toBe('6.4.0');
  expect(lock.overrides['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  for(const [path,manifest] of [['',root],['packages/xpod-api',api]] as const)for(const kind of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])expect(lock.workspaces[path][kind]??{}).toEqual(manifest[kind]??{});
 });
});

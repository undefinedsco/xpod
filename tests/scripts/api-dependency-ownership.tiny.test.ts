import {describe,it,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import legacy from '../fixtures/independent-admission/api-pre-catalog-manifests.original.json';
import ts from 'typescript';
const {JSONC}=createRequire(import.meta.url)('bun') as {JSONC:{parse(text:string):any}};
const normalize=(x:any):any=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])])):x;
const digest=(x:any)=>createHash('sha256').update(JSON.stringify(normalize(x))).digest('hex');
const old=(name:string)=>{const row=legacy.files.find(item=>item.path===name);if(!row)throw Error('Fixed legacy original absent');const bytes=Buffer.from(row.base64,'base64');expect(bytes.length).toBe(row.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);expect(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex')).toBe(row.gitBlobOid);return JSON.parse(bytes.toString());};
const current=(name:string)=>JSON.parse(readFileSync(name,'utf8'));
describe('API declaration ownership proposal, not installer proof',()=>{
 it('preserves every existing root capability range through a single shared catalog',()=>{
  const before=old('package.json'),after=current('package.json');const catalog=after.catalogs['api-producer'];
  // The reviewed ORM bump is the single allowed delta: every other declared range
  // is unchanged, and the drizzle-solid range now resolves to the actual 0.3.26.
  expect(after.catalogs['api-producer']['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  const resolve=(manifest:any,name:string)=>{
   const range=manifest.dependencies?.[name]??manifest.devDependencies?.[name]??manifest.peerDependencies?.[name]??manifest.optionalDependencies?.[name];
   return range==='catalog:api-producer'?catalog[name]:range;
  };
  for(const kind of ['dependencies','devDependencies','peerDependencies','optionalDependencies']){
   expect(Object.keys(after[kind]??{}).sort()).toEqual(Object.keys(before[kind]??{}).sort());
   for(const name of Object.keys(before[kind]??{})){
    // Resolve BOTH sides through the same catalog so a literal historical range and
    // a catalog reference are compared as the same declaration.
    const historical=resolve(before,name),live=resolve(after,name);
    if(name==='@undefineds.co/drizzle-solid'){expect(historical).toBe('0.3.25');expect(live).toBe('0.3.26');}
    else expect(live).toBe(historical);
   }
  }
  expect(after.scripts).toEqual(before.scripts);
  // ORM 0.3.26 is the ONLY reviewed declaration delta: the historical resolutions
  // and patchedDependencies stay as published everywhere else, and the single
  // drizzle-solid pin moves from the historical 0.3.25 fact to the actual 0.3.26.
  expect({...after.resolutions,'@undefineds.co/drizzle-solid':before.resolutions['@undefineds.co/drizzle-solid']}).toEqual(before.resolutions);
  expect(after.resolutions['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  expect(before.resolutions['@undefineds.co/drizzle-solid']).toBe('0.3.25');
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
  // The historical fixture keeps its published pre-catalog table facts. The
  // current lock differs only because the single reviewed ORM dependency moved
  // 0.3.25 -> 0.3.26; the package ROW COUNT is unchanged, so the historical
  // identity still describes the same graph size.
  expect(legacy.lockPackageRows).toBe(2780);
  expect(Object.keys(lock.packages).length).toBe(legacy.lockPackageRows);
  expect(digest(lock.packages)).toBe('4923c8134808a345a9d6a85c283292af6e7ab9bc1a132157b1f9af4572c0ebd8');
  expect(digest(lock.overrides)).toBe('1f08aa51a613ad41468683e53ffef3f11e4674dbe73fea8ce61cb646e8412634');
  expect(lock.overrides['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  for(const [path,manifest] of [['',root],['packages/xpod-api',api]] as const)for(const kind of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])expect(lock.workspaces[path][kind]??{}).toEqual(manifest[kind]??{});
 });
});

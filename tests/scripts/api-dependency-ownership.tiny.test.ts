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
  for(const kind of ['dependencies','devDependencies','peerDependencies','optionalDependencies']){expect(Object.keys(after[kind]??{}).sort()).toEqual(Object.keys(before[kind]??{}).sort());for(const [name,range] of Object.entries(before[kind]??{}))expect(after[kind][name]==='catalog:api-producer'?catalog[name]:after[kind][name]).toBe(range);}
  expect(after.scripts).toEqual(before.scripts);expect(after.resolutions).toEqual(before.resolutions);expect(after.patchedDependencies).toEqual(before.patchedDependencies);
 });
 it('preserves original API externals and adds only the existing explicit external declaration table',()=>{
  const before=old('packages/xpod-api/package.json'),after=current('packages/xpod-api/package.json');for(const [name,range] of Object.entries(before.dependencies))expect(after.dependencies[name]).toBe(range);
  const file=ts.createSourceFile('bundle-products.ts',readFileSync('packages/xpod-api/scripts/bundle-products.ts','utf8'),ts.ScriptTarget.Latest,true);let external:string[]=[];
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='apiRuntimeImportDeclarations'&&node.initializer&&ts.isArrayLiteralExpression(node.initializer)){for(const item of node.initializer.elements){if(!ts.isObjectLiteralExpression(item))throw Error('Literal external policy required');let name:string|undefined,enabled=false;for(const property of item.properties){if(!ts.isPropertyAssignment(property))continue;if(property.name.getText(file)==='specifier'&&ts.isStringLiteral(property.initializer))name=property.initializer.text;if(property.name.getText(file)==='externalize')enabled=property.initializer.kind===ts.SyntaxKind.TrueKeyword;}if(name&&enabled)external.push(name);}}ts.forEachChild(node,visit);};visit(file);
  expect(Object.keys(after.dependencies).filter(name=>!before.dependencies[name]).sort()).toEqual(external.sort());expect(after.devDependencies['@undefineds.co/xpod-cli']).toBe('workspace:*');expect(after.scripts).toEqual(before.scripts);
 });
 it('actual generated lock binds catalogs/workspaces without package resolution or peer drift',()=>{
  const lock=JSONC.parse(readFileSync('bun.lock','utf8')),root=current('package.json'),api=current('packages/xpod-api/package.json');expect(lock.catalogs).toEqual(root.catalogs);expect(Object.keys(lock.packages).length).toBe(legacy.lockPackageRows);expect(digest(lock.packages)).toBe(legacy.lockPackageTableSha256);expect(digest(lock.overrides)).toBe(legacy.lockOverridesSha256);
  for(const [path,manifest] of [['',root],['packages/xpod-api',api]] as const)for(const kind of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])expect(lock.workspaces[path][kind]??{}).toEqual(manifest[kind]??{});
 });
});

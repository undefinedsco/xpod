import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {registryLegalLockEntries,registryLegalLockLayoutEntries} from '../../scripts/lib/independent-admission/legal-registry-originals';
const sri=(seed:string)=>'sha512-'+createHash('sha512').update(seed).digest('base64');
const lock=(packages:Record<string,unknown>,workspaces?:Record<string,unknown>,version=1)=>
 JSON.stringify({lockfileVersion:version,workspaces,packages});
const raw=(value:string)=>Buffer.from(value);
const typescript=sri('typescript'),reactDom=sri('react-dom'),react=sri('react');
const base=lock({
 'typescript':['typescript@5.9.2','',{},typescript],
 '@types/react-dom/@types/react':['@types/react@19.0.0','',{},react],
 '@types/react-dom':['@types/react-dom@19.0.0','',{},reactDom],
 '@undefineds.co/pod-settings/typescript':['typescript@5.9.2','',{},typescript],
 'git-dep':['git-dep@1.0.0','git+https://example.invalid/repo',{},''],
 'workspace-root':['@undefineds.co/pod','workspace:*',{},''],
},{
 '':{name:'root',version:'0.0.0'},
 'packages/pod-settings':{name:'@undefineds.co/pod-settings',version:'0.0.0'},
});

test('layout rows resolve scoped pairs, workspaces and nested node_modules exactly',()=>{
 const rows=registryLegalLockLayoutEntries(raw(base));
 expect(rows.map(row=>row.logicalPath)).toEqual([
  'node_modules/typescript',
  'node_modules/@types/react-dom/node_modules/@types/react',
  'node_modules/@types/react-dom',
  'packages/pod-settings/node_modules/typescript',
 ]);
 expect(rows.every(row=>Object.isFrozen(row))).toBe(true);
 expect(rows[2]).toEqual({logicalPath:'node_modules/@types/react-dom',name:'@types/react-dom',version:'19.0.0',integrity:reactDom});
 expect(rows[1]).toEqual({logicalPath:'node_modules/@types/react-dom/node_modules/@types/react',name:'@types/react',version:'19.0.0',integrity:react});
 expect(rows[0]).toEqual({logicalPath:'node_modules/typescript',name:'typescript',version:'5.9.2',integrity:typescript});
 expect(rows[3]).toEqual({logicalPath:'packages/pod-settings/node_modules/typescript',name:'typescript',version:'5.9.2',integrity:typescript});
 expect(Object.isFrozen(rows)).toBe(true);
});

test('same parser result as registryLegalLockEntries',()=>{
 const entries=registryLegalLockEntries(raw(base));
 const rows=registryLegalLockLayoutEntries(raw(base));
 expect([...new Set(rows.map(row=>row.name+'@'+row.version+'='+row.integrity))].sort()).toEqual([...entries].map(([key,value])=>key+'='+value).sort());
 expect(entries.get('typescript@5.9.2')).toBe(typescript);
 expect(entries.size).toBe(3);
 expect(rows.length).toBe(4);
});

test('multiple versions and trailing-comma JSONC are preserved without alias semantics',()=>{
 const multiple=lock({
  'a/typescript':['typescript@5.8.0','',{},sri('old')],
  'typescript':['typescript@5.9.2','',{},typescript],
  'b/@scope/pkg':['@scope/pkg@2.0.0','',{},sri('pkg')],
 },undefined).replace('}]','},]');
 const rows=registryLegalLockLayoutEntries(raw(multiple));
 expect(rows.map(row=>row.logicalPath)).toEqual([
  'node_modules/a/node_modules/typescript',
  'node_modules/typescript',
  'node_modules/b/node_modules/@scope/pkg',
 ]);
 expect(rows.map(row=>row.integrity)).toEqual([sri('old'),typescript,sri('pkg')]);
 expect(registryLegalLockEntries(raw(multiple)).size).toBe(3);
});

test('alias keys preserve installed logicalPath while name/version/SRI stay canonical',()=>{
 const width=sri('string-width-4.2.3'),emoji=sri('emoji-regex-9.2.2');
 // Bun array rows: [coordinate, registry, dependencies, ..., integrity]
 const aliased=lock({
  'string-width-cjs':['string-width@4.2.3','https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz',{emoji:'emoji-regex'},width],
  'emoji-regex':['emoji-regex@9.2.2','https://registry.npmjs.org/emoji-regex/-/emoji-regex-9.2.2.tgz',{},emoji],
  'string-width-cjs/emoji-regex':['emoji-regex@9.2.2','https://registry.npmjs.org/emoji-regex/-/emoji-regex-9.2.2.tgz',{},emoji],
 });
 const rows=registryLegalLockLayoutEntries(raw(aliased));
 expect(rows).toEqual([
  {logicalPath:'node_modules/string-width-cjs',name:'string-width',version:'4.2.3',integrity:width},
  {logicalPath:'node_modules/emoji-regex',name:'emoji-regex',version:'9.2.2',integrity:emoji},
  {logicalPath:'node_modules/string-width-cjs/node_modules/emoji-regex',name:'emoji-regex',version:'9.2.2',integrity:emoji},
 ]);
 // The alias is not a coordinate: lock entries keep row[0] identity only.
 expect([...registryLegalLockEntries(raw(aliased)).keys()]).toEqual(['string-width@4.2.3','emoji-regex@9.2.2']);
 expect(registryLegalLockEntries(raw(aliased)).get('string-width-cjs@4.2.3')).toBeUndefined();
});

test('ambiguous or unsafe keys are rejected',()=>{
 for(const packages of [
  {'/@scope/pkg':['@scope/pkg@1.0.0','',{},sri('x')]},
  {'node_modules/typescript':['typescript@1.0.0','',{},sri('x')]},
  {'typescript//x':['x@1.0.0','',{},sri('x')]},
  {'typescript':['typescript@1.0.0','',{},sri('x')],'nested/typescript':['typescript@1.0.0','',{},'sha512-'+'A'.repeat(86)+'==']},
  {'typescript':['typescript@1.0.0','',{},sri('x')],'a/typescript':['typescript@1.0.0','',{},sri('y')]},
 ]) expect(()=>registryLegalLockLayoutEntries(raw(lock(packages)))).toThrow();
 expect(()=>registryLegalLockLayoutEntries(raw(lock({
  'packages/settings/typescript':['typescript@1.0.0','',{},sri('x')],
 },{'packages/settings':{name:'@undefineds.co/pod-settings'},'packages/other':{name:'@undefineds.co/pod-settings'}})))).toThrow();
 expect(()=>registryLegalLockLayoutEntries(raw(lock({
  'typescript':['typescript@1.0.0','',{},sri('x')],
 },{'../escape':{name:'escape'}})))).toThrow();
});

test('git rows without registry SRI and workspace rows are skipped, workspaces absent tolerated',()=>{
 const skipped=lock({
  'git-only':['git-only@1.0.0','git+ssh://example.invalid/x','',{}],
  'no-sri':['no-sri@1.0.0','',{}],
  'typescript':['typescript@5.9.2','',{},typescript],
 });
 expect(registryLegalLockLayoutEntries(raw(skipped)).map(row=>row.name)).toEqual(['typescript']);
 expect(registryLegalLockEntries(raw(skipped)).size).toBe(1);
 expect(()=>registryLegalLockLayoutEntries(raw(JSON.stringify({lockfileVersion:2,packages:{}})))).toThrow('unsupported immutable Bun lock');
});

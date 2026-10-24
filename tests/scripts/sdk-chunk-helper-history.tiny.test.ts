import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import before from '../fixtures/independent-admission/pre-sdk-chunk-helper-group-hashes.original.json';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function recipes(file:string,name:string):unknown[]{
 const source=fs.readFileSync('scripts/lib/independent-admission/'+file,'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),names=new Set(['HELPERS','REVIEWED_OBSERVER_SHA',name]);
 const declarations=ast.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&(names.has(d.name.text)||(d.name.text.startsWith('PRE_LIFETIME_')||d.name.text.startsWith('PRE_SIGQ_')||d.name.text.startsWith('PRE_CLONE3_'))||d.name.text==='LIFETIME_HELPER_GROUP'))).map(n=>n.getText(ast)).join('\n');
 const scope:{result?:unknown[]}={};runInNewContext(ts.transpileModule(declarations+'\nresult='+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText,scope,{timeout:1000});return scope.result!;
}
test('SDK chunk addition preserves all 76 historical helper and observer whole recipes',()=>{
 for(const [file,name,key,count] of [['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS','helpers',25],['qlever-sdk-generation.ts','REVIEWED_OBSERVER_GROUPS','observer',34],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS','fetch',29]]as const){
  const groups=recipes(file,name);expect(groups).toHaveLength(count);expect(groups.slice(0,before[key].length).map(hash)).toEqual(before[key]);
  const last=groups.at(-1)!;const entries=Array.isArray(last)?last as [string,string][]:Object.entries(last as Record<string,string>);
  expect(entries.some(([name])=>name.endsWith('sdk-original-chunk-store.py'))).toBe(true);
  for(const [name,expected]of entries){const path=name.startsWith('qlever/')?name:'qlever/scripts/'+name;expect(createHash('sha256').update(fs.readFileSync(path)).digest('hex')).toBe(expected);}
 }
});

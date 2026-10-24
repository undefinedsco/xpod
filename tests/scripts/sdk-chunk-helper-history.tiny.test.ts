import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import before from '../fixtures/independent-admission/pre-sdk-chunk-helper-group-hashes.original.json';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function recipes(file:string,name:string):unknown[]{
 const source=fs.readFileSync('scripts/lib/independent-admission/'+file,'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 // Recursive actual const-initializer dependency collection from the requested
 // group, exactly like the main controller fixture: no prefix whitelist, so a
 // newly renamed historical const cannot silently drop out.
 const constants=new Map<string,ts.Expression>();
 for(const statement of ast.statements)if(ts.isVariableStatement(statement)&&(statement.declarationList.flags&ts.NodeFlags.Const))for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&declaration.initializer)constants.set(declaration.name.text,declaration.initializer);
 if(!constants.has(name))throw Error('missing top-level const '+name);
 const needed=new Set<string>([name]),visit=(node:ts.Node):void=>{
  if(ts.isIdentifier(node)&&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node)&&!(ts.isPropertyAssignment(node.parent)&&node.parent.name===node)){const initializer=constants.get(node.text);if(initializer&&!needed.has(node.text)){needed.add(node.text);visit(initializer);}}
  ts.forEachChild(node,visit);
 };
 visit(constants.get(name)!);
 const declarations=ast.statements.filter((statement):statement is ts.VariableStatement=>ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&needed.has(declaration.name.text))).map(node=>node.getText(ast)).join('\n');
 const scope:{result?:unknown[]}={};runInNewContext(ts.transpileModule(declarations+'\nresult='+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText,scope,{timeout:1000});return scope.result!;
}
test('SDK chunk addition preserves all 76 historical helper and observer whole recipes',()=>{
 for(const [file,name,key,count] of [['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS','helpers',29],['qlever-sdk-generation.ts','REVIEWED_OBSERVER_GROUPS','observer',39],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS','fetch',32]]as const){
  const groups=recipes(file,name);expect(groups).toHaveLength(count);expect(groups.slice(0,before[key].length).map(hash)).toEqual(before[key]);
  const last=groups.at(-1)!;const entries=Array.isArray(last)?last as [string,string][]:Object.entries(last as Record<string,string>);
  expect(entries.some(([name])=>name.endsWith('sdk-original-chunk-store.py'))).toBe(true);expect(entries.some(([name])=>name.endsWith('sdk-generated-vma-originals.py'))).toBe(true);
  for(const [name,expected]of entries){const path=name.startsWith('qlever/')?name:'qlever/scripts/'+name;expect(createHash('sha256').update(fs.readFileSync(path)).digest('hex')).toBe(expected);}
 }
});

import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
import {selectSdkControllerHelperGroup as select} from '../../scripts/lib/independent-admission/sdk-controller-helper-groups';
function groupsFor(file:string,groupName:string){
 const root=path.resolve(import.meta.dirname,'../..'),source=fs.readFileSync(path.join(root,'scripts/lib/independent-admission',file),'utf8');
 const ast=ts.createSourceFile('controller.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),names=new Set(['HELPERS',groupName]);
 const declarations=ast.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&(names.has(row.name.text)||row.name.text==='PRE_LIFETIME_'+groupName||row.name.text==='PRE_SIGQ_'+groupName||row.name.text==='LIFETIME_HELPER_GROUP'))).map(node=>node.getText(ast)).join('\n');
 const compiled=ts.transpileModule(declarations+'\nresult='+groupName+';', {compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText,scope:{result?:readonly (readonly (readonly[string,string])[])[]}={};runInNewContext(compiled,scope,{timeout:100});return {root,groups:scope.result!};
}
for(const [file,name,count]of[['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS',24],['qlever-sdk-upstream-source.ts','REVIEWED_HELPER_GROUPS',6],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS',28],['qlever-sdk-readonly-executor.ts','REVIEWED_READONLY_HELPER_GROUPS',5]]as const)it(file+' selects whole historical/current actual controller import tuples, never independent file unions',()=>{
 const{root,groups}=groupsFor(file,name);expect(groups).toHaveLength(count);
 for(const group of groups)expect(select(groups,new Map(group))).toBe(group);
 const latest=groups[groups.length-1]!,actual=new Map(latest.map(([name])=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,name.startsWith('qlever/')||name.startsWith('scripts/')?name:'qlever/scripts/'+name))).digest('hex')]));expect(select(groups,actual)).toBe(latest);
 for(const group of groups)for(const [name]of group){const missing=new Map(group);missing.delete(name);expect(()=>select(groups,missing)).toThrow();const unknown=new Map(group);unknown.set(name,'f'.repeat(64));expect(()=>select(groups,unknown)).toThrow();}
 expect(groups[0]!.map(([name])=>name)).toEqual(latest.slice(0,groups[0]!.length).map(([name])=>name));
 if(file==='qlever-sdk-generation.ts'||file==='qlever-sdk-fetchcontent.ts')expect(latest.slice(groups[0]!.length).map(([name])=>name)).toEqual(['sdk-generated-vma-originals.py','sdk-coordinated-wait.py','sdk-original-chunk-store.py','sdk-raw-wire-reader.py','sdk-executable-memory-policy.py']);else expect(latest).toHaveLength(groups[0]!.length);
 // Every mixture must itself be one reviewed whole tuple, otherwise rejection.
 for(const historical of groups)for(const [name,sha]of historical){const mixed=new Map(latest);mixed.set(name,sha);const matches=groups.filter(group=>group.length===mixed.size&&group.every(([key,value])=>mixed.get(key)===value));if(matches.length===1)expect(select(groups,mixed)).toBe(matches[0]);else expect(()=>select(groups,mixed)).toThrow();}
});

it('bounds twenty-eight reviewed whole tuples without accepting a twenty-ninth or ambiguous tuple',()=>{
 const groups=Array.from({length:28},(_,i)=>Object.freeze([Object.freeze(['helper',String(i)] as const)]));
 expect(select(groups,new Map(groups[27]!))).toBe(groups[27]);
 expect(()=>select([...groups,[['helper','28']]],new Map([['helper','28']]))).toThrow();
 expect(()=>select([...groups.slice(0,25),groups[0]!],new Map(groups[0]!))).toThrow();
});

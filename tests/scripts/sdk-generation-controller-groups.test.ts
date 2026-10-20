import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
import {selectSdkControllerHelperGroup as select} from '../../scripts/lib/independent-admission/sdk-controller-helper-groups';
it('generation selects whole legacy/current actual controller import tuples, never independent file unions',()=>{
 const root=path.resolve(import.meta.dirname,'../..'),source=fs.readFileSync(path.join(root,'scripts/lib/independent-admission/qlever-sdk-generation.ts'),'utf8');
 const ast=ts.createSourceFile('controller.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const names=new Set(['HELPERS','REVIEWED_CONTROLLER_HELPER_GROUPS']);const declarations=ast.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&names.has(row.name.text))).map(node=>node.getText(ast)).join('\n');
 const compiled=ts.transpileModule(declarations+'\nresult=REVIEWED_CONTROLLER_HELPER_GROUPS;', {compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText;const scope:{result?:readonly (readonly (readonly[string,string])[])[]}={};runInNewContext(compiled,scope,{timeout:100});const groups=scope.result!;expect(groups).toHaveLength(2);
 for(const group of groups)expect(select(groups,new Map(group))).toBe(group);
 const actual=new Map(groups[1]!.map(([name])=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,'qlever/scripts',name))).digest('hex')]));expect(select(groups,actual)).toBe(groups[1]);
 for(const group of groups)for(const [name] of group){const missing=new Map(group);missing.delete(name);expect(()=>select(groups,missing)).toThrow();const unknown=new Map(group);unknown.set(name,'f'.repeat(64));expect(()=>select(groups,unknown)).toThrow();}
 expect(groups[0]!.map(([name])=>name)).toEqual(groups[1]!.map(([name])=>name));
});

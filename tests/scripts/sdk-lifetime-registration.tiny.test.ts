import{test,expect}from'bun:test';import fs from'node:fs';import{createHash}from'node:crypto';import{runInNewContext}from'node:vm';import ts from'typescript';
import before from'../fixtures/independent-admission/pre-sdk-lifetime-hashes.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('lifetime registration retains all 293 complete historical source recipes',()=>{for(const[k,v]of Object.entries({api,sdk,consumer,ci}))expect(v.slice(0,before.groups[k as keyof typeof before.groups].length).map(hash)).toEqual(before.groups[k as keyof typeof before.groups]);});
test('all 97 historical Python observer and helper recipes remain exact',()=>{
 for(const[key,hashes]of Object.entries(before.helpers)){
  const[file,name]=key.split('#'),source=fs.readFileSync(file!,'utf8'),ast=ts.createSourceFile(file!,source,ts.ScriptTarget.Latest,true);const chunks:string[]=[];
  for(const stmt of ast.statements)if(ts.isVariableStatement(stmt))for(const d of stmt.declarationList.declarations)if(/^(HELPERS|LOCAL_HELPERS|REVIEWED_.*|PRE_(?:LIFETIME|SIGQ|CLONE3)_.*|LIFETIME_HELPER_GROUP)$/.test(d.name.getText(ast)))chunks.push('const '+d.getText(ast)+';');
  const scope:{result?:unknown[]}={};runInNewContext(ts.transpileModule(chunks.join('\n')+'\nresult='+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText,scope,{timeout:1000});expect(scope.result!.slice(0,hashes.length).map(hash)).toEqual(hashes);
 }
});

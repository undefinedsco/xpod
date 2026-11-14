import{test,expect}from'bun:test';import fs from'node:fs';import{createHash}from'node:crypto';import{runInNewContext}from'node:vm';import ts from'typescript';
import before from'../fixtures/independent-admission/pre-sdk-clone3-hashes.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('Clone3/BTI registration retains all 301 complete historical source recipes',()=>{for(const[k,v]of Object.entries({api,sdk,consumer,ci}))expect(v.slice(0,before.groups[k as keyof typeof before.groups].length).map(hash)).toEqual(before.groups[k as keyof typeof before.groups]);});
test('all 103 historical Python observer and helper recipes remain exact',()=>{
 for(const[key,hashes]of Object.entries(before.helpers)){
  const[file,name]=key.split('#'),source=fs.readFileSync(file!,'utf8'),ast=ts.createSourceFile(file!,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  // Recursive actual const-initializer dependency collection (no name whitelist).
  const constants=new Map<string,ts.Expression>();
  for(const statement of ast.statements)if(ts.isVariableStatement(statement)&&(statement.declarationList.flags&ts.NodeFlags.Const))for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&declaration.initializer)constants.set(declaration.name.text,declaration.initializer);
  if(!constants.has(name))throw Error('missing top-level const '+name);
  const needed=new Set<string>([name]),visit=(node:ts.Node):void=>{
   if(ts.isIdentifier(node)&&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node)&&!(ts.isPropertyAssignment(node.parent)&&node.parent.name===node)){const initializer=constants.get(node.text);if(initializer&&!needed.has(node.text)){needed.add(node.text);visit(initializer);}}
   ts.forEachChild(node,visit);
  };
  visit(constants.get(name)!);
  const chunks:string[]=ast.statements.filter((statement):statement is ts.VariableStatement=>ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&needed.has(declaration.name.text))).map(node=>'const '+node.declarationList.declarations[0]!.getText(ast)+';');
  const scope:{result?:unknown[]}={};runInNewContext(ts.transpileModule(chunks.join('\n')+'\nresult='+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None}}).outputText,scope,{timeout:1000});expect(scope.result!.slice(0,hashes.length).map(hash)).toEqual(hashes);
 }
});

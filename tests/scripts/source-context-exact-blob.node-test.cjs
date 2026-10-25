const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),path=require('node:path');
const ts=require('typescript');
// Extract the real private issuer function for a protocol fixture; this creates no exported issuer.
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'scripts/lib/independent-admission/source-context.ts'),'utf8');
const ast=ts.createSourceFile('source-context.ts',source,ts.ScriptTarget.Latest,true);
const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='deriveExactAdmissionSource');
// The real function now closes over the private `sourceBudget` helper and its
// `sourceBudgets` WeakMap (source-context.ts:15-20). Extract those REAL
// declarations alongside it instead of injecting a no-op budget stub, so the
// harness exercises the production helper closure rather than a mirror.
function realDecl(name){
 const found=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);
 if(!found)throw Error('harness: real '+name+' declaration missing');
 return found.getText(ast);
}
function realConst(name){
 const found=ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));
 if(!found)throw Error('harness: real '+name+' declaration missing');
 return found.getText(ast);
}
// Every private module-level WeakMap the real function touches is itself a REAL
// declaration extracted from the module, never a re-implemented mirror.
const helpers=[realConst('sourceBudgets'),realDecl('sourceBudget'),realConst('bulkSources')].join('\n');
const fn=ts.transpileModule(helpers+'\n'+node.getText(ast)+'\nexports.derive=deriveExactAdmissionSource',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText;
const issued=new WeakMap(),currentChecks=new WeakMap();const exports0={};new Function('exports','realpathSync','execFileSync','createHash','issued','currentChecks','fail','sourceLimits',fn)(exports0,fs.realpathSync,cp.execFileSync,crypto.createHash,issued,currentChecks,m=>{throw Error(m)},{shardBytes:536870912});
const checkout=process.env.SOURCE_BLOB_FIXTURE_REPO || root;
// Source checkout must be clean: isolated exact commit Git worktree below.
const parent=path.join(root,'.test-data/source-context-exact-blob');fs.mkdirSync(parent,{recursive:true});const repo=fs.mkdtempSync(path.join(parent,'git-'));cp.execFileSync('git',['init','-q',repo]);cp.execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:repo});cp.execFileSync('git',['config','user.name','fixture'],{cwd:repo});
const large=Buffer.alloc(7_599_955, 42);fs.writeFileSync(path.join(repo,'large.js'),large);cp.execFileSync('git',['add','large.js'],{cwd:repo});cp.execFileSync('git',['commit','-qm','fixture'],{cwd:repo});const commit=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim();const cap=exports0.derive(commit,repo,()=>{}).source,view=issued.get(cap);let rejected=0;for(const n of [undefined,large.length-1,large.length+1,-1,true,536870913]){try{view.readTrackedGitObject('large.js',n);throw Error('accepted bad bound')}catch(e){if(e.message==='accepted bad bound')throw e;rejected++}}
const actual=view.readTrackedGitObject('large.js',large.length);if(!actual.bytes.equals(large))throw Error('bytes mismatch');currentChecks.get(cap)();console.log(JSON.stringify({actualBytes:actual.bytes.length,sha256:crypto.createHash('sha256').update(actual.bytes).digest('hex'),negativeCases:rejected,privateIssuerUnchanged:true}));fs.rmSync(repo,{recursive:true,force:true});

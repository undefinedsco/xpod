import{test,expect}from'bun:test';import{readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync}from'node:fs';import{spawnSync}from'node:child_process';import path from'node:path';
test('actual pack Git helper observes one NUL-delimited exact tracked set',()=>{
 const root=path.resolve('.test-data/api-performance-git');mkdirSync(root,{recursive:true});const repo=mkdtempSync(path.join(root,'repo-'));
 try{
  const run=(args:string[])=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);};run(['init','-q']);
  const names=['ordinary',' leading','trailing ','line\nbreak','中文','quote"name','-flag','[path]'];for(const n of names)writeFileSync(path.join(repo,n),'fixture');run(['add','--',...names]);
  const source=readFileSync('packages/xpod-api/scripts/pack.ts','utf8');const helper=source.match(/^const git=.*$/m)![0];const declaration=source.match(/^const trackedSourceFiles=.*$/m)![0];let calls=0;
  const wrapped=(...args:any[])=>{calls++;return (spawnSync as any)(...args);};
  const js=helper.replace('args:string[]','args')+'\n'+declaration+'\nreturn trackedSourceFiles;';const actual=new Function('spawnSync','repo',js)(wrapped,repo) as Set<string>;
  expect(calls).toBe(1);expect(actual.size).toBe(names.length);for(const n of names)expect(actual.has(n)).toBe(true);for(const n of ['', 'ordinary\n','leading','trailing','untracked','../ordinary'])expect(actual.has(n)).toBe(false);
 }finally{rmSync(repo,{recursive:true,force:true});}
});

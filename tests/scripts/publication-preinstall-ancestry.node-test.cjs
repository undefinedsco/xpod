const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const yaml=require('yaml');
test('publish resolver executes trusted ancestry check before all setup/install',()=>{
 const workflow=yaml.parse(fs.readFileSync('.github/workflows/independent-publication.yml','utf8'));
 const matrix=workflow.jobs['consumer-matrix'].steps,prepare=workflow.jobs.publication.steps;
 const step=matrix.findIndex(row=>row.name==='Require exact staging ancestry before installing or executing source');
 assert.equal(step,1);assert.equal(matrix[0].uses,'actions/checkout@v4');
 assert.equal(matrix[step].run,prepare.find(row=>row.name===matrix[step].name).run);
 assert.equal(matrix[step].env.SOURCE_SHA,'${{ inputs.source_sha }}');
 assert.ok(matrix.slice(step+1).some(row=>row.run==='bun install --frozen-lockfile'));
 const base=path.resolve('.test-data/publication-preinstall-git');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
 const git=(...args)=>{const p=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
 const check=source=>spawnSync('bash',['-c',matrix[step].run+'\nprintf reached-install'],{cwd:root,encoding:'utf8',env:{...process.env,SOURCE_SHA:source}});
 try{
  git('init','-q','-b','staging');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(root,'input'),'one');git('add','input');git('commit','-qm','one');const ancestor=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(root,'input'),'two');git('commit','-qam','two');const tip=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/staging',tip);
  git('checkout','-q','--detach',ancestor);const accepted=check(ancestor);assert.equal(accepted.status,0,accepted.stderr);assert.equal(accepted.stdout,'reached-install');
  fs.writeFileSync(path.join(root,'input'),'dirty');const dirty=check(ancestor);assert.notEqual(dirty.status,0);assert.equal(dirty.stdout,'');git('checkout','--','input');
  const mismatch=check(tip);assert.notEqual(mismatch.status,0);assert.equal(mismatch.stdout,'');
  git('checkout','-q','--orphan','unrelated');fs.writeFileSync(path.join(root,'input'),'unrelated');git('add','input');git('commit','-qm','unrelated');const unrelated=check(git('rev-parse','HEAD'));assert.notEqual(unrelated.status,0);assert.equal(unrelated.stdout,'');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {validatePublicationControlInput}=require('../../scripts/lib/publication-control-input.cjs');
const source='a'.repeat(40);
const good={event:'workflow_dispatch',ref:'refs/heads/staging',operation:'independent-publication',sourceSha:source,mode:'prepare',coordinates:JSON.stringify({schemaVersion:2,sourceSha:source,products:[{}]})};
test('explicit prepare/publish route validates data, issues no approval',()=>{
 for(const mode of ['prepare','publish'])assert.deepEqual(validatePublicationControlInput({...good,mode}),{sourceSha:source,mode});
});
test('ordinary events, other refs/op/mode/source and malformed selectors fail',()=>{
 for(const bad of [{event:'push'},{event:'pull_request'},{ref:'refs/heads/main'},{ref:'refs/tags/staging'},{operation:'publish'},{mode:'Publish'},{mode:''},{sourceSha:'staging'},{coordinates:'{}'},{coordinates:'not json'},{coordinates:JSON.stringify({schemaVersion:2,sourceSha:'b'.repeat(40),products:[{}]})},{coordinates:JSON.stringify({schemaVersion:2,sourceSha:source,products:[]})},{coordinates:'x'.repeat(1024*1024+1)},{extra:true}])assert.throws(()=>validatePublicationControlInput({...good,...bad}));
});
test('actual command rejects invalid route without printing selector or secrets',()=>{
 const result=spawnSync(process.execPath,['scripts/lib/publication-control-input.cjs'],{encoding:'utf8',env:{PATH:process.env.PATH,CONTROL_EVENT:'push',CONTROL_COORDINATES:'private-marker'}});
 assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/private-marker/);
});
test('workflow route is isolated from ordinary CI and prepares without publish token',()=>{
 const fs=require('node:fs'),yaml=require('yaml');
 const ci=yaml.parse(fs.readFileSync('.github/workflows/ci.yml','utf8'));
 const publication=yaml.parse(fs.readFileSync('.github/workflows/independent-publication.yml','utf8'));
 for(const job of ['test','integration-lite','bun-runtime','integration-full'])assert.equal(ci.jobs[job].if,"${{ github.event_name != 'workflow_dispatch' }}");
 assert.equal(ci.concurrency['cancel-in-progress'],"${{ github.event_name != 'workflow_dispatch' }}");
 assert.equal(ci.jobs['independent-publication'].needs,'publication-control');
 assert.equal(ci.jobs['independent-publication'].uses,'./.github/workflows/independent-publication.yml');
 assert.deepEqual(Object.keys(ci.jobs['independent-publication'].secrets),['NPM_TOKEN']);
 assert.equal(ci.jobs['independent-publication'].secrets.NPM_TOKEN,"${{ inputs.mode == 'publish' && secrets.NPM_TOKEN || '' }}");
 assert.equal(publication.concurrency['cancel-in-progress'],false);
 assert.equal(publication.jobs.publication.needs,'control');
 assert.equal(publication.jobs['consumer-matrix'].needs,'control');
 for(const job of [ci.jobs['publication-control'],publication.jobs.control]){
  const step=job.steps.find(step=>step.run);assert.equal(step.run,'node scripts/lib/publication-control-input.cjs');
  assert.deepEqual(Object.keys(step.env).sort(),['CONTROL_COORDINATES','CONTROL_EVENT','CONTROL_MODE','CONTROL_OPERATION','CONTROL_REF','CONTROL_SOURCE_SHA']);
 }
});

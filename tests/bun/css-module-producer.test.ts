import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const repo = path.resolve(import.meta.dir, '../..');
const base = path.join(repo, '.test-data/css-module-producer-contract');
function python(code: string) {
  mkdirSync(base, { recursive: true });
  const prelude = `import importlib.util,json,pathlib,tempfile,sys,hashlib,base64,copy,zipfile,tarfile,io\nrepo=pathlib.Path(sys.argv[1]);base=pathlib.Path(sys.argv[2])\nspec=importlib.util.spec_from_file_location('producer',repo/'scripts/css-module-producer.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n`;
  const result = spawnSync('python3', ['-c', prelude + code, repo, base], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
test('CSS uses normal minimal dist chain and runtime-only installed patch check', () => {
  const rows = JSON.parse(python(`print(json.dumps(m.phase_plan(repo,base/'out','0.0.0-preview.1','darwin-arm64')))`));
  expect(rows.map((r: string[]) => r[0])).toEqual(['install','tools','client','cli','afs-client','dependency-state','pack']);
  expect(rows[5][1]).toContain('--runtime-only');
  expect(rows[6][1]).toContain('packages/xpod-css/scripts/build-package.ts');
  expect(rows[6][1]).toContain('--native-runtime-input');
  expect(JSON.stringify(rows)).not.toContain('build:packages');
});
test('same-run acquisition requires exact completed native job, original upload digest and current attempt', () => {
 python(`identity={'runId':42,'runAttempt':2,'actualCheckoutSha':'a'*40,'runHeadSha':'b'*40,'target':'darwin-arm64'}
env={'CSS_NATIVE_ARTIFACT_ID':'7','CSS_NATIVE_ARTIFACT_DIGEST':'c'*64,'CSS_NATIVE_RUN_ID':'42','CSS_NATIVE_RUN_ATTEMPT':'2','CSS_NATIVE_SOURCE_SHA':'a'*40}
artifact={'id':7,'expired':False,'name':'qlever-local-runtime-darwin-arm64-'+'a'*40,'workflow_run':{'id':42,'head_sha':'b'*40},'digest':'sha256:'+'c'*64,'size_in_bytes':10,'created_at':'2026-10-15T01:01:00Z','updated_at':'2026-10-15T01:01:01Z'}
job={'id':8,'name':'native / build','run_id':42,'run_attempt':2,'head_sha':'b'*40,'status':'completed','conclusion':'success','started_at':'2026-10-15T01:00:00Z','completed_at':'2026-10-15T01:02:00Z'}
jobs={'total_count':1,'jobs':[job]}
assert m.validate_native_metadata(identity,env,artifact,jobs)==('c'*64,8)
for delta in [{'run_attempt':1},{'head_sha':'a'*40},{'status':'in_progress'},{'conclusion':'failure'},{'name':'other / build'},{'completed_at':'2026-10-15T01:00:00Z'}]:
 try:m.validate_native_metadata(identity,env,artifact,{'total_count':1,'jobs':[dict(job,**delta)]})
 except ValueError:pass
 else:raise AssertionError('bad native job accepted')
for delta in [{'digest':'sha256:'+'d'*64},{'expired':True},{'workflow_run':{'id':43,'head_sha':'b'*40}},{'name':'wrong'},{'id':9}]:
 try:m.validate_native_metadata(identity,env,dict(artifact,**delta),jobs)
 except ValueError:pass
 else:raise AssertionError('bad artifact accepted')
for key,value in [('CSS_NATIVE_RUN_ATTEMPT','1'),('CSS_NATIVE_SOURCE_SHA','b'*40),('CSS_NATIVE_RUN_ID','43')]:
 try:m.validate_native_metadata(identity,dict(env,**{key:value}),artifact,jobs)
 except ValueError:pass
 else:raise AssertionError('bad output binding accepted')
`);
});
test('original ZIP layout rejects links and extras before expanding archive', () => {
 python(`with tempfile.TemporaryDirectory(dir=base) as directory:
 out=pathlib.Path(directory)
 for names in [['../escape'],['qlever-local-runtime-darwin-arm64.tar.gz','qlever-local-acceptance.json','extra']]:
  original=out/str(len(names));original.mkdir()
  with zipfile.ZipFile(original/'native.zip','w') as z:
   for name in names:z.writestr(name,b'tiny')
  try:m.unpack_native(original,out/'runtime','darwin-arm64')
  except ValueError:pass
  else:raise AssertionError('bad zip accepted')
`);
});
test('credentials are absent from build subprocesses and redirects do not inherit authorization', () => {
 python(`env={'GH_TOKEN':'secret','GITHUB_TOKEN':'secret2','PATH':'unchanged'}
for phase in ['install','tools','client','cli','afs-client','dependency-state','pack']:
 assert m.phase_environment(env,phase)=={'PATH':'unchanged'}
assert m.NoRedirect().redirect_request(None,None,302,'',{},'https://example.invalid') is None
`);
});
test('workflow has precise native output bindings and preview-only permissions', () => {
 const parsed = spawnSync('bun', ['-e', "import {readFileSync} from 'node:fs';console.log(JSON.stringify(Bun.YAML.parse(readFileSync(process.argv[1],'utf8'))));", path.join(repo,'.github/workflows/css-module-product.yml')], {encoding:'utf8'});
 expect(parsed.status).toBe(0);
 const workflow = JSON.parse(parsed.stdout);
 expect(workflow.jobs.products['runs-on']).toBe('${{ matrix.runner }}');
 expect(workflow.jobs.products.permissions).toEqual({contents:'read',actions:'read'});
 const native = readFileSync(path.join(repo,'.github/workflows/build-qlever-macos-runtime.yml'),'utf8');
 expect(native).toContain('artifact_id:'); expect(native).toContain('steps.upload.outputs.artifact-id');
 const text = JSON.stringify(workflow);
 for (const key of ['CSS_NATIVE_ARTIFACT_ID','CSS_NATIVE_ARTIFACT_DIGEST','CSS_NATIVE_SOURCE_SHA','CSS_NATIVE_RUN_ID','CSS_NATIVE_RUN_ATTEMPT']) expect(text).toContain(key);
 for (const forbidden of ['npm publish','workflow_dispatch --','gh release','docker push','refs/tags']) expect(text).not.toContain(forbidden);
 expect(workflow.on.pull_request.paths).toBeUndefined();
});
test('CSS facts bind actual normal compiler/material schema and retain preview admission', () => {
 python(`with tempfile.TemporaryDirectory(dir=base) as directory:
 out=pathlib.Path(directory);stage=out/'stage';stage.mkdir();archive=out/'product.tgz';archive.write_bytes(b'fixture only')
 records={'package.json':{'name':'@undefineds.co/xpod-css-darwin-arm64','version':'0.1.0','private':True,'xpodModule':{'id':'css','platform':'darwin','arch':'arm64'}},'provenance/compiler.json':{'compiledSources':[{'source':'src/css/main.ts'}]},'provenance/css-scoped-components.json':{},'provenance/css-resource-plan.json':{},'provenance/identity-dedup.json':{},'provenance/publication.json':{'mode':'preview','version':'0.1.0','sourceCommit':None},'provenance/css-native-runtime.json':{'target':'darwin-arm64','sourceSha':'a'*40,'releaseAccepted':False}}
 for name,value in records.items():
  p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
 packed={'archive':str(archive),'sha256':m.sha_file(archive),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode(),'members':1}
 facts=m.collect_facts(out,packed,'a'*40,'0.1.0','darwin-arm64');assert 'compiler' in facts['materials'] and 'sourceAuthority' not in facts
 for target in ['darwin-arm64','darwin-x64','linux-arm64','linux-x64']:
  platform,arch=target.split('-')
  product=dict(records['package.json'],name='@undefineds.co/xpod-css-'+target,xpodModule={'id':'css','platform':platform,'arch':arch})
  (stage/'package.json').write_text(json.dumps(product));(stage/'provenance/css-native-runtime.json').write_text(json.dumps(dict(records['provenance/css-native-runtime.json'],target=target)))
  m.collect_facts(out,packed,'a'*40,'0.1.0',target)
  try:m.collect_facts(out,packed,'a'*40,'0.1.0','wrong-x64')
  except ValueError:pass
  else:raise AssertionError('different product target accepted')
 for name in ['package.json','provenance/css-native-runtime.json']:(stage/name).write_text(json.dumps(records[name]))
 (stage/'provenance/css-native-runtime.json').write_text(json.dumps(dict(records['provenance/css-native-runtime.json'],sourceSha='b'*40)))
 try:m.collect_facts(out,packed,'a'*40,'0.1.0','darwin-arm64')
 except ValueError:pass
 else:raise AssertionError('native substitution accepted')
`);
});
test('current CSS run validation permits ongoing parent only with exact immutable workflow identity', () => {
 python(`identity={'runId':42,'runAttempt':2,'runHeadSha':'b'*40,'event':'pull_request'}
run={'id':42,'run_attempt':2,'head_sha':'b'*40,'path':m.WORKFLOW,'event':'pull_request','repository':{'full_name':m.REPOSITORY},'head_repository':{'full_name':m.REPOSITORY},'status':'in_progress'}
m.validate_run(identity,run)
for delta in [{'run_attempt':1},{'path':'.github/workflows/other.yml'},{'head_sha':'a'*40},{'head_repository':{'full_name':'fork/xpod'}}]:
 try:m.validate_run(identity,dict(run,**delta))
 except ValueError:pass
 else:raise AssertionError('foreign run accepted')
`);
});

test('CSS metadata revalidates API state before strict run and native custody checks', () => {
 python(`from unittest.mock import patch
requests=[]
identity={'runId':42,'runAttempt':2,'runHeadSha':'b'*40,'event':'pull_request'}
run={'id':42,'run_attempt':2,'head_sha':'b'*40,'path':m.WORKFLOW,'event':'pull_request','repository':{'full_name':m.REPOSITORY},'head_repository':{'full_name':m.REPOSITORY},'status':'in_progress'}
class MetadataVerified(Exception):pass
class Opener:
 def open(self,request,timeout):
  requests.append((request,timeout));headers=dict((key.lower(),value)for key,value in request.header_items())
  value=run if headers.get('cache-control')=='no-cache'else dict(run,status='queued')
  return io.BytesIO(json.dumps(value if request.full_url.endswith('/attempts/2')else {}).encode())
with tempfile.TemporaryDirectory(dir=base)as tmp,patch.object(m.urllib.request,'build_opener',return_value=Opener()),patch.object(m.shutil,'disk_usage',return_value=type('Disk',(),{'free':m.FLOOR_BYTES+1024})()),patch.object(m,'validate_native_metadata',side_effect=MetadataVerified):
 root=pathlib.Path(tmp)
 try:m.acquire_native(root,{'GH_TOKEN':'test-canary','CSS_NATIVE_ARTIFACT_ID':'7'},identity)
 except MetadataVerified:pass
 else:raise AssertionError('actual metadata validation stage was not reached')
 assert len(requests)==3
 for request,timeout in requests:
  headers=dict((key.lower(),value)for key,value in request.header_items())
  assert headers['cache-control']=='no-cache'and headers['pragma']=='no-cache'and timeout==60
 assert json.loads((root/'originals/run.raw.json').read_text())==run
 try:m.validate_run(identity,dict(run,status='queued'))
 except ValueError:pass
 else:raise AssertionError('fresh queued state was accepted')
`);
});

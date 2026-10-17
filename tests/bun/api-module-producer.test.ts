import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dir, '../..');
const base = path.join(repo, '.test-data/api-module-producer-contract');
function python(code: string) {
  mkdirSync(base, { recursive: true });
  const prelude = `import importlib.util,json,pathlib,tempfile,sys,hashlib,base64\nrepo=pathlib.Path(sys.argv[1]);base=pathlib.Path(sys.argv[2])\nspec=importlib.util.spec_from_file_location('producer',repo/'scripts/api-module-producer.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n`;
  const result = spawnSync('python3', ['-c', prelude + code, repo, base], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

test('normal phase plan includes real shared build prerequisites, API-owned UI build and original material gates', () => {
  const result = JSON.parse(python(`rows=m.phase_plan(repo,base/'out','0.0.0-preview.1','darwin-arm64');print(json.dumps(rows))`));
  const names = result.map((row: [string, string[]]) => row[0]);
  expect(names.indexOf('shared-packages') < names.indexOf('api-build')).toBe(true);
  expect(names.indexOf('native-inputs') < names.indexOf('native-material')).toBe(true);
  expect(names.indexOf('notices') < names.indexOf('pack')).toBe(true);
  expect(result.find((row: [string]) => row[0] === 'stage')[1].slice(-2)).toEqual(['preview', '0.0.0-preview.1']);
  expect(result.flat().join(' ')).not.toContain('build:ui');
  expect(result.flat().join(' ')).not.toContain('--ignore-scripts');
});

test('PR event head and actual merge checkout remain distinct immutable fields', () => {
  python(`with tempfile.TemporaryDirectory(dir=base) as directory:
 p=pathlib.Path(directory)/'event.json';p.write_text(json.dumps({'pull_request':{'head':{'sha':'b'*40}}}))
 env={'GITHUB_REPOSITORY':'undefinedsco/xpod','GITHUB_SHA':'a'*40,'GITHUB_EVENT_NAME':'pull_request','GITHUB_EVENT_PATH':str(p),'GITHUB_RUN_ID':'42','GITHUB_RUN_ATTEMPT':'2','GITHUB_WORKFLOW_REF':'undefinedsco/xpod/.github/workflows/api-module-product.yml@refs/pull/1/merge','GITHUB_WORKFLOW_SHA':'c'*40}
 value=m.context(env,{'sha':'a'*40,'status':''});assert value['runHeadSha']=='b'*40 and value['actualCheckoutSha']=='a'*40 and value['runAttempt']==2
 for changed in [{'sha':'d'*40,'status':''},{'sha':'a'*40,'status':' M src/api/main.ts'}]:
  try:m.context(env,changed)
  except ValueError:pass
  else:raise AssertionError('wrong or dirty checkout accepted')
 env['GITHUB_WORKFLOW_SHA']=''
 try:m.context(env,{'sha':'a'*40,'status':''})
 except ValueError:pass
 else:raise AssertionError('missing workflow commit accepted')
`);
});

test('read token is scoped to official native preparation, never normal install/build/pack', () => {
  python(`env={'GH_TOKEN':'test-secret','GITHUB_TOKEN':'another-secret','PATH':'unchanged'}
for phase in ['install','shared-packages','api-build','pack']:
 value=m.phase_environment(env,phase);assert value=={'PATH':'unchanged'}
assert m.phase_environment(env,'native-inputs')=={'PATH':'unchanged','GH_TOKEN':'test-secret'}
assert env['GH_TOKEN']=='test-secret'
`);
});

test('exit zero alone never substitutes for actual closed process and raw evidence', () => {
  python(`good={'exit':0,'signal':None,'actualWait':True,'ownedGroupAbsentAfterWait':True,'rawClosedBeforeHash':True,'resourceStop':None,'supervisorError':None,'cleanupErrors':[]}
assert m.closed_phase(good)
for delta in [{'actualWait':False},{'ownedGroupAbsentAfterWait':False},{'rawClosedBeforeHash':False},{'resourceStop':'floor'},{'exit':1},{'cleanupErrors':['failure']}]:assert not m.closed_phase(dict(good,**delta))
assert not m.closed_phase({'exit':0})
assert m.FRESH_BYTES==8*1024**3 and m.FLOOR_BYTES==2*1024**3
`);
});

test('existing supervisor closes a real tiny process and hashes its original raw output', () => {
  python(`spec=importlib.util.spec_from_file_location('supervise',repo/'scripts/agentfs-native-ci/supervise.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
with tempfile.TemporaryDirectory(dir=base) as directory:
 receipt,raw=s.run_stage('tiny',[sys.executable,'-c',"print('contract only')"],pathlib.Path(directory),repo,fresh_bytes=0,stop_bytes=0,poll_seconds=.01,timeout=5)
 assert m.closed_phase(receipt) and raw=='contract only\\n';assert receipt['rawSHA256']==m.sha_file(pathlib.Path(directory)/'tiny.raw.log')
`);
});

test('receipt facts reject missing materials, source substitution and native/terms drift without fabricating clearance', () => {
  python(`with tempfile.TemporaryDirectory(dir=base) as directory:
 out=pathlib.Path(directory);stage=out/'stage';stage.mkdir();archive=out/'product.tgz';archive.write_bytes(b'tiny contract bytes, not a product archive')
 packed={'archive':str(archive),'sha256':m.sha_file(archive),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode(),'members':1}
 declaration={'name':'@undefineds.co/xpod-api-darwin-arm64','cliApiVersion':1};version='0.0.0-preview.1';source='a'*40
 records={'package.json':{'name':declaration['name'],'version':version,'private':True,'xpodModule':{'id':'api','platform':'darwin','arch':'arm64','cliApiVersion':1}},'provenance/source-inventory.json':{'sourceAuthority':{'sourceCommit':source,'dirty':False}},'provenance/release-status.json':{'sourceAuthority':{'sourceCommit':source,'dirty':False}},'provenance/publication.json':{'mode':'preview','version':version,'sourceCommit':None},'provenance/terms/index.json':{'status':'original-material-collection','legalClearance':False,'missingNamedOriginalTerms':[{'name':'missing-original','version':'1.0.0'}]},'provenance/native/inngest/index.json':{'platform':'darwin','arch':'arm64','legalClearance':False}}
 for name,value in records.items():
  p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
 value=m.collect_facts(out,packed,source,version,declaration,'darwin-arm64');assert value['missingNamedOriginalTerms']==[{'name':'missing-original','version':'1.0.0'}]
 for target in ['darwin-arm64','darwin-x64','linux-arm64','linux-x64']:
  platform,arch=target.split('-');decl=dict(declaration,name='@undefineds.co/xpod-api-'+target)
  product=dict(records['package.json'],name=decl['name'],xpodModule=dict(records['package.json']['xpodModule'],platform=platform,arch=arch))
  (stage/'package.json').write_text(json.dumps(product));(stage/'provenance/native/inngest/index.json').write_text(json.dumps({'platform':platform,'arch':arch,'legalClearance':False}))
  m.collect_facts(out,packed,source,version,decl,target)
  (stage/'provenance/native/inngest/index.json').write_text(json.dumps({'platform':platform,'arch':'wrong','legalClearance':False}))
  try:m.collect_facts(out,packed,source,version,decl,target)
  except ValueError:pass
  else:raise AssertionError('different native target accepted')
 for name in ['package.json','provenance/native/inngest/index.json']:(stage/name).write_text(json.dumps(records[name]))
 for name,delta in [('provenance/release-status.json',{'sourceAuthority':{'sourceCommit':'b'*40,'dirty':False}}),('provenance/native/inngest/index.json',{'platform':'linux'}),('provenance/terms/index.json',{'legalClearance':True})]:
  p=stage/name;original=p.read_bytes();p.write_text(json.dumps(dict(records[name],**delta)))
  try:m.collect_facts(out,packed,source,version,declaration,'darwin-arm64')
  except ValueError:pass
  else:raise AssertionError('drift accepted')
  p.write_bytes(original)
 (stage/'provenance/terms/index.json').unlink()
 try:m.collect_facts(out,packed,source,version,declaration,'darwin-arm64')
 except (FileNotFoundError,ValueError):pass
 else:raise AssertionError('missing original terms silently replaced')
`);
});

test('workflow keeps pilot preview permissions, triggers and separate failed diagnostics', () => {
  const source = readFileSync(path.join(repo, '.github/workflows/api-module-product.yml'), 'utf8');
  // Bun 1.4.2 supplies the YAML parser; the cold contract job needs no install.
  const parsed = spawnSync('bun', ['-e', "import {readFileSync} from 'node:fs';console.log(JSON.stringify(Bun.YAML.parse(readFileSync(process.argv[1],'utf8'))));", path.join(repo, '.github/workflows/api-module-product.yml')], { encoding: 'utf8' });
  expect(parsed.status).toBe(0);
  const workflow = JSON.parse(parsed.stdout);
  expect(workflow.on.pull_request.branches).toEqual(['staging', 'main']);
  // With neither filter, shared runtime/SDK/AI/UI/config/source changes all
  // reach this job; the YAML does not mirror a partial producer input closure.
  expect(workflow.on.pull_request.paths).toBeUndefined();
  expect(workflow.on.pull_request['paths-ignore']).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(source).toContain('branches: [staging, main]');
  const pullRequest = source.slice(source.indexOf('  pull_request:'), source.indexOf('  workflow_dispatch:'));
  expect(pullRequest).not.toContain('paths:');
  expect(pullRequest).not.toContain('paths-ignore:');
  expect(source).toContain('contents: read');
  expect(source).toContain('runs-on: ${{ matrix.runner }}');
  expect(source).toContain('api-module-products-${{ matrix.target }}-');
  expect(source).toContain('api-module-diagnostics-${{ matrix.target }}-');
  expect(source).not.toContain('NPM_TOKEN');
  expect(source).not.toContain('cancel-in-progress');
  expect(source).not.toContain('id-token: write');
  expect(source).not.toContain('workflow_call');
});

test('one API phase plan passes each declared target to the official native input producer', () => {
  const rows = JSON.parse(python(`targets=['darwin-arm64','darwin-x64','linux-arm64','linux-x64'];print(json.dumps([m.phase_plan(repo,base/'out','0.0.0-preview.1',target) for target in targets]))`));
  for (const [index, target] of ['darwin-arm64','darwin-x64','linux-arm64','linux-x64'].entries()) {
    const native = rows[index].find((row: [string, string[]]) => row[0] === 'native-inputs')[1];
    expect(native[native.indexOf('--target') + 1]).toBe(target);
  }
});

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afsConsumerTarget, verifyAfsBoundFile, verifyAfsBoundBytes, verifyAfsHarnessSource } from '../../scripts/lib/afs-module-consumer-bridge';

describe('fixed full AFS normal consumer contracts', () => {
  it('uses the installation catalog and rejects mismatched hosts or unsupported targets', () => {
    expect(afsConsumerTarget('darwin-arm64').name).toBe('@undefineds.co/xpod-afs-darwin-arm64');
    expect(() => afsConsumerTarget('darwin-arm64', { platform: 'linux', arch: 'arm64' })).toThrow('host');
    expect(() => afsConsumerTarget('win32-x64')).toThrow('target');
  });
  it('streams actual bound files and rejects mutation and symlink authority', () => {
    const parent = path.resolve('.test-data/afs-normal-consumer'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const file = path.join(root, 'original'), bytes = Buffer.alloc(2 * 1024 ** 2, 42);
      writeFileSync(file, bytes); const ref = { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
      expect(verifyAfsBoundFile(ref).length).toBe(1024 ** 2);
      writeFileSync(file, 'changed'); expect(() => verifyAfsBoundFile(ref)).toThrow('changed');
      const link = path.join(root, 'alias'); symlinkSync(file, link);
      expect(() => verifyAfsBoundFile({ ...ref, path: link })).toThrow('binding');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('uses verified handoff bytes after the read and requires clean immutable harness source', () => {
    const parent = path.resolve('.test-data/afs-normal-json'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const file = path.join(root, 'handoff.json'), bytes = Buffer.from('{"schemaVersion":1}');
      writeFileSync(file, bytes);
      const original = verifyAfsBoundBytes({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
      writeFileSync(file, '{"schemaVersion":99}');
      expect(JSON.parse(original.toString()).schemaVersion).toBe(1);
      expect(() => verifyAfsBoundBytes({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') })).toThrow('changed');
      expect(() => verifyAfsBoundBytes({ path: file, sha256: 'a'.repeat(64) }, 4 * 1024 ** 2 + 1)).toThrow('bound');
      const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init']); git(['add', 'handoff.json']);
      git(['-c', 'user.name=Tiny Test', '-c', 'user.email=tiny@example.invalid', 'commit', '-m', 'test original']);
      const sha = git(['rev-parse', 'HEAD']).trim();
      expect(() => verifyAfsHarnessSource(root, sha)).not.toThrow();
      expect(() => verifyAfsHarnessSource(root, 'b'.repeat(40))).toThrow('clean source');
      writeFileSync(path.join(root, 'untracked'), 'dirty harness');
      expect(() => verifyAfsHarnessSource(root, sha)).toThrow('clean source');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps fixed AFS profile exceptions separate from strict defaults and rejects fixture execution', () => {
    const result = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import importlib.util,sys,pathlib
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('afs',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=m.profile();assert f['workflowPath']=='.github/workflows/agentfs-module-mounted-acceptance.yml'
assert f['producerFlags']==['published','releaseQualified','legalClearance','nativeAdmission']
assert f['consumerInputRequired'] is False and f['targetResolver'] is m.target
try:m.validate({'transport':'immutable-local-fixture'})
except ValueError as e:assert 'fixture transport' in str(e)
else:raise AssertionError('fixture accepted')
r={'target':'linux-arm64','version':'1.0','archive':{'sha256':'a'}};p={'context':{'target':'linux-arm64','version':'1.0'},'archive':r['archive']}
assert m.bind_projection(r,p,{'target':'linux-arm64','name':'exact'})['package']['name']=='exact'
for bad in [dict(r,target='linux-x64'),dict(r,version='2.0'),dict(r,archive={'sha256':'b'})]:
 try:m.bind_projection(bad,p,{'target':'linux-arm64','name':'exact'})
 except ValueError:pass
 else:raise AssertionError('unbound projection accepted')
import tempfile,json,hashlib,subprocess,shutil,os
parent=pathlib.Path(tempfile.gettempdir())/'.test-data/afs-normal-structural';parent.mkdir(parents=True,exist_ok=True);root=pathlib.Path(tempfile.mkdtemp(prefix='case-',dir=parent));repo=pathlib.Path(sys.argv[1]).parents[2];sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
def put(name,value):
 file=root/name;file.write_text(json.dumps(value));return file
def ref(file):return dict(path=str(file),sha256=hashlib.sha256(file.read_bytes()).hexdigest())
def archive(name):
 file=root/name;file.write_bytes(b'actual tiny origin-free archive');return dict(path=name,bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest(),integrity='sha512-'+m.lifecycle.base64.b64encode(hashlib.sha512(file.read_bytes()).digest()).decode())
try:
 custody=put('custody.json',{});a=archive('product.tgz');ca=archive('cli.tgz');cl=archive('client.tgz')
 source=dict(sha=sha,status='');context=dict(actualCheckoutSha=sha,workflowPath=m.WORKFLOW,target='linux-arm64',version='1.0.0',runHeadSha=sha,runId=1,runAttempt=1)
 producer=dict(schemaVersion=1,kind='afs-module-product-production',status='controlled-preview-materials',sourceBefore=source,sourceAfter=source,context=context,archive=a,published=False,releaseQualified=False,legalClearance=False,nativeAdmission=False)
 prod=put('producer.receipt.json',producer)
 receipt=dict(schemaVersion=1,kind='afs-product-input-projection',status='projected-blocked',sourceSha=sha,custodyReceipt=ref(custody),producerReceipt=dict(path=prod.name,sha256=ref(prod)['sha256']),archive=a,target='linux-arm64',version='1.0.0',runHeadSha=sha,runId=1,runAttempt=1,**{key:False for key in m.profile()['projectionFlags']})
 main=put('projection.json',receipt);publication=put('input.json',dict(schemaVersion=1,cli=ca,client=cl))
 cli=dict(schemaVersion=1,kind='cli-publication-input-projection',status='projected-blocked',sourceSha=sha,custodyReceipt=ref(custody),publicationInput=dict(path=publication.name,sha256=ref(publication)['sha256']),products={role:dict(package='@undefineds.co/xpod-'+role,version='1.0.0',archive=ar) for role,ar in [('cli',ca),('client',cl)]},**{key:False for key in ['actualCheckoutVerified','exactAttemptAdmitted','registryConsumerValidated','published','releaseQualified']})
 clipath=put('cli.projection.json',cli);preflight=root/'module-admission.mjs';preflight.write_text('test-owned negative tool')
 plan=dict(schemaVersion=1,sourceSha=sha,checkout=str(repo),sourceRoots=[str(repo)],afsReceipt=ref(main),cliReceipt=ref(clipath),afsArchive=dict(a,path=str(root/'product.tgz')),cliArchive=dict(ca,path=str(root/'cli.tgz')),clientArchive=dict(cl,path=str(root/'client.tgz')),afsPreflightDriver=ref(preflight),node='/usr/bin/true',bun='/usr/bin/true',target='linux-arm64',output=str(root/'output'),temporaryParent=str(root),budget=dict(estimatedPeakBytes=1,remainingFloorBytes=1024**3,cushionBytes=128*1024**2),transport='collected-product-archives')
 plan['registryTools']=[dict(package='@undefineds.co/xpod-'+role,version='1.0.0',files=[dict(path='package.json')]) for role in ['cli','client']]
 m.target=lambda module,value,bun,host=False:dict(target='linux-arm64',platform='linux',arch='arm64',name='@undefineds.co/xpod-afs-linux-arm64')
 assert m.validate(plan)['module']['package']['name']=='@undefineds.co/xpod-afs-linux-arm64'
 assert m.bounded_json(main)['sourceSha']==sha
 large=root/'too-large.json'
 with large.open('wb') as file:file.truncate(m.LIMITS['metadataBytes']+1)
 try:m.bounded_json(large)
 except ValueError as e:assert 'byte bound' in str(e)
 else:raise AssertionError('unbounded JSON accepted')
 alias=root/'json-alias';alias.symlink_to(main)
 try:m.bounded_json(alias)
 except OSError:pass
 else:raise AssertionError('JSON symlink accepted')
 # Default profiles still require all prior producer flags and consumer inputs.
 strict=m.profile();del strict['producerFlags']
 try:m.lifecycle.validate_consumer_plan(plan,strict)
 except ValueError as e:assert 'producer admission' in str(e)
 else:raise AssertionError('default missing flag accepted')
 strict=m.profile();del strict['consumerInputRequired']
 try:m.lifecycle.validate_consumer_plan(plan,strict)
 except KeyError as e:assert 'consumerInput' in str(e)
 else:raise AssertionError('default missing consumer input accepted')
 original=context['workflowPath'];context['workflowPath']='.github/workflows/afs-module-product.yml';prod.write_text(json.dumps(producer));receipt['producerReceipt']['sha256']=ref(prod)['sha256'];main.write_text(json.dumps(receipt));plan['afsReceipt']=ref(main)
 try:m.validate(plan)
 except ValueError as e:assert 'context mismatch' in str(e)
 else:raise AssertionError('wrong workflow accepted')
finally:shutil.rmtree(root)
print('fixed-profile-and-negative-bindings-verified')`, path.resolve('scripts/lib/afs-module-consumer.py')], { encoding: 'utf8' });
    expect(result.trim()).toBe('fixed-profile-and-negative-bindings-verified');
  });
});

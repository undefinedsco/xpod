import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
describe('fixed AFS safe original projection', () => {
  it('exports only exact generated no-credential roles and rejects hash-rebound unknown fields/env', () => {
    const parent = path.resolve('.test-data/afs-safe-originals'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const result = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import pathlib,sys,importlib.util,json,hashlib,os
spec=importlib.util.spec_from_file_location('afs',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);base=pathlib.Path(sys.argv[2])
def case(name,mutate=None):
 root=base/name;root.mkdir();out=root/'consumer-results';out.mkdir(mode=0o700);safe=root/'safe-evidence';safe.mkdir();source=root/'source';source.mkdir();owned=root/'xpod-afs-consumer-tiny'
 digest=lambda b:hashlib.sha256(b).hexdigest()
 def write(p,v):p.write_text(json.dumps(v));return dict(path=str(p),sha256=digest(p.read_bytes()))
 def file(name):p=root/name;p.write_text('actual test-owned '+name);return dict(path=str(p),sha256=digest(p.read_bytes()))
 archives=file('product.tgz');preflight=file('module-admission.mjs');node=file('node');bun=file('bun');sha='a'*40;target='darwin-arm64';version='1.0.0';helper_sha=digest(b'helper');entry_sha=digest(b'entry');core_sha=digest(b'core')
 projection=write(root/'projection.json',dict(version=version));plan=dict(output=str(out),temporaryParent=str(root),sourceSha=sha,target=target,checkout=str(source),sourceRoots=[str(source)],afsReceipt=projection,afsArchive=archives,afsPreflightDriver=preflight,node=node['path'],bun=bun['path'],registryTools=[dict(package='@undefineds.co/xpod-cli',files=[dict(path='dist/xpod.mjs',sha256=core_sha)])])
 result=dict(kind='afs-public-cli-consumer',status='passed',sourceSha=sha,processGroupsUnknown=False,ownedTemporaryRootRemoved=True,driverSourcesUnchanged=True,ownedTemporaryRoot=str(owned),privateOriginalReferences={},installedVerification={})
 # This origin-free mechanics fixture supplies a deterministic trusted sandbox
 # projection; no installer, candidate or mounted program is executed.
 m.lifecycle.targets.sandbox=lambda declaration,cycle,roots:['/usr/bin/true','--fixed-source-denial']
 for runtime in ('node','bun'):
  cycle=owned/runtime;cycle.mkdir(parents=True);pkg=cycle/'home/.xpod/modules/afs'/target/version/'package'
  manifest=dict(name='@undefineds.co/xpod-afs-'+target,version=version,xpodModule=dict(files=[dict(path='helper/agentfs-pod',sha256=helper_sha),dict(path='dist/entry.mjs',sha256=entry_sha)]))
  manifest_ref=write(out/(runtime+'-installed-package.json'),manifest);result['installedVerification'][runtime]=dict(fullInventoryVerified=True,manifestSha256=manifest_ref['sha256'])
  env=m.launcher_environment(dict(HOME=str(cycle/'home'),TMPDIR=str(cycle),PATH=str(cycle/'runtime-bin')+':/usr/bin:/bin',LANG='en_US.UTF-8'),cycle)
  cli=['/usr/bin/true','--fixed-source-denial',str(cycle/'node_modules/@undefineds.co/xpod-cli/dist/bin/xpod')]
  launcher=cycle/'afs-installed-cli';launcher.write_bytes(m.launcher_bytes(env,cli));launcher.chmod(0o700)
  retained,lref=m.retain_private_original(launcher,out,runtime,'afs-installed-cli',True)
  runtimes=dict(node=node,bun=bun)
  handoff=dict(schemaVersion=1,sourceSha=sha,target=target,workspace=str(owned/'verifier-harness'),evidence=str(out/(runtime+'-mounted')),home=str(cycle/'home'),packageRoot=str(pkg),packageManifest=dict(path=str(pkg/'package.json'),sha256=manifest_ref['sha256']),storeRoot=str(cycle/'home/.xpod/modules'),runtime=runtime,archive=archives,helper=dict(path=str(pkg/'helper/agentfs-pod'),sha256=helper_sha),entry=dict(path=str(pkg/'dist/entry.mjs'),sha256=entry_sha),launcher=dict(path=str(retained),sha256=lref['sha256']),cliCore=dict(path=str(cycle/'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs'),sha256=core_sha),node=node,selectedRuntime=runtimes[runtime],preflightDriver=preflight,runtimes=runtimes)
  if mutate=='field' and runtime=='node':handoff['token']='private-secret-marker'
  if mutate=='path' and runtime=='node':handoff['home']='/other/private-home'
  if mutate=='env' and runtime=='node':
   retained.chmod(0o700);retained.write_bytes(retained.read_bytes()+b'export API_KEY=private-secret-marker\\n');retained.chmod(0o500);lref['sha256']=digest(retained.read_bytes());lref['bytes']=retained.stat().st_size;handoff['launcher']['sha256']=lref['sha256']
  inp=cycle/'afs-installed-handoff.json';inp.write_text(json.dumps(handoff));_,href=m.retain_private_original(inp,out,runtime,'afs-installed-handoff.json')
  result['privateOriginalReferences'][runtime]=dict(launcher=lref,handoff=href)
 write(out/'result.json',result)
 destination=safe/'afs-checked-originals'
 if mutate:
  try:m.export_safe_originals(plan,destination)
  except ValueError:assert not destination.exists()
  else:raise AssertionError('unsafe actual original accepted '+mutate)
 else:
  summary=m.export_safe_originals(plan,destination)
  assert set(p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file())=={'summary.json','node/handoff.json','node/launcher','bun/handoff.json','bun/launcher'}
  assert len(summary['files'])==4 and summary['kind']=='fixed-afs-consumer-safe-originals'
  for row in summary['files']:
   data=(destination/row['path']).read_bytes();assert digest(data)==row['sha256']==row['original']['sha256']
  assert json.loads((destination/'node/handoff.json').read_text())['home']==str(owned/'node/home')
for name,mutation in [('valid',None),('unknown-field','field'),('credential-env','env'),('foreign-path','path')]:case(name,mutation)
print(json.dumps(dict(validFiles=4,unsafeOriginalsRejected=3)))`, path.resolve('scripts/lib/afs-module-consumer.py'), root], { encoding: 'utf8' });
      expect(JSON.parse(result)).toEqual({ validFiles: 4, unsafeOriginalsRejected: 3 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { reviewedModulePhasePlan, verifyClosedModulePhaseReceipts } from '../../scripts/lib/independent-admission/module-source-phases';

describe('AFS normal recipe source production', () => {
  it('projects only the existing normal build and pack entrypoints', () => {
    const plan = reviewedModulePhasePlan('afs', '/immutable', '/owned', '1.2.3', 'darwin-arm64');
    expect(plan.map(row => row.name)).toEqual(['install', 'tools', 'client', 'cli', 'afs-build', 'driver', 'cli-pack', 'client-pack']);
    expect(plan[4]!.command).toContain('scripts/build-afs-from-producer.ts');
    expect(plan[4]!.command).toContain('/owned/originals/native.zip');
    expect(plan.flatMap(row => row.command).join(' ')).not.toMatch(/--native-build|docker|publish/);
  });
  it('obtains actual waited and closed originals from the production supervisor', () => {
    const parent = path.resolve('.test-data/afs-module-producer'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const raw = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import importlib.util,pathlib,sys,json
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2])
def load(file,name):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
p=load(repo/'scripts/afs-module-producer.py','p');s=load(repo/'scripts/agentfs-native-ci/supervise.py','s');m=load(repo/'scripts/lib/module-source-materials.py','m')
(root/'evidence').mkdir()
command=[sys.executable,'-I','-B','-c','print("actual AFS source receipt probe")']
r,_=s.run_stage('probe',command,root/'evidence',repo,fresh_bytes=1024**3,stop_bytes=1024**3,timeout=10,environment={'PATH':'/usr/bin:/bin'})
assert load(repo/'scripts/api-module-producer.py','a').closed_phase(r)
refs=[m.ref(root/'evidence'/n,root) for n in ['probe.receipt.json','probe.raw.log']]
print(json.dumps({'command':command,'receipt':r,'refs':refs}))`, path.resolve('.'), root], { encoding: 'utf8' });
      const value = JSON.parse(raw.trim());
      expect(value.receipt.actualWait).toBe(true);
      expect(value.receipt.ownedGroupAbsentAfterWait).toBe(true);
      const producer = { phases: [{ name: 'probe', receipt: value.refs[0], raw: value.refs[1] }] };
      const read = (name: string) => readFileSync(path.join(root, name));
      expect(verifyClosedModulePhaseReceipts([{ name: 'probe', command: value.command }], producer,
        value.refs, read).phases).toBe(1);
      const differentCommand = [...value.command, 'unexecuted'];
      expect(() => verifyClosedModulePhaseReceipts([{ name: 'probe', command: differentCommand }],
        producer, value.refs, read)).toThrow('phase command/closure/raw mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

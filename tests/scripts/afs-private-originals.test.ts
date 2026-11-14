import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportModuleConsumerEvidence } from '../../scripts/export-module-consumer-evidence';

describe('AFS private execution originals', () => {
  it('executes the retained bytes, preserves them across cycle deletion, and exports metadata only', () => {
    const parent = path.resolve('.test-data/afs-private-originals'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-')), output = path.join(root, 'consumer-results'); mkdirSync(output, { mode: 0o700 });
    try {
      const result = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import pathlib,sys,importlib.util,json,os,shutil,subprocess,hashlib
s=importlib.util.spec_from_file_location('afs',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);root=pathlib.Path(sys.argv[2]);out=root/'consumer-results';cycle=root/'cycle';cycle.mkdir()
env=dict(HOME=str(cycle/'home'),TMPDIR=str(cycle),PATH=str(cycle/'runtime-bin')+':/usr/bin:/bin',LANG='en_US.UTF-8');safe=m.launcher_environment(env,cycle)
try:m.launcher_environment(dict(env,API_KEY='private-secret-marker'),cycle)
except ValueError:pass
else:raise AssertionError('credential environment accepted')
launcher=cycle/'afs-installed-cli';launcher.write_text('#!/bin/sh\\nexport HOME='+safe['HOME']+'\\nexec /usr/bin/printf %s "$HOME"\\n');launcher.chmod(0o700)
retained,launcher_ref=m.retain_private_original(launcher,out,'node','afs-installed-cli',executable=True)
assert subprocess.check_output([str(retained)],text=True)==str(cycle/'home')
assert retained.stat().st_mode&0o777==0o500
handoff=cycle/'afs-installed-handoff.json';handoff.write_text(json.dumps(dict(launcher=dict(path=str(retained),sha256=launcher_ref['sha256']))))
original,handoff_ref=m.retain_private_original(handoff,out,'node','afs-installed-handoff.json')
assert original.stat().st_mode&0o777==0o400 and original.parent.stat().st_mode&0o777==0o700
launcher.write_text('changed source');shutil.rmtree(cycle)
for file,ref in [(retained,launcher_ref),(original,handoff_ref)]:assert hashlib.sha256(file.read_bytes()).hexdigest()==ref['sha256']
refs=dict(launcher=launcher_ref,handoff=handoff_ref);assert 'private-secret-marker' not in json.dumps(refs)
assert all(r['publicUploadEligible'] is False for r in refs.values())
print(json.dumps(refs))`, path.resolve('scripts/lib/afs-module-consumer.py'), root], { encoding: 'utf8' });
      const references = JSON.parse(result);
      expect(references.launcher.path).toBe('.private-originals/node/afs-installed-cli');
      writeFileSync(path.join(output, 'result.json'), JSON.stringify({ processGroupsUnknown: false, records: [], privateOriginalReferences: { node: references } }));
      const exported = path.join(root, 'safe-evidence'); exportModuleConsumerEvidence(root, exported);
      const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(row => row.isDirectory() ? files(path.join(directory, row.name)) : [path.join(directory, row.name)]);
      expect(files(exported).some(file => file.includes('.private-originals'))).toBe(false);
      expect(files(exported).map(file => readFileSync(file, 'utf8')).join('\n')).not.toContain('private-secret-marker');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

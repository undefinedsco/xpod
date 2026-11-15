import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('exports fixed bounded receipt/raw originals and withholds credential bytes', () => {
  const code = `import importlib.util,pathlib,os,json,shutil,time,hashlib
repo=pathlib.Path.cwd();spec=importlib.util.spec_from_file_location('d',repo/'scripts/export-afs-producer-diagnostics.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
root=repo/'.test-data'/('afs-product-'+str(time.time_ns())+'-1-linux-x64');root.mkdir()
try:
 (root/'evidence').mkdir()
 data=b'actual diagnostic line\\n'*20000
 (root/'evidence/cli-pack.raw.log').write_bytes(data)
 (root/'evidence/cli-pack.receipt.json').write_text('{"exit":1,"rawClosedBeforeHash":true}')
 (root/'evidence/client-pack.raw.log').write_bytes(b'x'*65530+b'credential-marker-value')
 (root/'arbitrary.env').write_text('TOKEN=not approved')
 result=d.export(repo,root,{'GH_TOKEN':'credential-marker-value'})
 rows={row['original']:row for row in result['files']}
 row=rows['evidence/cli-pack.raw.log']
 assert row['snapshotBytes']==d.SNAPSHOT and row['originalBytes']==len(data) and not row['completeOriginal']
 assert row['originalSha256']==hashlib.sha256(data).hexdigest()
 assert (root/'diagnostics/evidence/cli-pack.raw.log').read_bytes()==data[:d.SNAPSHOT]
 assert rows['evidence/client-pack.raw.log']['state']=='credential-content-withheld'
 assert not (root/'diagnostics/evidence/client-pack.raw.log').exists()
 assert not (root/'diagnostics/arbitrary.env').exists()
 assert rows['evidence/cli-pack.receipt.json']['completeOriginal']
 print('bounded fixed originals and credential exclusion verified')
finally: shutil.rmtree(root)`;
  expect(execFileSync('/usr/bin/python3', ['-I', '-B', '-c', code], { encoding: 'utf8' })).toContain('verified');
});

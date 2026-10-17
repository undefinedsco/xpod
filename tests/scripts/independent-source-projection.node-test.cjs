const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('source original projection is explicit, bounded and cannot rename unrelated members', () => {
  const parent = path.resolve('.test-data/independent-source-projection');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const source = `import importlib.util,sys,zipfile,hashlib,pathlib
spec=importlib.util.spec_from_file_location('selector',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]); archive=root/'input.zip'
members={'cleanup.json':b'{"success":true}','phase-000.stdout.raw.log':b'actual raw','phase-005.metafiles/npm-entry-inputs.json':b'{}','unrelated-secret.txt':b'not allowed'}
with zipfile.ZipFile(archive,'w') as z:
 for name,data in members.items():z.writestr(name,data)
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
def selection(name,destination=None):
 data=members[name];return {'path':name,'destination':destination or name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
for i,rows in enumerate([[selection('cleanup.json')],[selection('unrelated-secret.txt')],[selection('cleanup.json','result.json')]]):
 try:m.inspect(str(archive),digest,4096,4096,20,rows,str(root/('reject'+str(i))),source_originals=i!=0)
 except ValueError:pass
 else:raise AssertionError('unexpected projection allowed')
rows=[selection(n) for n in members if n!='unrelated-secret.txt']; out=root/'good'
result=m.inspect(str(archive),digest,4096,4096,20,rows,str(out),source_originals=True)
assert result['selectedMembersProjected']==3
for row in rows:assert (out/row['path']).read_bytes()==members[row['path']]
for name in ['../cleanup.json','phase-000.metafiles/../secret.json','phase-000.other.raw.log','phase-000.metafiles/nested/x.json']:
 assert not m.source_original_path(name)
`;
    const result = spawnSync('python3', ['-c', source, path.resolve('scripts/lib/inspect-product-artifact.py'), root],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

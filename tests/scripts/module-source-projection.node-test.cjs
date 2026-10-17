const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('module receipt originals use the same whole-ZIP scanner with an exact fixed allowlist', () => {
  const parent = path.resolve('.test-data/module-source-projection'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const script = `import importlib.util,sys,zipfile,hashlib,pathlib,subprocess,json
spec=importlib.util.spec_from_file_location('selector',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]); archive=root/'input.zip'
items={'producer.receipt.json':b'{}','evidence/build-2.receipt.json':b'{"actualWait":true}','evidence/build-2.stdout.raw.log':b'raw','phase-000.receipt.json':b'{}','producer/a.json':b'legacy','secret.txt':b'secret'}
with zipfile.ZipFile(archive,'w') as z:
 for name,data in items.items():z.writestr(name,data)
hash=lambda b:hashlib.sha256(b).hexdigest()
digest=hash(archive.read_bytes())
def row(name,destination=None):
 data=items.get(name,b'{}');return {'path':name,'destination':destination or name,'bytes':len(data),'sha256':hash(data)}
def reject(rows,**kwargs):
 try:m.inspect(str(archive),digest,10000,10000,30,rows,str(root/'reject'),**kwargs)
 except ValueError:pass
 else:raise AssertionError('unexpected accepted projection')
for name in ['evidence/build-2.stdout.raw.log','secret.txt','phase-000.receipt.json','evidence/../secret.receipt.json','evidence/UPPER.receipt.json','evidence/nested/a.receipt.json']:
 reject([row(name)],module_source_originals=True)
reject([row('evidence/build-2.receipt.json','producer.receipt.json')],module_source_originals=True)
reject([row('evidence/build-2.receipt.json')])
reject([row('evidence/build-2.receipt.json')],source_originals=True)
reject([dict(row('evidence/build-2.receipt.json'),bytes=8*1024*1024+1)],module_source_originals=True)
reject([row('producer/a.json')],module_source_originals=True)
rows=[row('producer.receipt.json'),row('evidence/build-2.receipt.json')]
out=root/'good';result=m.inspect(str(archive),digest,10000,10000,30,rows,str(out),module_source_originals=True)
assert len(result['members'])==len(items) and result['selectedMembersProjected']==2 and result['innerArchiveExpanded'] is False
for r in rows:assert (out/r['path']).read_bytes()==items[r['path']]
legacy=root/'legacy';m.inspect(str(archive),digest,10000,10000,30,[row('producer/a.json')],str(legacy),legacy=True)
assert (legacy/'producer/a.json').read_bytes()==b'legacy'
# CLI unknown-mode rejection occurs before archive projection.
request=json.dumps(rows)
result=subprocess.run([sys.executable,sys.argv[1],str(archive),digest,'10000','10000','30',request,str(root/'unknown'),'module-source-originals-typo'],capture_output=True)
assert result.returncode!=0 and b'unknown projection mode' in result.stderr
result=subprocess.run([sys.executable,sys.argv[1],str(archive),digest,'10000','10000','30',request,str(root/'cli'),'module-source-originals'],capture_output=True)
assert result.returncode==0,result.stderr
# Even an unselected traversal poisons the entire ZIP.
with zipfile.ZipFile(archive,'a') as z:z.writestr('../escape',b'x')
digest=hash(archive.read_bytes());reject(rows,module_source_originals=True)
`;
    const result = spawnSync('python3', ['-c', script, path.resolve('scripts/lib/inspect-product-artifact.py'), root], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

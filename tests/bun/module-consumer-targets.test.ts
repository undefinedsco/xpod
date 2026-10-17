import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { productTargets } from '../../scripts/module-product-targets';
import { verifyConsumerNative } from '../../scripts/verify-module-consumer-native';

mkdirSync('.test-data', { recursive: true });
const root = mkdtempSync(path.resolve('.test-data/consumer-targets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function header(platform: string, arch: string): Buffer {
  const bytes = Buffer.alloc(64);
  if (platform === 'linux') {
    bytes.write('\x7fELF', 0, 'binary'); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    bytes.writeUInt32LE(2, 12);
  }
  return bytes;
}
function python(body: string) {
  const file = path.resolve(import.meta.dir, '../../scripts/lib/module-consumer-targets.py');
  const result = spawnSync('python3', ['-c', `import importlib.util,pathlib,json,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('targets',${JSON.stringify(file)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${body}`], { encoding: 'utf8', timeout: 15000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
}

test('all centrally declared API target headers bind exact installed bytes; architecture/OS drift refuses', () => {
  const targets = productTargets('api');
  for (const row of targets) {
    const bytes = header(row.platform, row.arch), file = path.join(root, row.target);
    writeFileSync(file, bytes);
    const input = { module: 'api' as const, target: row.target, files: [{ path: file, size: bytes.length, sha256: digest(bytes) }] };
    const checked = verifyConsumerNative(input);
    expect(checked.nativeAdmission).toBe(false);
    expect(checked.nativeHeaderTargetVerified).toBe(true);
    const other = targets.find(value => value.target !== row.target)!;
    expect(() => verifyConsumerNative({ ...input, target: other.target })).toThrow();
    expect(() => verifyConsumerNative({ ...input, files: [{ ...input.files[0], sha256: '0'.repeat(64) }] })).toThrow();
  }
});

test('Python adapter reads the actual central target authority and refuses host mismatch', () => {
  const rows = productTargets('api');
  python(`rows=json.loads(${JSON.stringify(JSON.stringify(rows))})
for row in rows:
 actual=m.target('api',row['target'],${JSON.stringify(process.execPath)})
 assert actual['name']==row['name'] and actual['runner']==row['runner']
 package=dict(name=row['name'],xpodModule=dict(id='api',platform=row['platform'],arch=row['arch']))
 m.installed(package,row,'api')
 package['xpodModule']['arch']='wrong'
 try:m.installed(package,row,'api')
 except ValueError:pass
 else:raise AssertionError('wrong installed architecture accepted')
wrong=next(row for row in rows if row['platform']!=${JSON.stringify(process.platform)} or row['arch']!=${JSON.stringify(process.arch)})
try:m.target('api',wrong['target'],${JSON.stringify(process.execPath)},host=True)
except ValueError:pass
else:raise AssertionError('wrong host accepted')`);
});

test('Linux masking is declared with no unsandboxed fallback and collapses nested roots', () => {
  python(`with patch.object(m.shutil,'which',lambda _:None):
 try:m.sandbox(dict(platform='linux'),pathlib.Path('/private/cycle'),[pathlib.Path('/source')])
 except ValueError:pass
 else:raise AssertionError('missing isolation backend accepted')
with patch.object(m.shutil,'which',lambda _:'/usr/bin/bwrap'):
 args=m.sandbox(dict(platform='linux'),pathlib.Path('/private/cycle'),[pathlib.Path('/source'),pathlib.Path('/source/nested')])
 assert '--unshare-user' in args and '--unshare-pid' in args and '--cap-drop' in args
 assert args.count('--tmpfs')==1 and '/source/nested' not in args
 assert args[-1]=='--' and args[args.index('--perms')+1]=='000'`);
});

test('Linux graceful shutdown selects one observed outer runtime, not its sandbox supervisor', () => {
  python(`import sys
actual=pathlib.Path(sys.executable).resolve(strict=True)
original=pathlib.Path.resolve
def resolve(value,*args,**kwargs):
 if str(value).startswith('/proc/'):
  return pathlib.Path('/bwrap-supervisor') if str(value)=='/proc/100/exe' else actual
 return original(value,*args,**kwargs)
rows='100 999 100 born-a\\n101 100 100 born-b\\n102 101 100 born-c\\n'
known={100:'born-a',101:'born-b',102:'born-c'}
with patch.object(m.subprocess,'check_output',lambda *args,**kwargs:rows),patch.object(pathlib.Path,'resolve',resolve),patch.object(m.os,'getpgid',lambda _:100):
 assert m.linux_service_pid(100,known,[sys.executable])==101
 try:m.linux_service_pid(100,{**known,101:'reused'},[sys.executable])
 except ValueError:pass
 else:raise AssertionError('reused process identity accepted')
 rows+='103 100 100 born-d\\n'
 try:m.linux_service_pid(100,{**known,103:'born-d'},[sys.executable])
 except ValueError:pass
 else:raise AssertionError('ambiguous outer runtime accepted')`);
});

test('pending native targets cannot be selected for acquisition', async () => {
  const { validateModuleConsumerRequest } = await import('../../scripts/prepare-module-consumer-plan');
  for (const row of productTargets('css').filter(row => !row.nativeSourceAvailable)) {
    expect(() => validateModuleConsumerRequest({ schemaVersion: 1, module: 'css', target: row.target,
      sourceSha: 'a'.repeat(40), product: {}, cli: {}, budget: {} })).toThrow('pending');
  }
});

test('API native provenance target and binary digest must match actual installed fixture bytes', () => {
  const declaration = productTargets('api')[0];
  const bytes = header(declaration.platform, declaration.arch);
  const adapter = path.resolve(import.meta.dir, '../../scripts/api-module-consumer.py');
  python(`import tempfile,hashlib
spec=importlib.util.spec_from_file_location('api_adapter',${JSON.stringify(adapter)})
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
row=json.loads(${JSON.stringify(JSON.stringify(declaration))})
with tempfile.TemporaryDirectory(dir=${JSON.stringify(root)}) as temp:
 package=pathlib.Path(temp);binary=package/'node_modules/inngest-cli/bin/inngest';binary.parent.mkdir(parents=True)
 data=bytes.fromhex('${bytes.toString('hex')}');binary.write_bytes(data)
 digest=hashlib.sha256(data).hexdigest()
 index=package/'provenance/native/inngest/index.json';index.parent.mkdir(parents=True)
 manifest=dict(name=row['name'],xpodModule=dict(id='api',platform=row['platform'],arch=row['arch'],files=[dict(path='node_modules/inngest-cli/bin/inngest',mode=493,size=len(data),sha256=digest)]))
 runner=types.SimpleNamespace(checked={'target':row},plan={'bun':${JSON.stringify(process.execPath)}},module_id='api')
 native=dict(platform='wrong',arch=row['arch'],binarySHA256=digest)
 index.write_text(json.dumps(native))
 try:a.Runner.verify_installed(runner,'bun',package,manifest)
 except ValueError:pass
 else:raise AssertionError('wrong native provenance target accepted')
 native['platform']=row['platform'];index.write_text(json.dumps(native))
 result=a.Runner.verify_installed(runner,'bun',package,manifest)
 assert result['nativeTargetVerification']['nativeAdmission'] is False
 binary.write_bytes(b'changed')
 try:a.Runner.verify_installed(runner,'bun',package,manifest)
 except ValueError:pass
 else:raise AssertionError('changed native bytes accepted')`);
});

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { reviewedModulePhasePlan, verifyClosedModulePhaseReceipts, inspectModuleSourcePhases } from '../../scripts/lib/independent-admission/module-source-phases';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const plan = [{ name: 'build', command: ['bun', 'run', 'build'] }, { name: 'pack', command: ['bun', 'run', 'pack'] }];
  const receipts = new Map<string, Buffer>(), inventory: { path: string; bytes: number; sha256: string }[] = [];
  const phases = plan.map((row, index) => {
    const raw = Buffer.from(row.name + ' actual raw');
    const rawReference = { path: `evidence/${row.name}.raw.log`, bytes: raw.length, sha256: hash(raw) };
    const receipt = Buffer.from(JSON.stringify({ command: row.command, actualWait: true, exit: 0, signal: null,
      ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true, resourceStop: null, supervisorError: null,
      cleanupErrors: [], ownedGroupMembers: [], rawSHA256: hash(raw), elapsedSeconds: 1,
      startedUTC: `2026-10-17T00:00:0${index * 2}.000Z`, closedUTC: `2026-10-17T00:00:0${index * 2 + 1}.000Z` }));
    const reference = { path: `evidence/${row.name}.receipt.json`, bytes: receipt.length, sha256: hash(receipt) };
    inventory.push(rawReference, reference); receipts.set(reference.path, receipt);
    return { name: row.name, receipt: reference, raw: rawReference };
  });
  return { plan, producer: { phases }, inventory, receipts };
}

test('reviewed producer projects its own API/CSS phase plan without executing production', () => {
  for (const module of ['api', 'css'] as const) {
    const plan = reviewedModulePhasePlan(module, '/repo', '/repo/.test-data/output', '0.1.0-preview.1', 'linux-x64');
    expect(plan[0]!.name).toBe('install'); expect(plan.filter(row => row.name === 'pack').length).toBe(1);
    expect(plan.every(row => row.command.length > 0 && row.timeoutSeconds > 0)).toBe(true);
    if (module === 'api') expect(plan.find(row => row.name === 'native-inputs')!.command).toContain('linux-x64');
  }
});

test('closed phase checks bind command/order/full raw identity and reject altered receipts', () => {
  const f = fixture();
  expect(verifyClosedModulePhaseReceipts(f.plan, f.producer, f.inventory, name => Buffer.from(f.receipts.get(name)!)).phases).toBe(2);
  expect(() => verifyClosedModulePhaseReceipts(f.plan, { phases: [...f.producer.phases].reverse() }, f.inventory, name => f.receipts.get(name)!)).toThrow('phase order');
  expect(() => verifyClosedModulePhaseReceipts(f.plan, f.producer, f.inventory.map(row => row.path.endsWith('.raw.log') ? { ...row, sha256: 'a'.repeat(64) } : row), name => f.receipts.get(name)!)).toThrow('original inventory');
  for (const change of [{ actualWait: false }, { ownedGroupAbsentAfterWait: false }, { rawClosedBeforeHash: false },
    { command: ['bun', 'run', 'other'] }, { rawSHA256: 'b'.repeat(64) }, { cleanupErrors: ['failed'] },
    { closedUTC: 'bad' }, { startedUTC: '2026-10-17T01:00:00.000Z' }]) {
    const c = fixture(), ref = c.producer.phases[0]!.receipt;
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(c.receipts.get(ref.path)!.toString()), ...change }));
    c.receipts.set(ref.path, bytes); ref.bytes = bytes.length; ref.sha256 = hash(bytes);
    const inventory = c.inventory.map(row => row.path === ref.path ? ref : row);
    expect(() => verifyClosedModulePhaseReceipts(c.plan, c.producer, inventory, name => c.receipts.get(name)!)).toThrow('closure/raw');
  }
});

test('serialized source, producer or origin claims cannot enter operational phase observation', () => {
  expect(() => inspectModuleSourcePhases({ artifact: { identity: { target: 'linux-x64' } }, source: {}, origin: {} })).toThrow('real artifact');
});

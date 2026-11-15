import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { exportSafe, projectConsumerDiagnostic } from '../../scripts/agentfs-native-ci/mounted/prepare-module-inputs';

const scene = () => ({ label: 'consumers', backend: 'nfs', primaryError: 'spawn ETIMEDOUT private-secret', cleanupError: 'scene retained private-secret', sceneRetained: true,
  closeState: 'closed', closeCode: 0, closeSignal: null, kernel: { state: 'unknown', reason: 'observer-threw', raw: 'private-secret' },
  proof: { daemonClosed: true, postKernel: 'unknown', result: { state: 'pending', actualExit: null, signal: null, stdout: 'private-secret', stderr: '' } },
  commands: [{ command: 'git', args: ['status', '--porcelain', 'private-secret'], cwd: '/private-secret', state: 'spawn-threw',
    error: { code: 'ETIMEDOUT', messageSHA256: 'a'.repeat(64) }, workerFacts: { launchState: 'threw', launchError: { code: 'ETIMEDOUT', errno: -60, syscall: 'spawn', message: 'private-secret' }, actualWait: false, childCloseObserved: false, pipeEOF: [false, false], workerExit: 0, elapsedMs: 3819, timeoutMs: 60000, waitBudgetMs: 75000, outputComplete: true, errors: [] } }],
  commandTiming: { windowsDropped: 0, windows: [{ id: 1, operation: 'metadata-index', counters: { httpStart: 1, httpFinish: 0, httpClose: 0, stdoutBytes: 2, stderrBytes: 0 }, events: [] }] },
});
function fixture(run: (root: string) => void) {
  const parent = path.resolve('.test-data/consumer-scene-diagnostic'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
describe('exact mounted ordinary-consumer scene export', () => {
  it('keeps failure/unknown scene facts without exposing paths, arguments, output or error text', () => {
    const output = projectConsumerDiagnostic(scene()) as any; const text = JSON.stringify(output);
    expect(text).not.toContain('private-secret'); expect(output.accepted).toBe(false); expect(output.diagnosticOnly).toBe(true);
    expect(output.sceneRetained).toBe(true); expect(output.kernel.state).toBe('unknown'); expect(output.unmount.postKernel).toBe('unknown');
    expect(output.commands[0].worker.actualWait).toBe(false); expect(output.commands[0].worker.childCloseObserved).toBe(false);
    expect(output.commands[0].worker.launchError.code).toBe('ETIMEDOUT'); expect(output.daemon.state).toBe('closed');
  });
  it('exports only the exact single consumers scene and binds the original hash', () => fixture(root => {
    const source = path.join(root, 'source'); mkdirSync(source); const row = scene();
    writeFileSync(path.join(source, 'daemon-consumers-123-456.json'), JSON.stringify(row));
    writeFileSync(path.join(source, 'daemon-consumers-123-456.raw.log'), 'private-secret');
    writeFileSync(path.join(source, 'unrelated.json'), 'private-secret');
    exportSafe(source, path.join(root, 'out'));
    expect(readdirSync(path.join(root, 'out')).sort()).toEqual(['consumer-scene.safe.json', 'export.safe.json']);
    const exported = JSON.parse(readFileSync(path.join(root, 'out/consumer-scene.safe.json'), 'utf8')); expect(exported.sourceReceiptSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(exported)).not.toContain('private-secret');
  }));
  it('rejects invalid labels, too many commands, oversize and linked input', () => fixture(root => {
    expect(() => projectConsumerDiagnostic({ ...scene(), label: 'foreign' })).toThrow('invalid consumer diagnostic');
    expect(() => projectConsumerDiagnostic({ ...scene(), commands: Array(129).fill({}) })).toThrow('invalid consumer diagnostic');
    for (const kind of ['oversize', 'link']) {
      const source = path.join(root, kind); mkdirSync(source); const file = path.join(source, 'daemon-consumers-1-2.json');
      if (kind === 'oversize') writeFileSync(file, Buffer.alloc(256 * 1024 + 1)); else symlinkSync('/dev/null', file);
      expect(() => exportSafe(source, path.join(root, kind + '-out'))).toThrow('invalid consumer diagnostic file');
    }
  }));
  it('rejects an exact-name FIFO in a bounded actual child instead of blocking the exporter', () => fixture(root => {
    const source = path.join(root, 'source'); mkdirSync(source); const file = path.join(source, 'daemon-consumers-1-2.json');
    expect(spawnSync('mkfifo', [file], { timeout: 1000 }).status).toBe(0);
    const script = `import {exportSafe} from ${JSON.stringify(path.resolve('scripts/agentfs-native-ci/mounted/prepare-module-inputs.ts'))};try{exportSafe(${JSON.stringify(source)},${JSON.stringify(path.join(root, 'out'))});process.exitCode=2}catch(e){console.log((e as Error).message)}`;
    const child = spawnSync('bun', ['-e', script], { timeout: 3000, encoding: 'utf8' });
    expect(child.status).toBe(0); expect(child.signal).toBeNull(); expect(child.error).toBeUndefined(); expect(child.stdout).toContain('invalid consumer diagnostic file');
  }));
});

describe('mounted command bridge under the actual Vitest Node runtime', () => {
  it('runs ordinary Git with original cwd/argv/env and preserves raw porcelain columns', async () => {
    const { createRequire } = await import('node:module');
    const { runMountedCommand } = createRequire(import.meta.url)('./support/mountedCommandWorker.cjs');
    const parent = path.resolve('.test-data/consumer-worker-git'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-'));
    const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_CONFIG_SYSTEM = '/dev/null'; env.GIT_CONFIG_NOSYSTEM = '1';
    let closed = true;
    const git = async (args: string[]) => {
      const row = await runMountedCommand({ command: 'git', args: ['-c', 'user.name=Worker Test', '-c', 'user.email=worker@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], cwd: root, env, timeoutMs: 10000 });
      closed &&= row.state === 'closed'; expect(row.state).toBe('closed'); expect(row.actualExit).toBe(0); expect(row.workerFacts.timeoutObserved).toBe(false); return row.stdout as string;
    };
    try {
      await git(['init', '--template=']); writeFileSync(path.join(root, 'content.txt'), 'original\n');
      await git(['add', 'content.txt']); await git(['commit', '-m', 'baseline']); writeFileSync(path.join(root, 'content.txt'), 'modified\n');
      expect(await git(['status', '--porcelain'])).toBe(' M content.txt\n');
    } finally { if (closed) rmSync(root, { recursive: true, force: true }); }
  });
});

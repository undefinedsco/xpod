import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/assert-rc-authenticated-smoke.cjs');
const tempRoots: string[] = [];

async function writeReport(item: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-auth-smoke-'));
  tempRoots.push(root);
  const reportPath = path.join(root, 'xpod-light-settings-acceptance.json');
  await writeFile(reportPath, `${JSON.stringify({ items: [ item ] }, null, 2)}\n`);
  return reportPath;
}

describe('RC authenticated smoke assertion', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('accepts only a passed solid-pod-isolation gate with an executed zero-exit command', async () => {
    const reportPath = await writeReport({
      requirementId: 'solid-pod-isolation',
      status: 'pass',
      commandResult: {
        exitCode: 0,
        timedOut: false,
      },
    });

    await expect(execFile('node', [ scriptPath, reportPath ], { cwd: repoRoot })).resolves.toMatchObject({
      stdout: expect.stringContaining('solid-pod-isolation passed'),
    });
  });

  it('rejects a missing report argument', async () => {
    await expect(execFile('node', [ scriptPath ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('acceptance report path is required'),
    });
  });

  it('rejects a report without items', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-auth-smoke-'));
    tempRoots.push(root);
    const reportPath = path.join(root, 'xpod-light-settings-acceptance.json');
    await writeFile(reportPath, `${JSON.stringify({}, null, 2)}\n`);

    await expect(execFile('node', [ scriptPath, reportPath ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('acceptance report items are required'),
    });
  });

  it.each([
    [ 'skip status', { requirementId: 'solid-pod-isolation', status: 'skip', commandResult: { exitCode: 0 } }],
    [ 'not complete status', { requirementId: 'solid-pod-isolation', status: 'not_complete', commandResult: { exitCode: 0 } }],
    [ 'failed command', { requirementId: 'solid-pod-isolation', status: 'pass', commandResult: { exitCode: 1 } }],
    [ 'missing command result', { requirementId: 'solid-pod-isolation', status: 'pass' }],
    [ 'missing item', { requirementId: 'browser-visual', status: 'pass', commandResult: { exitCode: 0 } }],
  ])('rejects %s', async (_label, item) => {
    const reportPath = await writeReport(item);

    await expect(execFile('node', [ scriptPath, reportPath ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('solid-pod-isolation'),
    });
  });
});

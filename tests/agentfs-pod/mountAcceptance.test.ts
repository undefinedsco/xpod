import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { discoverAgentFsHelper } from './support/helperDiscovery';
import { runMountAcceptance } from './support/mountHarness';

const helper = discoverAgentFsHelper();
const runMount = process.env.XPOD_AGENTFS_RUN_MOUNT === '1' && helper.available;
const WORK_DIR = path.resolve('.test-data/agent-directory-workers/agentfs-test/mount');

describe('AgentFS Pod helper availability', () => {
  it('reports helper status and platform requirements honestly', () => {
    expect(typeof helper.available).toBe('boolean');
    expect(helper.platformRequirements.length).toBeGreaterThan(0);
    expect(helper.command?.[0] ?? '').not.toContain('agentfs-pod-check');
    expect(helper.available).toBe(Boolean(helper.helperPath));
    if (!helper.available) {
      console.warn(`[agentfs] OS mount UNAVAILABLE: ${helper.reason}`);
      for (const requirement of helper.platformRequirements) {
        console.warn(`[agentfs] requirement: ${requirement}`);
      }
    }
    expect(helper.available ? helper.command : helper.reason).toBeTruthy();
  });

  it('never mistakes the diagnostic prerequisite shell for a mount helper', () => {
    if (helper.checkBinaryPath && !helper.helperPath) {
      expect(helper.command ?? []).not.toContain(helper.checkBinaryPath);
      expect(helper.available).toBe(false);
    }
  });
});

describe.runIf(runMount)('AgentFS Pod real OS mount acceptance', () => {
  let server: PodContractServer;

  beforeAll(async () => {
    await mkdir(WORK_DIR, { recursive: true });
    server = await startPodContractServer({
      token: 'accept-token',
      files: {
        'alpha.txt': 'ALPHA_BODY_0123456789\n',
        'big.txt': `${'x'.repeat(200_000)}\nBIG_END\n`,
      },
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(WORK_DIR, { recursive: true, force: true });
  });

  it('passes readdir/stat/read/range/conditional/invalidation checks through the mount', async () => {
    const report = await runMountAcceptance({ server, helper, token: 'accept-token', workDir: WORK_DIR });
    expect(report.status).toBe('pass');
    for (const check of report.checks) {
      expect(check, `${check.name}: ${check.detail}`).toMatchObject({ ok: true });
    }
  }, 120_000);
});

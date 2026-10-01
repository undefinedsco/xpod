import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { discoverAgentFsHelper } from './support/helperDiscovery';
import { probeRustBackend, RUST_BACKEND_CLI } from './support/rustBackendHarness';

const helper = discoverAgentFsHelper();
const runBackend = process.env.XPOD_AGENTFS_RUN_BACKEND === '1' && Boolean(helper.helperPath);
const WORK_DIR = path.resolve('.test-data/agent-directory-workers/agentfs-test/rust-backend');

describe('Rust AgentFS backend probe against an external Pod fixture (not the helper self-test)', () => {
  it('documents the real CLI surface and reports helper availability honestly', () => {
    expect(RUST_BACKEND_CLI.length).toBeGreaterThanOrEqual(4);
    expect(RUST_BACKEND_CLI.some((entry) => entry.includes('selftest') && entry.includes('NOT'))).toBe(true);
    if (!helper.helperPath) {
      console.warn(`[agentfs] Rust backend UNAVAILABLE: ${helper.reason}`);
    }
    expect(helper.helperPath !== undefined || helper.reason.length > 0).toBe(true);
  });
});

describe.runIf(runBackend)('Rust AgentFS backend probe against the Pod HTTP fixture', () => {
  let server: PodContractServer;

  beforeAll(async () => {
    await mkdir(WORK_DIR, { recursive: true });
    server = await startPodContractServer({
      token: 'rust-token',
      files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n' },
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(WORK_DIR, { recursive: true, force: true });
  });

  it('verifies readdir/stat/range/conditional-write/delete without an OS mount', async () => {
    const report = await probeRustBackend(helper, server, 'rust-token', WORK_DIR);
    for (const check of report.checks) {
      expect(check, `${check.name}: ${check.detail}`).toMatchObject({ ok: true });
    }
    expect(report.status).toBe('pass');
  }, 120_000);
});

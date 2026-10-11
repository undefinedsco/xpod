import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverAgentFsHelper } from './support/helperDiscovery';
import { AGENTFS_UPSTREAM } from '../../packages/xpod-afs/src/agent-fs/mount';

const REPO_ROOT = process.cwd();
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const SESSION_DIR = path.resolve('.test-data/agent-directory-workers/agentfs-test/mount-entry');
const helper = discoverAgentFsHelper();
const helperPresent = Boolean(helper.helperPath);

function runBun(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [ CLI_ENTRY, ...args ], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SOLID_HOME: path.join(SESSION_DIR, 'empty-auth') },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

interface MountPayload { code?: string; blockers?: string[]; helperPath?: string; helperPresent?: boolean }

function tryParseData<T>(stdout: string): T | undefined {
  try {
    const payload = JSON.parse(stdout) as { data?: T };
    return payload.data;
  } catch {
    return undefined;
  }
}

describe('AgentFS mount entry points reflect real prerequisites instead of fabricating a mount', () => {
  afterAll(() => {
    rmSync(SESSION_DIR, { recursive: true, force: true });
  });

  it('mount either performs a real mount attempt or reports mount_unavailable with blockers', () => {
    mkdirSync(SESSION_DIR, { recursive: true });
    // An unreachable Pod root: a real helper attempt must fail, never fabricate success.
    const result = runBun([ 'agent-fs', 'mount', '--json', '--root', `${SESSION_DIR}=https://pod.invalid.example/alice/`, '--session-dir', SESSION_DIR ]);
    const data = tryParseData<MountPayload>(result.stdout);

    if (!helperPresent) {
      expect(result.status).toBe(3);
      expect(data?.code).toBe('mount_unavailable');
      expect((data?.blockers ?? []).length).toBeGreaterThan(0);
      expect(data?.helperPath).toBeUndefined();
      return;
    }
    // Helper present: the entry must not claim a successful mount of an
    // unreachable Pod. It may report unavailable (JSON) or a failed attempt.
    expect(result.status).not.toBe(0);
    if (data?.code) {
      expect([ 'mount_unavailable', 'mount_failed' ]).toContain(data.code);
      expect((data.blockers ?? []).length).toBeGreaterThan(0);
    }
  });

  it('status reports the real helper/fuse/nfs decision inputs and pinned upstream', () => {
    const result = runBun([ 'agent-fs', 'status', '--json' ]);
    expect(result.status).toBe(0);
    const data = tryParseData<MountPayload & { fuseAvailable?: boolean; nfsMountAvailable?: boolean; upstream?: { commit?: string } }>(result.stdout);
    expect(data?.helperPresent).toBe(helperPresent);
    expect(data?.upstream?.commit).toBe(AGENTFS_UPSTREAM.commit);
  });

  it('the prerequisite check shell refuses mount with exit 3', () => {
    if (!helper.checkBinaryPath) {
      return;
    }
    const result = spawnSync(helper.checkBinaryPath, [ 'mount' ], { encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(`${result.stdout}${result.stderr}`).toMatch(/prerequisite shell|not available|FUSE/i);
  });

  it('the prerequisite check shell status names the pinned AgentFS commit and mode', () => {
    if (!helper.checkBinaryPath) {
      return;
    }
    const result = spawnSync(helper.checkBinaryPath, [ 'status', '--json' ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { agentfsCommit?: string; mode?: string; fuseAvailable?: boolean };
    expect(payload.agentfsCommit).toBe(AGENTFS_UPSTREAM.commit);
    expect(payload.mode).toBe('prerequisite-shell');
  });
});

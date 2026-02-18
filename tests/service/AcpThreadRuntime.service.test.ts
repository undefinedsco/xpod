import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PtyThreadRuntime } from '../../src/api/chatkit/runtime/PtyThreadRuntime';

describe('ACP Thread Runtime', () => {
  it('streams agent_message_chunk from ACP session/update notifications', async () => {
    const rt = new PtyThreadRuntime();
    const repoPath = process.cwd();
    const workdir = process.cwd();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-echo-agent.js');

    await rt.ensureStarted('thread-acp-test', {
      workspace: { type: 'path', rootPath: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: [ 'node', agentPath ],
      },
    });

    let out = '';
    for await (const ev of rt.sendMessage('thread-acp-test', 'hello', { idleMs: 50 })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    expect(out).toBe('echo:hello');
  }, 20_000);

  it('surfaces auth_required events with an auth URL', async () => {
    const rt = new PtyThreadRuntime();
    const workdir = process.cwd();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-auth-agent.js');

    await rt.ensureStarted('thread-acp-auth-test', {
      workspace: { type: 'path', rootPath: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: [ 'node', agentPath ],
      },
    });

    let sawAuth = false;
    let out = '';
    for await (const ev of rt.sendMessage('thread-acp-auth-test', 'hello', { idleMs: 50 })) {
      if (ev.type === 'auth_required') {
        expect(ev.url).toBe('https://example.com/login');
        sawAuth = true;
      }
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    expect(sawAuth).toBe(true);
    expect(out).toBe('ok');
  }, 20_000);
});

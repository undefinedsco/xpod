import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AcpAgentRuntime } from '../../src/api/chatkit/runtime/AcpAgentRuntime';

describe('ACP Thread Runtime', () => {
  const workspaceRef = `file://localhost${process.cwd()}`;

  it('streams agent_message_chunk from ACP session/update notifications', async () => {
    const rt = new AcpAgentRuntime();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-echo-agent.js');

    let out = '';
    for await (
      const ev of rt.run({
        threadId: 'thread-acp-test',
        prompt: 'hello',
        config: {
          workspace: workspaceRef,
          runner: {
            type: 'codex',
            protocol: 'acp',
            argv: [ 'node', agentPath ],
          },
        },
      })
    ) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    expect(out).toBe('echo:hello');
  }, 20_000);

  it('surfaces auth_required events with an auth URL', async () => {
    const rt = new AcpAgentRuntime();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-auth-agent.js');

    let sawAuth = false;
    let out = '';
    for await (
      const ev of rt.run({
        threadId: 'thread-acp-auth-test',
        prompt: 'hello',
        config: {
          workspace: workspaceRef,
          idleMs: 50,
          runner: {
            type: 'codex',
            protocol: 'acp',
            argv: [ 'node', agentPath ],
          },
        },
      })
    ) {
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

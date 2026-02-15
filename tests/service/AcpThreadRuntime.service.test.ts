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
      repoPath,
      worktree: { mode: 'existing', path: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: [ 'node', agentPath ],
      },
    });

    let out = '';
    for await (const chunk of rt.sendMessage('thread-acp-test', 'hello', { idleMs: 50 })) {
      out += chunk;
    }

    expect(out).toBe('echo:hello');
  });
});


import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { AiProvider } from '../../src/api/chatkit/service';

function parseSseDataLines(chunks: Uint8Array[]): unknown[] {
  const text = Buffer.concat(chunks).toString('utf-8');
  const events: unknown[] = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice('data:'.length).trim();
    if (!json) continue;
    events.push(JSON.parse(json));
  }
  return events;
}

describe('ChatKitService + ACP runtime', () => {
  it('emits runtime.auth_required client_effect with a clickable url', async () => {
    const store = new InMemoryStore();

    const aiProvider: AiProvider = {
      async generateResponse() {
        throw new Error('aiProvider should not be used when PTY runtime is enabled');
      },
      async listModels() {
        return [];
      },
    };

    const svc = new ChatKitService({
      store,
      aiProvider,
      enablePtyRuntime: true,
    });

    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-auth-agent.js');

    const req = {
      type: 'threads.create',
      metadata: {
        runtime: {
          workspace: { type: 'path', rootPath: process.cwd() },
          runner: {
            type: 'codex',
            protocol: 'acp',
            allowCustomArgv: true,
            argv: [ 'node', agentPath ],
          },
        },
      },
      params: {
        input: {
          content: [ { type: 'input_text', text: 'hello' } ],
        },
      },
    };

    const result = await svc.process(JSON.stringify(req), { userId: 'u1' });
    if (result.type !== 'streaming') {
      throw new Error('expected streaming result');
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of result.stream()) {
      chunks.push(chunk);
    }

    const events = parseSseDataLines(chunks);

    const auth = events.find((e: any) => e?.type === 'client_effect' && e?.effect?.effect_type === 'runtime.auth_required') as any;
    expect(auth).toBeTruthy();
    expect(auth.effect.data.url).toBe('https://example.com/login');
    expect(Array.isArray(auth.effect.data.options)).toBe(true);
    expect(auth.effect.data.options[0]?.url).toBe('https://example.com/login');
    expect(auth.effect.data.params).toBeUndefined();

    // Closed loop: after auth request, the agent still streams output text.
    const deltas = events.filter((e: any) => e?.type === 'thread.item.updated');
    expect(deltas.length).toBeGreaterThan(0);
  }, 20_000);
});


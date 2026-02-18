import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { AiProvider } from '../../src/api/chatkit/service';

function parseSseDataLines(chunks: Uint8Array[]): any[] {
  const text = Buffer.concat(chunks).toString('utf-8');
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice('data:'.length).trim();
    if (!json) continue;
    events.push(JSON.parse(json));
  }
  return events;
}

describe('ChatKitService + ACP tool call', () => {
  it('maps ACP request to client_tool_call and continues after threads.add_client_tool_output', async () => {
    const store = new InMemoryStore();
    const aiProvider: AiProvider = {
      async *streamResponse() {
        throw new Error('aiProvider should not be used when PTY runtime is enabled');
      },
    };

    const svc = new ChatKitService({
      store,
      aiProvider,
      enablePtyRuntime: true,
    });

    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-tool-agent.js');

    const createReq = {
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

    const createResult = await svc.process(JSON.stringify(createReq), { userId: 'u1' });
    expect(createResult.type).toBe('streaming');
    const createChunks: Uint8Array[] = [];
    for await (const chunk of createResult.type === 'streaming' ? createResult.stream() : []) {
      createChunks.push(chunk);
    }
    const createEvents = parseSseDataLines(createChunks);

    const threadCreated = createEvents.find((e) => e.type === 'thread.created');
    expect(threadCreated).toBeTruthy();
    const threadId = threadCreated.thread.id as string;

    const toolEvent = createEvents.find((e) => e.type === 'thread.item.added' && e.item?.type === 'client_tool_call');
    expect(toolEvent).toBeTruthy();
    expect(toolEvent.item.name).toBe('tool/example');
    const toolItemId = toolEvent.item.id as string;

    const outputReq = {
      type: 'threads.add_client_tool_output',
      params: {
        thread_id: threadId,
        item_id: toolItemId,
        output: JSON.stringify({ ok: true }),
      },
    };

    const outputResult = await svc.process(JSON.stringify(outputReq), { userId: 'u1' });
    expect(outputResult.type).toBe('streaming');

    const outputChunks: Uint8Array[] = [];
    for await (const chunk of outputResult.type === 'streaming' ? outputResult.stream() : []) {
      outputChunks.push(chunk);
    }
    const outputEvents = parseSseDataLines(outputChunks);

    const assistantDeltas = outputEvents.filter((e) => e.type === 'thread.item.updated');
    expect(assistantDeltas.length).toBeGreaterThan(0);
    expect(assistantDeltas.some((e) => e.update?.delta === 'after-tool')).toBe(true);
  }, 20_000);
});

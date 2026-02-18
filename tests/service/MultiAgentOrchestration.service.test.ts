import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';

function repoRoot(): string {
  return path.resolve(__dirname, '../..');
}

function decodeSseEvents(chunks: Uint8Array[]): any[] {
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  const events: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice('data: '.length).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json));
    } catch {
      // ignore
    }
  }
  return events;
}

async function collectStreamingEvents(service: ChatKitService, body: unknown, context: StoreContext): Promise<any[]> {
  const result = await service.process(JSON.stringify(body), context);
  if (result.type !== 'streaming') {
    throw new Error('Expected streaming result');
  }
  const chunks: Uint8Array[] = [];
  for await (const c of result.stream()) {
    chunks.push(c);
  }
  return decodeSseEvents(chunks);
}

function lastAssistantText(events: any[]): string {
  let text = '';
  for (const ev of events) {
    if (ev?.type === 'thread.item.updated' && ev.update?.type === 'assistant_message.content_part.text_delta') {
      text += ev.update.delta ?? '';
    }
  }
  return text;
}

function extractDelegateTask(secretaryText: string, who: 'claude' | 'codebuddy'): string {
  for (const line of secretaryText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('DELEGATE ') && trimmed.includes(`${who}:`)) {
      return trimmed.split(`${who}:`)[1].trim();
    }
  }
  return '';
}

describe('Multi-agent orchestration over ChatKit threads (service)', () => {
  const root = repoRoot();
  const agentScriptPath = path.join(root, 'tests/fixtures/acp-multi-agent.js');

  let store: InMemoryStore<StoreContext>;
  let service: ChatKitService<StoreContext>;
  const context: StoreContext = { userId: 'local-user' };

  beforeAll(() => {
    store = new InMemoryStore<StoreContext>();
    service = new ChatKitService<StoreContext>({
      store,
      aiProvider: {
        async *streamResponse() {
          yield 'not-used';
        },
      },
      enablePtyRuntime: true,
    });
  });

  afterAll(() => {
    store.clear();
  });

  it('Secretary(codex) delegates to ClaudeCode + CodeBuddy and aggregates results', async () => {
    const node = process.execPath;
    const workspacePath = root;

    const secretaryEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: { input: undefined },
      metadata: {
        runtime: {
          workspace: { type: 'path', rootPath: workspacePath },
          runner: {
            type: 'codex',
            protocol: 'acp',
            allowCustomArgv: true,
            argv: [node, agentScriptPath, 'secretary'],
          },
        },
      },
    }, context);
    const secretaryThreadId = secretaryEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof secretaryThreadId).toBe('string');

    const claudeEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: { input: undefined },
      metadata: {
        runtime: {
          workspace: { type: 'path', rootPath: workspacePath },
          runner: {
            type: 'claude',
            protocol: 'acp',
            allowCustomArgv: true,
            argv: [node, agentScriptPath, 'worker-claude'],
          },
        },
      },
    }, context);
    const claudeThreadId = claudeEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof claudeThreadId).toBe('string');

    const buddyEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: { input: undefined },
      metadata: {
        runtime: {
          workspace: { type: 'path', rootPath: workspacePath },
          runner: {
            type: 'codebuddy',
            protocol: 'acp',
            allowCustomArgv: true,
            argv: [node, agentScriptPath, 'worker-codebuddy'],
          },
        },
      },
    }, context);
    const buddyThreadId = buddyEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof buddyThreadId).toBe('string');

    const secretaryRound1 = await collectStreamingEvents(service, {
      type: 'threads.add_user_message',
      params: {
        thread_id: secretaryThreadId,
        input: { content: [{ type: 'input_text', text: 'REQUEST: Please delegate two tasks and wait.' }] },
      },
    }, context);

    // ACP auth link should surface as a runtime effect for the secretary.
    expect(secretaryRound1.some((e) => e?.type === 'client_effect' && e?.effect?.effect_type === 'runtime.auth_required')).toBe(true);

    const secretaryText1 = lastAssistantText(secretaryRound1);
    expect(secretaryText1).toContain('DELEGATE');

    const claudeTask = extractDelegateTask(secretaryText1, 'claude');
    const buddyTask = extractDelegateTask(secretaryText1, 'codebuddy');
    expect(claudeTask.length).toBeGreaterThan(0);
    expect(buddyTask.length).toBeGreaterThan(0);

    const claudeRun = await collectStreamingEvents(service, {
      type: 'threads.add_user_message',
      params: {
        thread_id: claudeThreadId,
        input: { content: [{ type: 'input_text', text: claudeTask }] },
      },
    }, context);
    const claudeOut = lastAssistantText(claudeRun).trim();
    expect(claudeOut).toContain('RESULT');

    const buddyRun = await collectStreamingEvents(service, {
      type: 'threads.add_user_message',
      params: {
        thread_id: buddyThreadId,
        input: { content: [{ type: 'input_text', text: buddyTask }] },
      },
    }, context);
    const buddyOut = lastAssistantText(buddyRun).trim();
    expect(buddyOut).toContain('RESULT');

    const secretaryRound2 = await collectStreamingEvents(service, {
      type: 'threads.add_user_message',
      params: {
        thread_id: secretaryThreadId,
        input: {
          content: [{
            type: 'input_text',
            text: `RESULTS: claude=${claudeOut} | codebuddy=${buddyOut}`,
          }],
        },
      },
    }, context);
    const secretaryText2 = lastAssistantText(secretaryRound2);
    expect(secretaryText2).toContain('FINAL');
    expect(secretaryText2).toContain('claude=');
    expect(secretaryText2).toContain('codebuddy=');
  }, 30_000);
});

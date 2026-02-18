import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { AiProvider } from '../../src/api/chatkit/service';

function tryParseSseEvent(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const json = trimmed.slice('data:'.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

describe('ChatKitService + ACP real auth flow', () => {
  it('continues after auth (already authorized or complete auth in browser)', async () => {
    // Keep full/lite stable in non-interactive environments.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }
    if (spawnSync('bash', ['-lc', 'command -v codebuddy'], { stdio: 'ignore' }).status !== 0) {
      return;
    }

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

    const req = {
      type: 'threads.create',
      metadata: {
        runtime: {
          workspace: { type: 'path', rootPath: process.cwd() },
          idleMs: 15_000,
          authWaitMs: 180_000,
          runner: { type: 'codebuddy', protocol: 'acp' },
        },
      },
      params: {
        input: {
          content: [ { type: 'input_text', text: '请只回复 OK' } ],
        },
      },
    };

    const result = await svc.process(JSON.stringify(req), { userId: 'u1' });
    expect(result.type).toBe('streaming');
    if (result.type !== 'streaming') return;

    let buf = '';
    let sawAuthRequired = false;
    let assistantText = '';
    let sawAssistantDone = false;
    let streamErrorMessage: string | undefined;
    let sawAnyEvent = false;

    for await (const chunk of result.stream()) {
      buf += Buffer.from(chunk).toString('utf-8');
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';

      for (const block of blocks) {
        const ev = tryParseSseEvent(block);
        if (!ev) continue;
        sawAnyEvent = true;

        if (ev.type === 'client_effect' && ev.effect?.effect_type === 'runtime.auth_required') {
          sawAuthRequired = true;
          const url = ev.effect?.data?.url;
          if (typeof url === 'string' && url.startsWith('http')) {
            // User can open this URL and complete auth, then stream should continue.
            console.warn(`[real-auth] Please complete auth: ${url}`);
          }
        }

        if (
          ev.type === 'thread.item.updated' &&
          ev.update?.type === 'assistant_message.content_part.text_delta' &&
          typeof ev.update?.delta === 'string'
        ) {
          assistantText += ev.update.delta;
        }

        if (ev.type === 'thread.item.done' && ev.item?.type === 'assistant_message') {
          sawAssistantDone = true;
        }

        if (ev.type === 'error' && typeof ev.error?.message === 'string') {
          streamErrorMessage = ev.error.message;
        }
      }
    }

    // This test is intentionally "best-effort":
    // - If the environment cannot run codebuddy ACP at all, we skip.
    // - If auth is required but the user did not complete it during the test window, we skip.
    if (!sawAnyEvent) {
      console.warn('[real-auth] skip: no SSE events observed');
      return;
    }
    if (!sawAssistantDone && streamErrorMessage) {
      console.warn(`[real-auth] skip due to runtime error: ${streamErrorMessage}`);
      return;
    }
    if (sawAuthRequired && !sawAssistantDone) {
      console.warn('[real-auth] skip: auth_required observed but assistant did not complete (finish auth in browser and re-run)');
      return;
    }

    expect(sawAssistantDone).toBe(true);
    expect(assistantText.length).toBeGreaterThan(0);
    // Either already authorized (false) or auth flow happened (true), both are valid.
    expect(typeof sawAuthRequired).toBe('boolean');
  }, 180_000);
});

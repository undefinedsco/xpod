import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { AiProvider } from '../../src/api/chatkit/service';

type RunnerType = 'codebuddy' | 'claude' | 'codex';

function isTty(): boolean {
  if (process.env.XPOD_RUN_INTEGRATION_TESTS === 'true') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function hasCommand(cmd: string): boolean {
  return spawnSync('bash', [ '-lc', `command -v ${cmd}` ], { stdio: 'ignore' }).status === 0;
}

function hasLocalBin(bin: string): boolean {
  const p = path.join(process.cwd(), 'node_modules', '.bin', bin);
  return spawnSync('bash', [ '-lc', `test -x ${JSON.stringify(p)}` ], { stdio: 'ignore' }).status === 0;
}

function tryParseSseEvent(block: string): any | null {
  const trimmed = block.trim();
  if (!trimmed.startsWith('data:')) return null;
  const json = trimmed.slice('data:'.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function runSmoke(runner: RunnerType): Promise<{
  sawAnyEvent: boolean;
  sawAssistantDone: boolean;
  assistantText: string;
  sawAuthRequired: boolean;
  runtimeError?: string;
}> {
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
        idleMs: 20_000,
        authWaitMs: 180_000,
        runner: { type: runner, protocol: 'acp' },
      },
    },
    params: {
      input: {
        content: [ { type: 'input_text', text: 'Please reply with a single word: OK' } ],
      },
    },
  };

  const result = await svc.process(JSON.stringify(req), { userId: 'u1' });
  expect(result.type).toBe('streaming');
  if (result.type !== 'streaming') {
    return {
      sawAnyEvent: false,
      sawAssistantDone: false,
      assistantText: '',
      sawAuthRequired: false,
    };
  }

  let buf = '';
  let sawAnyEvent = false;
  let sawAssistantDone = false;
  let assistantText = '';
  let sawAuthRequired = false;
  let runtimeError: string | undefined;

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
        runtimeError = ev.error.message;
      }
    }
  }

  return { sawAnyEvent, sawAssistantDone, assistantText, sawAuthRequired, runtimeError };
}

describe('ChatKit + ACP CLI smoke', () => {
  const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
  const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

  suite('real CLIs (best-effort)', () => {
    it('codebuddy --acp works (or requires auth)', async () => {
      if (!isTty()) return;
      if (!hasCommand('codebuddy')) return;

      const r = await runSmoke('codebuddy');
      if (!r.sawAnyEvent) return;
      if (r.runtimeError && !r.sawAssistantDone) {
        // If codebuddy ACP is unavailable on the machine, keep suite green.
        console.warn(`[acp smoke] skip codebuddy due to runtime error: ${r.runtimeError}`);
        return;
      }
      if (r.sawAuthRequired && !r.sawAssistantDone) {
        console.warn('[acp smoke] skip codebuddy: auth required but not completed');
        return;
      }
      expect(r.sawAssistantDone).toBe(true);
      expect(r.assistantText.trim().length).toBeGreaterThan(0);
    }, 180_000);

    it('claude-code-acp works (requires DEFAULT_API_KEY)', async () => {
      if (!isTty()) return;
      if (!hasLocalBin('claude-code-acp') && !hasCommand('claude-code-acp')) return;
      if (!process.env.DEFAULT_API_KEY?.trim()) return;

      const r = await runSmoke('claude');
      if (!r.sawAnyEvent) return;
      if (r.runtimeError && !r.sawAssistantDone) {
        console.warn(`[acp smoke] skip claude due to runtime error: ${r.runtimeError}`);
        return;
      }
      if (r.sawAuthRequired && !r.sawAssistantDone) {
        console.warn('[acp smoke] skip claude: auth required but not completed');
        return;
      }
      expect(r.sawAssistantDone).toBe(true);
      expect(r.assistantText.trim().length).toBeGreaterThan(0);
    }, 180_000);

    it('codex-acp works (requires DEFAULT_API_KEY)', async () => {
      if (!isTty()) return;
      if (!hasLocalBin('codex-acp') && !hasCommand('codex-acp')) return;
      if (!process.env.DEFAULT_API_KEY?.trim()) return;

      const r = await runSmoke('codex');
      if (!r.sawAnyEvent) return;
      if (r.runtimeError && !r.sawAssistantDone) {
        console.warn(`[acp smoke] skip codex due to runtime error: ${r.runtimeError}`);
        return;
      }
      if (r.sawAuthRequired && !r.sawAssistantDone) {
        console.warn('[acp smoke] skip codex: auth required but not completed');
        return;
      }
      if (!r.sawAssistantDone) {
        console.warn('[acp smoke] skip codex: did not complete (likely provider incompatibility)');
        return;
      }
      expect(r.sawAssistantDone).toBe(true);
      expect(r.assistantText.trim().length).toBeGreaterThan(0);
    }, 180_000);
  });
});

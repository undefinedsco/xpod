import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
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

describe('Manual: Multi-agent orchestration over ChatKit threads (PTY runtime)', () => {
  const root = repoRoot();
  const testDataDir = path.join(root, '.test-data', 'manual-multi-agent');
  const agentScriptPath = path.join(testDataDir, 'agent-sim.js');

  let store: InMemoryStore<StoreContext>;
  let service: ChatKitService<StoreContext>;
  const context: StoreContext = { userId: 'local-user' };

  beforeAll(() => {
    fs.mkdirSync(testDataDir, { recursive: true });
    fs.writeFileSync(agentScriptPath, buildAgentSimScript(), 'utf8');

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
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}
  });

  it('Secretary(codex) delegates to ClaudeCode + CodeBuddy and aggregates results', async () => {
    const node = process.execPath;
    const repoPath = root;

    // Create 3 ChatKit threads, each backed by a PTY runtime (CLI agent simulation).
    const secretaryEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: {
        xpod: {
          pty: {
            repoPath,
            worktree: { mode: 'existing', path: repoPath },
            runner: { type: 'codex', argv: [node, agentScriptPath, 'secretary'] },
          },
        },
      },
    }, context);
    const secretaryThreadId = secretaryEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof secretaryThreadId).toBe('string');

    const claudeEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: {
        xpod: {
          pty: {
            repoPath,
            worktree: { mode: 'existing', path: repoPath },
            runner: { type: 'claude', argv: [node, agentScriptPath, 'worker-claude'] },
          },
        },
      },
    }, context);
    const claudeThreadId = claudeEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof claudeThreadId).toBe('string');

    const buddyEvents = await collectStreamingEvents(service, {
      type: 'threads.create',
      params: {
        xpod: {
          pty: {
            repoPath,
            worktree: { mode: 'existing', path: repoPath },
            runner: { type: 'codebuddy', argv: [node, agentScriptPath, 'worker-codebuddy'] },
          },
        },
      },
    }, context);
    const buddyThreadId = buddyEvents.find((e) => e.type === 'thread.created')?.thread?.id;
    expect(typeof buddyThreadId).toBe('string');

    // 1) Ask secretary to delegate.
    const secretaryRound1 = await collectStreamingEvents(service, {
      type: 'threads.add_user_message',
      params: {
        thread_id: secretaryThreadId,
        input: { content: [{ type: 'input_text', text: 'REQUEST: Please delegate two tasks and wait.' }] },
      },
    }, context);
    const secretaryText1 = lastAssistantText(secretaryRound1);
    expect(secretaryText1).toContain('DELEGATE');

    // 2) Execute worker tasks (as instructed by secretary output).
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

    // 3) Send results back to secretary for aggregation.
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

function extractDelegateTask(secretaryText: string, who: 'claude' | 'codebuddy'): string {
  for (const line of secretaryText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('DELEGATE ') && trimmed.includes(`${who}:`)) {
      return trimmed.split(`${who}:`)[1].trim();
    }
  }
  return '';
}

function buildAgentSimScript(): string {
  // Keep this deterministic and fast to avoid idle-time cutoffs.
  return `
const role = process.argv[2] || 'worker';
function println(s) { process.stdout.write(String(s) + '\\n'); }

process.stdin.setEncoding('utf8');
process.stdin.resume();
let buf = '';
function onLine(line) {
  const t = String(line || '').trim();
  if (!t) return;
  if (role === 'secretary') {
    if (t.startsWith('REQUEST:')) {
      println('DELEGATE claude: Please summarize the repo structure (1 paragraph).');
      println('DELEGATE codebuddy: Please list 3 potential risks and mitigations.');
      println('WAITING');
      return;
    }
    if (t.startsWith('RESULTS:')) {
      println('FINAL: aggregated -> ' + t.slice('RESULTS:'.length).trim());
      return;
    }
    println('ACK: ' + t);
    return;
  }
  if (role === 'worker-claude') {
    println('RESULT(claude): ' + t);
    return;
  }
  if (role === 'worker-codebuddy') {
    println('RESULT(codebuddy): ' + t);
    return;
  }
  println('RESULT(worker): ' + t);
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf('\\n');
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\\r$/, '');
    buf = buf.slice(idx + 1);
    onLine(line);
  }
});

if (role === 'secretary') {
  println('[secretary] ready');
} else if (role === 'worker-claude') {
  println('[worker-claude] ready');
} else if (role === 'worker-codebuddy') {
  println('[worker-codebuddy] ready');
} else {
  println('[worker] ready');
}
`;
}

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { AiProvider } from '../../src/api/chatkit/service';
import { AcpRunExecutionBackend } from '../helpers/AcpRunExecutionBackend';
import { RunStatus, XpodRunStepType as RunStepType } from '../../src/api/runs/schema';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';

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

class RecordingClientToolBackend implements RunExecutionBackend {
  public readonly inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    if (!input.continuation) {
      yield {
        type: 'tool_call',
        requestId: 'tool_req_1',
        name: 'tool/example',
        arguments: JSON.stringify({ value: 1 }),
      };
    }
  }
}

describe('ChatKitService + ACP tool call', () => {
  const workspaceUri = `file://localhost${process.cwd()}`;

  it('maps ACP request to client_tool_call and records threads.add_client_tool_output', async () => {
    const store = new InMemoryStore();
    const aiProvider: AiProvider = {
      async *streamResponse() {
        throw new Error('aiProvider should not be used when PTY runtime is enabled');
      },
    };

    const svc = new ChatKitService({
      store,
      aiProvider,
      enableAgentRuntime: true,
      runExecutionBackend: new AcpRunExecutionBackend(),
    });

    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-tool-agent.js');

    const createReq = {
      type: 'threads.create',
      params: {
        workspace: workspaceUri,
        input: {
          content: [ { type: 'input_text', text: 'hello' } ],
        },
      },
      metadata: {
        runtime: {
          runner: {
            type: 'codex',
            protocol: 'acp',
            allowCustomArgv: true,
            argv: [ 'node', agentPath ],
          },
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
    const chatId = threadCreated.thread.metadata?.chat_id as string | undefined;
    expect(chatId).toBeTruthy();

    const toolEvent = createEvents.find((e) => e.type === 'thread.item.added' && e.item?.type === 'client_tool_call');
    expect(toolEvent).toBeTruthy();
    expect(toolEvent.item.name).toBe('tool/example');
    expect(toolEvent.item.metadata?.runId).toBeTruthy();
    const toolItemId = toolEvent.item.id as string;
    const runId = toolEvent.item.metadata.runId as string;
    const waitingRun = await store.loadRun(runId, { userId: 'u1' });
    expect(waitingRun.status).toBe(RunStatus.WAITING_INPUT);

    const outputReq = {
      type: 'threads.add_client_tool_output',
      params: {
        thread_id: threadId,
        chat_id: chatId,
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

    const doneToolOutput = outputEvents.find((e) => e.type === 'thread.item.done' && e.item?.id === toolItemId);
    expect(doneToolOutput).toBeTruthy();
    expect(doneToolOutput.item.status).toBe('completed');
    expect(doneToolOutput.item.output).toBe(JSON.stringify({ ok: true }));
    const continuedRun = await store.loadRun(runId, { userId: 'u1' });
    expect(continuedRun.status).toBe(RunStatus.WAITING_INPUT);
    expect(continuedRun.metadata?.continuation).toMatchObject({
      kind: 'client_tool_output',
      itemId: toolItemId,
      output: JSON.stringify({ ok: true }),
    });
    const steps = await store.loadRunSteps(runId, { userId: 'u1' });
    expect(steps.map((step) => step.type)).toContain(RunStepType.CLIENT_TOOL_OUTPUT);
    expect(steps.map((step) => step.type)).toContain(RunStepType.CONTINUE_REQUESTED);
  }, 20_000);

  it('requeues client tool output onto the same Run instead of creating a new Run', async () => {
    const store = new InMemoryStore();
    const backend = new RecordingClientToolBackend();
    const aiProvider: AiProvider = {
      async *streamResponse() {
        throw new Error('aiProvider should not be used when runtime backend is configured');
      },
    };

    const svc = new ChatKitService({
      store,
      aiProvider,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });

    const createResult = await svc.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceUri,
        input: {
          content: [{ type: 'input_text', text: 'needs client tool' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    }), { userId: 'u1' });

    const createChunks: Uint8Array[] = [];
    for await (const chunk of createResult.type === 'streaming' ? createResult.stream() : []) {
      createChunks.push(chunk);
    }
    const createEvents = parseSseDataLines(createChunks);
    const thread = createEvents.find((e) => e.type === 'thread.created')?.thread;
    const toolEvent = createEvents.find((e) => e.type === 'thread.item.added' && e.item?.type === 'client_tool_call');

    expect(thread).toBeTruthy();
    expect(toolEvent).toBeTruthy();
    expect(backend.inputs).toHaveLength(1);
    const firstInput = backend.inputs[0];
    const runId = toolEvent.item.metadata.runId as string;
    expect(firstInput.runId).toBe(runId);
    expect(firstInput.prompt).toBe('needs client tool');

    const output = JSON.stringify({ ok: true, value: 42 });
    const outputResult = await svc.process(JSON.stringify({
      type: 'threads.add_client_tool_output',
      params: {
        thread_id: thread.id,
        chat_id: thread.metadata.chat_id,
        item_id: toolEvent.item.id,
        output,
      },
    }), { userId: 'u1' });

    for await (const _chunk of outputResult.type === 'streaming' ? outputResult.stream() : []) {
      // drain
    }

    expect(backend.inputs).toHaveLength(2);
    const continuationInput = backend.inputs[1];
    expect(continuationInput.runId).toBe(runId);
    expect(continuationInput.runId).toBe(firstInput.runId);
    expect(continuationInput.continuation).toEqual({
      kind: 'client_tool_output',
      itemId: toolEvent.item.id,
    });
    expect(continuationInput.prompt).toContain('Continue the previous run after client tool output.');
    expect(continuationInput.prompt).toContain('tool/example');
    expect(continuationInput.prompt).toContain(output);
  });
});

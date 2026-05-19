import { PI_AGENT_WORKER_EVENT_PREFIX, PiAgentRuntimeDriver, type PiAgentRuntimeDriverOptions } from './PiAgentRuntimeDriver';
import type { AgentRuntimeEvent } from './AgentRuntimeTypes';
import type { RunExecutionInput } from './RunExecutionBackend';

type WorkerPayload = {
  input: RunExecutionInput;
  options?: Pick<PiAgentRuntimeDriverOptions, 'persistPiSessions' | 'sessionRootDir'>;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function emit(event: AgentRuntimeEvent): void {
  process.stdout.write(`${PI_AGENT_WORKER_EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as WorkerPayload;
  const driver = new PiAgentRuntimeDriver({
    ...payload.options,
    agentLoopIsolation: 'in-process',
  });

  for await (const event of driver.start(payload.input)) {
    emit(event);
  }
}

if (require.main === module) {
  main().catch((error) => {
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

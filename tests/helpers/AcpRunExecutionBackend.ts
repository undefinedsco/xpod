import { AcpAgentRuntime } from '../../src/api/chatkit/runtime/AcpAgentRuntime';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';

export class AcpRunExecutionBackend implements RunExecutionBackend {
  private readonly runtime = new AcpAgentRuntime();

  public start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    return this.runtime.run({
      threadId: input.threadId,
      prompt: input.prompt,
      config: input.config,
    });
  }
}

/**
 * Agent Executors 单元测试
 *
 * 测试支持的 2 个 Executor 的基本结构、接口实现和继承关系。
 * - CodeBuddyExecutor (使用 @tencent-ai/agent-sdk)
 * - ClaudeExecutor (使用 @anthropic-ai/claude-agent-sdk)
 *
 * 注意：OpenAI 和 Gemini 没有完整的 Agent SDK，已移除支持。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock CodeBuddy Agent SDK
vi.mock('@tencent-ai/agent-sdk', () => ({
  query: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
    const generator = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write', 'Bash'],
        model: 'claude-sonnet-4-20250514',
        apiKeySource: 'env',
      };
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `CodeBuddy response to: ${prompt}` }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: `CodeBuddy completed: ${prompt}`,
        usage: { input_tokens: 100, output_tokens: 50 },
        duration_ms: 1000,
      };
    })();

    // 添加 accountInfo 方法
    (generator as any).accountInfo = vi.fn().mockResolvedValue({
      email: 'test@example.com',
      organization: 'Test Org',
      apiKeySource: 'env',
    });

    return generator;
  }),
}));

// Mock Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
    const generator = (async function* () {
      // 流式事件
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 80 } },
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid-1',
        session_id: 'test-session',
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Claude ' },
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid-2',
        session_id: 'test-session',
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: `response to: ${prompt}` },
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid-3',
        session_id: 'test-session',
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 40 },
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid-4',
        session_id: 'test-session',
      };
      // 完整的 assistant 消息
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `Claude response to: ${prompt}` }],
          usage: { input_tokens: 80, output_tokens: 40 },
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid-5',
        session_id: 'test-session',
      };
      // 结果消息
      yield {
        type: 'result',
        subtype: 'success',
        result: `Claude completed: ${prompt}`,
        usage: { input_tokens: 80, output_tokens: 40 },
        duration_ms: 800,
        modelUsage: {},
        permission_denials: [],
        total_cost_usd: 0.001,
        num_turns: 1,
        is_error: false,
        duration_api_ms: 700,
        uuid: 'test-uuid-6',
        session_id: 'test-session',
      };
    })();

    return generator;
  }),
}));

// 动态导入以确保 mock 生效
const { CodeBuddyExecutor, createCodeBuddyExecutor } = await import('../../src/agents/CodeBuddyExecutor');
const { ClaudeExecutor, createClaudeExecutor } = await import('../../src/agents/ClaudeExecutor');
const { BaseAgentExecutor } = await import('../../src/agents/BaseAgentExecutor');
const { AgentExecutorFactory, SUPPORTED_EXECUTOR_TYPES } = await import('../../src/agents/AgentExecutorFactory');

import type { ExecutorConfig, BaseExecutorOptions, AiCredential } from '../../src/agents/types';

describe('Supported Executor Types', () => {
  it('should only support codebuddy and claude', () => {
    expect(SUPPORTED_EXECUTOR_TYPES).toEqual(['codebuddy', 'claude']);
  });
});

describe('Executor Inheritance', () => {
  it('CodeBuddyExecutor should extend BaseAgentExecutor', () => {
    const executor = new CodeBuddyExecutor();
    expect(executor).toBeInstanceOf(BaseAgentExecutor);
  });

  it('ClaudeExecutor should extend BaseAgentExecutor', () => {
    const executor = new ClaudeExecutor();
    expect(executor).toBeInstanceOf(BaseAgentExecutor);
  });
});

describe('Executor Optional Constructor', () => {
  it('CodeBuddyExecutor should support no-arg constructor', () => {
    const executor = new CodeBuddyExecutor();
    expect(executor.executorType).toBe('codebuddy');
    expect(executor.providerId).toBe('default');
  });

  it('ClaudeExecutor should support no-arg constructor', () => {
    const executor = new ClaudeExecutor();
    expect(executor.executorType).toBe('claude');
    expect(executor.providerId).toBe('default');
  });
});

describe('Executor With Options Constructor', () => {
  const credential: AiCredential = {
    providerId: 'test-provider',
    apiKey: 'test-api-key',
  };

  const options: BaseExecutorOptions = {
    providerId: 'custom-provider',
    credential,
  };

  it('CodeBuddyExecutor should accept options', () => {
    const executor = new CodeBuddyExecutor(options);
    expect(executor.providerId).toBe('custom-provider');
  });

  it('ClaudeExecutor should accept options', () => {
    const executor = new ClaudeExecutor(options);
    expect(executor.providerId).toBe('custom-provider');
  });
});

describe('Create Functions with Optional Args', () => {
  it('createCodeBuddyExecutor should work without args', () => {
    const executor = createCodeBuddyExecutor();
    expect(executor).toBeInstanceOf(CodeBuddyExecutor);
  });

  it('createClaudeExecutor should work without args', () => {
    const executor = createClaudeExecutor();
    expect(executor).toBeInstanceOf(ClaudeExecutor);
  });
});

describe('CodeBuddyExecutor', () => {
  let executor: InstanceType<typeof CodeBuddyExecutor>;

  const testConfig: ExecutorConfig = {
    name: 'test-codebuddy',
    systemPrompt: 'You are a test agent.',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CodeBuddyExecutor();
  });

  it('should have correct executorType', () => {
    expect(executor.executorType).toBe('codebuddy');
  });

  it('should return correct auth type', () => {
    expect(executor.getAuthType()).toBe('oidc'); // 没有 apiKey 时默认 oidc
  });

  it('should return api-key auth type when credential has apiKey', () => {
    const executorWithKey = new CodeBuddyExecutor({
      providerId: 'test',
      credential: { providerId: 'test', apiKey: 'test-key' },
    });
    expect(executorWithKey.getAuthType()).toBe('api-key');
  });

  it('should execute and yield messages', async () => {
    const messages: any[] = [];
    for await (const msg of executor.execute(testConfig, 'Hello')) {
      messages.push(msg);
    }

    expect(messages.length).toBeGreaterThan(0);
    const doneMsg = messages.find((m) => m.type === 'done');
    expect(doneMsg).toBeDefined();
    expect(doneMsg.result.success).toBe(true);
  });

  it('should executeAndWait and return result', async () => {
    const result = await executor.executeAndWait(testConfig, 'Test message');
    expect(result.success).toBe(true);
  });

  it('should check authentication', async () => {
    const authInfo = await executor.checkAuthentication();
    expect(authInfo.authenticated).toBe(true);
    expect(authInfo.executorType).toBe('codebuddy');
  });
});

describe('ClaudeExecutor', () => {
  let executor: InstanceType<typeof ClaudeExecutor>;

  const testConfig: ExecutorConfig = {
    name: 'test-claude',
    systemPrompt: 'You are a test agent.',
  };

  const credential: AiCredential = {
    providerId: 'anthropic',
    apiKey: 'test-claude-key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ClaudeExecutor({
      providerId: 'anthropic',
      credential,
    });
  });

  it('should have correct executorType', () => {
    expect(executor.executorType).toBe('claude');
  });

  it('should return api-key auth type', () => {
    expect(executor.getAuthType()).toBe('api-key');
  });

  it('should execute and yield messages', async () => {
    const messages: any[] = [];
    for await (const msg of executor.execute(testConfig, 'Hello')) {
      messages.push(msg);
    }

    expect(messages.length).toBeGreaterThan(0);
    const doneMsg = messages.find((m) => m.type === 'done');
    expect(doneMsg).toBeDefined();
    expect(doneMsg.result.success).toBe(true);
  });

  it('should yield text messages during streaming', async () => {
    const messages: any[] = [];
    for await (const msg of executor.execute(testConfig, 'Hello')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    expect(textMsgs.length).toBeGreaterThan(0);
    expect(textMsgs.some((m) => m.content.includes('Claude'))).toBe(true);
  });

  it('should executeAndWait and return result', async () => {
    const result = await executor.executeAndWait(testConfig, 'Test message');
    expect(result.success).toBe(true);
  });

  it('should chat with multiple messages', async () => {
    const result = await executor.chat(testConfig, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
    ]);
    expect(result.success).toBe(true);
  });

  it('should check authentication', async () => {
    const authInfo = await executor.checkAuthentication();
    expect(authInfo.authenticated).toBe(true);
    expect(authInfo.executorType).toBe('claude');
    expect(authInfo.authType).toBe('api-key');
  });
});

describe('AgentExecutorFactory', () => {
  let factory: InstanceType<typeof AgentExecutorFactory>;

  beforeEach(() => {
    factory = new AgentExecutorFactory();
  });

  it('should check if executor type is supported', () => {
    expect(factory.isSupported('codebuddy')).toBe(true);
    expect(factory.isSupported('claude')).toBe(true);
    expect(factory.isSupported('openai')).toBe(false);
    expect(factory.isSupported('gemini')).toBe(false);
    expect(factory.isSupported('unknown')).toBe(false);
  });

  it('should create CodeBuddyExecutor', () => {
    const executor = factory.createExecutor('codebuddy', {
      providerId: 'cb',
      credential: { providerId: 'cb', apiKey: 'key' },
    });
    expect(executor.executorType).toBe('codebuddy');
  });

  it('should create ClaudeExecutor', () => {
    const executor = factory.createExecutor('claude', {
      providerId: 'anthropic',
      credential: { providerId: 'anthropic', apiKey: 'key' },
    });
    expect(executor.executorType).toBe('claude');
  });

  it('should throw for unsupported executor type (openai)', () => {
    expect(() => {
      factory.createExecutor('openai' as any, {
        providerId: 'openai',
        credential: { providerId: 'openai', apiKey: 'key' },
      });
    }).toThrow('Unsupported executor type');
  });

  it('should throw for unsupported executor type (gemini)', () => {
    expect(() => {
      factory.createExecutor('gemini' as any, {
        providerId: 'gemini',
        credential: { providerId: 'gemini', apiKey: 'key' },
      });
    }).toThrow('Unsupported executor type');
  });

  it('should throw for unknown executor type', () => {
    expect(() => {
      factory.createExecutor('unknown' as any, {
        providerId: 'test',
        credential: { providerId: 'test', apiKey: 'key' },
      });
    }).toThrow('Unsupported executor type');
  });

  it('should createDirect with credential', () => {
    const executor = factory.createDirect('claude', 'my-claude', {
      providerId: 'my-claude',
      apiKey: 'direct-key',
    });
    expect(executor.executorType).toBe('claude');
    expect(executor.providerId).toBe('my-claude');
  });
});

describe('Usage Statistics', () => {
  const testConfig: ExecutorConfig = {
    name: 'test',
    systemPrompt: 'Test',
  };

  it('CodeBuddyExecutor should return usage stats', async () => {
    const executor = new CodeBuddyExecutor();
    const result = await executor.executeAndWait(testConfig, 'Test');

    expect(result.usage).toBeDefined();
    expect(result.usage?.promptTokens).toBe(100);
    expect(result.usage?.completionTokens).toBe(50);
    expect(result.usage?.durationMs).toBeGreaterThan(0);
  });

  it('ClaudeExecutor should return usage stats', async () => {
    const executor = new ClaudeExecutor({
      providerId: 'anthropic',
      credential: { providerId: 'anthropic', apiKey: 'key' },
    });
    const result = await executor.executeAndWait(testConfig, 'Test');

    expect(result.usage).toBeDefined();
    expect(result.usage?.promptTokens).toBe(80);
    expect(result.usage?.completionTokens).toBe(40);
  });
});

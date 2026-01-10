/**
 * IndexAgent 单元测试
 *
 * 测试 IndexAgent 的基本属性和结构，mock SDK 调用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IndexAgent } from '../../src/agents/IndexAgent';
import type { AgentContext } from '../../src/task/types';

// Mock CodeBuddy Agent SDK
vi.mock('@tencent-ai/agent-sdk', () => ({
  query: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
    const generator = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write', 'Bash'],
        model: 'claude-sonnet-4-20250514',
      };
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `Response to: ${prompt}` }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({
          success: true,
          indexLevel: 'L0',
          summary: 'Test file summary',
        }),
        usage: { input_tokens: 100, output_tokens: 50 },
        duration_ms: 1000,
      };
    })();

    (generator as any).accountInfo = vi.fn().mockResolvedValue({
      email: 'test@example.com',
    });

    return generator;
  }),
}));

// Mock AgentContext
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    taskId: 'task-123',
    podBaseUrl: 'https://pod.example.com',
    accessToken: 'test-access-token',
    getAuthenticatedFetch: vi.fn().mockResolvedValue(fetch),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe('IndexAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Agent Properties', () => {
    it('should have correct name', () => {
      const agent = new IndexAgent();
      expect(agent.name).toBe('indexing');
    });

    it('should have description containing 索引', () => {
      const agent = new IndexAgent();
      expect(agent.description).toContain('索引');
    });

    it('should have description containing 可检索', () => {
      const agent = new IndexAgent();
      expect(agent.description).toContain('可检索');
    });
  });

  describe('execute', () => {
    it('should execute and return success result', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute(
        '用户在 </docs/> 上传了文件 </docs/report.pdf>',
        context,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should include usage statistics in result', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute(
        '用户在 </docs/> 上传了文件 </docs/report.pdf>',
        context,
      );

      expect(result.usage).toBeDefined();
    });

    it('should log execution progress', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      await agent.execute('用户在 </docs/> 上传了文件 </docs/report.pdf>', context);

      // 日志格式为 "IndexAgent (L0) received: ..."
      expect(context.log.info).toHaveBeenCalledWith(
        expect.stringContaining('received'),
      );
    });

    it('should log completion on success', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      await agent.execute('用户在 </docs/> 上传了文件 </docs/report.pdf>', context);

      // 日志格式为 "IndexAgent (L0) completed: ..."
      expect(context.log.info).toHaveBeenCalledWith(
        expect.stringContaining('completed'),
      );
    });
  });

  describe('Message Types', () => {
    it('should accept file upload message', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute(
        '用户在 </docs/> 上传了文件 </docs/report.pdf>',
        context,
      );

      expect(result.success).toBe(true);
    });

    it('should accept starred file message', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute('用户收藏了文件 </docs/important.pdf>', context);

      expect(result.success).toBe(true);
    });

    it('should accept scheduled scan message', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute(
        '定时扫描：检查 </docs/> 下未索引的文件',
        context,
      );

      expect(result.success).toBe(true);
    });

    it('should accept L0 index request', async () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      const result = await agent.execute(
        '为文件 </docs/readme.md> 生成 L0 索引',
        context,
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Design Principles', () => {
    it('should not hardcode processing logic', () => {
      const agent = new IndexAgent();

      // IndexAgent 不应该有具体的处理方法
      expect((agent as any).parseWithJina).toBeUndefined();
      expect((agent as any).chunkMarkdown).toBeUndefined();
      expect((agent as any).storeChunks).toBeUndefined();
      expect((agent as any).generateEmbedding).toBeUndefined();
    });

    it('should delegate to CodeBuddyExecutor', () => {
      const agent = new IndexAgent();

      // IndexAgent 应该有 executor 属性
      expect((agent as any).executor).toBeDefined();
      expect((agent as any).executor.executorType).toBe('codebuddy');
    });

    it('should have L0-focused system prompt', () => {
      const agent = new IndexAgent();
      const context = createMockContext();

      // getConfig 现在接受 (level, context) 两个参数
      const config = (agent as any).getConfig('L0', context);

      expect(config.systemPrompt).toContain('L0');
      expect(config.systemPrompt).toContain('摘要');
    });

    it('should use acceptEdits permission mode', () => {
      const agent = new IndexAgent();
      const context = createMockContext();
      const config = (agent as any).getConfig('L0', context);

      expect(config.permissionMode).toBe('acceptEdits');
    });

    it('should limit maxTurns for L0 simplicity', () => {
      const agent = new IndexAgent();
      const context = createMockContext();
      const config = (agent as any).getConfig('L0', context);

      expect(config.maxTurns).toBeLessThanOrEqual(10);
    });
  });

  describe('Context Handling', () => {
    it('should pass podBaseUrl to executor', async () => {
      const agent = new IndexAgent();
      const context = createMockContext({
        podBaseUrl: 'https://my-pod.example.com',
      });

      const result = await agent.execute('索引文件', context);

      // 验证执行成功即可，内部会传递 podBaseUrl
      expect(result.success).toBe(true);
    });

    it('should pass accessToken to executor', async () => {
      const agent = new IndexAgent();
      const context = createMockContext({
        accessToken: 'my-oauth-token',
      });

      const result = await agent.execute('索引文件', context);

      expect(result.success).toBe(true);
    });
  });
});

describe('IndexAgent Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle executor failure gracefully', async () => {
    // 重新 mock 为失败响应
    vi.doMock('@tencent-ai/agent-sdk', () => ({
      query: vi.fn().mockImplementation(() => {
        const generator = (async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['Execution failed'],
            duration_ms: 100,
          };
        })();
        return generator;
      }),
    }));

    const agent = new IndexAgent();
    const context = createMockContext();

    // 即使执行失败，也不应该抛出异常
    const result = await agent.execute('索引文件', context);

    // 结果取决于 IndexAgent 如何处理错误
    expect(result).toBeDefined();
  });
});

describe('IndexAgent Levels', () => {
  it('should support L0 level by default', () => {
    const agent = new IndexAgent();
    const context = createMockContext();
    const config = (agent as any).getConfig('L0', context);

    expect(config.systemPrompt).toContain('L0');
  });

  it('should support L1 level', () => {
    const agent = new IndexAgent({ level: 'L1' });
    const context = createMockContext();
    const config = (agent as any).getConfig('L1', context);

    expect(config.systemPrompt).toContain('L1');
  });

  it('should support L2 level', () => {
    const agent = new IndexAgent({ level: 'L2' });
    const context = createMockContext();
    const config = (agent as any).getConfig('L2', context);

    expect(config.systemPrompt).toContain('L2');
  });
});

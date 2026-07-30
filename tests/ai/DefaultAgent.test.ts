/**
 * Default Agent 单元测试
 *
 * 测试 Default Agent 的配置和可用性检查
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt }: { prompt: string }) => (async function*() {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `scoped:${prompt}` }],
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: `done:${prompt}`,
      total_cost_usd: 0.01,
    };
  })()),
}));

import * as claudeSdk from '@anthropic-ai/claude-agent-sdk';
import {
  getDefaultAgentConfig,
  isDefaultAgentAvailable,
  runDefaultAgent,
} from '../../src/api/chatkit/default-agent';

describe('DefaultAgent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // 保存环境变量
    savedEnv.DEFAULT_API_BASE = process.env.DEFAULT_API_BASE;
    savedEnv.DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER;
    savedEnv.DEFAULT_MODEL = process.env.DEFAULT_MODEL;
    savedEnv.DEFAULT_API_KEY = process.env.DEFAULT_API_KEY;
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    savedEnv.CLAUDE_CODE_PATH = process.env.CLAUDE_CODE_PATH;

    // 清除环境变量
    delete process.env.DEFAULT_API_BASE;
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_MODEL;
    delete process.env.DEFAULT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_PATH;
    (claudeSdk.query as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    // 恢复环境变量
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  describe('getDefaultAgentConfig', () => {
    it('should return no ambient provider connection when no invocation config is provided', () => {
      process.env.DEFAULT_PROVIDER = 'anthropic';
      process.env.DEFAULT_MODEL = 'claude-3-opus';
      process.env.DEFAULT_API_KEY = 'raw-provider-key';
      process.env.DEFAULT_API_BASE = 'https://raw-provider.example/v1';

      const config = getDefaultAgentConfig();

      expect(config.connection).toBeUndefined();
      expect(config.claudeCodePath).toBeUndefined();
    });

    it('should use explicit AI Connection invocation config', () => {
      process.env.DEFAULT_PROVIDER = 'anthropic';
      process.env.DEFAULT_MODEL = 'claude-3-opus';
      process.env.DEFAULT_API_KEY = 'raw-provider-key';
      process.env.CLAUDE_CODE_PATH = '/usr/local/bin/claude';

      const config = getDefaultAgentConfig({
        connection: {
          baseUrl: 'http://127.0.0.1:3000/v1',
          gatewayKey: 'gateway-key',
        },
        model: 'linx',
      });

      expect(config.connection).toEqual({
        baseUrl: 'http://127.0.0.1:3000/v1',
        gatewayKey: 'gateway-key',
      });
      expect(config.model).toBe('linx');
      expect(config.claudeCodePath).toBe('/usr/local/bin/claude');
    });
  });

  describe('isDefaultAgentAvailable', () => {
    it('should return false without explicit AI Connection even when ambient DEFAULT_API_KEY is set', () => {
      process.env.DEFAULT_API_KEY = 'raw-provider-key';
      process.env.DEFAULT_API_BASE = 'https://raw-provider.example/v1';
      expect(isDefaultAgentAvailable()).toBe(false);
    });

    it('should return true only with explicit AI Connection', () => {
      expect(isDefaultAgentAvailable({
        connection: {
          baseUrl: 'http://127.0.0.1:3000/v1',
          gatewayKey: 'gateway-key',
        },
      })).toBe(true);
    });
  });

  it('runs with scoped AI Connection env and does not inherit ambient provider credentials', async () => {
    process.env.DEFAULT_API_KEY = 'raw-default-key';
    process.env.DEFAULT_API_BASE = 'https://raw-default.example/v1';
    process.env.ANTHROPIC_API_KEY = 'ambient-anthropic-key';
    process.env.ANTHROPIC_BASE_URL = 'https://ambient-anthropic.example';

    const response = await runDefaultAgent(
      'hello',
      {
        solidToken: 'solid-token',
        podBaseUrl: 'https://pod.example/alice/',
      },
      {
        connection: {
          baseUrl: 'http://127.0.0.1:3000/v1',
          gatewayKey: 'gateway-key',
        },
        model: 'linx',
      },
    );

    expect(response.success).toBe(true);
    const queryOptions = (claudeSdk.query as ReturnType<typeof vi.fn>).mock.calls[0][0].options;
    expect(queryOptions.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3000');
    expect(queryOptions.env.ANTHROPIC_API_KEY).toBe('gateway-key');
    expect(queryOptions.env.DEFAULT_API_KEY).toBeUndefined();
    expect(queryOptions.env.DEFAULT_API_BASE).toBeUndefined();
    expect(queryOptions.env.SOLID_TOKEN).toBe('solid-token');
  });

  it('directs AI setup through AI Connection without plaintext Pod credential examples', async () => {
    await runDefaultAgent(
      'help me configure AI',
      {
        solidToken: 'solid-token',
        podBaseUrl: 'https://pod.example/alice/',
      },
      {
        connection: {
          baseUrl: 'http://127.0.0.1:3000/v1',
          gatewayKey: 'gateway-key',
        },
      },
    );

    const systemPrompt = (claudeSdk.query as ReturnType<typeof vi.fn>).mock.calls[0][0].options.systemPrompt;
    expect(systemPrompt).toContain('AI Connection');
    expect(systemPrompt).toMatch(/Connect|SecretCell/);
    expect(systemPrompt).not.toContain('/settings/credentials.ttl');
    expect(systemPrompt).not.toContain('xpod:apiKey');
    expect(systemPrompt).not.toMatch(/apiKey\s+"sk/i);
  });
});

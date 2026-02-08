/**
 * Default Agent 集成测试
 *
 * 测试 Default Agent 通过 Claude Code SDK 访问 Pod 并存储数据
 *
 * 需要：
 * - DEFAULT_API_KEY 环境变量
 * - Claude Code CLI 已安装
 * - CSS 服务运行中（可选，用于真实 Pod 测试）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  isDefaultAgentAvailable,
  getDefaultAgentConfig,
  runDefaultAgent,
} from '../../src/api/chatkit/default-agent';

// 跳过条件：没有 DEFAULT_API_KEY 或没有 Claude Code
const shouldSkip = process.env.XPOD_RUN_DOCKER_TESTS !== 'true' || !process.env.DEFAULT_API_KEY;

describe.skipIf(shouldSkip)('DefaultAgent Integration', () => {
  const testConfig = {
    claudeCodePath: process.env.CLAUDE_CODE_PATH || '/Users/ganlu/.local/bin/claude',
    podBaseUrl: process.env.TEST_POD_URL || 'http://localhost:3000/test/',
    solidToken: process.env.TEST_SOLID_TOKEN || 'test-token',
    timeout: 60000,
  };

  let originalHome: string | undefined;

  beforeAll(() => {
    originalHome = process.env.HOME;
    const claudeHome = path.resolve(process.cwd(), '.test-data/claude-home');
    fs.mkdirSync(path.join(claudeHome, '.claude', 'debug'), { recursive: true });
    process.env.HOME = claudeHome;
    process.env.USERPROFILE = claudeHome;
    console.log('Default Agent 集成测试配置:');
    console.log(`  Claude Code: ${testConfig.claudeCodePath}`);
    console.log(`  Pod URL: ${testConfig.podBaseUrl}`);
    console.log(`  DEFAULT_API_KEY: ${process.env.DEFAULT_API_KEY?.slice(0, 10)}...`);
  });

  afterAll(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
    }
  });


  describe('环境变量注入', () => {
    it('should inject SOLID_TOKEN and POD_BASE_URL into CC environment', async () => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), testConfig.timeout);

      try {
        const q = query({
          prompt: '请执行 echo "TOKEN=$SOLID_TOKEN, POD=$POD_BASE_URL" 并返回结果',
          options: {
            abortController,
            pathToClaudeCodeExecutable: testConfig.claudeCodePath,
            env: {
              ...process.env,
              SOLID_TOKEN: testConfig.solidToken,
              POD_BASE_URL: testConfig.podBaseUrl,
            },
            allowedTools: ['Bash'],
            maxTurns: 3,
          },
        });

        let output = '';
        for await (const msg of q) {
          if (msg.type === 'assistant') {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') {
                  output += block.text;
                }
              }
            }
          } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
            output = msg.result;
          }
        }

        clearTimeout(timeoutId);

        // 验证环境变量被正确注入
        expect(output).toContain(testConfig.solidToken);
        expect(output).toContain(testConfig.podBaseUrl);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }, testConfig.timeout + 10000);
  });

  describe('runDefaultAgent', () => {
    it('should respond to basic greeting', async () => {
      const context = {
        solidToken: testConfig.solidToken,
        podBaseUrl: testConfig.podBaseUrl,
        webId: `${testConfig.podBaseUrl}profile/card#me`,
      };

      const response = await runDefaultAgent(
        '你好，请简单介绍一下你自己',
        context,
        { timeout: testConfig.timeout, maxTurns: 2 },
      );

      expect(response.success).toBe(true);
      expect(response.content).toBeTruthy();
      expect(response.content.length).toBeGreaterThan(10);
    }, testConfig.timeout + 10000);
  });
});

describe('DefaultAgent Availability', () => {
  it('should correctly report availability based on DEFAULT_API_KEY', () => {
    const originalKey = process.env.DEFAULT_API_KEY;

    // 测试无 key
    delete process.env.DEFAULT_API_KEY;
    expect(isDefaultAgentAvailable()).toBe(false);

    // 测试有 key
    process.env.DEFAULT_API_KEY = 'test-key';
    expect(isDefaultAgentAvailable()).toBe(true);

    // 恢复
    if (originalKey) {
      process.env.DEFAULT_API_KEY = originalKey;
    } else {
      delete process.env.DEFAULT_API_KEY;
    }
  });

  it('should return correct default config', () => {
    const config = getDefaultAgentConfig();

    expect(config.provider).toBe(process.env.DEFAULT_PROVIDER || 'openrouter');
    expect(config.model).toBe(process.env.DEFAULT_MODEL || 'stepfun/step-3.5-flash:free');
  });
});

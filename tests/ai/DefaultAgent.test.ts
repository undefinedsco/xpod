/**
 * Default Agent 单元测试
 *
 * 测试 Default Agent 的配置和可用性检查
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDefaultAgentConfig,
  isDefaultAgentAvailable,
} from '../../src/api/chatkit/default-agent';

describe('DefaultAgent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // 保存环境变量
    savedEnv.DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER;
    savedEnv.DEFAULT_MODEL = process.env.DEFAULT_MODEL;
    savedEnv.DEFAULT_API_KEY = process.env.DEFAULT_API_KEY;
    savedEnv.CLAUDE_CODE_PATH = process.env.CLAUDE_CODE_PATH;

    // 清除环境变量
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_MODEL;
    delete process.env.DEFAULT_API_KEY;
    delete process.env.CLAUDE_CODE_PATH;
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
    it('should return default values when no env vars set', () => {
      const config = getDefaultAgentConfig();

      expect(config.provider).toBe('openrouter');
      expect(config.model).toBe('stepfun/step-3.5-flash:free');
      expect(config.apiKey).toBe('');
      expect(config.claudeCodePath).toBeUndefined();
    });

    it('should use env vars when set', () => {
      process.env.DEFAULT_PROVIDER = 'anthropic';
      process.env.DEFAULT_MODEL = 'claude-3-opus';
      process.env.DEFAULT_API_KEY = 'test-api-key';
      process.env.CLAUDE_CODE_PATH = '/usr/local/bin/claude';

      const config = getDefaultAgentConfig();

      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe('claude-3-opus');
      expect(config.apiKey).toBe('test-api-key');
      expect(config.claudeCodePath).toBe('/usr/local/bin/claude');
    });
  });

  describe('isDefaultAgentAvailable', () => {
    it('should return false when DEFAULT_API_KEY is not set', () => {
      expect(isDefaultAgentAvailable()).toBe(false);
    });

    it('should return false when DEFAULT_API_KEY is empty', () => {
      process.env.DEFAULT_API_KEY = '';
      expect(isDefaultAgentAvailable()).toBe(false);
    });

    it('should return true when DEFAULT_API_KEY is set', () => {
      process.env.DEFAULT_API_KEY = 'some-api-key';
      expect(isDefaultAgentAvailable()).toBe(true);
    });
  });
});

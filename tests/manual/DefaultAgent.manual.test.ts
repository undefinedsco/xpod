/**
 * DefaultAgent manual/local integration test.
 *
 * Requirements:
 * - AI_CONNECTION_BASE_URL (Xpod /v1 gateway endpoint)
 * - AI_CONNECTION_API_KEY (Xpod-issued gateway key, not raw provider secret)
 * - Claude Code CLI installed (or set CLAUDE_CODE_PATH)
 *
 * Notes:
 * - This test depends on local machine + external network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { runDefaultAgent } from '../../src/api/chatkit/default-agent';

const claudeCodePath = process.env.CLAUDE_CODE_PATH || '/Users/ganlu/.local/bin/claude';

const shouldSkip =
  process.env.XPOD_RUN_INTEGRATION_TESTS !== 'true' ||
  !process.env.AI_CONNECTION_BASE_URL ||
  !process.env.AI_CONNECTION_API_KEY ||
  !fs.existsSync(claudeCodePath);

describe.skipIf(shouldSkip)('DefaultAgent Manual Integration', () => {
  const testConfig = {
    claudeCodePath,
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

    console.log('Default Agent manual test config:');
    console.log(`  Claude Code: ${testConfig.claudeCodePath}`);
    console.log(`  Pod URL: ${testConfig.podBaseUrl}`);
    console.log(`  AI Connection: ${process.env.AI_CONNECTION_BASE_URL}`);
  });

  afterAll(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
    }
  });

  it(
    'should keep Pod context available when running default model fallback',
    async () => {
      const context = {
        solidToken: testConfig.solidToken,
        podBaseUrl: testConfig.podBaseUrl,
        webId: `${testConfig.podBaseUrl}profile/card#me`,
      };

      const response = await runDefaultAgent(
        'Please confirm you received the current Pod context.',
        context,
        {
          timeout: testConfig.timeout,
          maxTurns: 2,
          connection: {
            baseUrl: process.env.AI_CONNECTION_BASE_URL!,
            gatewayKey: process.env.AI_CONNECTION_API_KEY!,
          },
        },
      );

      expect(response.success).toBe(true);
      expect(response.content).toBeTruthy();
    },
    testConfig.timeout + 10000,
  );

  it(
    'should respond to basic greeting',
    async () => {
      const context = {
        solidToken: testConfig.solidToken,
        podBaseUrl: testConfig.podBaseUrl,
        webId: `${testConfig.podBaseUrl}profile/card#me`,
      };

      const response = await runDefaultAgent(
        'Hello, please briefly introduce yourself.',
        context,
        {
          timeout: testConfig.timeout,
          maxTurns: 2,
          connection: {
            baseUrl: process.env.AI_CONNECTION_BASE_URL!,
            gatewayKey: process.env.AI_CONNECTION_API_KEY!,
          },
        },
      );

      expect(response.success).toBe(true);
      expect(response.content).toBeTruthy();
      expect(response.content.length).toBeGreaterThan(10);
    },
    testConfig.timeout + 10000,
  );
});

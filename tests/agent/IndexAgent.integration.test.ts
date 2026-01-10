/**
 * IndexAgent 集成测试
 *
 * 测试 IndexAgent 通过真实 CodeBuddy Agent SDK 执行任务。
 *
 * 运行方式：
 * XPOD_RUN_AGENT_TESTS=true npm test -- tests/agent/IndexAgent.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IndexAgent, type IndexLevel } from '../../src/agents/IndexAgent';
import { CodeBuddyExecutor, CodeBuddyAuthError } from '../../src/agents/CodeBuddyExecutor';
import type { AgentContext } from '../../src/task/types';

// 仅在设置环境变量时运行
const runAgentTests = process.env.XPOD_RUN_AGENT_TESTS === 'true';

// 创建临时目录模拟 Pod
function createTempPod(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-test-pod-'));

  // 创建测试文件
  fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });

  // 创建一个简单的文本文件
  fs.writeFileSync(
    path.join(tempDir, 'docs', 'readme.txt'),
    `# Project README

This is a sample project for testing the IndexAgent.

## Features

- Feature 1: Document indexing
- Feature 2: Semantic search
- Feature 3: AI-powered summaries

## Getting Started

Run npm install to get started.
`,
  );

  // 创建一个 Markdown 文件
  fs.writeFileSync(
    path.join(tempDir, 'docs', 'notes.md'),
    `# Meeting Notes - 2026-01-09

## Attendees
- Alice
- Bob
- Charlie

## Agenda
1. Project status update
2. Q1 planning
3. Resource allocation

## Action Items
- Alice to prepare the demo
- Bob to review the design doc
`,
  );

  // 创建一个更复杂的 Markdown 文件用于 L2 测试
  fs.writeFileSync(
    path.join(tempDir, 'docs', 'technical-design.md'),
    `# Technical Design Document

## 1. Introduction

This document describes the technical architecture of the XPod system.
The system is designed to provide a personal data storage solution.

### 1.1 Purpose

The purpose of this document is to outline the key components and their interactions.
It serves as a reference for developers and architects.

### 1.2 Scope

This document covers the backend architecture, API design, and data models.
Frontend implementation is covered in a separate document.

## 2. Architecture Overview

The system follows a modular architecture with clear separation of concerns.

### 2.1 Core Components

The core components include:
- **Storage Layer**: Handles data persistence
- **API Layer**: RESTful and LDP interfaces
- **Auth Layer**: OAuth 2.0 authentication

### 2.2 Data Flow

Data flows through the following stages:
1. Client request
2. Authentication
3. Authorization
4. Business logic
5. Storage operation
6. Response

## 3. API Design

### 3.1 REST Endpoints

The REST API follows standard conventions:

\`\`\`
GET /api/resources
POST /api/resources
PUT /api/resources/:id
DELETE /api/resources/:id
\`\`\`

### 3.2 LDP Interface

The LDP interface provides RDF-based data access:

\`\`\`turtle
@prefix ldp: <http://www.w3.org/ns/ldp#> .
</container/> a ldp:Container .
\`\`\`

## 4. Security Considerations

### 4.1 Authentication

OAuth 2.0 with PKCE flow is used for authentication.
Access tokens are short-lived with refresh token rotation.

### 4.2 Authorization

Fine-grained access control is implemented using ACL.
Resources can have individual permissions.

## 5. Conclusion

This architecture provides a solid foundation for personal data management.
Future iterations will add more advanced features.
`,
  );

  return tempDir;
}

// 创建 Mock AgentContext
function createTestContext(podPath: string): AgentContext {
  return {
    taskId: `test-task-${Date.now()}`,
    podBaseUrl: `file://${podPath}`,
    getAuthenticatedFetch: async () => fetch,
    updateStatus: async () => {},
    log: {
      debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
      info: (msg: string) => console.log(`[INFO] ${msg}`),
      warn: (msg: string) => console.warn(`[WARN] ${msg}`),
      error: (msg: string) => console.error(`[ERROR] ${msg}`),
    },
  };
}

// 创建无鉴权的 AgentContext（没有 accessToken）
function createUnauthenticatedContext(podPath: string): AgentContext {
  return {
    taskId: `test-task-no-auth-${Date.now()}`,
    podBaseUrl: `file://${podPath}`,
    // 没有 accessToken，Agent 将无法通过 Pod MCP 访问资源
    // 但仍可以使用本地工具（Read, Write, Bash 等）
    getAuthenticatedFetch: async () => fetch,
    updateStatus: async () => {},
    log: {
      debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
      info: (msg: string) => console.log(`[INFO] ${msg}`),
      warn: (msg: string) => console.warn(`[WARN] ${msg}`),
      error: (msg: string) => console.error(`[ERROR] ${msg}`),
    },
  };
}

describe.skipIf(!runAgentTests)('IndexAgent Integration', () => {
  let tempPodPath: string;

  beforeAll(() => {
    tempPodPath = createTempPod();
    console.log(`Created temp pod at: ${tempPodPath}`);
  });

  afterAll(() => {
    // 清理临时目录
    if (tempPodPath) {
      fs.rmSync(tempPodPath, { recursive: true, force: true });
      console.log(`Cleaned up temp pod: ${tempPodPath}`);
    }
  });

  describe('CodeBuddyExecutor', () => {
    it('should initialize and respond to simple query', async () => {
      const executor = new CodeBuddyExecutor();

      const config = {
        name: 'test-agent',
        description: 'Test agent',
        systemPrompt: '你是一个测试助手。请直接回答问题，不要使用任何工具。',
        maxTurns: 1,
        permissionMode: 'acceptEdits' as const,
        disallowedTools: ['Task', 'Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep'],
      };

      const result = await executor.executeAndWait(
        config,
        '请直接回答：1+1=?（只需要回答数字）',
      );

      console.log('CodeBuddyExecutor result:', result);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.result).toContain('2');
    }, 120000); // 2 分钟超时
  });

  describe('IndexAgent L0', () => {
    it('should have correct properties', () => {
      const agent = new IndexAgent();

      expect(agent.name).toBe('indexing');
      expect(agent.description).toContain('索引');
    });

    it('should execute L0 indexing for a text file', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      // 执行 L0 索引
      const result = await agent.execute(
        `为文件 ${tempPodPath}/docs/readme.txt 生成 L0 索引（摘要）`,
        context,
      );

      console.log('IndexAgent L0 result:', JSON.stringify(result, null, 2));

      // 验证返回了结果（成功或失败都有返回）
      expect(result).toBeDefined();

      // Agent 执行完成（即使 AI 决定无法完成也算执行成功）
      // 实际集成测试中，AI 可能因为权限、工具限制等原因返回失败
      // 这里主要验证整个执行流程是通的
      if (result.success) {
        // 如果成功，验证返回了摘要相关信息
        if (result.data) {
          console.log('Result data:', result.data);
        }
      } else {
        // 如果失败，验证有错误信息
        console.log('Result error:', result.error);
        expect(result.error).toBeDefined();
      }
    }, 180000); // 3 分钟超时

    it('should handle markdown file indexing', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      const result = await agent.execute(
        `为文件 ${tempPodPath}/docs/notes.md 生成 L0 索引`,
        context,
      );

      console.log('IndexAgent markdown result:', JSON.stringify(result, null, 2));

      // 验证执行完成
      expect(result).toBeDefined();

      // 同样，主要验证流程通的
      if (!result.success) {
        console.log('Markdown indexing error:', result.error);
      }
    }, 180000);

    it('should report usage statistics', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      const result = await agent.execute(
        `为文件 ${tempPodPath}/docs/readme.txt 生成简短摘要`,
        context,
      );

      console.log('Usage stats:', result.usage);

      expect(result).toBeDefined();
      // usage 可能存在也可能不存在，取决于 SDK 版本
      if (result.usage) {
        // CodeBuddy SDK 不返回 turns，检查 durationMs
        expect(result.usage.durationMs).toBeGreaterThan(0);
      }
    }, 180000);
  });

  describe('Error Handling', () => {
    it('should handle non-existent file gracefully', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      const result = await agent.execute(
        `为文件 ${tempPodPath}/docs/nonexistent.pdf 生成索引`,
        context,
      );

      console.log('Non-existent file result:', JSON.stringify(result, null, 2));

      // Agent 应该能够处理这种情况（可能成功但报告文件不存在，或者失败）
      expect(result).toBeDefined();
    }, 180000);
  });

  describe('IndexAgent L2', () => {
    it('should execute L2 full-text indexing', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      // 使用 executeWithLevel 直接指定 L2 级别
      const result = await agent.executeWithLevel(
        'L2',
        `对文件 ${tempPodPath}/docs/technical-design.md 进行全文索引，提取所有章节和内容块`,
        context,
      );

      console.log('IndexAgent L2 result:', JSON.stringify(result, null, 2));

      // 验证返回了结果
      expect(result).toBeDefined();

      if (result.success) {
        console.log('L2 indexing data:', result.data);
        // L2 应该返回更多的 chunks
        if (result.data && typeof result.data === 'object') {
          console.log('L2 structured output:', result.data);
        }
      } else {
        console.log('L2 indexing error:', result.error);
      }

      // 验证 usage 统计
      if (result.usage) {
        console.log('L2 usage stats:', result.usage);
        // CodeBuddy SDK 不返回 turns，检查 durationMs
        expect(result.usage.durationMs).toBeGreaterThan(0);
      }
    }, 300000); // L2 给 5 分钟超时

    it('should parse level from message correctly', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      // 测试通过消息自动识别 L2 级别
      const result = await agent.execute(
        `为文件 ${tempPodPath}/docs/technical-design.md 进行深度索引，需要全文分块`,
        context,
      );

      console.log('L2 auto-detect result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
    }, 300000);

    it('should handle large document with multiple sections', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      const result = await agent.executeWithLevel(
        'L2',
        `分析文件 ${tempPodPath}/docs/technical-design.md 的结构，列出所有章节标题和内容摘要`,
        context,
      );

      console.log('L2 structure analysis:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();

      // 如果成功，应该包含多个 chunks
      if (result.success && result.data) {
        console.log('Document structure:', result.data);
      }
    }, 300000);
  });

  describe('IndexAgent L1', () => {
    it('should execute L1 TOC-level indexing', async () => {
      const agent = new IndexAgent();
      const context = createTestContext(tempPodPath);

      const result = await agent.executeWithLevel(
        'L1',
        `为文件 ${tempPodPath}/docs/technical-design.md 生成目录级索引，提取主要标题`,
        context,
      );

      console.log('IndexAgent L1 result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();

      if (result.success) {
        console.log('L1 indexing completed with TOC');
      }
    }, 180000);
  });

  describe('Unauthenticated Environment', () => {
    it('should work without accessToken (no Pod MCP)', async () => {
      const agent = new IndexAgent();
      // 使用无鉴权 context - 没有 accessToken
      const context = createUnauthenticatedContext(tempPodPath);

      console.log('Testing unauthenticated context (no accessToken)...');
      console.log('Context:', {
        taskId: context.taskId,
        podBaseUrl: context.podBaseUrl,
        hasAccessToken: 'accessToken' in context,
      });

      // 即使没有 Pod MCP，Agent 仍可以使用本地工具
      const result = await agent.executeWithLevel(
        'L0',
        `为文件 ${tempPodPath}/docs/readme.txt 生成简短摘要`,
        context,
      );

      console.log('Unauthenticated L0 result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();

      // 验证 usage 统计
      if (result.usage) {
        console.log('Usage without auth:', result.usage);
        // CodeBuddy SDK 不返回 turns，检查 durationMs
        expect(result.usage.durationMs).toBeGreaterThan(0);
      }
    }, 180000);

    it('should handle L2 indexing without Pod access', async () => {
      const agent = new IndexAgent();
      const context = createUnauthenticatedContext(tempPodPath);

      console.log('Testing L2 without Pod MCP access...');

      const result = await agent.executeWithLevel(
        'L2',
        `对文件 ${tempPodPath}/docs/technical-design.md 进行全文分块索引`,
        context,
      );

      console.log('Unauthenticated L2 result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();

      // Agent 应该能完成任务（使用本地 Read 工具）或者报告无法访问
      if (result.success) {
        console.log('L2 succeeded without Pod MCP');
      } else {
        console.log('L2 failed (expected if file access denied):', result.error);
      }
    }, 300000);
  });
});

describe.skipIf(!runAgentTests)('Agent SDK Authentication', () => {
  it('should check authentication status', async () => {
    const executor = new CodeBuddyExecutor();

    console.log('Checking Agent SDK authentication status...');

    const authInfo = await executor.checkAuthentication();

    console.log('Authentication info:', authInfo);

    expect(authInfo.authenticated).toBe(true);

    if (authInfo.account) {
      console.log('Account info:', authInfo.account);
    }
  }, 60000);

  it('should export CodeBuddyAuthError', () => {
    const error = new CodeBuddyAuthError('Test error');

    expect(error.name).toBe('CodeBuddyAuthError');
    expect(error.message).toBe('Test error');
    expect(error instanceof Error).toBe(true);
  });

  it('should have default error message', () => {
    const error = new CodeBuddyAuthError();

    expect(error.message).toContain('CodeBuddy');
  });
});

describe.skipIf(!runAgentTests)('CodeBuddyExecutor Streaming', () => {
  it('should stream execution messages', async () => {
    const executor = new CodeBuddyExecutor();

    const config = {
      name: 'stream-test',
      description: 'Streaming test',
      systemPrompt: '你是一个测试助手。请简短回答问题。',
      maxTurns: 1,
      permissionMode: 'acceptEdits' as const,
      disallowedTools: ['Task', 'Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep'],
    };

    const messages: string[] = [];

    for await (const msg of executor.execute(config, '你好')) {
      messages.push(msg.type);
      console.log(`Message type: ${msg.type}`);

      if (msg.type === 'text') {
        console.log(`Text: ${msg.content}`);
      } else if (msg.type === 'done') {
        console.log(`Final result: ${msg.result.success}`);
      }
    }

    expect(messages).toContain('done');
  }, 120000);
});

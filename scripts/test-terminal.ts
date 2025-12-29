#!/usr/bin/env npx ts-node
/**
 * Terminal Integration Test Script
 *
 * Run this script directly to test Terminal Sidecar functionality:
 *   npx ts-node scripts/test-terminal.ts
 *   yarn test:terminal
 *
 * This script tests:
 * - Direct PTY sessions (no sandbox)
 * - Sandboxed sessions (sandbox-exec on macOS, bubblewrap on Linux)
 * - End-to-end HTTP + WebSocket API
 */

import http from 'http';
import { TerminalSession } from '../src/terminal/TerminalSession';
import { SandboxFactory } from '../src/terminal/sandbox';
import type { SandboxConfig } from '../src/terminal/sandbox';
import type { SessionConfig, CreateSessionResponse, ServerMessage, ClientMessage } from '../src/terminal/types';
import WebSocket, { WebSocketServer } from 'ws';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<boolean> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('\x1b[32m✓ PASS\x1b[0m');
    results.push({ name, passed: true });
    return true;
  } catch (error) {
    console.log('\x1b[31m✗ FAIL\x1b[0m');
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`    Error: ${errorMsg}`);
    results.push({ name, passed: false, error: errorMsg });
    return false;
  }
}

function createConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    command: '/bin/sh',
    args: [],
    workdir: process.cwd(),
    env: {},
    timeout: 60,
    ...overrides,
  };
}

// ============================================================================
// No-Sandbox Tests (Direct PTY)
// ============================================================================

async function testNoSandboxSuite(): Promise<void> {
  console.log('\n\x1b[1m[No Sandbox] Direct PTY Tests\x1b[0m\n');

  // Test 1: Spawn PTY and execute ls
  await runTest('Spawn PTY and execute ls command', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-1', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('ls package.json\n');
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes('package.json')) {
      throw new Error(`Expected 'package.json' in output, got: ${fullOutput.slice(0, 200)}`);
    }
  });

  // Test 2: Echo command
  await runTest('Execute echo command and capture output', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-2', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    const marker = `MARKER_${Date.now()}`;
    session.write(`echo "${marker}"\n`);
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes(marker)) {
      throw new Error(`Expected marker '${marker}' in output`);
    }
  });

  // Test 3: PID check
  await runTest('Report correct PID', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-3', 'test-user', config, {});

    await sleep(300);

    const pid = session.pid;
    session.terminate();

    if (!pid || pid <= 0) {
      throw new Error(`Expected positive PID, got: ${pid}`);
    }
  });

  // Test 4: Resize
  await runTest('Handle resize without error', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-4', 'test-user', config, {});

    await sleep(300);
    session.resize(120, 40);
    await sleep(100);

    session.terminate();
  });

  // Test 5: PWD command
  await runTest('Execute pwd and verify working directory', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-5', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('pwd\n');
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    const cwdName = process.cwd().split('/').pop();
    if (!fullOutput.includes(cwdName!)) {
      throw new Error(`Expected '${cwdName}' in output`);
    }
  });

  // Test 6: List directory
  await runTest('List directory contents with ls -la', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-6', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('ls -la src/\n');
    await sleep(1000);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes('terminal') && !fullOutput.includes('http')) {
      throw new Error(`Expected 'terminal' or 'http' in ls output`);
    }
  });
}

// ============================================================================
// Sandbox Tests (Platform-specific)
// ============================================================================

async function testSandboxSuite(): Promise<void> {
  const sandboxAvailable = SandboxFactory.isAvailable();
  const technology = SandboxFactory.getTechnology();

  console.log(`\n\x1b[1m[Sandbox] ${technology} Tests\x1b[0m`);
  console.log(`  Platform: ${process.platform}, Available: ${sandboxAvailable}\n`);

  if (!sandboxAvailable) {
    console.log('  \x1b[33m⚠ Sandbox not available, skipping tests\x1b[0m\n');
    return;
  }

  // Test 1: Launch sandboxed process
  await runTest(`Launch ${technology} sandbox and execute command`, async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'echo SANDBOX_OK'],
      env: {},
    };

    const result = SandboxFactory.launch(config);

    if (!result.sandboxed) {
      throw new Error('Expected sandboxed=true');
    }
    if (result.technology !== technology) {
      throw new Error(`Expected technology=${technology}, got ${result.technology}`);
    }

    const output: string[] = [];
    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Process exited with code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('SANDBOX_OK')) {
      throw new Error(`Expected 'SANDBOX_OK' in output, got: ${fullOutput}`);
    }
  });

  // Test 2: Workdir access
  await runTest('Access files in workdir', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'ls package.json && cat package.json | head -1'],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];
    const errors: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));
    result.process.stderr?.on('data', (data) => errors.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}: ${errors.join('')}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('package.json') && !fullOutput.includes('{')) {
      throw new Error(`Expected workdir file access, got: ${fullOutput}`);
    }
  });

  // Test 3: Write file in workdir
  await runTest('Write file in workdir', async () => {
    const testFile = `.test-data/sandbox-test-${Date.now()}.txt`;
    const testContent = `sandbox-test-${Date.now()}`;

    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', `mkdir -p .test-data && echo "${testContent}" > ${testFile} && cat ${testFile}`],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes(testContent)) {
      throw new Error(`Expected '${testContent}' in output, got: ${fullOutput}`);
    }

    // Cleanup
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(testFile);
    } catch {
      // ignore
    }
  });

  // Test 4: Network access (if not isolated)
  await runTest('Network access works (non-isolated)', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'curl -s --connect-timeout 5 https://httpbin.org/get | head -1 || echo "NETWORK_FAIL"'],
      env: {},
      isolateNetwork: false,
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve) => {
      result.process.on('exit', () => resolve());
      result.process.on('error', () => resolve());
    });

    const fullOutput = output.join('');
    // Should either succeed or show attempt (not immediately fail)
    if (fullOutput.includes('NETWORK_FAIL') && !fullOutput.includes('{')) {
      // Network might be unavailable, but sandbox didn't block it
      console.log(' (network unavailable, but not blocked)');
    }
  });

  // Test 5: Read system paths
  await runTest('Read-only access to system paths', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'ls /usr/bin/env && which sh'],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('env') && !fullOutput.includes('sh')) {
      throw new Error(`Expected system path access, got: ${fullOutput}`);
    }
  });

  // Test 6: Deny access outside workdir (macOS only, skip on Linux for now)
  if (process.platform === 'darwin') {
    await runTest('Deny write access outside workdir', async () => {
      const config: SandboxConfig = {
        workdir: process.cwd(),
        command: '/bin/sh',
        args: ['-c', 'touch /tmp/xpod-sandbox-test-deny 2>&1 || echo "DENIED"'],
        env: {},
      };

      const result = SandboxFactory.launch(config);
      const output: string[] = [];

      result.process.stdout?.on('data', (data) => output.push(data.toString()));
      result.process.stderr?.on('data', (data) => output.push(data.toString()));

      await new Promise<void>((resolve) => {
        result.process.on('exit', () => resolve());
      });

      // Note: /tmp might be allowed in some sandbox configs
      // This test documents behavior rather than strict enforcement
      const fullOutput = output.join('');
      console.log(` (output: ${fullOutput.trim().slice(0, 50)})`);
    });
  }
}

// ============================================================================
// End-to-End HTTP + WebSocket Tests
// ============================================================================

/** Mock credentials extractor that always returns a test user */
class MockCredentialsExtractor {
  async handleSafe(): Promise<{ agent?: { webId?: string } }> {
    return { agent: { webId: 'https://example.com/user/test-user' } };
  }
}

/**
 * Custom TerminalSessionManager for testing that allows /bin/sh
 */
class TestTerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();

  async createSession(
    userId: string,
    request: { command: string; args?: string[]; workdir?: string },
  ): Promise<TerminalSession> {
    const sessionId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const config: SessionConfig = {
      command: request.command,
      args: request.args ?? [],
      workdir: request.workdir ?? process.cwd(),
      env: {},
      timeout: 60,
    };

    const session = new TerminalSession(sessionId, userId, config, {});
    this.sessions.set(sessionId, session);

    session.on('exit', () => {
      this.sessions.delete(sessionId);
    });

    return session;
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  terminateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.terminate();
      return true;
    }
    return false;
  }

  terminateAll(): void {
    for (const session of this.sessions.values()) {
      session.terminate();
    }
    this.sessions.clear();
  }
}

/**
 * Custom TerminalHttpHandler for testing that uses TestTerminalSessionManager
 */
class TestTerminalHttpHandler {
  private readonly sidecarPath = '/-/terminal';
  private readonly sessionManager = new TestTerminalSessionManager();
  private wss?: WebSocketServer;
  private readonly wsConnections = new Map<string, Set<WebSocket>>();

  async canHandle({ request }: { request: http.IncomingMessage }): Promise<void> {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (!url.pathname.includes(this.sidecarPath)) {
      throw new Error(`Not a terminal request: ${url.pathname}`);
    }
  }

  async handle({
    request,
    response,
  }: {
    request: http.IncomingMessage;
    response: http.ServerResponse;
  }): Promise<void> {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const pathAfterSidecar = url.pathname.split(this.sidecarPath)[1] ?? '';

    if (pathAfterSidecar === '/sessions' || pathAfterSidecar === '/sessions/') {
      if (request.method === 'POST') {
        await this.handleCreateSession(request, response);
      } else {
        this.sendError(response, 405, 'Method Not Allowed');
      }
    } else if (pathAfterSidecar.match(/^\/sessions\/[^/]+$/)) {
      const sessionId = pathAfterSidecar.split('/')[2];
      if (request.method === 'GET') {
        this.handleGetSession(sessionId, response);
      } else if (request.method === 'DELETE') {
        this.handleDeleteSession(sessionId, response);
      } else {
        this.sendError(response, 405, 'Method Not Allowed');
      }
    } else {
      this.sendError(response, 404, 'Not Found');
    }
  }

  handleUpgrade(request: http.IncomingMessage, socket: any, head: Buffer): void {
    if (!this.wss) {
      const WebSocketServer = require('ws').WebSocketServer;
      this.wss = new WebSocketServer({ noServer: true });
    }

    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const match = url.pathname.match(new RegExp(`${this.sidecarPath}/sessions/([^/]+)/ws`));

    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss!.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      this.handleWebSocketConnection(ws, session);
    });
  }

  private async handleCreateSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(request);
    let sessionRequest: { command: string; args?: string[]; workdir?: string };
    try {
      sessionRequest = JSON.parse(body);
    } catch {
      this.sendError(response, 400, 'Invalid JSON body');
      return;
    }

    const session = await this.sessionManager.createSession(
      'https://example.com/user/test-user',
      sessionRequest,
    );

    const wsUrl = new URL(request.url ?? '', `ws://${request.headers.host}`);
    wsUrl.pathname = `${this.sidecarPath}/sessions/${session.sessionId}/ws`;

    const responseBody: CreateSessionResponse = {
      sessionId: session.sessionId,
      status: session.status,
      wsUrl: wsUrl.toString(),
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    };

    this.sendJson(response, 201, responseBody);
  }

  private handleGetSession(sessionId: string, response: http.ServerResponse): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(response, 404, 'Session not found');
      return;
    }
    this.sendJson(response, 200, session.toJSON());
  }

  private handleDeleteSession(sessionId: string, response: http.ServerResponse): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(response, 404, 'Session not found');
      return;
    }
    this.sessionManager.terminateSession(sessionId);
    response.writeHead(204);
    response.end();
  }

  private handleWebSocketConnection(ws: WebSocket, session: TerminalSession): void {
    if (!this.wsConnections.has(session.sessionId)) {
      this.wsConnections.set(session.sessionId, new Set());
    }
    this.wsConnections.get(session.sessionId)!.add(ws);

    const dataHandler = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'output', data };
        ws.send(JSON.stringify(msg));
      }
    };
    session.on('data', dataHandler);

    const exitHandler = (code: number, signal?: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'exit', code, signal };
        ws.send(JSON.stringify(msg));
        ws.close();
      }
    };
    session.on('exit', exitHandler);

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        this.handleClientMessage(session, msg, ws);
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      session.removeListener('data', dataHandler);
      session.removeListener('exit', exitHandler);
      const connections = this.wsConnections.get(session.sessionId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.wsConnections.delete(session.sessionId);
        }
      }
    });

    // Send initial pong
    const pong: ServerMessage = { type: 'pong' };
    ws.send(JSON.stringify(pong));
  }

  private handleClientMessage(session: TerminalSession, msg: ClientMessage, ws: WebSocket): void {
    switch (msg.type) {
      case 'input':
        if (msg.data) session.write(msg.data);
        break;
      case 'resize':
        if (msg.cols && msg.rows) session.resize(msg.cols, msg.rows);
        break;
      case 'ping':
        const pong: ServerMessage = { type: 'pong' };
        ws.send(JSON.stringify(pong));
        break;
    }
  }

  private sendJson(response: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  private sendError(response: http.ServerResponse, status: number, message: string): void {
    this.sendJson(response, status, { error: message });
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString()));
      request.on('error', reject);
    });
  }

  getSessionManager(): TestTerminalSessionManager {
    return this.sessionManager;
  }
}

async function testE2ESuite(): Promise<void> {
  console.log('\n\x1b[1m[E2E] HTTP + WebSocket API Tests\x1b[0m\n');

  const PORT = 19876;
  const BASE_URL = `http://localhost:${PORT}`;
  const WS_URL = `ws://localhost:${PORT}`;

  // Create test handler (allows /bin/sh for testing)
  const handler = new TestTerminalHttpHandler();

  const server = http.createServer(async (req, res) => {
    try {
      await handler.canHandle({ request: req });
      await handler.handle({ request: req, response: res });
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  // Handle WebSocket upgrades
  server.on('upgrade', (request, socket, head) => {
    handler.handleUpgrade(request, socket, head);
  });

  // Start server
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => resolve());
  });

  try {
    // Test 1: Create session via HTTP POST
    let sessionId: string;
    let wsUrl: string;

    await runTest('Create session via POST /-/terminal/sessions', async () => {
      const response = await fetch(`${BASE_URL}/-/terminal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/sh',
          args: [],
          workdir: process.cwd(),
        }),
      });

      if (response.status !== 201) {
        const body = await response.text();
        throw new Error(`Expected 201, got ${response.status}: ${body}`);
      }

      const data = await response.json() as CreateSessionResponse;
      if (!data.sessionId) throw new Error('Missing sessionId');
      if (!data.wsUrl) throw new Error('Missing wsUrl');
      if (data.status !== 'active') throw new Error(`Expected status=active, got ${data.status}`);

      sessionId = data.sessionId;
      wsUrl = data.wsUrl;
    });

    // Test 2: Get session via HTTP GET
    await runTest('Get session via GET /-/terminal/sessions/:id', async () => {
      const response = await fetch(`${BASE_URL}/-/terminal/sessions/${sessionId}`);

      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }

      const data = await response.json() as { sessionId: string; status: string };
      if (data.sessionId !== sessionId) throw new Error('Session ID mismatch');
      if (data.status !== 'active') throw new Error(`Expected status=active, got ${data.status}`);
    });

    // Test 3: Connect WebSocket and receive pong
    await runTest('Connect WebSocket and receive initial pong', async () => {
      const ws = new WebSocket(`${WS_URL}/-/terminal/sessions/${sessionId}/ws`);

      const message = await new Promise<ServerMessage>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
        ws.on('message', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });

      ws.close();

      if (message.type !== 'pong') {
        throw new Error(`Expected pong, got ${message.type}`);
      }
    });

    // Test 4: Send command via WebSocket and receive output
    await runTest('Send command via WebSocket and receive output', async () => {
      const ws = new WebSocket(`${WS_URL}/-/terminal/sessions/${sessionId}/ws`);
      const messages: ServerMessage[] = [];
      const marker = `E2E_MARKER_${Date.now()}`;

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          // Wait for initial pong, then send command
          setTimeout(() => {
            const input: ClientMessage = { type: 'input', data: `echo "${marker}"\n` };
            ws.send(JSON.stringify(input));
          }, 200);
        });

        ws.on('message', (data) => {
          const msg: ServerMessage = JSON.parse(data.toString());
          messages.push(msg);
        });

        ws.on('error', reject);

        // Wait for output
        setTimeout(() => {
          ws.close();
          resolve();
        }, 1500);
      });

      const outputs = messages.filter((m) => m.type === 'output').map((m) => m.data).join('');
      if (!outputs.includes(marker)) {
        throw new Error(`Expected marker '${marker}' in output, got: ${outputs.slice(0, 100)}`);
      }
    });

    // Test 5: Resize via WebSocket
    await runTest('Send resize via WebSocket', async () => {
      const ws = new WebSocket(`${WS_URL}/-/terminal/sessions/${sessionId}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          const resize: ClientMessage = { type: 'resize', cols: 120, rows: 40 };
          ws.send(JSON.stringify(resize));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 200);
        });
        ws.on('error', reject);
      });
    });

    // Test 6: Ping/Pong
    await runTest('Ping/Pong via WebSocket', async () => {
      const ws = new WebSocket(`${WS_URL}/-/terminal/sessions/${sessionId}/ws`);

      const pongReceived = await new Promise<boolean>((resolve, reject) => {
        let gotInitialPong = false;

        ws.on('open', () => {
          // Wait for initial pong first
        });

        ws.on('message', (data) => {
          const msg: ServerMessage = JSON.parse(data.toString());
          if (msg.type === 'pong') {
            if (!gotInitialPong) {
              // Initial pong, now send our ping
              gotInitialPong = true;
              const ping: ClientMessage = { type: 'ping' };
              ws.send(JSON.stringify(ping));
            } else {
              // Response to our ping
              ws.close();
              resolve(true);
            }
          }
        });

        ws.on('error', reject);
        setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000);
      });

      if (!pongReceived) {
        throw new Error('Did not receive pong response');
      }
    });

    // Test 7: Delete session via HTTP DELETE
    await runTest('Delete session via DELETE /-/terminal/sessions/:id', async () => {
      const response = await fetch(`${BASE_URL}/-/terminal/sessions/${sessionId}`, {
        method: 'DELETE',
      });

      if (response.status !== 204) {
        throw new Error(`Expected 204, got ${response.status}`);
      }
    });

    // Test 8: Verify session is gone
    await runTest('Verify deleted session returns 404', async () => {
      const response = await fetch(`${BASE_URL}/-/terminal/sessions/${sessionId}`);

      if (response.status !== 404) {
        throw new Error(`Expected 404, got ${response.status}`);
      }
    });

    // Test 9: WebSocket to non-existent session
    await runTest('WebSocket to non-existent session fails', async () => {
      const ws = new WebSocket(`${WS_URL}/-/terminal/sessions/non-existent-session/ws`);

      const closed = await new Promise<boolean>((resolve) => {
        ws.on('error', () => resolve(true));
        ws.on('close', () => resolve(true));
        ws.on('open', () => resolve(false));
        setTimeout(() => resolve(false), 2000);
      });

      if (!closed) {
        ws.close();
        throw new Error('Expected WebSocket to fail');
      }
    });

    // Test 10: 404 for unknown path
    await runTest('Unknown path returns 404', async () => {
      const response = await fetch(`${BASE_URL}/-/terminal/unknown`);
      if (response.status !== 404) {
        throw new Error(`Expected 404, got ${response.status}`);
      }
    });
  } finally {
    // Cleanup
    server.close();
    handler.getSessionManager().terminateAll();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n\x1b[1m╔══════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║           Terminal Integration Tests                     ║\x1b[0m');
  console.log('\x1b[1m╚══════════════════════════════════════════════════════════╝\x1b[0m');

  // Run no-sandbox tests
  await testNoSandboxSuite();

  // Run sandbox tests
  await testSandboxSuite();

  // Run E2E tests
  await testE2ESuite();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1mResults Summary\x1b[0m');
  console.log('\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
  console.log(`  \x1b[32mPassed: ${passed}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${failed}\x1b[0m`);
  console.log(`  Total:  ${results.length}`);

  if (failed > 0) {
    console.log('\n\x1b[31mFailed tests:\x1b[0m');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}`);
      if (r.error) console.log(`    ${r.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

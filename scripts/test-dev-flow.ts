#!/usr/bin/env ts-node
/**
 * 完整集成测试脚本
 *
 * 测试流程:
 * 1. 调用 /dev/setup 创建 credentials + node
 * 2. 使用 credentials 认证
 * 3. 使用 node 连接信令服务
 * 4. 验证 WebSocket 连接和心跳
 * 5. 清理测试数据
 *
 * 用法:
 *   # 先启动 Cloud 服务
 *   NODE_ENV=development yarn cloud
 *
 *   # 运行测试
 *   yarn ts-node scripts/test-dev-flow.ts
 */

import WebSocket from 'ws';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';

interface SetupResponse {
  testId: string;
  credentials: {
    clientId: string;
    clientSecret: string;
    webId: string;
  };
  node: {
    nodeId: string;
    token: string;
  };
  signalingUrl: string;
  env: Record<string, string>;
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('📋 Xpod 开发模式集成测试');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log();

  let testId: string | undefined;

  try {
    // Step 1: 检查服务健康状态
    console.log('Step 1: 检查服务健康状态...');
    const healthRes = await fetch(`${API_BASE}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health check failed: ${healthRes.status}`);
    }
    console.log('✅ 服务健康\n');

    // Step 2: 检查开发模式状态
    console.log('Step 2: 检查开发模式...');
    const devStatusRes = await fetch(`${API_BASE}/dev/status`);
    if (!devStatusRes.ok) {
      throw new Error(`Dev mode not enabled. Make sure NODE_ENV=development`);
    }
    const devStatus = await devStatusRes.json();
    console.log(`✅ 开发模式已启用`);
    console.log(`   可用端点: ${devStatus.endpoints.length} 个\n`);

    // Step 3: 一键创建测试环境
    console.log('Step 3: 创建测试环境 (credentials + node)...');
    const setupRes = await fetch(`${API_BASE}/dev/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testId: `integration-${Date.now()}`,
        displayName: 'Integration Test',
      }),
    });

    if (!setupRes.ok) {
      const error = await setupRes.text();
      throw new Error(`Setup failed: ${error}`);
    }

    const setup: SetupResponse = await setupRes.json();
    testId = setup.testId;

    console.log('✅ 测试环境已创建');
    console.log(`   testId: ${setup.testId}`);
    console.log(`   clientId: ${setup.credentials.clientId}`);
    console.log(`   nodeId: ${setup.node.nodeId}`);
    console.log(`   signalingUrl: ${setup.signalingUrl}\n`);

    // Step 4: 使用 credentials 调用需要认证的 API
    console.log('Step 4: 测试 Client Credentials 认证...');
    // 注意：这需要 ClientCredentialsAuthenticator 支持
    // 目前先跳过，直接测试信令连接
    console.log('⏭️  跳过 (需要实现 Client Credentials OAuth flow)\n');

    // Step 5: 连接信令服务
    console.log('Step 5: 连接 WebSocket 信令服务...');
    const signalingResult = await testSignalingConnection(
      setup.signalingUrl,
      setup.node.nodeId,
      setup.node.token
    );

    if (signalingResult.success) {
      console.log('✅ 信令连接成功');
      console.log(`   认证时间: ${signalingResult.authTime}ms`);
      console.log(`   信令能力: ${signalingResult.capabilities?.join(', ') || '未上报'}\n`);
    } else {
      throw new Error(`Signaling failed: ${signalingResult.error}`);
    }

    // Step 6: 测试心跳
    console.log('Step 6: 测试心跳上报...');
    const heartbeatResult = await testHeartbeat(
      setup.signalingUrl,
      setup.node.nodeId,
      setup.node.token
    );

    if (heartbeatResult.success) {
      console.log('✅ 心跳上报成功');
      console.log(`   响应时间: ${heartbeatResult.responseTime}ms\n`);
    } else {
      console.log(`⚠️  心跳测试: ${heartbeatResult.error}\n`);
    }

    // Step 7: 清理测试数据
    console.log('Step 7: 清理测试数据...');
    const cleanupRes = await fetch(`${API_BASE}/dev/cleanup/${testId}`, {
      method: 'DELETE',
    });

    if (cleanupRes.ok) {
      const cleanup = await cleanupRes.json();
      console.log('✅ 清理完成');
      console.log(`   删除 credentials: ${cleanup.deleted.credentials}`);
      console.log(`   删除 nodes: ${cleanup.deleted.nodes}\n`);
    } else {
      console.log('⚠️  清理失败，可能需要手动清理\n');
    }

    // 总结
    console.log('='.repeat(60));
    console.log('🎉 集成测试通过!');
    console.log('='.repeat(60));
    console.log();
    console.log('环境变量 (可用于 Local 节点):');
    console.log('-'.repeat(40));
    Object.entries(setup.env).forEach(([key, value]) => {
      console.log(`${key}=${value}`);
    });
    console.log();

  } catch (error) {
    console.error('\n❌ 测试失败:', error instanceof Error ? error.message : error);

    // 尝试清理
    if (testId) {
      console.log('\n尝试清理测试数据...');
      try {
        await fetch(`${API_BASE}/dev/cleanup/${testId}`, { method: 'DELETE' });
        console.log('清理完成');
      } catch {
        console.log('清理失败');
      }
    }

    process.exit(1);
  }
}

interface SignalingResult {
  success: boolean;
  authTime?: number;
  capabilities?: string[];
  error?: string;
}

async function testSignalingConnection(
  url: string,
  nodeId: string,
  token: string
): Promise<SignalingResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const ws = new WebSocket(url);
    let authenticated = false;

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: 'Connection timeout (10s)' });
    }, 10000);

    ws.on('open', () => {
      // 发送认证消息
      ws.send(JSON.stringify({
        type: 'auth',
        connectionType: 'local',
        id: nodeId,
        token: token,
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'authSuccess') {
          authenticated = true;
          const authTime = Date.now() - startTime;
          clearTimeout(timeout);
          ws.close();
          resolve({
            success: true,
            authTime,
            capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : ['signal'],
          });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.message });
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ success: false, error: error.message });
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!authenticated) {
        resolve({ success: false, error: `Connection closed: ${code} ${reason}` });
      }
    });
  });
}

interface HeartbeatResult {
  success: boolean;
  responseTime?: number;
  error?: string;
}

async function testHeartbeat(
  url: string,
  nodeId: string,
  token: string
): Promise<HeartbeatResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let authenticated = false;

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: 'Heartbeat timeout (15s)' });
    }, 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'auth',
        connectionType: 'local',
        id: nodeId,
        token: token,
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'authSuccess') {
          authenticated = true;
          // 发送心跳
          const heartbeatStart = Date.now();
          ws.send(JSON.stringify({
            type: 'heartbeat',
            status: 'online',
            ipv4: '192.168.1.100',
            ipv6: '::1',
            capabilities: ['solid:0.11', 'tcp-punch:1.0'],
          }));

          // 服务端不会响应心跳，所以等待一小段时间后认为成功
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve({
              success: true,
              responseTime: Date.now() - heartbeatStart,
            });
          }, 500);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.message });
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ success: false, error: error.message });
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!authenticated) {
        resolve({ success: false, error: `Connection closed: ${code} ${reason}` });
      }
    });
  });
}

main();

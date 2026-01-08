# Xpod 多端进程管理架构

> **设计参考**: VSCode 架构 - 主进程 + 多子进程模式

## 1. 概述

Xpod 在不同部署模式下需要管理多个进程，本文档定义统一的进程管理架构，确保各端一致性。

### 1.1 核心进程

| 进程 | 说明 | 端口 | 必需 |
|------|------|------|------|
| CSS | Community Solid Server，核心数据服务 | 3000 | 是 |
| API | 独立 API 服务（Chat/Signal/Node/Quota） | 3001 | 是 |
| frpc | FRP 客户端，用于穿透内网（Edge 模式） | - | 否 |

### 1.2 部署模式与进程关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           部署模式与进程关系                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CLI / 开发模式 (npm run local)                                             │
│  ├─ CSS :3000     ← 单进程，API 内嵌于 CSS（当前）                          │
│  └─ (未来) CSS :3000 + API :3001 分离                                       │
│                                                                             │
│  Gateway 模式 (生产/容器)                                                   │
│  ├─ Gateway :8080  ← 统一入口，路由分发                                     │
│  ├─ CSS :3000      ← 内部进程                                              │
│  └─ API :3001      ← 内部进程                                              │
│                                                                             │
│  桌面端 (Electron)                                                          │
│  ├─ Electron Main  ← 进程管理器                                             │
│  ├─ CSS :3000      ← 子进程                                                │
│  ├─ API :3001      ← 子进程                                                │
│  └─ frpc           ← 子进程（可选）                                         │
│                                                                             │
│  服务器模式 (systemd/pm2)                                                   │
│  ├─ CSS :3000      ← 独立服务                                              │
│  ├─ API :3001      ← 独立服务                                              │
│  └─ frpc           ← 独立服务（可选）                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 统一进程管理接口

### 2.1 核心抽象

```typescript
// packages/process-manager/types.ts

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface ProcessConfig {
  id: string;                          // 进程标识 (css, api, frpc)
  name: string;                        // 显示名称
  command: string;                     // 启动命令
  args: string[];                      // 命令参数
  cwd?: string;                        // 工作目录
  env?: Record<string, string>;        // 环境变量
  healthCheck?: {                      // 健康检查
    url: string;                       // 检查 URL
    interval: number;                  // 检查间隔 (ms)
    timeout: number;                   // 超时时间 (ms)
    retries: number;                   // 重试次数
  };
  autoRestart?: boolean;               // 崩溃后自动重启
  restartDelay?: number;               // 重启延迟 (ms)
  maxRestarts?: number;                // 最大重启次数
  dependencies?: string[];             // 依赖的进程（启动顺序）
}

export interface ProcessState {
  id: string;
  status: ProcessStatus;
  pid?: number;
  startTime?: number;
  uptime?: number;
  exitCode?: number;
  restartCount: number;
  lastError?: string;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
}

export interface ProcessManager {
  // 进程注册
  register(config: ProcessConfig): void;
  unregister(id: string): void;

  // 生命周期
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;

  // 状态查询
  getState(id: string): ProcessState | undefined;
  getAllStates(): ProcessState[];

  // 事件
  on(event: 'state-change', handler: (id: string, state: ProcessState) => void): void;
  on(event: 'log', handler: (id: string, type: 'stdout' | 'stderr', data: string) => void): void;
  on(event: 'error', handler: (id: string, error: Error) => void): void;
}
```

### 2.2 各端实现

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           进程管理器实现                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    ProcessManager (抽象接口)                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ▲                                              │
│           ┌──────────────────┼──────────────────┐                          │
│           │                  │                  │                          │
│  ┌────────┴────────┐ ┌──────┴───────┐ ┌────────┴────────┐                 │
│  │ NodeProcessMgr  │ │ ElectronPM   │ │ SystemdAdapter  │                 │
│  │ ─────────────── │ │ ──────────── │ │ ─────────────── │                 │
│  │ child_process   │ │ IPC + spawn  │ │ dbus / systemctl│                 │
│  │ CLI/Gateway     │ │ 桌面端        │ │ 服务器模式       │                 │
│  └─────────────────┘ └──────────────┘ └─────────────────┘                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 现有实现分析

### 3.1 Gateway Supervisor (src/gateway/Supervisor.ts)

当前实现已具备基础能力：

```typescript
// 已有功能
✓ register(config)      // 注册进程
✓ start(name)           // 启动进程
✓ stop(name)            // 停止进程
✓ startAll() / stopAll() // 批量操作
✓ getStatus(name)       // 状态查询
✓ 自动重启 (简单版)

// 待增强
○ 健康检查 (readyUrl 定义但未实现)
○ 启动依赖顺序
○ 日志收集 (当前 stdio: 'inherit')
○ 事件通知
○ 最大重启次数限制
```

### 3.2 需要统一的能力

| 能力 | Gateway | 桌面端 | 说明 |
|------|---------|--------|------|
| 进程启停 | ✓ | 需实现 | 基础 |
| 健康检查 | ○ | 需实现 | HTTP 轮询 |
| 自动重启 | ✓ | 需实现 | 带退避 |
| 日志收集 | ○ | 需实现 | 分离 stdout/stderr |
| 状态通知 | ○ | 需实现 | 事件/IPC |
| 依赖顺序 | ✗ | 需实现 | CSS 先于 API |

---

## 4. 重构方案

### 4.1 抽取公共模块

```
packages/
└── process-manager/           # @xpod/process-manager
    ├── src/
    │   ├── types.ts           # 类型定义
    │   ├── ProcessManager.ts  # 抽象基类
    │   ├── NodeProcessManager.ts  # Node.js 实现
    │   ├── HealthChecker.ts   # 健康检查
    │   └── index.ts
    └── package.json
```

### 4.2 Node.js 实现 (CLI/Gateway 共用)

```typescript
// packages/process-manager/src/NodeProcessManager.ts

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import kill from 'tree-kill';
import type { ProcessConfig, ProcessState, ProcessManager, ProcessStatus } from './types';

export class NodeProcessManager extends EventEmitter implements ProcessManager {
  private processes = new Map<string, ChildProcess>();
  private states = new Map<string, ProcessState>();
  private configs = new Map<string, ProcessConfig>();
  private healthTimers = new Map<string, NodeJS.Timeout>();

  register(config: ProcessConfig): void {
    this.configs.set(config.id, config);
    this.states.set(config.id, {
      id: config.id,
      status: 'stopped',
      restartCount: 0,
    });
  }

  unregister(id: string): void {
    this.stop(id);
    this.configs.delete(id);
    this.states.delete(id);
  }

  async start(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) throw new Error(`Process ${id} not registered`);

    const state = this.states.get(id)!;
    if (state.status === 'running' || state.status === 'starting') return;

    // 检查依赖
    if (config.dependencies) {
      for (const depId of config.dependencies) {
        const depState = this.states.get(depId);
        if (!depState || depState.status !== 'running') {
          throw new Error(`Dependency ${depId} is not running`);
        }
      }
    }

    this.updateState(id, { status: 'starting' });

    const child = spawn(config.command, config.args, {
      cwd: config.cwd || process.cwd(),
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(id, child);

    // 日志收集
    child.stdout?.on('data', (data) => {
      this.emit('log', id, 'stdout', data.toString());
    });
    child.stderr?.on('data', (data) => {
      this.emit('log', id, 'stderr', data.toString());
    });

    child.on('error', (err) => {
      this.emit('error', id, err);
      this.updateState(id, { status: 'crashed', lastError: err.message });
    });

    child.on('exit', (code, signal) => {
      this.handleExit(id, code, signal);
    });

    // 健康检查
    if (config.healthCheck) {
      await this.waitForHealthy(id, config.healthCheck);
    }

    this.updateState(id, {
      status: 'running',
      pid: child.pid,
      startTime: Date.now(),
      healthStatus: 'healthy',
    });
  }

  async stop(id: string): Promise<void> {
    const child = this.processes.get(id);
    if (!child?.pid) return;

    this.updateState(id, { status: 'stopping' });
    this.clearHealthTimer(id);

    return new Promise((resolve) => {
      kill(child.pid!, 'SIGTERM', (err) => {
        if (err) this.emit('error', id, err);
        this.processes.delete(id);
        this.updateState(id, { status: 'stopped', pid: undefined });
        resolve();
      });
    });
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  async startAll(): Promise<void> {
    // 按依赖顺序启动
    const sorted = this.topologicalSort();
    for (const id of sorted) {
      await this.start(id);
    }
  }

  async stopAll(): Promise<void> {
    // 逆序停止
    const sorted = this.topologicalSort().reverse();
    for (const id of sorted) {
      await this.stop(id);
    }
  }

  getState(id: string): ProcessState | undefined {
    const state = this.states.get(id);
    if (state?.status === 'running' && state.startTime) {
      return { ...state, uptime: Date.now() - state.startTime };
    }
    return state;
  }

  getAllStates(): ProcessState[] {
    return Array.from(this.states.keys()).map(id => this.getState(id)!);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private updateState(id: string, update: Partial<ProcessState>): void {
    const current = this.states.get(id);
    if (!current) return;
    const newState = { ...current, ...update };
    this.states.set(id, newState);
    this.emit('state-change', id, newState);
  }

  private handleExit(id: string, code: number | null, signal: string | null): void {
    const config = this.configs.get(id);
    const state = this.states.get(id);
    if (!config || !state) return;

    this.processes.delete(id);
    this.clearHealthTimer(id);

    const wasRunning = state.status === 'running';
    const maxRestarts = config.maxRestarts ?? 5;

    this.updateState(id, {
      status: code === 0 ? 'stopped' : 'crashed',
      exitCode: code ?? undefined,
      pid: undefined,
    });

    // 自动重启
    if (config.autoRestart && wasRunning && code !== 0) {
      if (state.restartCount < maxRestarts) {
        const delay = config.restartDelay ?? 1000;
        setTimeout(() => {
          this.updateState(id, { restartCount: state.restartCount + 1 });
          this.start(id).catch(err => this.emit('error', id, err));
        }, delay);
      } else {
        this.emit('error', id, new Error(`Max restarts (${maxRestarts}) exceeded`));
      }
    }
  }

  private async waitForHealthy(
    id: string,
    check: NonNullable<ProcessConfig['healthCheck']>
  ): Promise<void> {
    const maxAttempts = check.retries || 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), check.timeout || 5000);
        const res = await fetch(check.url, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          this.startHealthTimer(id, check);
          return;
        }
      } catch {
        // 继续重试
      }
      await new Promise(r => setTimeout(r, check.interval || 1000));
    }
    throw new Error(`Health check failed for ${id} after ${maxAttempts} attempts`);
  }

  private startHealthTimer(id: string, check: NonNullable<ProcessConfig['healthCheck']>): void {
    this.healthTimers.set(id, setInterval(async () => {
      try {
        const res = await fetch(check.url);
        this.updateState(id, { healthStatus: res.ok ? 'healthy' : 'unhealthy' });
      } catch {
        this.updateState(id, { healthStatus: 'unhealthy' });
      }
    }, check.interval));
  }

  private clearHealthTimer(id: string): void {
    const timer = this.healthTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(id);
    }
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const config = this.configs.get(id);
      for (const dep of config?.dependencies ?? []) {
        visit(dep);
      }
      result.push(id);
    };

    for (const id of this.configs.keys()) {
      visit(id);
    }

    return result;
  }
}
```

### 4.3 默认进程配置

```typescript
// packages/process-manager/src/defaults.ts

import type { ProcessConfig } from './types';

export function createDefaultConfigs(options: {
  dataDir: string;
  cssPort?: number;
  apiPort?: number;
  cssConfig?: string;
  databaseUrl?: string;
}): ProcessConfig[] {
  const { dataDir, cssPort = 3000, apiPort = 3001, cssConfig, databaseUrl } = options;

  return [
    {
      id: 'css',
      name: 'Community Solid Server',
      command: 'node',
      args: [
        'node_modules/.bin/community-solid-server',
        ...(cssConfig ? ['-c', cssConfig] : []),
        '-f', `${dataDir}/data`,
        '-p', cssPort.toString(),
      ],
      env: {
        CSS_BASE_URL: `http://localhost:${cssPort}/`,
        ...(databaseUrl ? { CSS_IDENTITY_DB_URL: databaseUrl } : {}),
      },
      healthCheck: {
        url: `http://localhost:${cssPort}/.well-known/solid`,
        interval: 2000,
        timeout: 5000,
        retries: 30,
      },
      autoRestart: true,
      restartDelay: 2000,
      maxRestarts: 5,
    },
    {
      id: 'api',
      name: 'API Server',
      command: 'node',
      args: ['dist/api/main.js'],
      env: {
        API_PORT: apiPort.toString(),
        CSS_TOKEN_ENDPOINT: `http://localhost:${cssPort}/.oidc/token`,
        ...(databaseUrl ? { CSS_IDENTITY_DB_URL: databaseUrl } : {}),
      },
      healthCheck: {
        url: `http://localhost:${apiPort}/health`,
        interval: 2000,
        timeout: 5000,
        retries: 30,
      },
      autoRestart: true,
      restartDelay: 2000,
      maxRestarts: 5,
      dependencies: ['css'], // API 依赖 CSS
    },
  ];
}

export function createFrpcConfig(options: {
  configPath: string;
}): ProcessConfig {
  return {
    id: 'frpc',
    name: 'FRP Client',
    command: 'frpc',
    args: ['-c', options.configPath],
    autoRestart: true,
    restartDelay: 5000,
    maxRestarts: 10,
  };
}
```

---

## 5. 各端集成

### 5.1 Gateway 模式

```typescript
// src/gateway/main.ts (重构后)

import { NodeProcessManager, createDefaultConfigs } from '@xpod/process-manager';
import { GatewayProxy } from './Proxy';
import { loadConfig } from './ConfigLoader';

async function main() {
  const config = await loadConfig();
  const pm = new NodeProcessManager();

  // 注册默认进程
  const configs = createDefaultConfigs({
    dataDir: process.cwd(),
    cssPort: config.css.port,
    apiPort: config.api.port,
    cssConfig: config.css.config,
  });

  configs.forEach(c => pm.register(c));

  // 日志输出
  pm.on('log', (id, type, data) => {
    process.stdout.write(`[${id}] ${data}`);
  });

  pm.on('state-change', (id, state) => {
    console.log(`[Gateway] ${id}: ${state.status}`);
  });

  // 启动
  await pm.startAll();

  // Gateway Proxy
  const proxy = new GatewayProxy(config.port, pm);
  proxy.start();

  // Shutdown
  process.on('SIGINT', async () => {
    await pm.stopAll();
    process.exit(0);
  });
}
```

### 5.2 桌面端 (Electron)

```typescript
// apps/desktop/electron/services/ProcessManager.ts

import { NodeProcessManager, createDefaultConfigs, createFrpcConfig } from '@xpod/process-manager';
import { app, BrowserWindow } from 'electron';
import path from 'path';

export class DesktopProcessManager {
  private pm = new NodeProcessManager();

  constructor() {
    const dataDir = app.getPath('userData');

    // 注册核心进程
    const configs = createDefaultConfigs({
      dataDir,
      cssConfig: path.join(dataDir, 'config/main.local.json'),
      databaseUrl: `sqlite:${path.join(dataDir, 'data/identity.sqlite')}`,
    });
    configs.forEach(c => this.pm.register(c));

    // 日志转发到渲染进程
    this.pm.on('log', (id, type, data) => {
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('process:log', { id, type, data });
      });
    });

    // 状态变化通知
    this.pm.on('state-change', (id, state) => {
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('process:state-change', { id, state });
      });
    });
  }

  // 添加 frpc（用户配置后）
  enableFrpc(configPath: string): void {
    this.pm.register(createFrpcConfig({ configPath }));
  }

  // 代理到 NodeProcessManager
  start = (id: string) => this.pm.start(id);
  stop = (id: string) => this.pm.stop(id);
  restart = (id: string) => this.pm.restart(id);
  startAll = () => this.pm.startAll();
  stopAll = () => this.pm.stopAll();
  getState = (id: string) => this.pm.getState(id);
  getAllStates = () => this.pm.getAllStates();
}

export const processManager = new DesktopProcessManager();
```

### 5.3 CLI 模式 (开发)

```typescript
// scripts/dev-server.ts

import { NodeProcessManager, createDefaultConfigs } from '@xpod/process-manager';

async function main() {
  const pm = new NodeProcessManager();

  const configs = createDefaultConfigs({
    dataDir: process.cwd(),
    cssConfig: 'config/main.local.json',
  });

  configs.forEach(c => pm.register(c));

  pm.on('log', (id, _type, data) => {
    process.stdout.write(`[${id}] ${data}`);
  });

  await pm.startAll();

  console.log('Development server started');
  console.log('  CSS: http://localhost:3000');
  console.log('  API: http://localhost:3001');

  process.on('SIGINT', async () => {
    await pm.stopAll();
    process.exit(0);
  });
}

main();
```

---

## 6. 迁移路径

### Phase 1: 抽取公共模块
1. 创建 `packages/process-manager`
2. 将 `Supervisor` 逻辑迁移到 `NodeProcessManager`
3. 添加健康检查、依赖排序、事件通知

### Phase 2: Gateway 重构
1. Gateway 使用新的 `NodeProcessManager`
2. 保持 API 兼容
3. 增强日志收集

### Phase 3: 桌面端集成
1. 桌面端使用相同的 `NodeProcessManager`
2. 添加 IPC 桥接层
3. 实现 UI 状态展示

### Phase 4: CLI 开发模式
1. 提供 `npm run dev` 一键启动 CSS + API
2. 统一日志格式
3. 热重载支持

---

## 7. 附：进程状态流转

```
                    ┌───────────┐
                    │  stopped  │
                    └─────┬─────┘
                          │ start()
                          ▼
                    ┌───────────┐
                    │ starting  │
                    └─────┬─────┘
                          │ health check passed
                          ▼
    ┌─────────────┐ ┌───────────┐ ┌─────────────┐
    │   crashed   │◄│  running  │►│  stopping   │
    └──────┬──────┘ └───────────┘ └──────┬──────┘
           │                              │
           │ auto-restart                 │ stop complete
           └──────────────────────────────┼──────►┌───────────┐
                                          └──────►│  stopped  │
                                                  └───────────┘
```

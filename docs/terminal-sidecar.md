# Terminal Sidecar 设计规范

## 概述

Terminal Sidecar 是 Xpod 的交互式终端服务，为 Agent 提供 PTY（伪终端）访问能力。它专注于**会话管理、身份验证、权限校验和凭据注入**，安全隔离由 Agent 自行负责。

### 设计理念

- **Terminal Sidecar 只做终端** - PTY 管理、WebSocket 通信、权限网关
- **只允许受信任 Agent** - 白名单机制，只启动已知安全的 Agent
- **安全由 Agent 负责** - Agent（如 Claude Code）内置 [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) 进行隔离
- **参考项目** - [Happy Coder](https://github.com/slopus/happy) 的设计思路

### 信任模型

```typescript
// 只允许启动受信任的 Agent
const TRUSTED_AGENTS = ['claude', 'codex', 'aider'];

function createSession(config: SessionConfig) {
  if (!TRUSTED_AGENTS.includes(config.command)) {
    throw new Error(`Untrusted command: ${config.command}`);
  }
  // 直接启动，信任 Agent 自己的安全机制
  return spawn(config.command, config.args, { env, cwd });
}
```

| Agent | 内置安全机制 |
|-------|-------------|
| `claude` | sandbox-runtime (文件系统 + 网络隔离) |
| `codex` | 权限提示 + 沙盒 |
| `aider` | 配置白名单 |

```
┌─────────────────────────────────────────────────────────────┐
│                  Client (Web / Mobile / CLI)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │ WebSocket (E2E 加密)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Terminal Sidecar                         │
│                                                              │
│  职责：                                                       │
│  ├── PTY 管理 (node-pty)                                     │
│  ├── 身份验证 (WebID / Solid-OIDC)                           │
│  ├── 权限校验 (Pod ACL + Agent 白名单)                        │
│  ├── 凭据注入 (/.secrets/ → 环境变量)                         │
│  ├── ACL→路径映射 (bubblewrap)                               │
│  └── 权限请求转发 (当 Agent 需要额外权限时)                    │
│                                                              │
└─────────────────────────────┬───────────────────────────────┘
                              │ bwrap + spawn (只允许受信任 Agent)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              受信任 Agent (claude / codex / aider)           │
│                                                              │
│  Agent 视角 (经过 bubblewrap 映射):                           │
│  ├── /workspace/  → 可读写                                   │
│  ├── /github/     → 只读                                     │
│  └── /.secrets/   → 不可见 (凭据已在 env 中)                  │
│                                                              │
│  Agent 内置安全机制：                                         │
│  ├── sandbox-runtime (进一步限制子进程)                       │
│  └── 权限提示 (危险操作需用户确认)                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                           Pod                                │
│      /.secrets/      /github/      /workspace/               │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. 核心概念

### 1.1 Session（会话）

一个 Session 代表一次终端交互会话，对应一个 PTY 实例。

| 属性 | 说明 |
|------|------|
| `sessionId` | 唯一标识符 |
| `userId` | 发起会话的用户/Agent WebID |
| `ptyPid` | PTY 进程 ID |
| `createdAt` | 创建时间 |
| `expiresAt` | 过期时间 |
| `status` | `active` / `idle` / `terminated` |
| `permissions` | 从 Pod ACL 读取的权限 |

### 1.2 PTY（伪终端）

Terminal Sidecar 使用 `node-pty` 提供交互式终端能力：

```typescript
import * as pty from 'node-pty';

const shell = pty.spawn('bash', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: workdir,
  env: {
    ...process.env,
    ...injectedCredentials,  // 从 Pod /.secrets/ 注入
  }
});
```

### 1.3 与 Happy Coder 的对比

| 功能 | Happy Coder | Terminal Sidecar |
|------|-------------|------------------|
| **定位** | 远程控制 Claude Code | Pod 的终端服务 |
| **会话管理** | QR 码配对 | WebID 认证 |
| **通信** | 云端中继 | Pod 旁 Sidecar |
| **权限** | 转发到手机确认 | Pod ACL + 客户端确认 |
| **E2E 加密** | ✓ | ✓ |
| **沙盒** | Agent 自己管 | Agent 自己管 |
| **凭据** | 用户自己配 | Pod /.secrets/ 统一管理 |

---

## 2. API 设计

### 2.1 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/-/terminal/sessions` | POST | 创建新会话 |
| `/-/terminal/sessions/{id}` | GET | 获取会话信息 |
| `/-/terminal/sessions/{id}` | DELETE | 终止会话 |
| `/-/terminal/sessions/{id}/ws` | WebSocket | 交互式连接 |

### 2.2 创建会话

**Request:**

```http
POST /-/terminal/sessions
Authorization: DPoP ...
Content-Type: application/json

{
  "command": "claude",
  "args": [],
  "workdir": "/workspace",
  "env": {
    "GITHUB_TOKEN": { "@ref": "/.secrets/github/personal.json", "jsonPath": "$.token" }
  },
  "timeout": 3600
}
```

**Response:**

```json
{
  "sessionId": "sess_abc123",
  "status": "active",
  "wsUrl": "wss://pod.example/alice/-/terminal/sessions/sess_abc123/ws",
  "createdAt": "2024-12-12T10:00:00Z",
  "expiresAt": "2024-12-12T11:00:00Z"
}
```

### 2.3 WebSocket 协议

#### 连接

```
wss://pod.example/alice/-/terminal/sessions/{sessionId}/ws
```

#### 消息格式

所有消息为 JSON 格式，支持端到端加密：

```typescript
interface TerminalMessage {
  type: string;
  encrypted?: boolean;  // 是否 E2E 加密
  payload?: string;     // 加密时为密文
  [key: string]: any;
}
```

#### Client → Server 消息

| type | 说明 | 参数 |
|------|------|------|
| `input` | 终端输入 | `data: string` |
| `resize` | 调整终端大小 | `cols: number, rows: number` |
| `signal` | 发送信号 | `signal: "SIGINT" \| "SIGTERM" \| ...` |
| `ping` | 心跳 | - |
| `permission_response` | 权限请求响应 | `requestId: string, granted: boolean` |

**示例：**

```json
{ "type": "input", "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "signal", "signal": "SIGINT" }
{ "type": "permission_response", "requestId": "req_123", "granted": true }
```

#### Server → Client 消息

| type | 说明 | 参数 |
|------|------|------|
| `output` | 终端输出 | `data: string` |
| `exit` | 进程结束 | `code: number, signal?: string` |
| `error` | 错误 | `message: string, code: string` |
| `pong` | 心跳响应 | - |
| `permission_request` | 权限请求 | `requestId: string, description: string, ...` |

**示例：**

```json
{ "type": "output", "data": "total 128\r\ndrwxr-xr-x  5 user user  160 Dec 12 10:00 .\r\n" }
{ "type": "exit", "code": 0 }
{ "type": "permission_request", "requestId": "req_123", "description": "写入 /etc/hosts", "path": "/etc/hosts", "action": "write" }
```

---

## 3. 权限与安全模型

### 3.1 认证

Terminal 使用与 Pod 相同的认证机制：

1. **Solid-OIDC**: Agent/用户使用 DPoP token 认证
2. **Session Token**: 创建会话时获取，用于 WebSocket 连接

```
┌─────────┐      1. DPoP Auth       ┌─────────────┐
│  Agent  │ ───────────────────────▶│   Pod       │
│         │                         │   (OIDC)    │
│         │◀─── 2. Session Token ───│             │
│         │                         └─────────────┘
│         │      3. WS + Token      ┌─────────────┐
│         │ ───────────────────────▶│  Terminal   │
└─────────┘                         └─────────────┘
```

### 3.2 授权 - Pod ACL 扩展

```turtle
# /alice/.terminal/.acl

@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix udf: <https://undefineds.co/ns/> .

# 允许 code-agent 使用 Terminal
<#codeAgentTerminal> a acl:Authorization ;
    acl:agent </alice/agents/code-agent/profile#me> ;
    acl:accessTo </alice/.terminal/> ;
    acl:mode acl:Read, acl:Write ;
    
    # Terminal 特有权限
    udf:terminalPermissions [
        udf:allowedWorkdirs "/alice/github/", "/alice/workspace/" ;
        udf:injectSecrets "/.secrets/github/personal.json" ;
        udf:maxSessionDuration 3600
    ] .
```

### 3.3 权限检查流程

```
1. 创建会话请求
        │
        ▼
2. 验证用户/Agent 身份 (Solid-OIDC)
        │
        ▼
3. 检查是否有 Terminal 访问权 (ACL)
        │
        ▼
4. 读取 Terminal 权限配置
        │
        ▼
5. 注入凭据到环境变量
        │
        ▼
6. 启动 PTY 进程
```

### 3.4 权限请求转发

当运行的进程（如 Agent）需要额外权限时，Terminal Sidecar 可以将请求转发到客户端：

```
Agent: "我需要写入 /etc/hosts，是否允许？"
    ↓
Terminal Sidecar: 
    - 检查 Pod ACL，没有预授权
    - 生成权限请求，转发到客户端
    ↓
Client: 弹窗 "Claude Code 请求写入 /etc/hosts [允许/拒绝]"
    ↓
User: 点击 "允许" 或 "拒绝"
    ↓
Terminal Sidecar → Agent: 返回权限结果
```

**权限请求消息：**

```json
{
  "type": "permission_request",
  "requestId": "req_abc123",
  "source": "claude-code",
  "action": "file_write",
  "resource": "/etc/hosts",
  "description": "Claude Code 请求写入系统 hosts 文件",
  "timeout": 60
}
```

**权限响应消息：**

```json
{
  "type": "permission_response",
  "requestId": "req_abc123",
  "granted": true,
  "expiresAt": "2024-12-12T11:00:00Z"
}
```

---

## 4. 安全隔离

### 4.1 两层安全模型

| 层级 | 负责方 | 机制 | 作用 |
|------|--------|------|------|
| **文件系统可见性** | Terminal Sidecar | bubblewrap | 根据 Pod ACL 限制 Agent 能看到哪些路径 |
| **运行时隔离** | Agent | sandbox-runtime | Agent 内部的细粒度权限控制 |

```
Pod ACL 定义:
    /alice/workspace/ → acl:Read, acl:Write
    /alice/github/    → acl:Read
    /alice/.secrets/  → (无权限，通过环境变量注入)
    
        ↓ Terminal Sidecar 用 bubblewrap 映射
        
Agent 视角:
    /workspace/  → 可读写 (映射自 /alice/workspace/)
    /github/     → 只读   (映射自 /alice/github/)
    /.secrets/   → 不可见 (凭据通过 env 注入)
```

### 4.2 bubblewrap 做 ACL 映射

Terminal Sidecar 根据 Pod ACL 生成 bubblewrap 参数：

```typescript
function aclToBwrapArgs(acl: PodACL, agentId: string): string[] {
  const args: string[] = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/bin', '/bin',
    '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc',
    '--dev', '/dev',
  ];
  
  // 根据 ACL 挂载 Pod 路径
  for (const grant of acl.getGrantsFor(agentId)) {
    if (grant.mode.includes('Write')) {
      args.push('--bind', grant.podPath, grant.sandboxPath);
    } else if (grant.mode.includes('Read')) {
      args.push('--ro-bind', grant.podPath, grant.sandboxPath);
    }
    // 无权限的路径不挂载，Agent 看不到
  }
  
  args.push('--chdir', '/workspace');
  return args;
}

// 启动 Agent
spawn('bwrap', [...bwrapArgs, 'claude'], { env: injectedEnv });
```

### 4.3 为什么用 bubblewrap？

| 特性 | 说明 |
|------|------|
| **性能** | 启动 ~5ms，运行时 0 开销 |
| **无需镜像** | 直接使用主机文件系统 |
| **精确控制** | 每个路径单独配置读/写/不可见 |
| **不嵌套** | bubblewrap 只做路径映射，不影响 Agent 内部的 sandbox-runtime |

### 4.4 Agent 内部的 sandbox-runtime

bubblewrap 解决"能看到什么"，Agent 内部的 sandbox-runtime 解决"能做什么"：

| 层级 | 问题 | 解决方案 |
|------|------|----------|
| Terminal (bubblewrap) | Agent 能看到哪些 Pod 路径？ | ACL → 路径映射 |
| Agent (sandbox-runtime) | Agent 执行的命令能访问什么？ | 网络过滤、文件限制、权限提示 |

两层不冲突，bubblewrap 是"上限"，sandbox-runtime 可以进一步收紧。

---

## 5. 凭据注入

### 5.1 从 Pod /.secrets/ 读取

Terminal Sidecar 自动从 Pod 读取凭据并注入环境变量：

```json
{
  "env": {
    "GITHUB_TOKEN": {
      "@ref": "/.secrets/github/personal.json",
      "jsonPath": "$.token"
    },
    "AWS_ACCESS_KEY_ID": {
      "@ref": "/.secrets/aws/prod.json",
      "jsonPath": "$.accessKeyId"
    }
  }
}
```

### 5.2 注入流程

```typescript
async function injectCredentials(envConfig: Record<string, EnvValue>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === 'string') {
      result[key] = value;
    } else if (value['@ref']) {
      // 从 Pod 读取凭据
      const secret = await pod.read(value['@ref']);
      const parsed = JSON.parse(secret);
      result[key] = jsonPath.query(parsed, value.jsonPath)[0];
    }
  }
  
  return result;
}
```

### 5.3 安全注意事项

- 凭据只在 Terminal Sidecar 进程内存中存在
- 不写入文件系统（除非显式配置）
- 会话结束后清除
- 审计日志记录凭据使用（不记录值）

---

## 6. 会话管理

### 6.1 生命周期

```
Created ──▶ Active ──▶ Idle ──▶ Terminated
               │         │
               │         ├──▶ (timeout) ──▶ Terminated
               │         │
               └─────────┴──▶ (manual close) ──▶ Terminated
```

### 6.2 超时策略

| 超时类型 | 默认值 | 说明 |
|----------|--------|------|
| Session 总时长 | 1 小时 | 会话最长存活时间 |
| Idle 超时 | 10 分钟 | 无活动自动终止 |
| WebSocket ping | 30 秒 | 心跳间隔 |

### 6.3 断线重连

支持客户端断线后重连到同一会话：

```typescript
// 重连时携带 sessionId
const ws = new WebSocket(`wss://pod.example/alice/-/terminal/sessions/${sessionId}/ws`);

// 服务端检测到重连，恢复输出缓冲
```

### 6.4 资源清理

会话终止时：

1. 发送 SIGTERM 到 PTY 进程
2. 等待 10 秒优雅退出
3. 强制 SIGKILL
4. 清理会话记录
5. 记录审计日志

---

## 7. E2E 加密

### 7.1 设计目标

确保终端 I/O 在传输过程中不可被中间人读取（包括 Sidecar 自身）。

### 7.2 密钥交换

使用 X25519 进行密钥交换：

```typescript
// 客户端生成密钥对
const clientKeyPair = generateX25519KeyPair();

// 创建会话时交换公钥
POST /-/terminal/sessions
{
  "publicKey": clientKeyPair.publicKey
}

// 服务端返回其公钥
{
  "sessionId": "...",
  "publicKey": serverPublicKey
}

// 双方计算共享密钥
const sharedSecret = x25519(clientKeyPair.privateKey, serverPublicKey);
```

### 7.3 消息加密

使用 ChaCha20-Poly1305 加密消息：

```typescript
// 发送加密消息
{
  "type": "input",
  "encrypted": true,
  "nonce": "base64...",
  "payload": "encrypted_base64..."
}
```

---

## 8. 配置

### 8.1 服务端配置

```json
{
  "@type": "TerminalSidecar",
  
  "pty": {
    "defaultShell": "/bin/bash",
    "defaultCols": 80,
    "defaultRows": 24
  },
  
  "limits": {
    "maxSessionsPerUser": 5,
    "maxTotalSessions": 100,
    "defaultTimeout": 3600,
    "maxTimeout": 86400,
    "idleTimeout": 600
  },
  
  "security": {
    "requireE2EEncryption": false,
    "allowedCommands": null,
    "auditLogging": true
  }
}
```

### 8.2 Pod 端配置

```turtle
# /alice/.terminal/config

</alice/.terminal/config> a udf:TerminalConfig ;
    udf:defaultShell "/bin/bash" ;
    udf:defaultWorkdir "/workspace" ;
    udf:autoInjectSecrets "/.secrets/github/personal.json" ;
    udf:env [
        udf:key "EDITOR" ;
        udf:value "vim"
    ] .
```

---

## 9. 错误处理

### 9.1 错误码

| 错误码 | HTTP | 说明 |
|--------|------|------|
| `UNAUTHORIZED` | 401 | 未认证 |
| `FORBIDDEN` | 403 | 无权限 |
| `SESSION_NOT_FOUND` | 404 | 会话不存在 |
| `SESSION_EXPIRED` | 410 | 会话已过期 |
| `RESOURCE_LIMIT` | 429 | 达到资源限制 |
| `PTY_ERROR` | 500 | PTY 创建/执行失败 |

### 9.2 WebSocket 错误消息

```json
{
  "type": "error",
  "code": "SESSION_EXPIRED",
  "message": "Session has expired",
  "details": {
    "sessionId": "sess_abc123",
    "expiredAt": "2024-12-12T11:00:00Z"
  }
}
```

---

## 10. 监控与日志

### 10.1 审计日志

记录会话活动（可选记录输入输出）：

```json
{
  "timestamp": "2024-12-12T10:05:00Z",
  "sessionId": "sess_abc123",
  "userId": "https://pod.example/alice/profile#me",
  "event": "session_created",
  "command": "bash",
  "workdir": "/workspace"
}
```

```json
{
  "timestamp": "2024-12-12T10:05:30Z",
  "sessionId": "sess_abc123",
  "event": "permission_requested",
  "action": "file_write",
  "resource": "/etc/hosts",
  "granted": true
}
```

### 10.2 指标

| 指标 | 说明 |
|------|------|
| `terminal_sessions_active` | 活跃会话数 |
| `terminal_sessions_total` | 总会话数 |
| `terminal_bytes_in` | 输入字节数 |
| `terminal_bytes_out` | 输出字节数 |
| `terminal_permission_requests` | 权限请求数 |

---

## 11. 参考项目

### 11.1 Happy Coder

[github.com/slopus/happy](https://github.com/slopus/happy) - 远程控制 Claude Code 的移动端工具

- 使用 MCP SDK 进行权限转发
- 端到端加密
- QR 码配对

### 11.2 Anthropic sandbox-runtime

[github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) - 轻量级进程沙盒

- 无需容器，使用 OS 原语
- 文件系统 + 网络双重隔离
- Claude Code 使用的沙盒方案

---

## 12. 未来扩展

- [ ] 多终端复用（tmux 风格）
- [ ] 终端录制与回放
- [ ] 协作模式（多人共享终端）
- [ ] 文件上传/下载 API
- [ ] Web Terminal UI 组件
- [ ] 更多受信任 Agent 支持

---

## Changelog

- **2024-12-12**: 初稿
- **2024-12-12**: 重构 - 明确 Terminal 只做 PTY，沙盒由 Agent 管理；加入 Happy Coder 和 sandbox-runtime 参考
- **2024-12-12**: 简化 - 只支持受信任 Agent 白名单
- **2024-12-12**: 安全模型 - 用 bubblewrap 做 ACL→路径映射，Agent 内部用 sandbox-runtime 做运行时隔离

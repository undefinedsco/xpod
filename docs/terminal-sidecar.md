# Terminal Sidecar

Terminal Sidecar 为 Xpod 提供远程终端访问能力，支持 AI Agent 在 Pod 中执行命令。

## 架构概览

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────►│   Cluster   │────►│  Edge Node  │
│  (AI Agent) │ WSS │  (Ingress)  │ WSS │  (Terminal) │
└─────────────┘     └─────────────┘     └─────────────┘
```

## API 端点

所有端点都是 pod-scoped，路径格式为 `/{podId}/-/terminal/sessions`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/{podId}/-/terminal/sessions` | 创建终端 session |
| GET | `/{podId}/-/terminal/sessions/{id}` | 获取 session 信息 |
| DELETE | `/{podId}/-/terminal/sessions/{id}` | 删除 session |
| WS | `/{podId}/-/terminal/sessions/{id}/ws` | WebSocket 连接 |

## 创建 Session

```bash
curl -X POST https://pod.example.com/alice/-/terminal/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "/bin/bash",
    "args": ["-l"],
    "env": {"TERM": "xterm-256color"},
    "cols": 80,
    "rows": 24
  }'
```

响应：

```json
{
  "sessionId": "abc123",
  "wsUrl": "wss://pod.example.com/alice/-/terminal/sessions/abc123/ws",
  "status": "active",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

## WebSocket 通信

连接到 `wsUrl` 后，使用 JSON 消息通信：

### 客户端 → 服务端

```json
// 输入数据
{"type": "input", "data": "ls -la\r"}

// 调整窗口大小
{"type": "resize", "cols": 120, "rows": 40}

// 心跳
{"type": "ping"}
```

### 服务端 → 客户端

```json
// 输出数据
{"type": "output", "data": "total 42\ndrwxr-xr-x ..."}

// 心跳响应
{"type": "pong"}

// 进程退出
{"type": "exit", "code": 0}
```

## 云边集群支持

Terminal 在云边集群中支持两种模式：

### Direct 模式

边缘节点有公网 IP 时，客户端直连边缘节点：

```
Client ──WSS──► Edge Node (1.2.3.4:443)
```

Cluster 返回 307 重定向，客户端重新连接到边缘节点。

### Proxy 模式

边缘节点在 NAT/防火墙后，通过 Cluster 中继：

```
Client ──WSS──► Cluster ──WSS──► FRP Tunnel ──WSS──► Edge Node
```

`ClusterWebSocketConfigurator` 处理 WebSocket 升级请求，使用 `http-proxy` 中继到 FRP 隧道。

## 安全

### 认证

所有请求需要 Bearer 或 DPoP token：

```bash
curl -H "Authorization: Bearer <access_token>" ...
```

### 信任的 Agent

只有白名单内的 Agent 可以访问 Terminal：

- `claude`, `codex`, `aider`, `codebuddy`, `gemini`
- `/bin/sh`, `/bin/bash`, `sh`, `bash`

### 沙箱

支持跨平台沙箱隔离：

| 平台 | 沙箱技术 |
|------|----------|
| Linux | Bubblewrap (`bwrap`) |
| macOS | `sandbox-exec` |
| 其他 | 无沙箱（仅开发环境） |

## 配置

### config/terminal.json

```json
{
  "@id": "urn:undefineds:xpod:TerminalHttpHandler",
  "@type": "TerminalHttpHandler",
  "sidecarPath": "/-/terminal",
  "credentialsExtractor": {
    "@id": "urn:solid-server:default:CredentialsExtractor"
  }
}
```

### 集成到 HTTP Pipeline

在 `extensions.local.json` 或 `xpod.cluster.json` 中添加：

```json
{
  "import": ["./terminal.json"],
  "@graph": [
    {
      "@type": "Override",
      "overrideInstance": { "@id": "urn:solid-server:default:BaseHttpHandler" },
      "overrideParameters": {
        "@type": "WaterfallHandler",
        "handlers": [
          { "@id": "urn:undefineds:xpod:SubgraphSparqlHttpHandler" },
          { "@id": "urn:undefineds:xpod:TerminalHttpHandler" },
          // ... 其他 handlers
        ]
      }
    }
  ]
}
```

## 相关组件

| 组件 | 文件 | 说明 |
|------|------|------|
| TerminalHttpHandler | `src/http/terminal/TerminalHttpHandler.ts` | HTTP/WebSocket 处理 |
| TerminalSession | `src/terminal/TerminalSession.ts` | PTY 会话管理 |
| ClusterWebSocketConfigurator | `src/http/ClusterWebSocketConfigurator.ts` | 集群 WebSocket 代理 |
| BubblewrapSandbox | `src/terminal/sandbox/BubblewrapSandbox.ts` | Linux 沙箱 |
| MacOSSandbox | `src/terminal/sandbox/MacOSSandbox.ts` | macOS 沙箱 |

# Solid 通知订阅机制

本文档介绍 xpod 如何实现 Solid 通知订阅协议，以及多节点环境下的架构设计。

## 概述

xpod 基于 [Community Solid Server (CSS)](https://github.com/CommunitySolidServer/CommunitySolidServer) 实现 Solid 通知订阅功能，并通过自定义配置实现集群感知的分布式存储。

**协议规范**: [Solid Notifications Protocol](https://solid.github.io/notifications/protocol)

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端                                    │
│  1. GET /.notifications/WebSocketChannel2023/ (发现端点)         │
│  2. POST /.notifications/WebSocketChannel2023/ (创建订阅)        │
│  3. WebSocket 连接到 receiveFrom URL                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    xpod 节点 (Node A/B/C)                        │
│  ┌───────────────────┐  ┌───────────────────┐                   │
│  │ CSS Notification  │  │ ClusterWebSocket  │                   │
│  │ Handler           │  │ Configurator      │                   │
│  └─────────┬─────────┘  └─────────┬─────────┘                   │
│            │                      │                              │
│            │    WebSocketMap      │                              │
│            │    (本节点连接)       │                              │
│            └──────────┬───────────┘                              │
└───────────────────────┼─────────────────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ PostgreSQL  │  │   Redis     │  │   MinIO     │
│ (订阅存储)   │  │ (分布式锁)  │  │ (资源存储)   │
└─────────────┘  └─────────────┘  └─────────────┘
```

## xpod 的定制实现

### 1. 订阅存储 (PostgreSQL)

CSS 默认使用内存存储订阅数据，xpod 通过配置覆盖为 PostgreSQL 存储：

**配置文件**: `config/xpod.cluster.json`

```json
{
  "@id": "urn:undefineds:xpod:PostgresInternalKeyValueStorage",
  "@type": "PostgresKeyValueStorage",
  "connectionString": { "@id": "urn:solid-server:default:variable:identityDbUrl" },
  "tableName": "internal_kv",
  "namespace": "/.internal/"
}
```

**优势**:
- 订阅数据持久化，节点重启不丢失
- 所有集群节点共享同一份订阅数据
- 支持水平扩展

### 2. 分布式锁 (Redis)

使用 Redis 实现分布式锁，确保多节点环境下的并发安全：

**配置文件**: `config/extensions.cloud.json`

```json
{
  "@type": "Override",
  "overrideInstance": { "@id": "urn:solid-server:default:ResourceLocker" },
  "overrideParameters": {
    "@type": "WrappedExpiringReadWriteLocker",
    "locker": {
      "@type": "RedisResourceLocker",
      "redisClient": { "@id": "urn:solid-server:default:RedisClient" }
    }
  }
}
```

### 3. WebSocket 路由 (ClusterWebSocketConfigurator)

xpod 自定义 `ClusterWebSocketConfigurator` 处理集群环境下的 WebSocket 连接路由：

**文件**: `src/http/ClusterWebSocketConfigurator.ts`

**功能**:
- 解析边缘节点子域名 (如 `node1.cluster.example.com`)
- 根据节点接入模式选择路由策略:
  - **Direct 模式**: 返回 307 重定向到节点公网 IP
  - **Proxy 模式**: 通过 FRP 隧道代理 WebSocket

```typescript
// 简化示例
export class ClusterWebSocketConfigurator {
  public async handle(server: Server): Promise<void> {
    server.prependListener('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }
  
  private async handleUpgrade(request, socket, head): Promise<boolean> {
    const nodeId = this.extractNodeId(request.headers.host);
    const connectivity = await this.repository.getNodeConnectivityInfo(nodeId);
    
    if (connectivity.accessMode === 'direct') {
      // 307 重定向到节点直连地址
      this.sendRedirect(socket, `wss://${connectivity.publicIp}${request.url}`);
    } else {
      // 通过 FRP 隧道代理
      this.wsProxy.ws(request, socket, head, { target: tunnelUrl });
    }
  }
}
```

## 通知流程

### 订阅创建流程

```
Client                    xpod                    PostgreSQL
   │                        │                          │
   │── POST /WebSocketChannel2023/ ─────────────────>│
   │   { topic: "/alice/inbox/" }                     │
   │                        │                          │
   │                        │── INSERT subscription ──>│
   │                        │<── OK ──────────────────│
   │                        │                          │
   │<── 201 Created ────────│                          │
   │    { receiveFrom: "wss://..." }                  │
   │                        │                          │
   │── WebSocket Connect ──>│                          │
   │<── Connection Open ────│                          │
```

### 通知投递流程

```
Writer                   xpod                     Subscriber
   │                       │                          │
   │── PUT /alice/inbox/msg1 ─────────────────────>│
   │                       │                          │
   │                       │── Query subscriptions ──>│ PostgreSQL
   │                       │<── [subscription] ───────│
   │                       │                          │
   │                       │── WebSocket send ───────>│
   │                       │   { type: "Create", ... }│
   │<── 201 Created ───────│                          │
```

## 已知限制

### 单节点通知投递

**问题**: WebSocket 连接仅存储在本地节点内存中 (`WebSocketMap`)，当资源变更发生在 A 节点，而订阅者连接在 B 节点时，通知无法跨节点投递。

```
Node A                     Node B                   PostgreSQL
   │                          │                          │
   │── Resource changed ──────│                          │
   │                          │                          │
   │── Query subscriptions ───────────────────────────>│
   │<── [subscription for B] ─────────────────────────│
   │                          │                          │
   │   ❌ 无法发送到 Node B    │                          │
   │   (WebSocket 在 B 节点)   │                          │
```

### 解决方案 (待实现)

1. **Redis Pub/Sub 广播**
   ```typescript
   // 发送节点
   redis.publish('notifications', JSON.stringify(notification));
   
   // 所有节点订阅
   redis.subscribe('notifications', (msg) => {
     const notification = JSON.parse(msg);
     // 转发到本地 WebSocket 连接
   });
   ```

2. **PostgreSQL LISTEN/NOTIFY**
   ```sql
   -- 发送
   NOTIFY subscription_event, '{"topic": "/alice/inbox/", ...}';
   
   -- 接收
   LISTEN subscription_event;
   ```

## 测试

### 集成测试

```bash
# 启动服务器
yarn start

# 运行通知订阅测试
XPOD_TEST_BASE_URL=http://localhost:3000 npx vitest run tests/integration/notification-subscription.test.ts
```

### 手动测试

```bash
# 1. 获取订阅端点描述
curl -X GET http://localhost:3000/.notifications/WebSocketChannel2023/ \
  -H "Accept: application/ld+json"

# 2. 创建订阅
curl -X POST http://localhost:3000/.notifications/WebSocketChannel2023/ \
  -H "Content-Type: application/ld+json" \
  -H "Accept: application/ld+json" \
  -d '{
    "@context": ["https://www.w3.org/ns/solid/notification/v1"],
    "type": "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023",
    "topic": "http://localhost:3000/test/"
  }'

# 3. 连接 WebSocket (使用返回的 receiveFrom URL)
wscat -c "wss://..."
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/http/ClusterWebSocketConfigurator.ts` | 集群 WebSocket 路由 |
| `config/xpod.cluster.json` | PostgreSQL 订阅存储配置 |
| `config/extensions.cloud.json` | Redis 分布式锁配置 |
| `tests/integration/notification-subscription.test.ts` | 集成测试 |

## 参考

- [Solid Notifications Protocol](https://solid.github.io/notifications/protocol)
- [WebSocketChannel2023 Type](https://solid.github.io/notifications/websocket-channel-2023)
- [Community Solid Server Notifications](https://communitysolidserver.github.io/CommunitySolidServer/latest/usage/notifications/)

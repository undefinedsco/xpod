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
      this.sendRedirect(socket, `wss://${connectivity.ipv4}${request.url}`);
    } else {
      // 通过 FRP 隧道代理
      this.wsProxy.ws(request, socket, head, { target: tunnelUrl });
    }
  }
}
```

## 通道生命周期与回收

### 缺陷（2026-09 实测）

CSS 默认实现只在 socket 关闭时把它从内存 `WebSocketMap` 移除：

- `node_modules/@solid/community-server/dist/server/notifications/WebSocketChannel2023/WebSocket2023Storer.js:27-31`：`close` / `error` 只调用 `socketMap.deleteEntry(...)`，**不删除通道记录**；
- `node_modules/@solid/community-server/dist/server/notifications/KeyValueChannelStorage.js:20-32`：通道只在 `get()` 时惰性判过期，而孤儿通道的 id 不会再被 `get()`；
- `node_modules/@solid/community-server/dist/server/notifications/NotificationSubscriber.js:36,58-63`：`maxDuration` 默认 20160 分钟，把没有显式 `endAt` 的通道寿命补到 **2 周**。

结果：每次页面刷新 / HMR / 页面崩溃都在 `internal_kv` 留下一个 `notifications/<channel-id>` 记录（外加它所在 topic 索引行里的一项），两周内不会消失。实测一次验证会话里通道数从 0 → 4 → 6 → 39 只增不减。

放大这个缺陷的两个代理层问题（同一次实测中发现）。**这两个都是开发/验证环境的放大器，不是产品缺陷的成因**：生产路径上浏览器直连 gateway，既不经过 Vite dev server，也不会丢 `close`。

- **开发态 Vite 的 WebSocket 代理（Bun 运行时）**：`ui` 的 dev server 若用 Bun 运行（`bun vite ...`），其 WS 代理在客户端关闭连接时会抛
  `TypeError: socket.destroySoon is not a function`（`node_modules/vite/dist/node/chunks/config.js:21706` 的 `socket.destroySoon()`；Bun 的 socket 没有 `destroySoon`，
  崩溃栈后紧跟 `Bun v1.3.8 (macOS arm64)`），Vite 进程随之退出，关闭信号没有传到 CSS，通道连同 `WebSocketMap` 里的 socket 一起变成僵尸（清扫看到“还有 socket”而不敢删）。
  实测证据：`.test-data/dev-monitor/monitor.log` 里该 TypeError 出现 44 次，每次后面紧跟 `[monitor] Vite stopped; ... bun exited (1)`。
  - 处置：5173 的 UI dev server 改由 Node 运行（`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`）。5174 的 Bun 实例是另一条调试通道，未改动；两个实例共用 `ui/node_modules/.vite` 依赖缓存，所以别再对 5173 加 `--force`（会与 5174 抢 `deps` 目录并 `ENOTEMPTY` 启动失败）。
  - **仍未修死**：仓库自带的 dev 循环 `scripts/dev-repair.ts:225` 仍然用 `bun` 拉起 Vite。Node 实例占用 5173 时它只会 `EADDRINUSE` 失败（此时环境恰好是 Node），但 Node 实例一旦退出，下一次 UI 编辑触发的重建就会把 Bun 版拉回来，放大器复现。要彻底修掉需要把那一行改成 Node。
  - 生产路径不受影响：gateway 的 `BunNativeUpgradeRelay` 会把客户端 `close` 转成关闭帧并在 5 秒宽限后销毁上游 socket（`src/runtime/upgrade/BunNativeUpgradeRelay.ts:481-494`）。
- **客户端 DELETE 在修复前从未到达服务端**：第一阶段实测里 CSS 没有收到任何 `DELETE /.notifications/...` 请求（`ReclaimingWebSocket2023Storer` / 日志均可证），所以泄漏完全依赖服务端回收。客户端侧不再补“跨会话记住通道 id”的逻辑，`ui/src/extensions/solid-notifications.ts` 现有的 close/pagehide 删除路径保持不变。第二次实测（见下）里 DELETE 会到达，但通常晚于服务端回收，因此落到 404/205——这正是“关闭即回收”先手生效的表现。

僵尸 socket（close 事件永远不到达）是唯一清扫**无法**回收的情况：清扫的存活判据就是本进程的 `WebSocketMap`，此时第三道防线（12 小时 `endAt`）负责收尾——`closeExpiredSockets` 会在下一次 60 分钟清理 tick 关掉过期 socket，通道随惰性过期删除。

### 三道防线（`config/notifications.json`）

| 措施 | 实现 | 位置 |
|------|------|------|
| 关闭即回收 | `ReclaimingWebSocket2023Storer`（等位替换 CSS `WebSocket2023Storer`）：通道名下最后一个 socket 关闭/出错时删除通道；还有其它 socket 时保留 | `src/notifications/ReclaimingWebSocket2023Storer.ts` |
| 孤儿清扫 | `NotificationChannelSweeper`：CSS 开始监听前执行一次启动清扫（此时 `WebSocketMap` 必为空，无 socket 的通道一律是孤儿），之后每 **5 分钟**一次；周期清扫对无 socket 的通道要求**连续两次**判定才删除，避免误删“刚 POST、socket 尚在握手”的通道 | `src/notifications/NotificationChannelSweeper.ts` |
| 寿命背板 | `NotificationSubscriber.maxDuration` 从 20160（2 周）收紧为 **720 分钟（12 小时）** | `config/notifications.json` |

判定“无活动 socket”的依据是本进程的 `WebSocketMap`；清扫只处理 id 以本实例 `baseUrl` 开头的通道，因此共享 `internal_kv` 的其它节点的通道不会被误删（各节点清扫各自的通道）。限制与已知边界见 [`COMPONENTS.md`](COMPONENTS.md) 的 Notifications 小节。

客户端侧不做额外补偿：`ui/src/extensions/solid-notifications.ts` 已经在 socket 关闭、`pagehide` 与 last-listener 离开时 DELETE 通道，页面崩溃等无法执行 DELETE 的场景由服务端清扫兜底。

### 第二次实测（2026-09-15 09:33，单次 CDP 刷新）

前提：dev 桌面壳页面 `http://127.0.0.1:5173/ai-connections` 打开且可见。计数命令：

```bash
sqlite3 -readonly ~/Library/Application\ Support/Xpod/identity.sqlite \
  "SELECT count(*) FROM internal_kv WHERE key LIKE 'notifications/%';"
```

行数 = 通道记录 + topic 索引行（`notifications/<encodeURIComponent(id)>` 与 `notifications/<encodeURIComponent(topic)>`）。

| 时刻（本地） | 行数 | 通道记录 | 每 topic 通道数 |
|--------------|------|----------|-----------------|
| 09:33:25（刷新前） | 5 | 3 | `glocal/settings/credentials.ttl` **2**（01:32:17 / 01:32:29 创建，两次 POST 之后都没有 `Accepted WebSocket connection`）；`glocal/settings/providers/bailian.ttl` 1 |
| 09:33:27 | — | — | 单次 `Page.reload`（CDP，page target 在 5173，只发 `Page.enable` + `Page.reload`） |
| 09:34:34（+67 s） | 5，同一秒内继续涨到 6 | 4 | `credentials.ttl` **3**；`bailian.ttl` 1 |
| 09:41:54 | 2 | 1 | `credentials.ttl` 1 |
| 09:42:51 | 2 | 1 | `providers/anthropic.ttl` 1 |

结论：

1. **单页面稳态下每 topic 就是 1 条通道**（09:42:51 样本），与客户端原语的 per-topic 引用计数一致：`ui/src/extensions/solid-notifications.ts` 的 `watch()` 每个 topic 只有一个 entry，两个 watcher 共用一个 channel/socket（`ui/src/extensions/solid-notifications.test.ts` 的 `shares one channel and one socket between two watchers of a table document`）。
2. **>1 时多出来的是“没有 socket 的通道”，不是第二个订阅者**：多出来的那些通道的时间点上只有 POST、没有 `Accepted WebSocket connection`，随后被清扫器按“连续两次孤儿”回收——09:36:55 `Reclaimed 5 notification channel(s) without a live WebSocket`、09:38:11 `Reclaimed 2 ...`、09:42:18 `Reclaimed 1 ...`（这三次同时打了 `sweep scheduled`，即新 CSS 进程的启动清扫；CSS 一重启所有通道立刻变孤儿，正是启动清扫该收的场景）。有 socket 的通道不走清扫：socket 一关就由 `ReclaimingWebSocket2023Storer` 即时回收（09:42:26 起每条 `Reclaimed notification channel ...: its last WebSocket closed` 后面 ~30 ms 内客户端 DELETE 落到 404/205）。
3. **本次窗口内计数不是平的，但也不再单调增长**（历史对照：修复前同一会话 0 → 4 → 6 → 39 只增不减）。抖动全部来自并发写：测量期间另一个 Codex 会话在同一工作区操作——编辑 `packages/ai-connections/**` 触发 HMR、`packages` 变更触发 `scripts/dev-repair.ts` 全量重建并**重启 gateway**（gateway pid 94673 → 30359 → 31494 → 35523）、并向 gateway 发过 `/.notifications/.../not-a-channel` 升级探测。09:45 出现过 12 秒内 6 次 POST，**每次都有 `Accepted WebSocket connection`**，那属于“多个客户端上下文各自订阅同一 topic”，不是宽限期残留；同一时刻被测的 5173 页面 `performance.getEntriesByType('resource')` 里 websocket 握手数为 0，说明这些 live 通道来自该页面之外的客户端。要断言“一个页面 = 一条通道/topic”，需要在没有并发客户端的窗口复测。

### 让修复生效需要重启谁

- **需要重启的是 CSS 子进程**：`config/notifications.json` 与 `dist/` 里的新组件只在 CSS 子进程启动时装配。运行中的 CSS 子进程必须晚于 `bun run build:ts` / `build:components` 与配置写出时间。
- **不需要重启 gateway**：gateway 暴露 `POST /service/restart/css`（`src/runtime/Proxy.ts:693-717`），由 gateway 内持有的 `Supervisor.restart('css')` 只停/起 CSS 子进程；同一入口显式拒绝 `gateway`（409 `Gateway restart requires restarting the whole Xpod runtime.`），因此 gateway 进程、端口与会话/登录态不受影响。
- 实测（本次修复落地时）：gateway pid `94673` 从 02:25:29 一直未变，CSS 子进程在 02:31:09 被重新拉起，`[Supervisor] css exited ... SIGTERM` 与 `[Supervisor] Starting css...` 之间**没有** `[Supervisor] Restarting css in 2s... (attempt n/5)`（那是子进程崩溃后的自动重启路径），与 `Supervisor.restart()` 的显式停/起路径一致；同期 api 子进程日志连续，未重启。
- 反例（不是本次修复的操作，仅作对照）：09:36:55 / 09:38:11 的两次重启是 `packages/**` 被并发编辑触发的 monitor 全量重建（`[monitor] Rebuilding packages` → `[Supervisor] Received SIGTERM, stopping all services...`），gateway pid 随之改变——那才是会踢掉登录态的重启方式。

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
| `src/notifications/ReclaimingWebSocket2023Storer.ts` | 最后一个 socket 关闭时回收通道（等位替换） |
| `src/notifications/NotificationChannelSweeper.ts` | 启动 + 周期清扫无 socket 的孤儿通道 |
| `config/notifications.json` | 通道生命周期配置（清扫间隔、寿命上限） |
| `config/xpod.cluster.json` | PostgreSQL 订阅存储配置 |
| `config/extensions.cloud.json` | Redis 分布式锁配置 |
| `tests/integration/notification-subscription.test.ts` | 集成测试 |

## 参考

- [Solid Notifications Protocol](https://solid.github.io/notifications/protocol)
- [WebSocketChannel2023 Type](https://solid.github.io/notifications/websocket-channel-2023)
- [Community Solid Server Notifications](https://communitysolidserver.github.io/CommunitySolidServer/latest/usage/notifications/)

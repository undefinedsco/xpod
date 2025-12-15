# xpod 架构设计 v2

## 概述

v2 核心目标：**Center 节点支持多机部署 + Pod 跨节点路由**

现有架构是单机部署，v2 支持：
- 多个 Center 节点组成集群（共享数据库）
- Pod 数据可以在任意节点
- 请求自动路由到 Pod 所在节点
- Pod 可在节点间迁移

---

## 一、架构变化

### 1.1 现状 vs 目标

```
现状（单机）：
┌─────────────────┐
│   Center Node   │  所有 Pod 数据都在本机
│   + PostgreSQL  │
│   + Minio/COS   │
└─────────────────┘

目标（多机）：
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Center Node 1  │   │  Center Node 2  │   │  Center Node 3  │
│  (北京)         │   │  (广州)         │   │  (上海)         │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         └──────────┬──────────┴──────────┬──────────┘
                    │                     │
              ┌─────▼─────┐         ┌─────▼─────┐
              │ PostgreSQL│         │  COS/OSS  │
              │  (共享)   │         │  (共享)   │
              └───────────┘         └───────────┘
```

### 1.2 核心改动

| 模块 | 改动 | 说明 |
|------|------|------|
| 存储 | MinioDataAccessor → TieredMinioDataAccessor | 加本地缓存层 |
| 路由 | 新增 Pod 路由中间件 | 查 Pod 位置，代理请求 |
| 数据模型 | identity_pod 表加 node_id 字段 | 记录 Pod 在哪个节点 |
| 配置 | 新增缓存配置 | 缓存路径、大小 |

---

## 二、存储架构

### 2.1 TieredMinioDataAccessor

```
┌─────────────────────────────────────────────────────────┐
│              TieredMinioDataAccessor                     │
│                                                          │
│   读取：本地缓存 → 命中返回 / 未命中从 COS 拉取          │
│   写入：写 COS → 写本地缓存                              │
│                                                          │
│   ┌─────────────────┐      ┌─────────────────┐          │
│   │    本地缓存      │      │    COS/OSS      │          │
│   │  (热数据, LRU)   │ ←──→ │  (持久化存储)   │          │
│   │  ${CSS_CACHE_PATH}     │  ${CSS_MINIO_*} │          │
│   └─────────────────┘      └─────────────────┘          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 配置变化

新增环境变量（加入 cli.json，hidden: true）：

```bash
CSS_CACHE_PATH=/data/cache        # 本地缓存目录
CSS_CACHE_MAX_SIZE=50GB           # 缓存大小上限
```

现有配置不变：
- `CSS_MINIO_ENDPOINT`
- `CSS_MINIO_BUCKET_NAME`
- `CSS_MINIO_ACCESS_KEY`
- `CSS_MINIO_SECRET_KEY`

---

## 三、Pod 路由

### 3.1 数据模型

```sql
-- 在现有 identity_pod 表加字段
ALTER TABLE identity_pod ADD COLUMN node_id TEXT;
ALTER TABLE identity_pod ADD COLUMN migration_status TEXT;      -- null | 'syncing' | 'done'
ALTER TABLE identity_pod ADD COLUMN migration_target_node TEXT;
ALTER TABLE identity_pod ADD COLUMN migration_progress INT;     -- 0-100
```

### 3.2 路由逻辑

```typescript
async function podRouter(req: Request, res: Response, next: NextFunction) {
  const podId = extractPodId(req.hostname);  // alice.xpod.com → alice
  
  if (!podId) return next();
  
  // 查 Pod 在哪个节点
  const location = await db.query(
    'SELECT node_id FROM identity_pod_location WHERE pod_id = $1',
    [podId]
  );
  
  // 本节点？直接处理
  if (location.node_id === currentNodeId) {
    return next();
  }
  
  // 其他节点？代理过去
  const node = await getNodeEndpoint(location.node_id);
  return proxy(req, res, { target: node.address });
}
```

### 3.3 节点发现

复用现有 Edge 节点心跳机制：
- Center 节点也上报自己的 endpoint
- 节点间通过数据库发现彼此

---

## 四、数据同步与迁移

### 4.1 同步机制

**复用 Solid Notification/Webhook 机制实现节点间同步：**

```
┌─────────────────────────────────────────────────────────┐
│                    迁移流程                              │
│                                                          │
│  1. 建立实时同步（先）                                   │
│     源节点 ──Webhook──→ 目标节点                         │
│     新写入的数据实时同步，保证不丢数据                   │
│                                                          │
│  2. 同步历史数据（后）                                   │
│     后台逐个文件搬运存量数据                             │
│     用 Solid 原生 API：GET 源 → PUT 目标                 │
│                                                          │
│  3. 切换                                                 │
│     历史同步完成 → 更新 node_id → 停止源节点订阅         │
└─────────────────────────────────────────────────────────┘
```

### 4.2 实现细节

```typescript
async function migratePod(podId: string, sourceNode: string, targetNode: string) {
  // 1. 标记迁移中
  await db.query(`
    UPDATE identity_pod 
    SET migration_status = 'syncing', migration_target_node = $1 
    WHERE pod_id = $2
  `, [targetNode, podId]);
  
  // 2. 目标节点订阅源节点变更（实时同步新数据）
  await targetNode.subscribe(sourceNode, `/pods/${podId}/**`, async (change) => {
    // 新写入实时同步
    await targetNode.solidClient.put(change.path, change.data);
  });
  
  // 3. 后台同步历史数据
  const files = await sourceNode.listPodFiles(podId);  // 从 Quadstore 查
  for (let i = 0; i < files.length; i++) {
    const data = await sourceNode.solidClient.get(files[i]);
    await targetNode.solidClient.put(files[i], data);
    
    // 更新进度
    const progress = Math.floor((i + 1) / files.length * 100);
    await db.query('UPDATE identity_pod SET migration_progress = $1 WHERE pod_id = $2', [progress, podId]);
    
    // 发通知给客户端
    await notify(podId, { type: 'migration:progress', progress });
  }
  
  // 4. 切换
  await db.query(`
    UPDATE identity_pod 
    SET node_id = $1, migration_status = 'done', migration_target_node = NULL 
    WHERE pod_id = $2
  `, [targetNode, podId]);
  
  // 5. 取消订阅
  await targetNode.unsubscribe(sourceNode, `/pods/${podId}/**`);
  
  await notify(podId, { type: 'migration:done' });
}
```

### 4.3 为什么 CSS 没有这个功能

CSS 定位是单实例部署：
- 一个 Pod 对应一个服务器
- Solid 协议的 Notification/Webhook 用于通知客户端，不是节点间同步
- 联邦设计假设不同 Pod 在不同服务商，不需要迁移

xpod 场景不同：
- 多 Center 节点组成集群
- Pod 可在节点间迁移
- 需要数据同步能力

---

## 五、配置汇总

### 5.1 新增配置（cli.json，hidden）

```json
// 本地缓存
{
  "@type": "YargsParameter",
  "name": "cachePath",
  "options": { "type": "string", "hidden": true }
},
{
  "@type": "YargsParameter",
  "name": "cacheMaxSize",
  "options": { "type": "string", "hidden": true }
},
// 多节点部署
{
  "@type": "YargsParameter",
  "name": "internalIp",
  "options": { "type": "string", "hidden": true }
},
{
  "@type": "YargsParameter",
  "name": "internalPort",
  "options": { "type": "number", "hidden": true }
},
{
  "@type": "YargsParameter",
  "name": "podRoutingEnabled",
  "options": { "type": "boolean", "hidden": true }
},
{
  "@type": "YargsParameter",
  "name": "nodeIdPath",
  "options": { "type": "string", "hidden": true }
}
```

对应环境变量：
- `CSS_CACHE_PATH` - 本地缓存目录，默认 `/data/cache`
- `CSS_CACHE_MAX_SIZE` - 缓存大小上限，默认 `50GB`
- `CSS_POD_ROUTING_ENABLED` - 是否启用 Pod 路由（默认 true）

自动检测（无需配置）：
- 内网 IP - 从网卡自动检测（K8s 环境使用 `POD_IP`）
- 内网端口 - 使用 CSS 的 `--port` 参数
- nodeId - 自动生成并持久化到 `{rootFilePath}/.node-id`

### 5.2 现有配置（不变）

```bash
# 节点
CSS_NODE_ID
CSS_NODE_TOKEN
CSS_NODE_PUBLIC_ADDRESS

# 存储
CSS_MINIO_ENDPOINT
CSS_MINIO_BUCKET_NAME
CSS_MINIO_ACCESS_KEY
CSS_MINIO_SECRET_KEY

# 数据库
CSS_DATABASE_URL
```

---

## 六、实现步骤

### Phase 1：基础（已完成）

- [x] `TieredMinioDataAccessor` 实现
  - 继承/包装 `MinioDataAccessor`
  - 加 LRU 缓存逻辑
  - 文件：`src/storage/accessors/TieredMinioDataAccessor.ts`
- [x] `identity_pod` 表加 `node_id` 字段
  - 扩展 `PodLookupRepository` 支持 nodeId、migrationStatus
  - 文件：`src/identity/drizzle/PodLookupRepository.ts`
- [x] Pod 路由中间件
  - 文件：`src/http/PodRoutingHttpHandler.ts`
- [x] cli.json 新增缓存配置
  - `cachePath`, `cacheMaxSize`

### Phase 2：多节点（进行中）

- [x] Center 节点注册（复用 Edge 机制）
  - 数据库 schema 扩展：`nodeType`, `internalIp`, `internalPort`
  - 文件：`schema.pg.ts`, `schema.sqlite.ts`, `db.ts`
- [x] `EdgeNodeRepository` 扩展
  - 新增方法：`registerCenterNode`, `updateCenterNodeHeartbeat`, `listCenterNodes`, `getCenterNode`
- [x] `CenterNodeRegistrationService`
  - 节点启动时自动注册
  - 自动检测内网 IP 和端口
  - 周期性心跳
  - 文件：`src/identity/CenterNodeRegistrationService.ts`
- [x] `PodRoutingHttpHandler` 支持内网端点
  - 优先使用 internalIp:internalPort 进行节点间通信
- [x] Components.js 集成
  - `CenterNodeRegistrationService` 加入初始化序列
  - `PodRoutingHttpHandler` 加入 HTTP pipeline

### Phase 3：迁移（已完成）

- [x] `PodLookupRepository` 扩展
  - 迁移状态字段：`migrationStatus`, `migrationTargetNode`, `migrationProgress`
  - 新增方法：`listAllPods`, `getMigrationStatus`, `setMigrationStatus`
- [x] `PodMigrationHttpHandler` - 迁移 API
  - `GET /.cluster/pods` - 列出所有 Pod
  - `GET /.cluster/pods/{podId}` - 获取 Pod 信息
  - `POST /.cluster/pods/{podId}/migrate` - 发起迁移
  - `GET /.cluster/pods/{podId}/migration` - 获取迁移状态
  - `DELETE /.cluster/pods/{podId}/migration` - 取消迁移
  - 文件：`src/http/cluster/PodMigrationHttpHandler.ts`
- [x] `PodMigrationService` - 迁移服务
  - 异步执行迁移流程
  - 共享存储检测（跳过数据复制）
  - 容器遍历 + HTTP GET/PUT 复制资源
  - 进度跟踪和取消支持
  - 文件：`src/service/PodMigrationService.ts`
- [x] 节点间数据同步
  - 共享存储模式：直接切换 nodeId（无需复制）
  - 非共享模式：遍历 LDP 容器，逐个资源 GET→PUT
- [ ] 实时同步（Webhook）- 可选优化，减少迁移窗口期数据丢失风险

---

## 七、API 路径规范

```
# CSS 原有（不动）
/.account/             # 账户管理
/.internal/            # CSS 内部数据
/idp/                  # 认证
/.well-known/          # 标准发现

# xpod 对外（需要稳定）
/api/v1/signal         # Edge 节点信令

# xpod 集群管理
/.cluster/
├── pods/              # Pod 管理
│   ├── {podId}/migrate
│   └── {podId}/migration
└── nodes/             # 节点管理（待实现）

# Pod 级 sidecar
/{pod}/-/sparql
/{pod}/-/terminal
```

---

## 八、待定

1. **多地域数据库**：初期共享 PostgreSQL，后续 PolarDB GDN？
2. **DNS 就近解析**：云商智能 DNS + L7 路由？
3. **沙盒**：单独文档设计

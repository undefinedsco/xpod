# xpod 架构设计

## 概述

xpod 是基于 Community Solid Server (CSS) 的扩展，支持：
- **多 Center 节点集群部署**（共享数据库）
- **Pod 跨节点路由**（请求自动转发到 Pod 所在节点）
- **Pod 跨区域迁移**（即时切换 + 跨区域 fallback 读取）
- **Edge 节点**（边缘设备接入）

---

## 一、架构总览

```
                           ┌─────────────────────────────────────────────┐
                           │              共享存储层                      │
                           │  ┌─────────────┐    ┌─────────────┐        │
                           │  │ PostgreSQL  │    │  COS/Minio  │        │
                           │  │ (Quadstore) │    │  (二进制)   │        │
                           │  └──────┬──────┘    └──────┬──────┘        │
                           └─────────┼──────────────────┼───────────────┘
                                     │                  │
         ┌───────────────────────────┼──────────────────┼───────────────────────────┐
         │                           │                  │                           │
┌────────▼────────┐         ┌────────▼────────┐         │         ┌────────────────┐
│  Center Node 1  │         │  Center Node 2  │         │         │  Edge Node     │
│  (北京)         │◄───────►│  (广州)         │         │         │  (用户设备)    │
│                 │  路由    │                 │         │         │                │
│  - Pod: alice   │         │  - Pod: bob     │◄────────┘         │  - 本地数据    │
│  - Pod: carol   │         │  - Pod: david   │                   │  - 隧道连接    │
└─────────────────┘         └─────────────────┘                   └────────────────┘
```

---

## 二、Center 集群

### 2.1 核心组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `MinioDataAccessor` | `src/storage/accessors/MinioDataAccessor.ts` | COS/R2 存储 + presigned URL 302 直出 |
| `PodRoutingHttpHandler` | `src/http/PodRoutingHttpHandler.ts` | Pod 路由：查询 Pod 位置，代理到目标节点 |
| `CenterNodeRegistrationService` | `src/identity/CenterNodeRegistrationService.ts` | 节点注册：自动发现内网 IP，心跳上报 |
| `PodMigrationService` | `src/service/PodMigrationService.ts` | Pod 迁移：即时切换 node_id |
| `PodMigrationHttpHandler` | `src/http/cluster/PodMigrationHttpHandler.ts` | 迁移 API |

### 2.2 存储架构

```
读取顺序：
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  本地缓存    │ ──► │  本地 Bucket │ ──► │ Fallback     │
│  (最快)      │     │  (当前区域)  │     │ Buckets      │
└──────────────┘     └──────────────┘     │ (其他区域)   │
                                          └──────┬───────┘
                                                 │
                                                 ▼
                                          懒复制到本地
```

**配置示例：**
```typescript
{
  region: 'bj',
  bucketName: 'xpod-bj',
  regionBuckets: {
    'bj': 'xpod-bj',
    'gz': 'xpod-gz',
    'sh': 'xpod-sh',
  }
}
```

### 2.3 Pod 路由流程

```
1. 请求到达 Center Node
2. 提取 Pod ID (从 hostname 或 path)
3. 查询 Pod 的 node_id
4. 如果在本节点 → 直接处理
5. 如果在其他节点 → 代理到目标节点内网地址
```

### 2.4 Pod 迁移

**迁移是即时的：**
1. 调用 `POST /.cluster/pods/{podId}/migrate`
2. 更新 `node_id` → 路由立即生效
3. 后续请求自动路由到新节点
4. 二进制文件通过跨区域 fallback 读取，按需懒复制

**为什么不需要数据同步？**
- 元数据在共享 PostgreSQL（Quadstore），所有节点都能访问
- 二进制文件通过 fallback 读取，首次访问时懒复制到本地

---

## 三、Edge 节点

Edge 节点运行在用户设备上，通过隧道连接到 Center。

### 3.1 核心组件

| 组件 | 说明 |
|------|------|
| `EdgeNodeAgent` | Edge 节点主控 |
| `FrpTunnelManager` | FRP 隧道管理 |
| `EdgeNodeDnsCoordinator` | DNS 记录管理 |
| `Dns01CertificateProvisioner` | 证书申请（DNS-01） |

### 3.2 连接流程

```
1. Edge 节点启动，向 Center 注册
2. Center 分配隧道端口
3. Edge 建立 FRP 隧道
4. Center 更新 DNS 记录
5. Edge 申请 HTTPS 证书
6. 外部请求通过隧道到达 Edge
```

---

## 四、API 路径规范

```
# CSS 原有
/.account/             # 账户管理
/.internal/            # CSS 内部数据
/idp/                  # 认证
/.well-known/          # 标准发现

# xpod 集群管理
/.cluster/
├── pods/              # Pod 管理
│   ├── GET            # 列出所有 Pod
│   ├── {podId}/       # 获取 Pod 信息
│   └── {podId}/migrate  # 迁移 Pod
└── nodes/             # 节点管理（待实现）

# xpod 对外
/api/v1/signal         # Edge 节点信令

# Pod 级功能
/{pod}/-/sparql        # SPARQL 端点
/{pod}/-/terminal      # Web Terminal
```

---

## 五、数据模型

### 5.1 identity_pod 表

```sql
CREATE TABLE identity_pod (
  pod_id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  account_id TEXT,
  node_id TEXT,                    -- Pod 所在节点
  migration_status TEXT,           -- null | 'syncing' | 'done'
  migration_target_node TEXT,
  migration_progress INT
);
```

### 5.2 edge_node 表

```sql
CREATE TABLE edge_node (
  node_id TEXT PRIMARY KEY,
  node_type TEXT DEFAULT 'edge',   -- 'edge' | 'center'
  internal_ip TEXT,                -- 内网 IP（Center 节点）
  internal_port INT,               -- 内网端口（Center 节点）
  public_address TEXT,
  status TEXT,
  last_heartbeat TIMESTAMP
);
```

---

## 六、配置

### 6.1 环境变量

```bash
# 节点标识
CSS_NODE_ID=auto                    # 自动生成，持久化到 .node-id

# 存储
CSS_MINIO_ENDPOINT=cos.ap-beijing.myqcloud.com
CSS_MINIO_BUCKET_NAME=xpod-bj
CSS_MINIO_ACCESS_KEY=xxx
CSS_MINIO_SECRET_KEY=xxx

# 缓存
CSS_CACHE_PATH=/data/cache
CSS_CACHE_MAX_SIZE=50GB

# 跨区域（可选）
CSS_MINIO_REGION=bj
CSS_MINIO_REGION_BUCKETS=bj:xpod-bj,gz:xpod-gz,sh:xpod-sh

# 数据库
CSS_DATABASE_URL=postgres://...

# 路由
CSS_POD_ROUTING_ENABLED=true
```

### 6.2 启动命令

```bash
# Center 节点
yarn cluster:center

# Edge 节点
yarn cluster:edge
```

---

## 七、测试

```bash
# 单元测试
yarn test

# 集成测试（需要数据库）
yarn test:integration

# 集群测试（多节点）
yarn test:cluster
```

---

## 八、待定 / 未来规划

1. **多地域数据库** - PolarDB GDN 或其他跨地域方案
2. **DNS 就近解析** - 智能 DNS + L7 路由
3. **节点管理 API** - `/.cluster/nodes/` 端点
4. **自动迁移建议** - 根据访问模式推荐迁移

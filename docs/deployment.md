# 部署架构

> 更新时间：2026-03-28

## 当前生产基线

当前部署策略分成两层：

1. **工作负载统一跑在 Sealos**
2. **外部状态服务按环境拆分**

境内和海外各一套独立环境，数据完全隔离。

| | `.cn` | `.co` |
|--|------------|--------------|
| 计算 | Sealos | Sealos |
| PostgreSQL | 境内托管 PG / Sealos 自管 PG | Supabase |
| Redis | 境内托管 Redis / Sealos 自管 Redis | Upstash |
| 文件存储 | 腾讯云 COS（S3 兼容） | Cloudflare R2（S3 兼容，零出站费） |
| CDN / DNS | 腾讯云 CDN + DNSPod | Cloudflare |
| 域名 | `undefineds.cn` | `undefineds.co` |

当前主线生产优先发 `.co`，即 `Sealos + Supabase + Upstash + R2`；`.cn` 复用同一套部署骨架，但替换为境内等价外部依赖。

## 架构图

### 境内

```
用户 → 腾讯云 CDN ──→ 腾讯云 COS（文件直出，预签名 URL）
  │                      ↑ 内网回源免费
  └→ Sealos 广州 ────────┘
       ├── xpod（应用）
       ├── PostgreSQL
       └── Redis
```

### 海外（`.co`）

```
用户 → Cloudflare CDN ──→ Cloudflare R2（文件直出，预签名 URL，零出站费）
  │
  └→ Sealos 新加坡
       └── xpod（应用）
             ├── Supabase PostgreSQL
             └── Upstash Redis
```

## 文件下载方案

xpod 对非 RDF 二进制资源返回 302 重定向到对象存储预签名 URL，文件流量不过应用层。

```
客户端 → GET /pod/file.jpg（带 Solid auth）
xpod   → 验证身份，生成预签名 URL
xpod   → 302 Location: https://object-storage.example/file.jpg?sign=xxx
客户端 → 跟随重定向，直连对象存储下载
```

已验证 Inrupt SDK `getFile()` 完全兼容 302 重定向（见 `scripts/test-redirect-fetch.ts`）。

## 成本原则

成本不再在主文档固化具体数值，避免随着 Sealos、Supabase、Upstash、R2 套餐调整而失真。当前只保留原则：

- `.co` 侧优先把数据库、缓存、对象存储外置，降低集群内有状态组件运维成本。
- 文件下载走对象存储直出，避免把大流量压在 Sealos 出口。
- `.cn` 侧按合规和网络条件替换为境内等价托管服务，尽量保持应用层配置不变。

## 扩容路径

```
当前：Sealos 承载应用层，外部服务托管化
  ↓ 规模扩大后再迁移计算层
未来：云厂商 K8s + 托管 PG/Redis + COS/R2
       境内 → TKE / ACK + 托管 PG/Redis + COS
       海外 → AWS / GKE / DO + 托管 PG/Redis + R2
```

PG 迁移方式：逻辑复制（Logical Replication），不停机。
Redis 迁移方式：RDB 导出导入。
对象存储：MinIO client 兼容 S3，换 endpoint 即可。

## CI/CD

| Workflow | 触发 | 作用 |
|----------|------|------|
| `ci.yml` | PR / push to main | 类型检查 + 单元测试 |
| `release.yml` | push tag `v*` / 手动 | 构建镜像推送到 GHCR |
| `deploy.yml` | 手动 | 部署到 Sealos（`co` / `cn` / `all`） |

### GitHub Environments

GitHub Actions 统一使用 environment 级别 secrets；推荐直接创建两个 environment：

- `co`
- `cn`

每个 environment 至少包含：

| Secret | 说明 |
|--------|------|
| `KUBE_CONFIG_DATA` | 当前环境 Sealos kubeconfig（base64） |
| `SEALOS_NAMESPACE` | 当前环境 namespace |
| `APP_ENV_FILE` | 完整运行时 env 文件内容 |

`Deploy` workflow 会先确保 namespace 存在，再下发 `xpod-cloud-secret`，最后应用 `configmap + service + deployment`。

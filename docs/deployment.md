# 部署架构

> 更新时间：2026-02-17

## 总体方案

境内和海外各一套独立集群，数据完全隔离（合规要求）。

| | 境内（广州） | 海外（新加坡） |
|--|------------|--------------|
| 计算 | Sealos 容器 | Sealos 容器 |
| 数据库 | PostgreSQL（Sealos 容器） | PostgreSQL（Sealos 容器） |
| 缓存 | Redis（Sealos 容器） | Redis（Sealos 容器） |
| 文件存储 | 腾讯云 COS（S3 兼容） | Cloudflare R2（S3 兼容，零出站费） |
| CDN | 腾讯云 CDN | Cloudflare CDN（免费） |
| DNS | DNSPod（腾讯云） | Cloudflare |
| 域名 | `undefineds.cn` + `xpod.cc` | `undefineds.co` + `xpod.cc` |

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

### 海外

```
用户 → Cloudflare CDN ──→ Cloudflare R2（文件直出，预签名 URL，零出站费）
  │
  └→ Sealos 新加坡
       ├── xpod（应用）
       ├── PostgreSQL
       └── Redis
```

## 文件下载方案

xpod 对非 RDF 二进制资源返回 302 重定向到对象存储预签名 URL，文件流量不过应用层。

```
客户端 → GET /pod/file.jpg（带 Solid auth）
xpod   → 验证身份，生成预签名 URL
xpod   → 302 Location: https://cos.xxx/file.jpg?sign=xxx
客户端 → 跟随重定向，直连对象存储下载
```

已验证 Inrupt SDK `getFile()` 完全兼容 302 重定向（见 `scripts/test-redirect-fetch.ts`）。

## 成本估算

假设月活 100 用户，月文件下载 500GB，API 流量 50GB。

### 境内

| 费项 | 月费 |
|------|------|
| Sealos 容器（xpod 1C2G + PG 1C1G + Redis 0.5C0.5G） | ~100 元 |
| Sealos PVC 存储 | ~6 元 |
| Sealos 出站带宽（API 流量 50GB） | ~40 元 |
| COS 存储 100GB | ~10 元 |
| CDN 下行 500GB | ~105 元 |
| **合计** | **~260 元/月** |

### 海外

| 费项 | 月费 |
|------|------|
| Sealos 容器（同上） | ~$15 |
| Sealos 出站带宽 | ~$5-10 |
| R2 存储 100GB | $1.5 |
| R2 出站 | $0（免费） |
| Cloudflare CDN | $0（免费） |
| **合计** | **~$22-27/月** |

## 扩容路径

```
当前：Sealos 全套（xpod + PG + Redis 容器）
  ↓ PG/Redis 需要高可用 / 自动备份时（应用一并迁移，保持内网互通）
未来：云厂商 K8s + 托管 PG/Redis + COS/R2
       境内 → 腾讯云 TKE + TencentDB + 云 Redis + COS
       海外 → DigitalOcean/AWS + 托管 PG/Redis + R2
```

PG 迁移方式：逻辑复制（Logical Replication），不停机。
Redis 迁移方式：RDB 导出导入。
对象存储：MinIO client 兼容 S3，换 endpoint 即可。

## CI/CD

| Workflow | 触发 | 作用 |
|----------|------|------|
| `ci.yml` | PR / push to main | 类型检查 + 单元测试 |
| `release.yml` | push tag `v*` / 手动 | 构建镜像推送到 GHCR |
| `deploy.yml` | release 完成 / 手动 | 部署到 Sealos（可选 cn / sg / all） |

### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `GITHUB_TOKEN` | 自动提供，需开启 Actions 读写权限 |
| `KUBE_CONFIG_CN` | 广州 Sealos kubeconfig（base64） |
| `KUBE_CONFIG_SG` | 新加坡 Sealos kubeconfig（base64） |

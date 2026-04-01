# Xpod 云端部署 Checklist

> 适用场景：xpod 运行在 Sealos，海外环境使用 Cloudflare R2、Supabase PostgreSQL、Upstash Redis。
>
> 当前示例镜像：`ghcr.io/undefinedsco/xpod:0.2.1`
>
> 更新时间：2026-03-28

## 0. GitHub Environment

- [ ] 为 `co` / `cn` 分别创建 GitHub `environment`
- [ ] 每个环境都配置 `KUBE_CONFIG_DATA`
- [ ] 每个环境都配置 `SEALOS_NAMESPACE`
- [ ] 每个环境都配置 `APP_ENV_FILE`

## 1. 发布物确认

- [ ] 确认镜像标签已存在：`ghcr.io/undefinedsco/xpod:0.2.1`
- [ ] 如走 GitHub Actions，确认 `Release` workflow 已成功推送 GHCR 镜像
- [ ] 如首次部署，优先固定版本号 `0.2.1` 或其他不可变 tag，不要直接用 `latest`

## 2. 外部依赖准备

### Supabase PostgreSQL

- [ ] 创建 Supabase 项目，区域尽量靠近 Sealos 新加坡节点
- [ ] 准备 PostgreSQL 连接串，推荐先用 direct connection，并带上 `sslmode=require`
- [ ] 确认数据库账号具备建表权限
- [ ] 启用 `vector` 扩展，避免 `PostgresVectorStore` 初始化失败
- [ ] 首次部署可先复用同一个库给 `CSS_SPARQL_ENDPOINT` 和 `CSS_IDENTITY_DB_URL`

示例连接串：

```bash
postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
```

### Upstash Redis

- [ ] 创建 Redis 实例
- [ ] 复制 TLS 连接串，必须使用 `rediss://`
- [ ] 确认 Sealos 出网可访问 Upstash 域名和 6379/TLS

示例连接串：

```bash
rediss://default:<password>@<database>.upstash.io:6379
```

### Cloudflare R2

- [ ] 创建私有 Bucket，例如 `xpod`
- [ ] 创建 S3 API Token，至少具备目标 Bucket 的读写权限
- [ ] 记录 S3 Endpoint、Access Key、Secret Key
- [ ] 确认 Bucket 名与环境变量 `CSS_MINIO_BUCKET_NAME` 一致

示例 Endpoint：

```bash
https://<account-id>.r2.cloudflarestorage.com
```

### Cloudflare DNS

- [ ] 准备管理目标域名的 API Token
- [ ] 记录 Cloudflare Account ID
- [ ] 若启用节点子域名分配，提前规划泛域名记录

## 3. 域名与入口规划

- [ ] 确定 xpod 主入口域名，例如 `https://id.example.com`
- [ ] `CSS_BASE_URL` 使用最终对外 HTTPS 地址
- [ ] 如有额外入口域名（例如 `pods.example.com`、`api.example.com`），写入 `CSS_ALLOWED_HOSTS`
- [ ] 如裸域给 `homepage`，不要把裸域填进 `CSS_BASE_URL`
- [ ] 如启用节点/Pod 子域名分配，设置独立的 `CSS_BASE_STORAGE_DOMAIN=storage.example.com`
- [ ] 在 Cloudflare 将 xpod 入口域名指向 Sealos 公网入口；存储根域按节点/DDNS 方案单独规划

## 4. Sealos 应用配置

推荐使用 Sealos App Launchpad 单容器部署，xpod 自带 gateway，会在容器内再拉起 CSS 和 API。

- [ ] 应用名称：`xpod`
- [ ] 镜像：`ghcr.io/undefinedsco/xpod:0.2.1`
- [ ] 启动命令：`node`
- [ ] 启动参数：`dist/main.js -m cloud -p 3000 --host 0.0.0.0`
- [ ] 容器端口：`3000`
- [ ] 就绪探针：`GET /service/status`，端口 `3000`
- [ ] 存活探针：`GET /service/status`，端口 `3000`
- [ ] 初始资源建议：`0.5 Core / 1 GiB`
- [ ] 若日志需要保留，额外挂载持久卷；否则 `logs/` 和 `data/` 可保持临时盘

## 5. 必填环境变量

以下变量建议直接按 key/value 填入 Sealos：

```bash
NODE_ENV=production
XPOD_EDITION=cloud
XPOD_EDGE_NODES_ENABLED=true
CSS_BASE_URL=https://id.example.com
CSS_ALLOWED_HOSTS=id.example.com,pods.example.com,api.example.com
CSS_BASE_STORAGE_DOMAIN=storage.example.com
CSS_LOGGING_LEVEL=info

CSS_SPARQL_ENDPOINT=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
CSS_IDENTITY_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require

CSS_REDIS_CLIENT=rediss://default:<password>@<database>.upstash.io:6379

CSS_MINIO_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CSS_MINIO_ACCESS_KEY=<r2-access-key>
CSS_MINIO_SECRET_KEY=<r2-secret-key>
CSS_MINIO_BUCKET_NAME=xpod

CLOUDFLARE_API_TOKEN=<cloudflare-dns-token>
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
```

可选变量：

- `CSS_OIDC_ISSUER`：如需显式指定 issuer；不填默认与 `CSS_BASE_URL` 一致
- `CSS_EMAIL_CONFIG_*`：开启邮件注册、找回密码时再填写
- `CSS_REDIS_USERNAME` / `CSS_REDIS_PASSWORD`：仅在不把认证信息写入 `CSS_REDIS_CLIENT` 时使用

## 6. 首次启动检查

- [ ] Sealos 日志中没有 `ECONNREFUSED`、`password authentication failed`、`self-signed certificate` 等错误
- [ ] `GET /service/status` 返回 `200`
- [ ] 返回体中至少能看到 `css`、`api` 两个服务状态为 `running`
- [ ] 未出现 `CREATE EXTENSION IF NOT EXISTS vector` 权限报错
- [ ] 未出现 `Invalid Redis client string` 或 `bucket does not exist`

验证命令：

```bash
curl -i https://id.example.com/service/status
```

## 7. 功能回归检查

- [ ] 打开 `https://id.example.com/.account/register`，确认注册页可访问
- [ ] 注册测试账号并完成登录
- [ ] 创建测试 Pod
- [ ] 上传一个非 RDF 文件，确认对象写入 R2 正常
- [ ] 下载同一文件，确认下载链路正常
- [ ] 如启用子域名分配，确认对应域名解析和访问正常

## 8. 回滚预案

- [ ] 保留上一版镜像标签，便于在 Sealos 一键回滚
- [ ] 变更环境变量前先导出当前配置
- [ ] Supabase 在升级前做一次数据库备份/快照
- [ ] R2 Bucket 不做破坏性清理
- [ ] 若新版本启动异常，先回滚镜像，再检查数据库扩展和外部连接串

## 9. 仓库内对应文件

- `deploy/sealos/cloud/env.co.example`
- `deploy/sealos/cloud/secret.co.example.yaml`
- `deploy/sealos/cloud/deployment.yaml`
- `deploy/sealos/cloud/README.md`

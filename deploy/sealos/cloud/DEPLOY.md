# Xpod 云端部署指南（Sealos / R2 / Supabase / Upstash）

> 当前示例镜像：`ghcr.io/undefinedsco/xpod:0.2.1`
>
> 适用环境：Sealos + Cloudflare R2 + Supabase PostgreSQL + Upstash Redis
>
> 更新时间：2026-03-28

完整上线核对项见 `deploy/sealos/cloud/CHECKLIST.md`。

## 架构

```
用户
  ↓
Cloudflare DNS / HTTPS
  ↓
Sealos App / Ingress
  ↓
xpod (Gateway + CSS + API)
  ├─ Supabase PostgreSQL   (RDF / identity / vector)
  ├─ Upstash Redis         (分布式锁 / 内部 KV)
  └─ Cloudflare R2         (非 RDF 文件对象存储)
```

## 前置准备

### 1. 发布物

- 镜像：`ghcr.io/undefinedsco/xpod:0.2.1`
- Node 运行时要求已内置在镜像中，无需额外安装

### 2. 外部服务

#### Supabase

- 创建 PostgreSQL 实例
- 准备连接串，推荐 direct connection + `sslmode=require`
- 确认数据库用户具备建表权限
- 如启用向量检索，先启用 `pgvector`

示例：

```bash
postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
```

#### Upstash

- 创建 Redis 实例
- 使用 TLS 连接串
- 连接串必须以 `rediss://` 开头

示例：

```bash
rediss://default:<password>@<database>.upstash.io:6379
```

#### Cloudflare R2

- 创建 Bucket，例如 `xpod`
- 创建 R2 S3 API Token
- 记录 `endpoint / access key / secret key`

示例 Endpoint：

```bash
https://<account-id>.r2.cloudflarestorage.com
```

#### Cloudflare DNS

- 准备管理域名的 API Token
- 记录 Account ID
- 如启用节点子域名分配，提前准备主域名和泛域名解析

## 域名规划

以当前生产规划为例：

```text
undefineds.co             -> homepage
id.undefineds.co          -> xpod
pods.undefineds.co        -> xpod
api.undefineds.co         -> xpod
billing.undefineds.co     -> billing
discovery.undefineds.co   -> discovery
*.undefineds.site         -> local SP / edge 节点子域名根域
```

推荐环境变量：

```bash
CSS_BASE_URL=https://id.undefineds.co
CSS_OIDC_ISSUER=https://id.undefineds.co
CSS_ALLOWED_HOSTS=id.undefineds.co,pods.undefineds.co,api.undefineds.co
CSS_BASE_STORAGE_DOMAIN=undefineds.site
```

其中：

- `CSS_BASE_URL` 填系统主入口 `id.*`
- `pods.*` 和 `api.*` 通过 `CSS_ALLOWED_HOSTS` 放行
- `CSS_BASE_STORAGE_DOMAIN` 填 Pod / edge 节点的存储根域
- 如果 `CSS_OIDC_ISSUER` 不单独配置，默认可与 `CSS_BASE_URL` 保持一致

## 方案一：Sealos App Launchpad

### 基本配置

```text
应用名称: xpod
镜像:     ghcr.io/undefinedsco/xpod:0.2.1
CPU:      0.5 Core
内存:     1 GiB
副本数:   1
```

### 启动命令

```text
Command: node
Args:    dist/main.js -m cloud -p 3000 --host 0.0.0.0
```

### 网络与探针

```text
容器端口: 3000
存活探针: GET /service/status
就绪探针: GET /service/status
```

### 环境变量

可直接参考 `deploy/sealos/cloud/env.co.example`，最少需要：

```bash
NODE_ENV=production
XPOD_EDITION=cloud
XPOD_EDGE_NODES_ENABLED=true
CSS_BASE_URL=https://id.undefineds.co
CSS_OIDC_ISSUER=https://id.undefineds.co
CSS_ALLOWED_HOSTS=id.undefineds.co,pods.undefineds.co,api.undefineds.co
CSS_BASE_STORAGE_DOMAIN=undefineds.site
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

### 部署后检查

```bash
curl -i https://id.undefineds.co/service/status
```

返回应为服务状态数组，且至少包含：

- `css: running`
- `api: running`

## 方案二：kubectl / kustomize

### 1. 准备环境变量文件

```bash
cp example.env.cloud .env.cloud
```

填入真实值后创建 Secret：

```bash
kubectl apply -f deploy/sealos/cloud/namespace.yaml

kubectl create secret generic xpod-cloud-secret \
  -n xpod-cloud \
  --from-env-file=.env.cloud \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 2. 可选：使用 ConfigMap 管理非敏感变量

当前目录提供了：

- 通用示例：`deploy/sealos/cloud/configmap.yaml`
- 海外示例：`deploy/sealos/cloud/configmap.co.yaml`

如你使用 `kustomize`，Deployment 会同时读取：

- `xpod-cloud-config`
- `xpod-cloud-secret`

### 3. 发布工作负载

```bash
kubectl apply -k deploy/sealos/cloud
```

如需公网入口，单独渲染并应用 `deploy/sealos/cloud/ingress.yaml`，不要直接把占位域名提交到生产：

```bash
kubectl apply -f deploy/sealos/cloud/ingress.yaml
```

### 4. 验证

```bash
kubectl -n xpod-cloud get pods,svc
kubectl -n xpod-cloud logs deploy/xpod-cloud -f
curl -i https://你的域名/service/status
```

## GitHub Actions 部署

生产推荐直接使用 `Deploy` workflow，并在 GitHub `environment`（`co` / `cn`）里分别配置：

- `KUBE_CONFIG_DATA`
- `SEALOS_NAMESPACE`
- `APP_ENV_FILE`

其中 `APP_ENV_FILE` 直接保存完整 env 文件内容；workflow 会自动：

- 确保 namespace 存在
- 创建或更新 `xpod-cloud-secret`
- 应用 `configmap + service + deployment`
- 等待 `deployment/xpod-cloud` rollout 完成

`image-tag` 必须显式填写不可变 tag，例如 `0.2.1`。

## 升级部署版本

如果之前跑的是旧版本：

```bash
kubectl set image deployment/xpod-cloud \
  xpod=ghcr.io/undefinedsco/xpod:0.2.1 \
  -n xpod-cloud

kubectl rollout status deployment/xpod-cloud -n xpod-cloud --timeout=300s
```

如果走 GitHub Actions：

- `Release` workflow 负责构建并推送 `ghcr.io/undefinedsco/xpod:0.2.1`
- `Deploy` workflow 负责执行升级 rollout

## 常见问题

### 1. Supabase 连接失败

- 检查连接串是否包含 `sslmode=require`
- 检查 Sealos 出网是否正常
- 检查数据库用户是否允许建表

### 2. 向量功能初始化失败

常见报错与 `CREATE EXTENSION IF NOT EXISTS vector` 有关。

处理方式：

- 在 Supabase 对应数据库开启 `pgvector`
- 确认数据库角色具备执行扩展初始化所需权限

### 3. Redis 连接失败

- 确认 `CSS_REDIS_CLIENT` 使用 `rediss://`
- 确认密码未包含未转义特殊字符

### 4. 文件上传成功但下载失败

- 检查 R2 Bucket 是否存在
- 检查 `CSS_MINIO_ENDPOINT` 是否为完整 `https://...`
- 检查 Access Key / Secret Key 是否匹配

### 5. 健康检查不通过

- 确认探针路径是 `/service/status`
- 确认容器端口是 `3000`
- 确认启动参数包含 `-p 3000`

## 相关文件

- `deploy/sealos/cloud/CHECKLIST.md`
- `deploy/sealos/cloud/README.md`
- `deploy/sealos/cloud/env.co.example`
- `deploy/sealos/cloud/configmap.yaml`
- `deploy/sealos/cloud/configmap.co.yaml`
- `deploy/sealos/cloud/secret.co.example.yaml`
- `deploy/sealos/cloud/deployment.yaml`
- `deploy/sealos/gateway/README.md`

# Sealos Cloud 部署（最小版）

完整上线清单见 `deploy/sealos/cloud/CHECKLIST.md`。

当前生产基线：

1. 计算跑在 Sealos
2. 对象存储用 Cloudflare R2
3. PostgreSQL 用 Supabase
4. Redis 用 Upstash

## 1) 打镜像并推送

```bash
# 在仓库根目录
IMAGE=ghcr.io/undefinedsco/xpod:0.2.1

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

## 2) 准备 `.env.cloud`

```bash
cp example.env.cloud .env.cloud
# 编辑 .env.cloud，填入生产真实值
```

也可以直接把完整内容放进 GitHub Environment Secret `APP_ENV_FILE`。

`.env.cloud` 里至少要有：

- `NODE_ENV=production`
- `XPOD_EDITION=cloud`
- `CSS_BASE_URL=https://id.你的域名`
- `CSS_OIDC_ISSUER=https://id.你的域名`（可选；不填时默认跟 `CSS_BASE_URL` 一致）
- `CSS_ALLOWED_HOSTS=id.你的域名,pods.你的域名,api.你的域名`
- `CSS_BASE_STORAGE_DOMAIN=你的存储根域`
- `CSS_SPARQL_ENDPOINT=...`
- `CSS_IDENTITY_DB_URL=...`
- `CSS_MINIO_ENDPOINT/CSS_MINIO_ACCESS_KEY/CSS_MINIO_SECRET_KEY/CSS_MINIO_BUCKET_NAME`
- `CSS_REDIS_CLIENT=rediss://...`
- `DEFAULT_API_BASE=http://ai-gateway.<namespace>.svc.cluster.local/v1`
- `DEFAULT_API_KEY=sk-...`
- `DEFAULT_TIMEOUT_MS=30000`（ai-gateway 短查询请求，例如 `/v1/models`）
- `DEFAULT_GENERATION_TIMEOUT_MS=120000`（ai-gateway 生成请求，例如 chat/responses/messages/stream）

如果裸域给 `homepage`，不要把 `CSS_BASE_URL` 指到裸域。
`CSS_BASE_URL` 填系统主入口 `id.*`；`pods.*` 和 `api.*` 通过 `CSS_ALLOWED_HOSTS` 放行。

其中：

- `DEFAULT_API_BASE` 是 `xpod -> ai-gateway` 服务调用入口
- `DEFAULT_API_KEY` 给 `xpod -> ai-gateway` 服务调用使用，必须是 ai-gateway / LiteLLM 里为 xpod 单独签发的 `sk-...` virtual key
- `DEFAULT_TIMEOUT_MS` 只控制短查询请求（如 `/v1/models`），默认 30s
- `DEFAULT_GENERATION_TIMEOUT_MS` 控制生成请求（chat/responses/messages/stream），默认 120s

## 3) 部署（Namespace + Secret + Workload）

推荐生产先发 `namespace + configmap + service + deployment`，`Ingress` 单独按真实域名和证书再发布。

```bash
kubectl create namespace xpod-cloud --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic xpod-cloud-secret \
  -n xpod-cloud \
  --from-env-file=.env.cloud \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f deploy/sealos/cloud/configmap.yaml
kubectl apply -f deploy/sealos/cloud/service.yaml
kubectl apply -f deploy/sealos/cloud/deployment.yaml
```

## 4) 验证

```bash
kubectl -n xpod-cloud get pods,svc
kubectl -n xpod-cloud logs deploy/xpod-cloud -f
kubectl -n xpod-cloud rollout status deployment/xpod-cloud --timeout=300s
curl -i https://你的域名/service/status
```

## GitHub Actions 部署

推荐生产直接走 GitHub Actions，并只通过 Environment Secrets 注入运行时配置。

### `xpod` 仓库建议 secrets

- `KUBE_CONFIG_DATA`
- `SEALOS_NAMESPACE`
- `APP_ENV_FILE`

以上运行时 secrets 建议放在 GitHub `environment` 里分别配置，例如 `co` / `cn`。

其中 `APP_ENV_FILE` 直接保存完整 env 文件内容，workflow 会在集群里生成 `xpod-cloud-secret`，不会在日志里回显具体值；`image-tag` 必须显式填写不可变 tag，例如 `0.2.1`。

## 说明

- `deploy/sealos/cloud/configmap.yaml` 只保留非敏感基础默认值，域名 / 数据库 / 对象存储 / Redis 统一从 Secret 注入。
- `kubectl apply -k deploy/sealos/cloud` 默认不再包含 `Ingress`，避免把占位域名误发布到生产。
- 如果你用 `.env.cloud` 全量生成 `xpod-cloud-secret`，同名环境变量会以 Secret 为准。
- 境内参考 `deploy/sealos/cloud/secret.cn.example.yaml`，海外参考 `deploy/sealos/cloud/secret.co.example.yaml` 和 `deploy/sealos/cloud/env.co.example`，不建议提交真实密钥。
- 部署架构和域名规划详见 `docs/deployment.md` 和 `docs/domains.md`。

# SealOS Cloud 部署（最小版）

完整上线清单见 `deploy/sealos/cloud/CHECKLIST-0.2.0.md`。

你说得对，最小可用就是两件事：

1. 打并推送镜像
2. 用 `.env.cloud` 作为环境变量注入

## 1) 打镜像并推送

```bash
# 在仓库根目录
IMAGE=ghcr.io/undefinedsco/xpod:0.2.0

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

## 2) 准备 `.env.cloud`

```bash
cp example.env.cloud .env.cloud
# 编辑 .env.cloud，填入生产真实值
```

`.env.cloud` 里至少要有：

- `NODE_ENV=production`
- `XPOD_EDITION=cloud`
- `CSS_BASE_URL=https://id.你的域名`
- `CSS_ALLOWED_HOSTS=id.你的域名,pods.你的域名,api.你的域名`
- `CSS_BASE_STORAGE_DOMAIN=你的存储根域`
- `CSS_SPARQL_ENDPOINT=...`
- `CSS_IDENTITY_DB_URL=...`
- `CSS_MINIO_ENDPOINT/CSS_MINIO_ACCESS_KEY/CSS_MINIO_SECRET_KEY/CSS_MINIO_BUCKET_NAME`
- `CSS_REDIS_CLIENT=rediss://...`

如果裸域给 `homepage`，不要把 `CSS_BASE_URL` 指到裸域。

## 3) 部署（Secret + Workload）

```bash
kubectl apply -f deploy/sealos/cloud/namespace.yaml

kubectl create secret generic xpod-cloud-secret \
  -n xpod-cloud \
  --from-env-file=.env.cloud \
  --dry-run=client -o yaml | kubectl apply -f -
```

把镜像和域名改成你的：

- `deploy/sealos/cloud/deployment.yaml` 中 `image`
- `deploy/sealos/cloud/ingress.yaml` 中 `host`/`tls.secretName`

然后发布：

```bash
kubectl apply -k deploy/sealos/cloud
```

## 4) 验证

```bash
kubectl -n xpod-cloud get pods,svc,ingress
kubectl -n xpod-cloud logs deploy/xpod-cloud -f
curl -i https://你的域名/service/status
```

## GitHub Actions 部署

推荐把生产部署切到 GitHub Actions，并只通过 repo secrets 注入运行时配置。

### `xpod` 仓库建议 secrets

- `GHCR_USERNAME`
- `GHCR_TOKEN`
- `KUBE_CONFIG_SG`
- `SEALOS_NAMESPACE_SG`
- `XPOD_ENV_FILE_SG`
- `KUBE_CONFIG_CN`
- `SEALOS_NAMESPACE_CN`
- `XPOD_ENV_FILE_CN`

其中 `XPOD_ENV_FILE_*` 直接保存完整 env 文件内容，workflow 会在集群里生成 `xpod-cloud-secret`，不会在日志里回显具体值。

## 说明

- `kubectl apply -k deploy/sealos/cloud` 会创建默认的 `xpod-cloud-config`。
- 如果你用 `.env.cloud` 全量生成 `xpod-cloud-secret`，同名环境变量会以 Secret 为准。
- 境内参考 `secret.cn.example.yaml`，海外使用 Supabase + Upstash + R2 的示例参考 `secret.sg.example.yaml`，不建议提交真实密钥。
- 部署架构和域名规划详见 `docs/deployment.md` 和 `docs/domains.md`。

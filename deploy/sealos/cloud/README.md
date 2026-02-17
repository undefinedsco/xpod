# SealOS Cloud 部署（最小版）

你说得对，最小可用就是两件事：

1. 打并推送镜像
2. 用 `.env.cloud` 作为环境变量注入

## 1) 打镜像并推送

```bash
# 在仓库根目录
IMAGE=registry.example.com/your-org/xpod:2026-02-08

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

## 2) 准备 `.env.cloud`

```bash
cp example.env.cloud .env.cloud
# 编辑 .env.cloud，填入生产真实值
```

`.env.cloud` 里至少要有：

- `XPOD_EDITION=cloud`
- `CSS_BASE_URL=https://你的域名`
- `CSS_SPARQL_ENDPOINT=...`
- `CSS_IDENTITY_DB_URL=...`
- `CSS_MINIO_ENDPOINT/CSS_MINIO_ACCESS_KEY/CSS_MINIO_SECRET_KEY/CSS_MINIO_BUCKET_NAME`
- `CSS_REDIS_CLIENT=...`

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
curl -i https://你的域名/_gateway/status
curl -i https://你的域名/api/ready
```

## 说明

- 现在清单默认只依赖一个 Secret：`xpod-cloud-secret`。
- 境内参考 `secret.cn.example.yaml`，海外参考 `secret.sg.example.yaml`，不建议提交真实密钥。
- 部署架构和域名规划详见 `docs/deployment.md` 和 `docs/domains.md`。

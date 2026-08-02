# Xpod RC Sealos overlay

This overlay renders one RC Xpod instance in the `xpod-rc` namespace.
It intentionally does not deploy physical PostgreSQL, Redis, object storage, or
Ingress resources.

Create the runtime Secret from an operator-owned env file:

```bash
kubectl create secret generic xpod-rc-secret \
  --namespace xpod-rc \
  --from-env-file="$APP_ENV_FILE"
```

`APP_ENV_FILE` must provide isolated values through supported Xpod/CSS keys:

- `CSS_SPARQL_ENDPOINT` and `CSS_IDENTITY_DB_URL` for the RC database or schema principal
- `CSS_REDIS_CLIENT` for the RC Redis database URL
- `CSS_MINIO_ENDPOINT`, `CSS_MINIO_ACCESS_KEY`, `CSS_MINIO_SECRET_KEY`, and `CSS_MINIO_BUCKET_NAME` for the RC object bucket
- `XPOD_INNGEST_EVENT_KEY` and `XPOD_INNGEST_SIGNING_KEY` for the RC Inngest instance
- Any deployment-specific AI, DNS, or email keys already supported by `config/cloud.json`

Do not use unsupported prefix variables such as `XPOD_REDIS_PREFIX` or
`XPOD_OBJECT_PREFIX`; this repository does not read them.

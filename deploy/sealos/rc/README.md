# Xpod RC Sealos overlay

This overlay renders one RC Xpod instance in the `xpod-rc` namespace.
It intentionally does not deploy physical PostgreSQL, Redis, object storage, or
Ingress resources.

Apply the namespace before creating the runtime Secret from an operator-owned
env file:

```bash
kubectl apply -f deploy/sealos/rc/namespace.yaml
kubectl create secret generic xpod-rc-secret \
  --namespace xpod-rc \
  --from-env-file="$APP_ENV_FILE"
```

Do not copy the production `APP_ENV_FILE`. The candidate workflow gate must
reject production domain, bucket, and database values before deployment.

`APP_ENV_FILE` may only use existing supported Xpod/CSS configuration keys.
It must provide isolated values for these categories:

- `CSS_SPARQL_ENDPOINT` and `CSS_IDENTITY_DB_URL` for the RC database or schema principal
- `CSS_REDIS_CLIENT` for the RC Redis database URL
- `CSS_MINIO_ENDPOINT`, `CSS_MINIO_ACCESS_KEY`, `CSS_MINIO_SECRET_KEY`, and `CSS_MINIO_BUCKET_NAME` for the RC object bucket
- `XPOD_INNGEST_EVENT_KEY` and `XPOD_INNGEST_SIGNING_KEY` for the RC Inngest instance
- Any deployment-specific AI, DNS, or email keys already supported by `config/cloud.json`

Do not use unsupported prefix variables such as `XPOD_REDIS_PREFIX` or
`XPOD_OBJECT_PREFIX`; this repository does not read them.

The overlay pins RC runtime invariants such as `CSS_BASE_URL`,
`CSS_ALLOWED_HOSTS`, `CSS_BASE_STORAGE_DOMAIN`, `XPOD_EDITION`, ports, and edge
node mode directly on the Xpod container so Secret values cannot override them.

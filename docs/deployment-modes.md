# Deployment Modes

## Profile Comparison

| Capability | `local` | `cloud` |
| --- | --- | --- |
| Data & Dependencies | SQLite + local disk; no Redis/MinIO dependency | PostgreSQL + MinIO + Redis, supports horizontal scaling |
| Quota Strategy | `NoopQuotaService`, no validation by default | `PerAccountQuotaStrategy`, configurable default/custom limits |
| Cloud-Edge Coordination | Disabled by default | Built-in `EdgeNodeSignal`, DNS-01, usage tracking |
| Tunnel Fallback | Disabled | Configurable `XPOD_FRP_*` |
| Certificate Automation | Manual config | ACME + DNS-01 auto-renewal |
| Typical Scenarios | Personal dev, testing, desktop client | Production deployment, multi-user hosting |

## Quick Start

```bash
# Local mode (SQLite, no external dependencies)
cp example.env .env.local
yarn local

# Cloud mode (PostgreSQL + MinIO + Redis)
cp example.env .env.cloud
yarn cloud
```

## Local Mode

Local mode is designed for single-user, self-hosted scenarios:

- **Storage**: SQLite database + local file system
- **No external dependencies**: Works offline, no Redis/MinIO required
- **Use cases**: Personal development, desktop client, testing

### HTTPS Options

1. **Self-Managed HTTPS**: Bring your own certificates and 443 listener
2. **Reverse Proxy**: Use nginx/caddy with auto-SSL in front of Xpod
3. **Development**: Run on HTTP locally, use `yarn dev`

## Cloud Mode

Cloud mode is designed for production multi-user deployments:

- **Storage**: PostgreSQL + MinIO (S3-compatible)
- **Caching**: Redis for sessions and coordination
- **Scalable**: Supports horizontal scaling behind load balancer

### Required Services

```bash
# PostgreSQL
CSS_DATABASE_URL=postgresql://user:pass@localhost:5432/xpod

# MinIO / S3
CSS_S3_ENDPOINT=http://localhost:9000
CSS_S3_ACCESS_KEY=...
CSS_S3_SECRET_KEY=...

# Redis
CSS_REDIS_URL=redis://localhost:6379
```

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `CSS_BASE_URL` | Public base URL | `http://localhost:3000` |
| `CSS_PORT` | HTTP port | `3000` |
| `CSS_DATABASE_URL` | PostgreSQL connection string | (SQLite if not set) |
| `CSS_S3_ENDPOINT` | S3/MinIO endpoint | (local disk if not set) |
| `CSS_REDIS_URL` | Redis connection string | (optional) |

See `example.env` for full list.

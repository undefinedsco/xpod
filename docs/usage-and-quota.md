# Usage Tracking and Quota Management

## Overview

Xpod provides built-in usage tracking and quota enforcement. For advanced management features (billing, alerts, reports), integrate with external services.

对当前 `hosted preview` 口径，免费账号额度优先由 `xpod` 自己提供，不依赖 `billing`：

- `XPOD_DEFAULT_*`：免费账号默认额度
- 本地管理员覆写：`/v1/quota/*`
- 外部 entitlement：可选；适合未来商业化或人工支持关系

最终优先级：

1. 本地自定义配额
2. 外部 entitlement
3. `XPOD_DEFAULT_*` 默认值
4. `null`（不限制）

## What's Tracked

### Storage Usage
- `identity_usage.storage_bytes` where `scope_type = 'account'` - Total storage per account
- `identity_usage.storage_bytes` where `scope_type = 'pod'` - Storage per pod

### Bandwidth Usage
- `identity_usage.ingress_bytes` / `egress_bytes` with `scope_type = 'account'` - Per account
- `identity_usage.ingress_bytes` / `egress_bytes` with `scope_type = 'pod'` - Per pod

### Collection Points
- `UsageTrackingStore` - Wraps resource operations
- `SubgraphSparqlHttpHandler` - SPARQL query traffic

## Quota Enforcement

### Strategies

| Strategy | Description |
| --- | --- |
| `NoopQuotaService` | No enforcement (default for local mode) |
| `DefaultQuotaService` | In-memory quota checks |
| `DrizzleQuotaService` | Database-backed quota with persistence |
| `PerAccountQuotaStrategy` | Per-account limits with configurable defaults |

### Configuration

Recommended cloud env baseline:

```env
XPOD_DEFAULT_STORAGE_LIMIT_BYTES=5368709120
XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS=5242880
XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY=250000
```

- `XPOD_DEFAULT_STORAGE_LIMIT_BYTES`：免费账号默认存储上限
- `XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS`：免费账号默认带宽上限
- `XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY`：免费账号默认月度模型 token 上限
- `XPOD_DEFAULT_COMPUTE_LIMIT_SECONDS`：可选；如果不承诺计算额度，可不设置

说明：

- `0` 表示显式限制为 0，不是“不限额”
- 留空才表示继续回退
- 手工 donation / supporter entitlement 可以把四个额度字段都留空，让账号继续继承免费档

## Quota Admin API

Requires admin Bearer token.

```bash
# Get account quota
GET /v1/quota/accounts/{accountId}

# Set custom quota
PUT /v1/quota/accounts/{accountId}
Content-Type: application/json
{"storageLimitBytes": 21474836480}

# Reset to default
DELETE /v1/quota/accounts/{accountId}

# Pod-scoped quota uses the same shape
GET /v1/quota/pods/{podId}
PUT /v1/quota/pods/{podId}
DELETE /v1/quota/pods/{podId}
```

## External Service Integration

For production management, integrate with external services:

### Billing Integration
- Query `identity_usage` periodically, grouped by `scope_type`
- Export to billing system or donation/support system if needed
- 当前免费档建议直接由 `XPOD_DEFAULT_*` 控制，不要求 `billing` 参与基线额度分发

### Monitoring & Alerts
- Connect to Prometheus/Grafana for metrics visualization
- Set up alerts for quota thresholds
- Monitor bandwidth spikes

### Example: Export Usage Data

```sql
-- Monthly usage report
SELECT
  u.scope_id as account_id,
  account.payload->>'email' as email,
  u.storage_bytes,
  u.ingress_bytes,
  u.egress_bytes,
  u.updated_at
FROM identity_usage u
LEFT JOIN identity_store account ON account.container = 'account' AND account.id = u.scope_id
WHERE u.scope_type = 'account'
  AND u.updated_at >= NOW() - INTERVAL '30 days';
```

### Webhook Integration (Planned)

Future: Webhook notifications for:
- Quota threshold warnings (80%, 90%, 100%)
- Usage anomaly detection
- Billing cycle events

## Database Schema

```sql
-- Account and Pod usage share one shape; scope_type selects the granularity.
CREATE TABLE identity_usage (
  scope_type TEXT NOT NULL, -- 'account' | 'pod'
  scope_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  storage_bytes BIGINT DEFAULT 0,
  ingress_bytes BIGINT DEFAULT 0,
  egress_bytes BIGINT DEFAULT 0,
  storage_limit_bytes BIGINT,
  bandwidth_limit_bps BIGINT,
  compute_seconds BIGINT DEFAULT 0,
  tokens_used BIGINT DEFAULT 0,
  compute_limit_seconds BIGINT,
  token_limit_monthly BIGINT,
  period_start TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (scope_type, scope_id)
);
```

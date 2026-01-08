# Usage Tracking and Quota Management

## Overview

Xpod provides built-in usage tracking and quota enforcement. For advanced management features (billing, alerts, reports), integrate with external services.

## What's Tracked

### Storage Usage
- `identity_account_usage.storage_bytes` - Total storage per account
- `identity_pod_usage.storage_bytes` - Storage per pod

### Bandwidth Usage
- `identity_account_usage.ingress_bytes` - Upload traffic per account
- `identity_account_usage.egress_bytes` - Download traffic per account
- `identity_pod_usage.ingress_bytes` / `egress_bytes` - Per pod

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

In `config/extensions.cloud.json`:
```json
{
  "options_defaultAccountStorageLimitBytes": 10737418240,
  "options_defaultAccountBandwidthLimitBps": 10485760
}
```

- Storage limit: 10 GB default
- Bandwidth limit: 10 MiB/s default (set to 0 to disable)

## Quota Admin API

Requires admin Bearer token.

```bash
# Get account quota
GET /api/quota/{accountId}

# Set custom quota
PUT /api/quota/{accountId}
Content-Type: application/json
{"storageLimitBytes": 21474836480}

# Reset to default
DELETE /api/quota/{accountId}
```

## External Service Integration

For production management, integrate with external services:

### Billing Integration
- Query `identity_account_usage` / `identity_pod_usage` tables periodically
- Export to billing system (Stripe, custom solution)
- Calculate costs based on storage + bandwidth

### Monitoring & Alerts
- Connect to Prometheus/Grafana for metrics visualization
- Set up alerts for quota thresholds
- Monitor bandwidth spikes

### Example: Export Usage Data

```sql
-- Monthly usage report
SELECT
  a.id as account_id,
  a.payload->>'email' as email,
  u.storage_bytes,
  u.ingress_bytes,
  u.egress_bytes,
  u.updated_at
FROM identity_account a
JOIN identity_account_usage u ON a.id = u.account_id
WHERE u.updated_at >= NOW() - INTERVAL '30 days';
```

### Webhook Integration (Planned)

Future: Webhook notifications for:
- Quota threshold warnings (80%, 90%, 100%)
- Usage anomaly detection
- Billing cycle events

## Database Schema

```sql
-- Account-level usage
CREATE TABLE identity_account_usage (
  account_id TEXT PRIMARY KEY,
  storage_bytes BIGINT DEFAULT 0,
  ingress_bytes BIGINT DEFAULT 0,
  egress_bytes BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pod-level usage
CREATE TABLE identity_pod_usage (
  pod_id TEXT PRIMARY KEY,
  account_id TEXT,
  storage_bytes BIGINT DEFAULT 0,
  ingress_bytes BIGINT DEFAULT 0,
  egress_bytes BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Custom quotas (overrides defaults)
CREATE TABLE identity_account_quota (
  account_id TEXT PRIMARY KEY,
  storage_limit_bytes BIGINT,
  bandwidth_limit_bps BIGINT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

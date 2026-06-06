# Account and Pod Quota Design

## Current Model

Quota and usage share a single relational table: `identity_usage`.

`account` and `pod` are scope values, not separate usage tables:

```sql
PRIMARY KEY (scope_type, scope_id)
scope_type: 'account' | 'pod'
scope_id: accountId | podId
account_id: owning account id
```

The canonical model does not define separate account/pod usage tables, single-field quota aliases, or quota fields on account/pod metadata records.

## Quota Fields

Each usage row can store four independent quota dimensions:

- `storage_limit_bytes`
- `bandwidth_limit_bps`
- `compute_limit_seconds`
- `token_limit_monthly`

Runtime TypeScript uses the camelCase shape:

```ts
interface AccountQuota {
  storageLimitBytes: number | null;
  bandwidthLimitBps: number | null;
  computeLimitSeconds: number | null;
  tokenLimitMonthly: number | null;
}
```

`null` means this layer does not set a limit and resolution should continue to the next source. `0` means an explicit zero allowance.

## Resolution Order

`DrizzleQuotaService` resolves quota in this order:

1. Local custom quota in `identity_usage`
2. External entitlement provider
3. `XPOD_DEFAULT_*` environment defaults
4. `null` for no limit

The supported defaults are:

- `XPOD_DEFAULT_STORAGE_LIMIT_BYTES`
- `XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS`
- `XPOD_DEFAULT_COMPUTE_LIMIT_SECONDS`
- `XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY`

## Responsibilities

- `UsageRepository` owns all reads/writes to `identity_usage`.
- `DrizzleQuotaService` owns quota resolution and writes quota fields through `UsageRepository`.
- `AccountRepository` only reads account/pod ownership facts needed to locate the owning account for a Pod.
- `UsageTrackingStore` and `SubgraphSparqlHttpHandler` record usage counters.
- `PerAccountQuotaStrategy` enforces storage quota by reading `quota.storageLimitBytes` from `QuotaService`.

Do not add account-specific or pod-specific usage tables. Do not add single-field quota shortcut APIs; storage quota is one field in the four-field quota model.

## APIs

The API server exposes the canonical management surface:

```http
GET    /v1/quota/accounts/:accountId
PUT    /v1/quota/accounts/:accountId
DELETE /v1/quota/accounts/:accountId
GET    /v1/quota/pods/:podId
PUT    /v1/quota/pods/:podId
DELETE /v1/quota/pods/:podId
```

`PUT` accepts any subset of canonical quota fields:

```json
{
  "storageLimitBytes": 5368709120,
  "bandwidthLimitBps": 5242880,
  "computeLimitSeconds": null,
  "tokenLimitMonthly": 250000
}
```

The CSS-side admin handler `/api/quota/accounts/:accountId` and `/api/quota/pods/:podId` follows the same request and response shape for deployments that still enable that handler.

## Testing

Quota changes should verify at least:

- `UsageRepository` writes account and pod scope rows into `identity_usage`.
- `DrizzleQuotaService` resolves local, entitlement, env default, and null values correctly.
- Pod quota writes require a real owning account id.
- `/v1/quota/*` and `/api/quota/*` reject non-canonical quota fields.
- Full integration tests keep account/pod usage in the unified table.

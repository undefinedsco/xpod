# Admin Guide

## Admin Initialization

### Seed File

Copy `config/seeds/admin.example.json` and adjust email, password, pod name, and `webId` for your environment. Pass it via `CSS_SEED_CONFIG` or `--seedConfig`. On first startup, the admin account and pod will be created automatically. If the entry includes `roles` (e.g., `["admin"]`), the system will sync to the `identity_account_role` table.

### Role Storage

Admin roles are now stored in `identity_account_role(account_id, role)` and can be maintained via SQL or scripts. Legacy fields in `payload` (`roles` / `isAdmin`) are no longer used for authorization - only for backward compatibility.

### Storage Implementation

- `yarn local` / `yarn dev`: Uses `.internal/accounts` file storage for accounts
- `yarn server` (cluster/production): Overridden to PostgreSQL in `config/extensions.server.json`
- Both modes use the `identity_account_role` database table for admin roles

## Authorization

### Write Operation Validation

Write endpoints like `QuotaAdminHttpHandler` extract WebID from the access token and check the database for `admin` role. Only accounts with the appropriate role can execute modifications.

The legacy Admin Console has been removed. All management actions must go through API / CLI / Portal.

### Quota API

`/api/quota/...` now requires admin Bearer Token. All `PUT/DELETE` calls reject non-admin identities.

## Bandwidth Usage Tracking

Server mode accumulates ingress/egress traffic in `identity_account_usage` / `identity_pod_usage` tables (`ingress_bytes`, `egress_bytes` fields). Resource writes, reads (including `.sparql` queries) are tracked via `UsageTrackingStore` + `SubgraphSparqlHttpHandler`.

Default bandwidth limit: 10 MiB/s. Configure via `options_defaultAccountBandwidthLimitBps` in `config/extensions.server.json` or `config/extensions.mix.json`. Set to 0 or remove to disable throttling.

## Data Archiving

For offline auditing, admin scripts can write output to `.internal/accounts/` directory, preserving snapshots without affecting the main database.

## Reserved Pod Names

To avoid routing conflicts, these names are reserved and rejected during pod creation:
- `admin`
- `quota`
- `signal`

Case and symbol normalization is applied (e.g., `Admin`, `ADMIN`, `admin-` are all rejected).

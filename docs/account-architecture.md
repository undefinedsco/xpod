# Account & Pod Metadata Architecture

## 1. CSS Default Implementation
- **Storage primitives**: Community Solid Server ships with `BaseLoginAccountStorage`, `BaseAccountStore`, and `BasePodStore`. They operate on a `WrappedIndexedStorage` that writes JSON documents under `.internal/accounts/**`.
- **Account structure**: `accounts/data/<accountId>.json` stores settings (e.g. `rememberLogin`) and nested maps for password logins, client credentials, pod registrations, and webid links. Supporting indexes live under `accounts/index/**` (e.g. `pod/<podId>.json`, `pod/baseUrl/<url>.json`).
- **Pod metadata**: When `BasePodStore.create` runs, it appends the pod entry inside the account document, writes the relevant index files, and delegates resource provisioning to `PodManager`. Owners and visibility flags are embedded inside the pod map.
- **Advantages**: zero extra dependencies, battle‑tested workflows, works out of the box for single-node deployments.
- **Limitations**:
  - Requires a shared filesystem for clusters; availability and throughput depend on the volume.
  - JSON layout is not query-friendly; running analytics or quota enforcement needs bespoke traversal.
  - No built-in transactional guarantees across multiple files.

## 2. Planned Drizzle-backed Replacement
- **Goal**: move account, login, and pod metadata into PostgreSQL via Drizzle ORM while keeping the rest of CSS unchanged.
- **Schema direction**:
  - `accounts` table with remember-login, creation timestamps, per-account quota, etc.
  - `password_logins`, `client_credentials`, `webid_links` referencing `accounts.id`.
  - `pods` table with `base_url`, `account_id`, quota settings, plus `pod_owners` table.
- **Runtime components**:
  - `DrizzleAccountLoginStorage` implementing the IndexedStorage and login-count semantics exposed by CSS (`defineType`, `create`, `setField`, etc.).
  - `DrizzleAccountStore` and `DrizzlePodStore` mirroring CSS interfaces but issuing SQL through Drizzle.
- Components.js overrides to swap the default account/pod stores only in the server profile（可按需开启云边协同）。
- **Benefits**:
  - Strong typing & migrations (Drizzle schema / migrations cover evolutions and rollbacks).
  - Easier aggregation and reporting (standard SQL instead of filesystem traversal).
  - Better concurrency story for multi-instance deployments.
- **Considerations**:
  - Migration tool required to convert existing `.internal` JSON documents into SQL rows.
  - Need integration tests to ensure CSS flows (registration, login, pod creation, owner updates) behave identically.
  - Must implement the login-count logic to preserve CSS invariants (e.g. at least one login method).

## 3. Migration Outline
1. Build Drizzle schema and storage adapters in a dedicated branch.
2. Implement a one-off migration script that reads `.internal/accounts/**` and `.internal/pods/**`, writes SQL rows, and validates counts.
3. Update Components.js/ENV only after the migrator succeeds; retain rollback path (e.g. keep JSON backup).
4. Add observability (metrics/logs) to verify successful read/write against the new store before deprecating JSON files.

## 4. Status & Next Steps
- Current master: defaults to CSS JSON storage for accounts/pods; `.internal/idp/**` routing to SPARQL remains unchanged.
- Planned work (feature branch): implement Drizzle-backed stores following the design above, then revisit configuration overrides.
- Reference: see also [`docs/quota-design.md`](quota-design.md) for quota and usage tracking design tied to the account metadata.

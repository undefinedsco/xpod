# Protected RC deployment boundary

`candidate.yml` never drops/recreates `xpod_rc`, creates/upgrades extensions,
or rewrites owners and grants. A read-only preflight runs before runtime Secret
writes or deployment. Missing database, wrong owner, PostgreSQL other than 17,
or mismatched required extension versions fails closed with the source retained.
This gate only proves catalog readiness, not migration, backup validity or product acceptance.

A required migration must be handled independently using the protected PostgreSQL
backup/independent-restore tooling reviewed in PR #44. Retain the protected source;
restore only to a newly owned empty target, independently retain the export manifest
hash, compare complete inventories, and complete actual restored-product RDF/FTS/VEC,
permissions and Gateway checks before routing deployment to that target. A disposable
fixture, tool availability or this read-only check does not count as actual migration.
No database migration or shared RC deployment was performed by this workflow patch.

The mounted development workflow uses one immutable authority inventory at
`scripts/agentfs-native-ci/mounted/native-authority.json`. Four targets execute
Node and Bun separately against the same built module/core and fresh homes.
Runner architecture, native artifact metadata and hashes, source reuse, actual mounted
cases and supervised close/cleanup remain required. Native build success alone cannot
satisfy mounted acceptance. These jobs do not enter or mutate shared RC.

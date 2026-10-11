# Protected PostgreSQL backup and independent restore

The Bun CLI uses `pg_dump`, `pg_dumpall`, and `pg_restore` installed on the host.
Connection URLs are supplied through explicitly named environment variables;
they never enter command arguments or safe output. Use a fresh output directory.

```sh
bun scripts/protected-postgres-migration.ts export --source-env SOURCE_DATABASE_URL --out .test-data/migration/backup
bun scripts/protected-postgres-migration.ts restore --target-env TARGET_DATABASE_URL --backup .test-data/migration/backup --manifest-sha256 <independently-retained-backup-manifest-sha256> --out .test-data/migration/restore
```

Export requires a superuser on PostgreSQL 16. A read-only repeatable-read
transaction exports the snapshot consumed by the complete custom-format dump
and all user-table canonical row hashes. The archive includes schema, data,
ownership, ACLs and extension declarations: there are no schema/table filters,
`--no-owner`, or `--no-acl`. Original global SQL is retained privately. Source
cluster/database identity, catalogs, roles, memberships and nontransactional
sequence state must remain unchanged across export; otherwise no successful
backup receipt is issued. Application row hashes describe the exported snapshot.

Restore requires a different PostgreSQL 17 cluster with only its empty bootstrap
database and bootstrap role. It creates the original database through
`pg_restore --dbname postgres --create --exit-on-error`; it never uses `--clean`, DROP or TRUNCATE.
Existing custom tablespaces or nonbaseline role memberships also reject the target before writes.
The PostgreSQL 17 initdb baseline contains exactly three grants to `pg_monitor`:
`pg_read_all_settings`, `pg_read_all_stats`, and `pg_stat_scan_tables`. Each grant
must come from the target bootstrap user with ADMIN false, INHERIT true and SET
true. Missing, extra or altered grants reject admission. These default memberships
remain in the source/target inventories and exact final verification.
These grants are defined in PostgreSQL 17's
[system_functions.sql](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/catalog/system_functions.sql),
which initdb loads during initialization.
Roles are recreated from structured source catalogs, preserving attributes,
password hashes, role settings, membership grantor and ADMIN/INHERIT/SET options. A role
colliding with the target bootstrap role is altered only after restore, so its
original target login remains usable while the archive is restored. No SQL text
is removed from the original globals dump and SQL errors are never ignored.

A service image may initialize product schemas/extensions in its bootstrap
database. Such a cluster is not empty and is correctly rejected before restore
writes. An isolated restore target can retain the exact PostgreSQL/extension
binaries while using an owned empty `/docker-entrypoint-initdb.d` directory to
skip product initialization scripts; standard PostgreSQL initdb must still run.
This is preparation of a new target, never deletion of schemas or data from an
existing cluster. Failed empty-target checks record each original guard result
and private catalog metadata in `target.preflight.private.json` (0600).

Exact before/after inventories cover all user table rows, sequence state,
namespaces, relations, column defaults and ACLs, database ownership/ACLs,
extensions, indexes, views, constraints, routine definitions, enum/domain types,
triggers, comments, security labels, database-specific role settings, large-object
contents/owners/ACLs and row policies (including PUBLIC). Their hashes
are compared after restore. Custom tablespaces are exported without filters,
but restore refuses them until a safe location mapping exists. Foreign tables,
foreign data wrappers, servers and user mappings are unsupported and fail closed,
including wrappers without handlers or tables. Existing foreign objects also
reject the bootstrap target before any role or database writes; they are never
deleted by this tool. Replication slots are not database dump objects;
this is a logical database backup, not a full physical cluster clone.
External extension binaries must already
exist on the target; version or restored object differences reject admission.
PostgreSQL dump/restore can refresh a populated materialized view. If the source
view is stale, the restored contents can differ from the exported snapshot and
inventory comparison rejects success. A real source needs a capability inventory
before admission; a successful disposable fixture does not establish support for
every PostgreSQL object or for a complete server migration.
Restore retains expected and actual inventories with their hashes in the private
0600 `restore.inventory.private.json` before comparison. Its companion safe file
contains only hashes and differing inventory categories, never object identities
or contents. This diagnostic does not change the exact comparison gate.
PG17 introduces the table MAINTAIN privilege. Restore removes MAINTAIN grants
introduced by restoring PG16 ALL grants on relations with explicit source ACLs,
using structured `aclexplode` source authority and the actual target grantor.
PUBLIC and quoted role names are supported. Dependent MAINTAIN grants cascade
with that privilege only; other privileges and NULL implicit ACLs are preserved.
The resulting literal ACL and structured grants must still compare exactly.

Directories are 0700 and private materials 0600. Temporary pgpass files are
replaced by explicit PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD child environment
variables, with no credential values in process arguments. Each native command
has closed private stdout/stderr logs, actual exit status, hash receipts and an
owned process-group absence check. Command timeout defaults to six hours and
may be changed by the library caller; timeout or abort rejects admission.
Log errors use the same owned-group TERM/KILL cleanup and failure receipt path.
Restore streams the archive and globals into fresh private files, verifies those
copied bytes against the authorized manifest before target writes, and restores
from the private archive. A post-command archive hash check also gates success.
Failed restore may leave its newly created
objects in the isolated target; it does not delete them automatically. Retain
the original source and backup. Global SQL, catalog manifests, row inventories
and database archives are private, even when they contain only hash references.

This is logical administrative backup tooling, not a Pod schema migration. Its
inventory comparison does not replace actual restored-product FTS/VEC, RDF,
permissions or Gateway acceptance. A disposable PG16-to-PG17 fixture proves the
tool only; it is not evidence for restoring a protected production database.

Bootstrap-role restoration currently requires a colliding source bootstrap role
to remain a superuser, and refuses a NULL source role validity when a non-NULL
target validity could not be reset through the structured role commands. Source
and target URLs must explicitly name their host/user/database and carry no query
parameters; unsupported connection options are refused rather than inferred.
The manifest digest must come from a separately retained export receipt; merely
changing the manifest and its colocated receipt cannot establish authority.

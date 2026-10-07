# Cloud RDF authority is not yet bound to a shared physical commit domain

Observed by read-only source/configuration review on2026-10-05 during generic conditional-write and Matrix recovery design. This is a static topology gap, not a measured PostgreSQL/Cloud failure: the current Docker engine returns503 and no corresponding real Cloud race has been run. No live Pod was changed.

## Current contract and source relationships

`docs/deployment-modes.md` describes Cloud horizontal expansion behind a load balancer. `docs/storage-overview.md` describes local RDF files as authority and PostgreSQL as a derived index. Current `config/cloud.json` binds RDF to the local `AtomicRdfFileDataAccessor` and `rootFilePath`; only unstructured data uses `RemoteDataAccessor`. Cloud's query backend is PostgreSQL/Comunica. A shared database therefore does not imply a shared physical authority file.

An individual runtime routes data requests to one CSS target, so two API/Agent callers can share that storage domain. Across independent Cloud CSS processes, the bootstrap accepts independent root directories and does not establish that an equal canonical base URL names one physical root.

`PodRoutingHttpHandler`, `ClusterIngressRouter` and `EdgeNodeProxyHttpHandler` express node routing, but current Cloud `BaseHttpHandler` does not insert those handlers. Definitions in `xpod.cluster.json` do not prove active default wiring. `PodMigrationService.migratePod` updates node ownership without transferring or fencing RDF files; its shared-database assumption must be reconciled with the current file-authority contract before migration is qualified.

## Static reproduction to execute against actual Cloud

1. Start two independently owned Cloud CSS instances with the same canonical base URL and PostgreSQL RDF backend, but different physical roots A/B.
2. Write a canonical RDF document through A. Read through B: the index-to-file path may materialize a separate file in B.
3. Update through A, then read the already-existing document through B.
4. Compare full RDF bytes/terms, commit revision, metadata and current authorization on both instances, including a stopped old writer and node reassignment.

`MixDataAccessor.refreshLocalRdfDocument` can materialize a missing file from the structured backend, while `getData` can return an already-existing local file. The inspected paths do not establish continuous replica synchronization, owner-only commits, or a globally qualified version. The steps above are a pending real reproduction; they must not be reported as executed or as proof that every deployment exhibits divergence.

## Required generic backend contract

- Each canonical resource must have one qualified commit/version domain, even when multiple APIs or CSS nodes serve it. Do not replace documented scaling with a single-node deployment requirement.
- A prepared conditional mutation must refresh the complete source, dependencies and current authority inside that domain, and the final commit must reject an obsolete writer. Checking a Redis lease or a remote PostgreSQL lock before a local rename is insufficient if an old process can resume after losing ownership.
- Readers, restart and migration must recover the same complete old/new authority and its actual commit provenance. Derived index or journal failure must not erase an already claimed committed source. Metadata and representation format boundaries require explicit qualification.
- Ordinary PUT/PATCH/DELETE, imports, index-to-file materialization, startup recovery and SolidFS workspace commits must participate. Direct/copy workspace writes cannot be omitted merely because HTTP paths are locked.
- Use existing canonical root/routing/storage inputs where justified. No new per-user deployment switch, Matrix-specific WAL/CDC, copied models layout, or independently writable RDF marker establishes this guarantee.

A dedicated SQLite `BEGIN IMMEDIATE` gate may be useful for multiple processes opening the same physical authority root. Its private Bun/Node process prototype does not qualify different Cloud roots, network filesystems, node migration, credential databases, or complete G08/G09. A generic remote commit mechanism or fully qualified storage-owner routing is still to be selected and independently proved before product adoption.

This issue belongs to Xpod's storage/routing boundary. drizzle-solid separately needs generic property patch, exact snapshot conditional mutation and applied/conflict/unknown results, as recorded in [the ORM issue](drizzle-solid-canonical-protocol-cas.md). Fixing only either side cannot claim the whole migration complete. Shared RDF schema remains owned by models; no upstream dependency or product code was changed by this report.

# QLever Local/Cloud Capability Design

Date: 2026-08-08

Status: superseded by the 2026-08-13 public/private boundary correction

## 1. Decision

Current product boundary:

- Public `xpod-jobs` ships both Local and Cloud.
- Local uses a SQLite physical RDF backend behind a static QLever runtime.
- Public Cloud uses the PostgreSQL physical RDF backend, RDF-3X/PG fast paths,
  and PG FTS/VEC without requiring QLever.
- Private Cloud may add PostgreSQL QLever acceleration through
  `xpod-rdf-components`, but that repository does not own the public Cloud
  product mode.
- RDF3X is not a second product-semantic definition. It may remain only where a
  separately approved operational role requires it; callers must never receive
  silently different SPARQL results because a different engine was selected.
- Commercial differentiation belongs to scale, fusion quality, managed
  operation, collaboration, enterprise controls, and optional private PG QLever
  acceleration rather than withholding Cloud deployment itself from the public
  repository.

## 2. Product Boundary

Shared Local and Cloud capability:

- supported SPARQL parsing, algebra, expression evaluation, EBV, FILTER,
  ordering, aggregation, joins, and result construction must be semantically
  consistent across Local and Cloud for the supported public surface;
- RDF term identity and typed-term interpretation follow one versioned physical
  backend contract;
- the same conformance corpus proves the common semantic surface;
- a query that is supported by both editions has the same observable result.

Local capability:

- embedded SQLite persistence and single-machine execution;
- the open-source Xpod repository owns the SQLite backend, shared QLever
  adapter/protocol/patches, and the complete Local build and release path;
- Local ships one `xpod_qlever_local_runtime` executable. The SQLite backend
  and QLever adapter are statically linked into it; there is no provider path,
  backend `.so`, or private component required to build or start Local;
- offline operation and resource limits appropriate to a personal device;
- baseline local text/vector features only when they can use the shared query
  contract without introducing another SPARQL evaluator.

Public Cloud capability:

- PostgreSQL storage and high-concurrency execution;
- PG RDF-3X/PG fast paths, FTS/VEC/RDF fusion, cost-based optimization, and
  larger indexes;
- managed upgrades, backups, high availability, observability, quotas, audit,
  remote access, collaboration, and service guarantees.

Private Cloud acceleration:

- PostgreSQL native QLever extension and PG-native conformance evidence;
- acceleration components that consume public SDK artifacts rather than copying
  public source;
- no ownership of public Cloud product startup, image shape, or baseline query
  path.

Cloud-only implementation must remain modular. The shared query contract must
not import Cloud orchestration, billing, deployment concerns, or private native
QLever components.

Repository ownership follows the product boundary: shared QLever semantics and
the complete Local implementation live in Xpod; the public PostgreSQL Cloud
implementation also lives in Xpod. The private component repository contains
only PostgreSQL QLever acceleration, native extension code, and operational
evidence. Private PG builds consume a public immutable QLever runtime SDK rather
than copying the shared implementation.

## 3. Storage and Value Boundary

Storage remains backend-owned and does not persist QLever vocabulary positions
as the canonical RDF identity.

Each backend owns:

- a stable physical term key for fact scans and joins;
- lossless RDF identity: kind, lexical value, datatype, and language;
- maintained typed projections needed for indexed pushdown;
- a facts/schema version used to invalidate query-side caches.

The QLever boundary owns conversion from a physical term to its semantic value:

- values representable by a real QLever inline typed `ValueId` are materialized
  as such;
- external IRI, blank-node, string, language, and unsupported typed terms are
  resolved through the physical vocabulary contract;
- an opaque SQLite or PostgreSQL term key must not be disguised as a natively
  ordered QLever vocabulary value;
- term identity, SPARQL value equality, relational comparison, and total order
  remain distinct operations.

Fixed-width keys or projections may be used for backend indexes and pushdown.
They are not, by themselves, the complete definition of SPARQL comparison.

## 4. Components

### Shared QLever adapter

Owns the planner/executor integration, typed-value conversion, request context,
authorization scope propagation, and result conversion. It contains no SQL
dialect-specific query construction.

### SQLite physical backend

Implements the shared scan, lookup, typed projection, statistics, and version
contract using the existing local RDF tables and indexes. It does not implement
a second SPARQL planner or expression evaluator.

### PostgreSQL physical backend

Implements the public Cloud contract using PostgreSQL and may expose ordered
scans, batch operations, PG text/vector candidates, fusion primitives, and
production statistics without requiring QLever. Optional private native QLever
capabilities must be declared; absence must not change the semantics of the
public operators.

### Cloud fusion modules

Own FTS/VEC candidate generation, rank fusion, Cloud cost models, and operational
limits. Public Cloud implementations return explicit candidates, scores,
ordering, and snapshot/version information to the PostgreSQL query authority.
Private QLever acceleration may consume the same candidate contract but does not
reinterpret arbitrary SPARQL outside its declared authority.

## 5. Query and Failure Flow

1. The product boundary authorizes the Pod/graph scope.
2. The active authority parses and plans the query: Local uses static QLever;
   public Cloud uses the PostgreSQL authority; private Cloud acceleration may
   use PG QLever when explicitly deployed.
3. The authority requests physical scans and declared optional capabilities from
   the selected SQLite or PostgreSQL backend.
4. The backend returns physical keys plus the typed/vocabulary information
   required by that authority.
5. The authority performs the supported SPARQL algebra and produces results.
6. The product boundary serializes the results and records engine/capability
   metrics.

Unsupported optional acceleration must remain inside the same authority's
declared public plan or fail explicitly. It must not switch to an approximate
comparison or another query engine within the request. Backend unavailability,
stale snapshots, and contract violations fail explicitly with structured
diagnostics.

## 6. Verification Contract

The implementation is acceptable only when:

- a shared semantic corpus runs against SQLite/QLever and public PostgreSQL
  Cloud for the common surface and produces identical canonical results;
- the corpus distinguishes `sameTerm`, RDF term identity, value equality,
  relational comparison, and ORDER BY;
- numeric promotion, booleans, NaN, infinities, date/time values, language
  literals, incompatible types, errors, and unbound variables are covered;
- OPTIONAL, UNION, MINUS, EXISTS, aggregation, ordering, pagination, and bag
  multiplicity are covered for the supported product surface;
- authorization scope cannot be widened by scans, vocabulary lookup, text/vector
  candidates, or cache reuse;
- Local startup and query execution are tested without PostgreSQL, Cloud fusion,
  or Cloud credentials;
- private Cloud acceleration tests prove that PG QLever accelerated and public
  PostgreSQL plans are semantically identical before performance results are
  accepted.

Full installed-image conformance remains the final release gate, after focused
contract, adapter, backend, and differential tests have already passed.

## 7. Rejected Alternatives

### Local RDF3X and Cloud QLever as permanent product semantics

Rejected because it creates two expression/comparison implementations, permits
semantic drift, makes Local an unreliable development environment for Cloud,
and turns baseline correctness into an edition difference.

### QLever native vocabulary/index as canonical persistence

Rejected because PostgreSQL and SQLite remain the authoritative mutable stores.
Persisting QLever vocabulary positions as RDF identity would couple data layout
to an engine index and introduce synchronization and dynamic-update costs.

### One universal fixed-width string as the entire semantic model

Rejected because a total byte order cannot alone represent SPARQL errors,
unordered comparisons, NaN behavior, numeric promotion, or the distinction
between term and value equality. Fixed projections remain valid physical index
tools, not the query-language definition.

## 8. Implementation Planning Boundary

Planning must proceed in dependency order:

1. freeze the shared typed-term and physical capability contract;
2. make public PostgreSQL Cloud pass focused semantic conformance without
   opaque-id comparison shortcuts;
3. implement the SQLite backend against that frozen contract;
4. run cross-backend differential conformance;
5. add or reconnect private Cloud-only QLever acceleration through explicit
   optional capabilities;
6. remove superseded permanent engine-routing and compatibility paths.

No migration, fallback compatibility layer, or speculative configuration system
is part of this design. Obsolete paths are deleted once their replacement gates
pass.

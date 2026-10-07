# drizzle-solid 0.3.24 repeats PATCH for subjects in one shared document

The full integration ChatKit deletion case retains its15-second budget. Phase diagnostics show11496ms for create/stream,4803ms for delete,387ms for verify; the same isolated case finishes5683ms total. The installed LdpExecutor.executeDelete loops over selectedsubjects, recursively reads each subject/inline children, PATCHes each separately, and invalidates the document/global engine cache after each successfulwrite. Two selectedmessages in the same messages.ttl cause two PATCH operations. This does not justify relaxing the budget or deleting the entire shared document.

Repair boundary: merge only consecutive selectedsubjects resolving to the same physical document. Keep cross-document order, authenticatedfetch, existingSPARQL/N3 fallback, fail-fast and recursive inline handling. Read a whole run before emitting one PATCH of deduplicated explicit triples. Keep one operation result per nonempty selectedsubject to preserve existing afterDelete hook counts. A run commits as one document operation; later-document failure does not roll it back. A1/B1/A2 remains three runs, rather than reordered A1+A2/B1. No cross-document transaction is claimed.

Before implementation, verify real shared-schema Message RDF and inline metadata with N3/Comunica, replacing only HTTPtransport; selectedA/B removed, unrelatedC intact. Cover duplicates, emptyselection, authorization rejection and per-document failure. Apply via official Bun patch at the sameinstalledversion; no newpackage.

A separate existing inverse-link cleanup gap is documented in drizzle-solid-delete-inverse-links.md and is not silently changed by this performance repair. Production/userGateway and fullmigration acceptance remain pending.

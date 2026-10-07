# Comunica 4.5.0 loses secondary ordering when the primary key ties

## Reproduction and root cause

The installed `@comunica/actor-query-operation-orderby` 4.5.0 implements composite `ORDER BY` with successive sorting passes, from the least significant field to the most significant. Its `SortIterator` inserts an equal item at an arbitrary binary-search midpoint. Equal primary keys therefore scramble the secondary ordering already established by the preceding pass.

A six-subject RDF query with identical numeric values returns correctly ordered subjects for `ORDER BY STR(?subject)`, but returns a different, unordered sequence for `ORDER BY ?value STR(?subject)`. The tracked public drizzle query/RDF regression reproduces omissions and repeats with twenty identical datetime values and page sizes 7 and 20. This is independent of drizzle's virtual `@id` binding defect.

## Repair

Preserve stable ordering by inserting new equal items before existing equal items in the iterator's descending internal window, which is consumed using `pop()`. Binary search must find the left boundary of the equal-key range rather than stop at a midpoint. Apply the correction with the official Bun patch workflow at the existing installed version, without adding or upgrading a dependency. Verify ordinary ascending and descending composite pagination against RDF and re-run the actual document endpoint probe.

This affects the installed engine used for document reads and the native protocol test fixture. Repairing query generation alone cannot prove this cursor contract. The engine's public query interface and source are documented in the [Comunica repository](https://github.com/comunica/comunica).

## Local verification after repair

Public ORM generated queries over actual RDF passed twenty timestamp ties at page sizes 1, 7 and 20, plus descending scoped-alias pagination (4 tests). Linked-schema alias regressions also passed (2 tests). Production TypeScript build and test typecheck both exited 0. The disposable closed-ACP actual Pod probe read twenty tied resources once each with pages `[2,2,2,2,2,2,2,2,2,2,0]` in both document LDP and document SPARQL modes, excluding the other-day document. Its result is `exact-document-orm-diagnostic-8d4c9772-18ea-4509-9a1a-1830a4bb7902/result.json` under the evidence directory; process exit 0. Full migration, native-source discovery, performance and the user Gateway remain separate acceptance requirements.

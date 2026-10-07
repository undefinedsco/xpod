# Virtual resource ID ordering omits tied rows during cursor pagination

## Reproduction

With drizzle-solid 0.3.24 and the authoritative `messageResource` schema, write multiple Message subjects into one daily document with identical `createdAt`. Use the public document-scoped schema and `orderBy(asc('createdAt'), asc('id')).limit(2)`, then `whereCursor` on the last creation time and exact resource IRI.

An actual disposable closed-ACP Pod probe returned two rows followed by an empty page, omitting the third subject. Both document LDP and document SPARQL variants reproduced the failure. The generated first query sorts by `?createdAt ?id`, although the schema's virtual `@id` has no triple binding for `?id`; the resource identity is bound as `?subject`. A tie therefore has no stable identity ordering.

## Required repair

The query generator must sort virtual `@id` columns by `STR(?subject)`, matching public cursor comparison semantics, including descending order. Other properties retain their ordinary column variable. Fix both shipped CJS and ESM builders through the existing Bun patch; retain the dependency version and existing patch changes. Test generated public queries against actual RDF with timestamp ties and multiple page sizes.

Cursor operands for datetime fields must be JavaScript `Date` values: passing an ISO string currently generates an untyped string literal. This is a caller requirement, separate from the unbound virtual-ID ordering defect.

## Evidence and limits

The failing probe is preserved under `.test-data/solid-multiparty-acceptance/provider-b/root-review/exact-document-orm-diagnostic-67451e45-ecf9-41df-95d0-68ebd3280665/result.json`. This is a disposable actual Pod with the native protocol fixture, not acceptance of the user's running Gateway or the complete migration.

## Local verification after repair

Public ORM generated queries over actual RDF passed twenty timestamp ties at page sizes 1, 7 and 20, plus descending scoped-alias pagination (4 tests). Linked-schema alias regressions also passed (2 tests). Production TypeScript build and test typecheck both exited 0. The disposable closed-ACP actual Pod probe read twenty tied resources once each with pages `[2,2,2,2,2,2,2,2,2,2,0]` in both document LDP and document SPARQL modes, excluding the other-day document. Its result is `exact-document-orm-diagnostic-8d4c9772-18ea-4509-9a1a-1830a4bb7902/result.json` under the evidence directory; process exit 0. Full migration, native-source discovery, performance and the user Gateway remain separate acceptance requirements.

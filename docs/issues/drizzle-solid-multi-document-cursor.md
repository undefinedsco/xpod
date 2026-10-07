# Multi-document LDP queries do not provide a global cursor page

Observed with installed `@undefineds.co/drizzle-solid` 0.3.24. Public source discovery over a room containing today's 20 messages and an eight-day-old message fails its strict `(createdAt, full subject IRI)` progression guard in a disposable authenticated ACP Pod. Evidence: `.test-data/solid-multiparty-acceptance/provider-b/root-review/native-source-orm-diagnostic-14e6c688-43c0-4d71-86dd-830f9cdc2a38/result.json`.

`LdpStrategy.executeSelect` resolves multiple documents, executes the complete ordered/limited query independently against each document, and appends each result to `allResults`. Thus `ORDER BY` and `LIMIT` apply per document. Their concatenation is neither globally ordered nor globally bounded. Exceptions from individual sources are also caught and skipped, which cannot establish completed reconciliation.

Reproduction: insert messages in two daily documents; select the shared Message resource with a parent filter, `orderBy(asc('createdAt'), asc('id'))`, `limit(2)` and public composite `whereCursor(condition)`. Compare the returned page to a globally ordered two-row page.

Adapter repair: use the public alias/schema API to select the same shared Message schema through the known room container's scoped SPARQL endpoint. The server applies a single global ordering and limit over that room's graphs. Keep current-caller authentication, parent filtering, exact source identities and non-progress rejection. No raw SPARQL, shared schema copy or client sorting of an already limited page.

Repaired actual Pod validation passed: `.test-data/solid-multiparty-acceptance/provider-b/root-review/native-source-orm-diagnostic-2761015a-6c2b-4e23-8f64-67a7c03965d8/result.json`. Incremental sync found all 20 tied native messages and the eight-day-old message; exact-document LDP/SPARQL checks returned bounded two-row pages. This disposable closed ACP stack uses the native-protocol fixture with Comunica and does not prove production QLever performance or the user's running Gateway. The datetime compiler repair in the companion issue was also required.

# Public SPARQL insert loses datetime column types for ISO strings

Installed `@undefineds.co/drizzle-solid` 0.3.24 formats ISO strings in datetime columns as ordinary literals in `db.insert(table).values(row).toSPARQL()`. Ordinary LDP insertion through the same shared schema emits `xsd:dateTime`. The public SPARQL compiler therefore disagrees with the normal ORM write path.

Actual evidence: `.test-data/solid-multiparty-acceptance/provider-b/root-review/native-source-orm-diagnostic-f088e96a-1ad7-479c-99ff-322c389fb6ec/result.json`. Room-scoped SPARQL returns an eight-day-old native message, 20 new native messages, then the three earlier conditionally inserted events. The persisted RDF index confirms the conditional events' `dc:created` has no explicit datatype while native rows have `http://www.w3.org/2001/XMLSchema#dateTime`. The source progression guard correctly rejects this type-dependent ordering.

Root cause: `core/sparql/helpers.formatSingleValue` handles strings before consulting datetime column metadata. `UpdateBuilder.buildInsertTriples` uses this helper; a conditional insert compiled through the public ORM preserves its output faithfully.

Repair in the existing Bun patch: consult the public column's datetime type before generic string formatting, validate and normalize its value, and emit `xsd:dateTime`. Apply equally to CJS and ESM. Preserve ordinary text, URI and object serialization. Reject values that parse to non-finite instants; JavaScript Date conversion follows the existing datetime column behavior and does not provide strict calendar/input-type validation. Regression must evaluate the public compiled insertion into actual RDF and inspect RDF term datatypes; do not normalize fixture rows to conceal the discrepancy.

Previously persisted untyped dates are a migration concern; this repair does not rewrite existing event facts or claim legacy-source recovery is complete.

Post-repair evidence: the two new public RDF tests failed before the patch and pass afterward. RDF/conditional-write/winner-guard regressions total 29 passes. Actual disposable ACP Pod `native-source-orm-diagnostic-2761015a-6c2b-4e23-8f64-67a7c03965d8` passes source sync of 20 tied native messages plus an eight-day-old message; all 26 persisted `dc:created` terms are dateTime. Both public exact-document query modes now include the three initial conditional events, not only the 20 native ones, with fixed two-row pages. No dependency version changed.

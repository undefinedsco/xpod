# Comunica 4.5.0 loses exact datetime milliseconds during cursor comparisons

## Actual reproduction

A fresh disposable closed-ACP Gateway returns `503 M_UNKNOWN: Source cursor did not advance in its declared order` after creating a room and granting two agents. Its scoped public ORM query uses `ORDER BY ?createdAt STR(?subject) LIMIT 500`, yet returns `.648Z` before `.647Z`. The retained RDF SQLite confirms every relevant created value is an `xsd:dateTime` Literal. This is separate from the earlier untyped datetime serialization defect.

Evidence: `gateway-grant-source-diagnostic-0fa0f35c-c3ca-4d00-8587-8fd1332b8dc9/result.json` under the ignored root-review evidence directory. The diagnostic now drains the initial client window using each returned cursor rather than incorrectly expecting a new event before the initial backlog is delivered.

An independent read-only SQLite-to-N3 replay and a four-row public QueryEngine VALUES query reproduce the problem. Public SPARQL comparison of `.647Z` and `.648Z` returns equality, and returns false for both less-than and greater-than. Root public ORM/RDF cursor regressions at the actual failing instant fail at page sizes 1, 7 and 20 (3 failed, 5 passed before repair).

## Root cause and repair boundary

The installed `@comunica/utils-expression-evaluator@4.5.0` implementation in `lib/util/DateTimeHelpers.js`, `toJSDate`, computes `(date.seconds % 1) * 1000` and supplies that floating value to JavaScript Date. For seconds `7.648`, the intermediate milliseconds are `647.9999999999997`, which Date truncates to `647`. Two genuinely distinct instants become equal. This affects both ordering and cursor FILTER expressions.

Repair the existing dependency using the official Bun patch workflow, without adding or upgrading packages. Preserve timezone handling, the year 0–99 correction and the existing millisecond truncation of submillisecond inputs. Preserve the earlier stable SortIterator repair: it correctly preserves the secondary order, but cannot repair a primary comparator that falsely reports equality. Do not relax source ordering guards, sort already limited pages in the product, or replace datetime semantics with string ordering.

The upstream implementation is maintained in the [Comunica repository](https://github.com/comunica/comunica). Actual production native QLever, the current user Gateway, migration acceptance and performance remain separate verification requirements.

## Local repair verification

The official Bun patch keeps the installed evaluator at 4.5.0. Decimal digits are truncated to milliseconds before Number conversion, including exponent notation and negative values; year and timezone handling remain in the existing code. This avoids both binary multiplication underflow and rounding an actual submillisecond value across an integer boundary. Independent stdin checks cover 120001 integer millisecond values, neighbouring doubles, scientific notation, negative values and year handling; these are diagnostic evidence, not production native-engine acceptance.

Public RDF/ORM regressions pass 27 tests across datetime insertion, linked-schema aliases, exact adjacent millisecond comparisons, offset instants, submillisecond compatibility, ascending/descending pagination and reverse identity order. Dependency-state check and production TypeScript build exit 0. The first actual repair probe passes initial window pages 7 and 2, then exactly one newly written event; the final compatibility patch also passes a fresh disposable Gateway with pages 7, 2, and then one new event (gateway-grant-source-diagnostic-20df0601-2691-4ef1-a3bf-894df377521a/result.json). No complete migration or current user Gateway pass is claimed.

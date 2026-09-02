# CSS SPARQL Endpoint Bug: OPTIONAL Clause Fails on Independent Files

## Summary

CSS SPARQL endpoint has a critical bug where OPTIONAL clauses fail when querying data stored in **independent files**, but work correctly when querying data stored as **fragments in the same file**.

## Environment

- **CSS Version**: Community Solid Server (xpod fork, based on CSS 7.x)
- **Storage Backend**: Quadstore (PostgreSQL)
- **SPARQL Endpoint**: `/.data/chat/-/sparql` (sidecar endpoint with prefix matching)
- **Query Engine**: Comunica (via CSS)

## Bug Description

### Symptom

SPARQL queries with OPTIONAL clauses return **0 results** when querying data stored in independent files, even though:
1. The data exists in the Pod
2. The same query without OPTIONAL returns correct results
3. The SPARQL syntax is valid

### Root Cause

The bug is related to how CSS/Comunica handles OPTIONAL clauses when querying across **multiple independent files** vs **fragments within a single file**.

## Reproduction

### Test Setup

We have two types of RDF data storage:

**Type A: Fragments in Same File** (Thread)
```
/.data/chat/cli-default/index.ttl
  #thread-1  (fragment)
  #thread-2  (fragment)
  #thread-3  (fragment)
```

**Type B: Independent Files** (Message - OLD)
```
/.data/chat/cli-default/
  msg-1.ttl#msg-1
  msg-2.ttl#msg-2
  msg-3.ttl#msg-3
```

**Type C: Fragments in Date-Grouped File** (Message - NEW)
```
/.data/chat/cli-default/2026/03/04/messages.ttl
  #msg-1  (fragment)
  #msg-2  (fragment)
  #msg-3  (fragment)
```

### Test Case 1: Query Type A (Fragments in Same File) - WORKS

```sparql
PREFIX sioc: <http://rdfs.org/sioc/ns#>
PREFIX udfs: <https://undefineds.co/ns#>
SELECT ?thread ?createdAt WHERE {
  ?thread a sioc:Thread ;
          sioc:has_parent <http://localhost:5739/test/.data/chat/cli-default/index.ttl#this> .
  OPTIONAL { ?thread udfs:createdAt ?createdAt . }
}
```

**Result**: ✓ Returns 40 threads (but filters out 17 without createdAt)

### Test Case 2: Query Type B (Independent Files) - FAILS

```sparql
PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
PREFIX sioc: <http://rdfs.org/sioc/ns#>
PREFIX udfs: <https://undefineds.co/ns#>
SELECT ?msg ?role ?content WHERE {
  ?msg a meeting:Message ;
       sioc:has_container <http://localhost:5739/test/.data/chat/cli-default/index.ttl#thread-xxx> .
  OPTIONAL { ?msg udfs:role ?role . }
  OPTIONAL { ?msg sioc:content ?content . }
}
```

**Result**: ✗ Returns 0 messages (even though data exists)

### Test Case 3: Query Type C (Date-Grouped File) - WORKS

```sparql
PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
PREFIX sioc: <http://rdfs.org/sioc/ns#>
PREFIX udfs: <https://undefineds.co/ns#>
SELECT ?msg ?role ?content WHERE {
  ?msg a meeting:Message ;
       sioc:has_container <http://localhost:5739/test/.data/chat/cli-default/index.ttl#thread-xxx> .
  OPTIONAL { ?msg udfs:role ?role . }
  OPTIONAL { ?msg sioc:content ?content . }
}
```

**Result**: ✓ Returns 2 messages correctly

## Test Results Summary

| Storage Type | OPTIONAL Query | Required Query | Conclusion |
|--------------|----------------|----------------|------------|
| Fragments in same file (Thread) | ✓ 40 results | ✓ 57 results | OPTIONAL works but filters records |
| Independent files (Message OLD) | ✗ 0 results | ✓ 2 results | OPTIONAL completely fails |
| Date-grouped file (Message NEW) | ✓ 2 results | ✓ 2 results | OPTIONAL works correctly |

## Detailed Test Scripts

All test scripts are available in the repository:

1. **`scripts/test_optional_issue.js`** - Demonstrates OPTIONAL failure
2. **`scripts/test_which_optional.js`** - Tests each OPTIONAL field individually
3. **`scripts/test_optional_workarounds.js`** - Tests various workarounds
4. **`scripts/test_dategroup_storage.js`** - Verifies fix with date-grouped files
5. **`scripts/compare_exact_sparql.js`** - Compares drizzle-solid vs manual SPARQL

### Key Test Output

```bash
$ node scripts/test_optional_issue.js

=== Test 1: Simple query (no OPTIONAL) ===
Result: 1 messages

=== Test 2: With ONE OPTIONAL ===
Result: 0 messages

=== Test 3: With ALL OPTIONAL (drizzle-solid full query) ===
Result: 0 messages

=== Test 4: FILTER BEFORE OPTIONAL ===
Result: 0 messages

✗ CONFIRMED: OPTIONAL clauses break the query!
This is likely a SPARQL endpoint bug or query optimization issue.
```

## Expected Behavior

OPTIONAL clauses should work consistently regardless of whether data is stored in:
- Independent files
- Fragments in the same file
- Date-grouped files

## Actual Behavior

OPTIONAL clauses:
- **Fail completely** (return 0) on independent files
- **Work but filter records** on fragments in same file
- **Work correctly** on date-grouped files

## Workaround

We changed Message storage from independent files to date-grouped files:

**Before** (broken):
```typescript
subjectTemplate: '{chatId}/{id}.ttl#{id}'
// Results in: cli-default/msg-1.ttl#msg-1
```

**After** (working):
```typescript
subjectTemplate: '{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}'
// Results in: cli-default/2026/03/04/messages.ttl#msg-1
```

This workaround confirms the issue is specifically with **independent files**, not OPTIONAL itself.

## Impact

This bug affects:
1. **drizzle-solid** - ORM for Solid Pods that generates OPTIONAL queries by default
2. **Any application** querying Solid Pods with OPTIONAL clauses on data in independent files
3. **Data modeling decisions** - forces developers to use grouped files instead of independent files

## Possible Root Causes

1. **Comunica query optimization** - May optimize OPTIONAL differently for distributed queries
2. **CSS sidecar endpoint** - May not correctly handle OPTIONAL across multiple files
3. **Quadstore indexing** - May not index OPTIONAL patterns correctly for independent files

## Request

Please investigate why OPTIONAL clauses fail on independent files but work on grouped files. This is a critical bug that affects data modeling decisions and forces workarounds.

## Additional Context

- Full investigation: `docs/sparql-optional-bug.md`
- Fix documentation: `docs/sparql-optional-bug-fix.md`
- Repository: https://github.com/undefinedxyz/xpod (private, can provide access)

## Related Issues

- drizzle-solid #4: FILTER placement bug (fixed in 0.2.10)
- This issue: OPTIONAL clause fails on independent files (new discovery)

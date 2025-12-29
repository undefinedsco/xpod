# W3C SPARQL 1.1 Query Test Suite

This repo uses the official W3C SPARQL 1.1 Query Test Suite as the standard
conformance baseline for SPARQL query behavior. We download it into a local
folder to keep it independent from the codebase.

## Download

Use the provided script to fetch the suite:

```bash
./scripts/fetch-w3c-sparql-query-suite.sh
```

Default location:

```
third_party/w3c-sparql11-test-suite
```

You can override the defaults:

```bash
REPO_URL=... TARGET_DIR=... ./scripts/fetch-w3c-sparql-query-suite.sh
```

## Notes

- The suite lives outside the repo and is ignored by git via `third_party/`.
- Use this suite as the primary SPARQL query correctness benchmark.

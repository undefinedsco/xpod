# W3C SPARQL 1.1 Update Test Suite

This repo uses the official W3C SPARQL 1.1 Update Test Suite as the standard
baseline for SPARQL update correctness.

## Download

Use the provided script to fetch the suite:

```bash
./scripts/fetch-w3c-sparql-update-suite.sh
```

Default location:

```
third_party/w3c-sparql11-test-suite
```

You can override the defaults:

```bash
REPO_URL=... TARGET_DIR=... ./scripts/fetch-w3c-sparql-update-suite.sh
```

## Notes

- The suite lives outside the repo and is ignored by git via `third_party/`.
- Query and Update test suites share the same upstream repo.

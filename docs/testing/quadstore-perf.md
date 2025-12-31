# quadstore-perf (Performance Benchmark)

We use the official quadstore benchmark suite to keep performance evaluation
aligned with upstream quadstore expectations.

Repo: https://github.com/quadstorejs/quadstore-perf

## Download

```bash
./scripts/fetch-quadstore-perf.sh
```

Default location:

```
third_party/quadstore-perf
```

You can override the defaults:

```bash
REPO_URL=... TARGET_DIR=... ./scripts/fetch-quadstore-perf.sh
```

## Notes

- The suite lives outside the repo and is ignored by git via `third_party/`.
- Use it as the primary performance benchmark for quadstore-backed workloads.

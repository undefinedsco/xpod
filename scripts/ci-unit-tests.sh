#!/usr/bin/env bash
# CI scope of the vitest unit suite.
#
#   ci-unit-tests.sh main [i/n]   the unit suite minus the slow group below, optionally
#                                 only vitest shard i of n (CI `unit` job matrix)
#   ci-unit-tests.sh slow         only the slow group (CI `integration-lite` job, in parallel)
#
# The slow group is a third of unit-test time: in-process PGlite RDF engine suites and
# the full runtime suite. Both jobs are required checks, so nothing becomes optional.
#
# On a pull request that touches no pipeline, release or build files, tests/scripts
# (contract tests of workflows, release gates and admission records) runs only where
# the change reaches it through imports (`vitest --changed`). Pushes run everything.
set -euo pipefail

mode="${1:?usage: ci-unit-tests.sh main [i/n] | slow}"
shard=()
if [ -n "${2:-}" ]; then
  [[ "$2" =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]] || { echo "invalid shard: $2" >&2; exit 64; }
  # A shard may receive no file of a narrow selection; the other shards still gate it.
  shard=(--shard="$2" --passWithNoTests)
fi
slow_filters=(tests/storage/rdf/PostgresRdf tests/runtime/XpodRuntime.integration.test.ts)
# vitest takes a single --exclude, so the globs are joined into one brace pattern.
slow_excludes='tests/storage/rdf/PostgresRdf*,tests/runtime/XpodRuntime.integration.test.ts'

if [ "$mode" = slow ]; then
  exec bun run test:run "${slow_filters[@]}"
fi
[ "$mode" = main ] || { echo "unknown mode: $mode" >&2; exit 64; }

pipeline_paths='^(\.github/|scripts/|tests/scripts/|qlever/|docker/|desktop/|config/|patches/|packages/|Dockerfile|package\.json$|bun\.lock$)'
scoped=false
if [ "${EVENT_NAME:-}" = pull_request ] && [ -n "${BASE_SHA:-}" ] \
  && changed="$(git diff --name-only "$BASE_SHA"...HEAD)" && [ -n "$changed" ] \
  && ! grep -Eq "$pipeline_paths" <<<"$changed"; then
  scoped=true
fi

if ! "$scoped"; then
  exec bun run test:run ${shard[@]+"${shard[@]}"} --exclude "{$slow_excludes}"
fi

echo "No pipeline files changed: tests/scripts runs only where the change reaches it." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
bun run test:run ${shard[@]+"${shard[@]}"} --exclude "{$slow_excludes,tests/scripts/**}"
bun run test:run ${shard[@]+"${shard[@]}"} --changed "$BASE_SHA" --passWithNoTests tests/scripts

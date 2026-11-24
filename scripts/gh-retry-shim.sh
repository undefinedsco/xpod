#!/usr/bin/env bash
# `gh` stand-in for release workflows: retries idempotent reads when GitHub answers
# with a transient failure (5xx, reset, timeout). A single 502 used to fail a whole
# candidate or release attempt. Writes and every other call go straight to the real
# CLI. Output of a failed attempt is discarded, so a retried read never emits twice.
# Install with scripts/install-gh-retry.sh; XPOD_REAL_GH names the real binary.
set -uo pipefail

real="${XPOD_REAL_GH:?XPOD_REAL_GH must name the real gh binary}"
attempts="${XPOD_GH_RETRY_ATTEMPTS:-5}"
delay="${XPOD_GH_RETRY_DELAY_SECONDS:-5}"

retryable=false
case "${1-}" in
  api)
    retryable=true
    # Anything that may send a body or a non-GET method is a write.
    for arg in "$@"; do
      case "$arg" in
        -X|--method|--method=*|-X?*|-f|-F|--field|--field=*|--raw-field|--raw-field=*|--input|--input=*) retryable=false ;;
      esac
    done
    ;;
  run|release)
    case "${2-}" in list|view|download) retryable=true ;; esac
    ;;
esac
"$retryable" || exec "$real" "$@"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/gh-retry.XXXXXX")"
trap 'rm -rf "$work"' EXIT
attempt=1
while :; do
  "$real" "$@" > "$work/out" 2> "$work/err"
  status=$?
  if [ "$status" -eq 0 ]; then
    cat "$work/out"
    cat "$work/err" >&2
    exit 0
  fi
  if [ "$attempt" -ge "$attempts" ] || ! grep -Eqi \
    'HTTP 5[0-9]{2}|server error|connection reset|i/o timeout|tls handshake timeout|unexpected EOF|context deadline exceeded|stream error' \
    "$work/err"; then
    cat "$work/out"
    cat "$work/err" >&2
    exit "$status"
  fi
  printf 'gh: transient failure on attempt %s of %s; retrying in %ss\n' "$attempt" "$attempts" "$delay" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done

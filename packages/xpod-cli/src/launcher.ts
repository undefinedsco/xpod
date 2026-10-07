/** Select once before executing; command failures never trigger another runtime. */
export function externalRuntimeLauncher(): string {
  return [
    '#!/bin/sh',
    'SELF=$0',
    'LINKS=0',
    'while [ -L "$SELF" ]; do',
    '  LINKS=$((LINKS + 1))',
    '  [ "$LINKS" -le 40 ] || { printf "%s\\n" "Xpod CLI launcher symlink cycle" >&2; exit 1; }',
    '  BASE="$(CDPATH= cd "$(dirname "$SELF")" && pwd)" || exit 1',
    '  LINK="$(readlink "$SELF")" || exit 1',
    '  case $LINK in /*) SELF=$LINK;; *) SELF=$BASE/$LINK;; esac',
    'done',
    'DIR="$(CDPATH= cd "$(dirname "$SELF")/.." && pwd)" || exit 1',
    'if command -v bun >/dev/null 2>&1; then',
    '  exec bun "$DIR/lib/xpodcli.mjs" "$@"',
    'elif command -v node >/dev/null 2>&1; then',
    '  exec node "$DIR/lib/xpodcli.mjs" "$@"',
    'fi',
    'printf "%s\\n" "Xpod CLI requires installed Bun >= 1.3.8 or Node.js >= 22" >&2',
    'exit 127',
    '',
  ].join('\n');
}

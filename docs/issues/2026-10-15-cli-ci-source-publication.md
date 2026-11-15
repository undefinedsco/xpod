# CLI preview source staging and Windows publication listing

CI run 38701067661 exposes two independent producer failures.

The preview build copies canonical CLI and AFS source into its hermetic tree,
but leaves the newer `@undefineds.co/xpod-client` imports unresolved there. Bun
then follows the workspace dependency into checkout SDK dist files. The notice
collector correctly rejects these files outside its staging/dependency boundary.
The local project-notice test reproduces the same failure. The fix must stage
canonical SDK source, bind its actual public exports and preserve that source in
application materials; the collector's outside-path rejection must remain intact.

Windows fails while reading the normal SDK tar listing. The existing parser
splits only LF, so a CRLF listing leaves CR in each member and fails its safety
check. CI did not retain the offending member bytes, so CRLF is a reproducible
parser defect rather than a claim about the exact unrecorded Windows member.
Only listing line delimiters may be decoded. Archive member names, backslashes,
control characters, traversal and duplicate-member checks remain strict, with
the actual archive independently checked against its exact inventory.

POSIX local regressions and Windows-shaped listing cases do not replace the
next real Windows CI run. No node_modules patch or broad source-boundary bypass
is part of either correction.

The real local external-cwd gate also exposed the CLI-owned public `output`
entry resolving to workspace dist; it now binds to staged `src/lib/output.ts`.
With both source boundaries fixed, Bun no longer emits the unused `__toESM`
helper block. The new 755-byte prefix is byte-for-byte the prior audited
1867-byte prefix minus that block and its exclusively used declarations.
The same pinned Bun runtime/ParseTask source attribution remains; the preview
profile records the new exact prefix hash and retained helper line numbers.
The collector still rejects any other prefix.

Local verification: original external-cwd failure retained; corrected notice
test passes (2 tests, 30 assertions), normal tools/SDK/CLI builds exit zero,
and CLI preview suite passes (94 tests, 813 assertions). Real Windows CI and
the integration owner's full repository regression remain separate gates.

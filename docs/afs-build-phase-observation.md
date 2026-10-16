# AFS build phase observations

The original lifetime regression shares one 180-second deadline between a fresh
client build and a fresh module build. A timed-out Darwin x64 run last printed
the Components.js start message; that alone cannot identify whether the child
was still running or had returned into materials, notices or native packaging.

The existing driver and builders now write bounded JSON start/end events to
their existing stderr stream. Named phases cover CLI pack/extraction, producer
materials, declarations, library/command bundling, Components.js, notices and
native/source/package archives. Commands retain the same executable, arguments,
cwd, inherited environment and inherited stdio. Their awaited runner records
actual exit and close events separately, including native startup errors. It
does not complete on exit alone. No child group or descendant closure is inferred.

Events include elapsed wall time and optional resource-usage deltas for the
emitting process only. Those deltas exclude child CPU and cannot by themselves
prove an I/O, CPU or environment cause. Arguments are the existing build paths
and switches; environment variables and arbitrary error messages are not logged.
Each process caps events at 256, each line at 8 KiB and total observation output
at 64 KiB. Short/failed writes fail observation; an operation failure remains
the primary error alongside any observation secondary. These are diagnostics,
not artifact admission facts or a general secret-redaction facility.

Cleanup has a separate obligation-preserving path. It always attempts the real
cleanup even if its start event cannot be written. Build primary, actual cleanup
failure, and start/end observation errors are preserved together; diagnostics
never silently bypass cleanup. Ordinary build phases still fail before starting
their operation when the start observation fails.

No new timeout, retry, producer cache, parallel build or runtime fallback is
introduced. The outer lifetime owner still cancels/drains the original process
group, and all original source/payload checks and fresh build boundaries remain.
Small fixtures exercise phase errors, child exit/close separation and output
bounds. Actual producer performance still requires new immutable-source evidence.

The lifetime test's progress file indexes the original stdout/stderr by timestamp
and observed byte count. It does not embed repeated raw tails. The original raw
files still contain every phase event and are exported with closed receipt hashes;
byte indexes are live observations, not a claim of child closure. Each summary is
at most 160 encoded bytes including its newline, with the existing 512 sample
attempts. A start row is at most 16 KiB. Thus nonterminal records occupy at most
96 KiB (16 KiB + 512 × 160 B), leaving 32 KiB for the final event inside the
unchanged 128 KiB progress cap. These are enforced byte limits. Oversize records,
short writes, fsync/close errors or command failures still reject acceptance and
retain the original error. The final diagnostic receipt is attempted independently.
No raw limit, sampling frequency, deadline or export budget is increased.

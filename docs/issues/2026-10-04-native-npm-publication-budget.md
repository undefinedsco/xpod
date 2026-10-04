# Native npm publication body exceeded the registry request capacity

On 2026-10-04, the signed `v0.4.23` release at
`b87b0a2614e32aed28c7085fb2961fd8a3f08fdc` passed RC run
[37210313043](https://github.com/undefinedsco/xpod/actions/runs/37210313043).
Stable run [37212086744](https://github.com/undefinedsco/xpod/actions/runs/37212086744)
then failed publishing `@undefineds.co/xpod-darwin-arm64`: npm reported a
213.6 MB gzip tarball, 331.2 MB unpacked, 199 files, and registry.npmjs.org
returned `E413 Payload Too Large`. The response exposed no numeric server
limit. Do not describe a guessed limit as an npm guarantee.

The root JavaScript package had no platform leakage: its actual stable
preflight was 8,776,729 bytes packed and 39,957,948 bytes unpacked. Platform
files were the 170.8 MB Xpod executable, the fixed 78,012,509-byte corresponding
source archive, QLever and its required ICU/crypto/SQLite dylibs, the 174 embedded
documentation inputs, metadata and licenses. These are runtime/source material;
removing the source offer or native libraries would violate the release contract.

The missing gate was the platform publication size. Root `check-pack-json`
budgets did not cover it, and RC desktop runtime verification did not measure
the eventual npm request. npm serializes the gzip tarball as base64 in its JSON
attachment, adding roughly one third before package metadata.

The recovery uses `0.4.24`, retaining the signed failed `v0.4.23` tag and its
source. The runtime manifest codec changes losslessly from gzip to built-in
Brotli quality 9; the fixed external source archive/pin remains byte-for-byte
unchanged. A complete local manifest measured 312,289,558 raw bytes,
80,817,459 gzip bytes and 54,771,906 Brotli bytes, with an exact round trip.
Those measurements are diagnostic, not proof that a registry accepted a package.

Platform construction now measures `npm pack --dry-run --json` including every
runtime/source file, saves the pack metadata even on budget failure, and rejects
more than 180 MiB tarball or 240 MiB publication body including a separate
64 KiB metadata reserve. These are **project budgets**, not documented npm
server limits. RC and stable upload the measured pack/budget evidence. A real
tarball and a local npm publication request must independently confirm the
measurement; successful public npm publication and clean consumers remain
separate stable gates.

Compiled bootstrap regression covers exact extracted bytes, executable mode,
normal/internal argv, cold and warm cache, archive checksum mismatch and
corrupt Brotli rejection on Bun 1.4.2. Warm cache keeps the existing ready-marker
behavior; this change does not add integrity checks for every cached file.

At the failed `0.4.23` stable run, all seven shared packages were published and
verified at their declared versions (`shared-ui`, `extension-sdk`, `solid-sdk`
0.1.1; `pod-settings`, `tasks`, `ai-connections`, `pod-collections` 0.1.0).
Root/native `0.4.23` were absent and their latest/staging tags stayed `0.4.20`.
Root Node/Bun consumer jobs, npm latest, GHCR promotion, production deployment,
stable desktop and GitHub Release were skipped. A passed RC or published shared
packages must not be reported as a completed `0.4.23` release.


Recovery shared-package versions must also advance: the existing packer embeds
`gitHead` equal to the accepted source SHA, and publication requires exact
registry tarball integrity. The new `0.4.24` SHA therefore cannot occupy the
already-published `0.4.23` shared versions, even when their runtime code is
unchanged. Recovery versions are `shared-ui`, `extension-sdk`, `solid-sdk`
0.1.2 and `pod-settings`, `tasks`, `ai-connections`, `pod-collections` 0.1.1.
The exact-SHA and immutable-integrity guards remain intact.

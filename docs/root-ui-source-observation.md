# Legacy root build UI source observation

The original root UI build replaces tracked assets whose names contain content
hashes. Its existing Vite observation declares exact output names for the three
UI targets. A strict normal-producer source snapshot must still reject any
missing tracked input. Root compatibility needs to represent the build's known
UI deletions before producing the original private registry supply.

The parent lane retains its actual successful root-build outcome and closed raw
hashes, source SHA and clean-before status, original packed root bytes, exact
post-build Git status, original per-target UI observation files and current
emitted-file byte hashes. The child verifies these before taking its snapshot.
It requires the baseline to equal the actual Git tracked UI paths, rehashes the
original observations, matches their exact declarations and validates every
current emitted output. Missing non-UI files, extra deletions, wrong source,
changed status, missing raw logs and changed observations or output bytes fail.

Only the exact verified deleted paths reach the optional snapshot observation.
A missing row records `missing: true`, `matchesGit: false` and the separate
`trackedGitBlob` index identity. It has no current `bytes`, `sha256` or `gitBlob`.
Present files keep their actual measured contents. The shared snapshot's default
remains strict; normal producers do not receive this root-specific observation.
The same full validation and snapshot run again after normal packing and before
consumption. No static subtree is ignored, and Git contents never replace a
missing current file. These local tests use a tiny real Git repository and
synthetic parent build records; they are not a real root product build or CI pass.

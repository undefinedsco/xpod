# Debian 13 signature originals

Official inputs acquired 2026-10-18 by bounded identity HTTP with redirects forbidden; all three keys come from https://ftp-master.debian.org/keys/ and suite InRelease inputs from Debian official mirrors. SHA/size are fixed by originals.index.json and the reviewed key policies.

An independent Linux probe used existing immutable image sha256:9e7f8a12c959532cff8b6e193dadf31c8bb192253d1bde30a155a77d82e7f652, network disabled/read-only/capabilities dropped; gpgv 2.2.40/libgcrypt 1.10.1. Existing owned command/supervisor captured actual wait, closed stdout/stderr, supervision raw, and gpgv-produced plaintext. Actual exit is 2 in every suite: approved Debian 13 VALIDSIG is present, while the exact Debian 12 co-signature lacks a key and has no authority. No exit is rewritten.

The keyring is derived solely from the three retained 13 armor originals. These fixtures exercise the unique policy/bridge; they do not issue a private SDK capability, prove LLVM licensing, or accept a release. Full Linux originals remain in the Root trixie-gpgv-root-v1 evidence directory.

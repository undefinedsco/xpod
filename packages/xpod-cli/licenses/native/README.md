# Pinned native dependency supplements

These unmodified texts supplement the Cargo target/features inventory. They do
not replace the remaining full notice inventory or clear the public release gate.

- `LICENSE-turso.md`: MIT, copyright 2024 the Turso authors. The nine Turso
  0.4.4 crates' `.cargo_vcs_info.json` identify
  [commit dc7781a52b888e323bb12e76c2793d3bab5f9106](https://github.com/tursodatabase/turso/blob/dc7781a52b888e323bb12e76c2793d3bab5f9106/LICENSE.md).
  SHA-256: `b646f9ee8bcaf87e8de75153b9df7a2861c7ac445c87e741768b3c2bccf47bc5`.
- `LICENSE-simsimd.txt`: Apache-2.0 from SimSIMD 6.5.16's
  [release source commit fb7cbdda3d187e4875cef71f2d16c1b739bff38f](https://github.com/ashvardanian/SimSIMD/blob/fb7cbdda3d187e4875cef71f2d16c1b739bff38f/LICENSE).
  SHA-256: `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.
- `LICENSE-libaegis.txt`: MIT, copyright 2023–2026 Frank Denis, from
  [libaegis commit 3992508d3c9dfd87ed7ed769e65bb26a9281e592](https://github.com/jedisct1/libaegis/blob/3992508d3c9dfd87ed7ed769e65bb26a9281e592/LICENSE).
  Aegis 0.9.20's source commit pins this C submodule. The tested Linux target
  compiles it; the tested macOS target uses `pure-rust`.
  SHA-256: `2239900b73e88ac9f37bd9fdf5d668fa67862645b983fc2ee5a4c20095aa5fe7`.

The public target inventories and remaining gaps are recorded in
`docs/agentfs-license-evidence.md`. Source package paths in the research cache
are not required to read these distributed files.

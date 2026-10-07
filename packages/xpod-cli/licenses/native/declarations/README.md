# Pinned release declarations and selected terms

`index.json` is the single supplement registry. It binds AgentFS's selected
commit, package/version identities, exact original declaration bytes, source
archive hashes where applicable, and the chosen license alternative.

AgentFS's project README declares MIT; its Rust SDK manifest declares MIT.
The three registry manifests retain `MIT`, `MIT/Apache-2.0` and
`Zlib OR Apache-2.0 OR MIT` exactly. We select the MIT alternative for these
supplements. Their archive and VCS identities were independently checked;
see [source evidence](../../../../../docs/native-missing-notice-source-evidence.json).

The MIT text is the unmodified SPDX v3.27.0 standard template, with literal
copyright placeholders. It is explicitly **standard text**, not an upstream
copyright notice. No holder or year is invented. The original README and
Cargo manifests remain intact, including any original authors/metadata.
Author metadata is not relabeled as a copyright statement.

All material is content-addressed under `objects/`. The packager checks every
byte hash, declared license text, selected alternative, engine source commit
and package/version in the audited target inventory before copying output.
The manifest binds the index hash and every copied object. Install verification
repeats source/material validation and refuses unmanifested objects.

These supplements accompany the original native notice collection and the
separately vendored fuser, nfsserve, Turso, SimSIMD and Linux libaegis notices.
They do not replace actual notices or establish whole-helper/Bun runtime
release clearance. An absent root LICENSE filename is informational; missing
or mismatched required material still fails the public gate.

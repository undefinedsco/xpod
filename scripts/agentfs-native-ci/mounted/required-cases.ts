/** Pure mounted case identities shared by runtime and original-only validation. */
/**
 * The SIX actual cases that MUST be observed PASSED for a mounted success:
 * four from the matrix and two from the original overlay scenario. A summary
 * count alone is insufficient — a real mounted case could silently skip.
 */
export const REQUIRED_MOUNTED_CASES = [
  'passes the original mounted harness for the platform backend',
  'consumes mounted content through ordinary shell, PATH rg and Git with host-local metadata and a mounted worktree',
  'streams disk-backed 64/512/1024 MiB remote bodies with Range, in-place copy-up and sampled helper RSS',
  'interrupts a genuinely in-flight remote copy-up, then recovers the same session and GCs the orphan partial',
  'keeps uncommitted edits local, recovers them across restart, then writes back on commit',
  'keeps a 412 conflict dirty and preserves the first baseline',
] as const;


export const MODULE_CHAIN_CASE = 'mounts through the installed core and AFS module with public-client authentication, then closes its proxy and kernel mount';

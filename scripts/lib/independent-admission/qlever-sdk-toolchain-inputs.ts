import limits from '../module-artifact-limits.json';

/** Pure obligation discovery, not an issuer or source-closure verifier. Feed the
 * complete already-custodied raw shards, preserving each original's line order.
 * Pointer-valued syscall arguments never identify an executable/file original. */
type OriginalLine = Readonly<{path: string; line: number; bytes: Buffer}>;
type Location = Readonly<{path: string; line: number; sequence: number; phase: string; pid: number}>;
const policies = new Map<number, Readonly<{exec: readonly number[]; mmap: number; protect: readonly number[]}>>([
  [0xc000003e, {exec: [59, 322], mmap: 9, protect: [10,329]}],
  [0xc00000b7, {exec: [221, 281], mmap: 222, protect: [226,288]}],
]);
const need = (value: unknown, reason: string): void => {if (!value) throw Error('SDK toolchain input obligations: ' + reason);};
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function inspectSdkToolchainInputRequirements(lines: Iterable<OriginalLine>, check: () => void) {
  const executions: Readonly<Location & {entrySequence: number; syscall: number}>[] = [];
  const mappings: Readonly<Location & {entrySequence: number; fd: number; offset: number; length: number; protection: number; exitSequence: number; returnedAddressHex: string}>[] = [];
  const candidates = new Map<number, any>();
  const pending = new Set<string>();
  let last = 0, total = 0, executableProtectionChanges = 0, anonymousExecutableMappings = 0;
  for (const original of lines) {
    check(); total += original.bytes.length;
    need(original.bytes.length > 0 && original.bytes.length <= limits.rangeBytes && total <= limits.sourceMaterialBytes, 'raw byte domain bound');
    need(typeof original.path === 'string' && original.path.length > 0 && natural(original.line) && original.line > 0, 'original location required');
    need(original.bytes[original.bytes.length - 1] === 10 && !original.bytes.subarray(0, -1).includes(10), 'one complete raw JSONL record required');
    const row = JSON.parse(original.bytes.toString('utf8'));
    need(natural(row.sequence) && row.sequence === last + 1 && typeof row.phase === 'string' && ['configure', 'compile'].includes(row.phase), 'complete ordered phase raw universe required'); last = row.sequence;
    const at = (): Location => {need(natural(row.pid) && row.pid > 0, 'actual process identifier required'); return Object.freeze({path: original.path, line: original.line, sequence: row.sequence, phase: row.phase, pid: row.pid});};
    if (row.kind === 'kernel-syscall' && row.op === 'entry') {
      const policy = policies.get(row.arch); need(policy && natural(row.nr) && Array.isArray(row.args) && row.args.length === 6 && row.args.every((value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0), 'reviewed kernel syscall ABI required');
      if (policy!.exec.includes(row.nr)) {
        need(!candidates.has(row.pid), 'prior relevant syscall has no actual exit'); candidates.set(row.pid, {kind: 'exec', row, location: at()});
      } else if (row.nr === policy!.mmap) {
        need(!candidates.has(row.pid), 'prior relevant syscall has no actual exit'); candidates.set(row.pid, {kind: 'mmap', row, location: at()});
      } else if (policy!.protect.includes(row.nr) && (row.args[2] & 4) !== 0) {
        need(!candidates.has(row.pid), 'prior relevant syscall has no exit'); candidates.set(row.pid, {kind:'protect',row,location:at()});
      }
    } else if (row.kind === 'ptrace-event' && row.event === 4) {
      const entry = candidates.get(row.pid); need(entry?.kind === 'exec' && entry.row.phase === row.phase, 'successful exec stop lacks actual matching entry');
      executions.push(Object.freeze({...at(), entrySequence: entry.row.sequence, syscall: entry.row.nr})); candidates.delete(row.pid);
    } else if (row.kind === 'kernel-syscall' && row.op === 'exit') {
      const entry = candidates.get(row.pid);
      if (entry && row.entrySequence === entry.row.sequence) {
        need(Number.isSafeInteger(row.result) && typeof row.isError === 'boolean', 'actual syscall result required');
        if (entry.kind === 'exec') need(row.isError && row.result < 0, 'successful exec syscall lacks actual exec-stop original');
        else if (entry.kind==='protect') {if(!row.isError&&row.result===0)executableProtectionChanges++;}
        else if (!row.isError && row.result >= 0) {
          const args = entry.row.args;need([args[1],args[2],args[4],args[5]].every(natural),'exact file mapping dimensions required');
          if ((args[3]&0x20)!==0) {if((args[2]&4)!==0)anonymousExecutableMappings++;}
          else {need(args[4]<0x80000000,'actual file mapping FD unavailable');mappings.push(Object.freeze({...entry.location, entrySequence: entry.row.sequence, fd: args[4], offset: args[5], length: args[1], protection: args[2],exitSequence:row.sequence,returnedAddressHex:row.result.toString(16)}));}
        }
        candidates.delete(row.pid);
      }
    } else if (row.kind === 'actual-wait-exit') need(!candidates.has(row.pid), 'process ended with unresolved relevant syscall');
    need(executions.length + mappings.length <= limits.sourceMembers, 'toolchain operation count bound');
  }
  need(candidates.size === 0, 'unfinished relevant syscall universe');
  need(executions.length > 0, 'actual successful execution universe unavailable');
  pending.add('toolchain-actual-executable-FD-bytes-and-ELF-interpreter-originals-unavailable');
  if (mappings.length) pending.add('toolchain-actual-file-mapping-FD-bytes-and-loader-dependency-originals-unavailable');
  if (anonymousExecutableMappings) pending.add('toolchain-anonymous-or-JIT-executable-mapping-source-unavailable');
  if (executableProtectionChanges) pending.add('toolchain-executable-memory-protection-to-file-mapping-causality-unavailable');
  pending.add('toolchain-installed-bytes-to-signed-Debian-binary-package-and-source-tuple-unverified');
  const result = {scope: 'actual raw exec-stop and successful file-mapping obligations only', executions: Object.freeze(executions), mappings: Object.freeze(mappings), executableProtectionChanges, anonymousExecutableMappings, rawBytes: total, pending: Object.freeze([...pending]), toolchainSourceClosureVerified: false as const};
  need(Buffer.byteLength(JSON.stringify(result)) <= limits.metadataBytes, 'bounded obligation projection required');
  return Object.freeze(result);
}

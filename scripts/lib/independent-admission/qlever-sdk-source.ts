import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import limits from '../module-artifact-limits.json';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { captureLegalFileIdentity, assertLegalFileIdentity } from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u;
const HELPER_SHA = 'dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c';
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('QLever SDK source: ' + reason); }
/** SDK byte/source-set facts only. The one central SDK private binding is
 * required; no JSON can reconstruct it, or authorize a native/release gate. */
export function inspectQleverSdkSourceOriginals(capability: unknown): Readonly<{
  verified: false; pending: readonly string[]; facts: Readonly<Record<string, unknown>>;
}> {
  const pending = new Set<string>(), facts: Record<string, unknown> = {sdkSourceCompletenessVerified: false};
  try {
    const sdk = qleverSdkOriginalsView(capability); need(sdk, 'issued related SDK originals required');
    const deadline = Date.now() + limits.timeoutMs, members = new Map(sdk.members.map(row => [row.path, row]));
    const check = () => need(Date.now() < deadline, 'mechanical source observation deadline exceeded');
    const reference = (value: any) => {
      check(); const actual = members.get(value?.path);
      need(value && safe(value.path) && actual && actual.bytes === value.bytes && actual.sha256 === value.sha256 && SHA.test(actual.sha256), 'same SDK ZIP original reference required'); return actual;
    };
    const small = (value: any, maximum = limits.metadataBytes) => {
      const ref = reference(value); need(ref.bytes <= maximum, 'bounded SDK source metadata required');
      const bytes = sdk.readOriginal(ref.path, maximum); need(bytes.length === ref.bytes && hash(bytes) === ref.sha256, 'SDK source metadata bytes differ'); return bytes;
    };
    const master = JSON.parse(small(sdk.masterReference, 8 * 1024 ** 2).toString());
    need(master.identity.sourceSha === sdk.originFacts.sourceSha && master.identity.target === sdk.originFacts.target && master.kind === 'qlever-linux-sdk-originals', 'SDK master/source binding differs');
    if (!master.debianSources) {
      pending.add('qlever-sdk-exact-Debian-dsc-and-all-orig-debian-originals-unavailable');
      return Object.freeze({verified: false, pending: Object.freeze([...pending]), facts: Object.freeze(facts)});
    }
    const sources = JSON.parse(small(master.debianSources).toString());
    need(sources.schemaVersion === 1 && sources.kind === 'qlever-sdk-exact-debian-source-originals' && Array.isArray(sources.packages) && sources.packages.length > 0 && sources.packages.length <= 4096, 'SDK Debian source collection schema differs');
    const helper = fileURLToPath(new URL('../../../qlever/scripts/sdk-debian-source-materials.py', import.meta.url));
    const helperIdentity = captureLegalFileIdentity(helper); need(helperIdentity.size <= BigInt(limits.metadataBytes) && hash(readFileSync(helper)) === HELPER_SHA, 'reviewed controller source parser differs');
    const python = realpathSync('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python);
    const parse = (mode: '--parse-dsc' | '--parse-ledger', bytes: Buffer) => {
      check(); assertLegalFileIdentity(helperIdentity); assertLegalFileIdentity(pythonIdentity);
      const output = execFileSync(python, ['-I', '-S', '-B', helper, mode], {input: bytes, maxBuffer: limits.metadataBytes,
        timeout: Math.max(1, Math.min(15000, deadline - Date.now())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
      assertLegalFileIdentity(helperIdentity); assertLegalFileIdentity(pythonIdentity); check(); return JSON.parse(output.toString());
    };
    const ledger = parse('--parse-ledger', small(sources.sourceIdentities));
    const identities = new Set(Object.values(ledger).map((row: any) => row.source.name + '\0' + row.source.version));
    const context = JSON.parse(small(master.sourceContext).toString());
    let total = reference(context.archive).bytes;
    need(Array.isArray(master.inputs?.shards), 'actual SDK input shard references unavailable');
    for (const ref of master.inputs.shards) total += reference(ref).bytes;
    need(total <= limits.sourceMaterialBytes, 'SDK context/input source domains already exceed shared source budget');
    const seen = new Set<string>(); let sourceBytes = 0;
    for (const item of sources.packages) {
      const coordinate = item.name + '\0' + item.version;
      need(!seen.has(coordinate) && identities.has(coordinate), 'exact Debian source identity absent or repeated in actual dpkg ledger'); seen.add(coordinate);
      const dscRef = reference(item.dsc), dsc = parse('--parse-dsc', small(dscRef));
      need(dsc.name === item.name && dsc.version === item.version && path.posix.basename(dscRef.path) === item.name + '_' + item.version.replace(/^[0-9]+:/u, '') + '.dsc', 'actual dsc source/version differs');
      const parent = path.posix.dirname(dscRef.path);
      need(/^inner\/debian-source\/package-[0-9]{4}$/u.test(parent) && Array.isArray(item.files) && item.files.length === dsc.files.length, 'Debian original group/reference set differs');
      const expected = new Map<string, any>(dsc.files.map((row: any) => [row.name, row]));
      const names = new Set<string>([dscRef.path]); sourceBytes += dscRef.bytes;
      for (const value of item.files) {
        const ref = reference(value), relative = ref.path.slice(parent.length + 1), declared = expected.get(relative);
        need(ref.path.startsWith(parent + '/') && !names.has(ref.path) && declared && ref.bytes === declared.bytes && ref.sha256 === declared.sha256, 'all orig/debian archive bytes must match dsc SHA256 universe'); names.add(ref.path);
        need(ref.bytes <= limits.shardBytes, 'Debian source member exceeds fixed original bound');
        sourceBytes += ref.bytes;
        need(total + sourceBytes <= limits.sourceMaterialBytes, 'SDK context/input/Debian domains exceed shared source budget');
        const digest = createHash('sha256');
        for (let offset = 0; offset < ref.bytes; offset += limits.rangeBytes) {
          check(); const length = Math.min(limits.rangeBytes, ref.bytes - offset), bytes = sdk.readOriginalRange(ref.path, offset, length);
          need(bytes.length === length, 'Debian source original truncated'); digest.update(bytes);
        }
        need(digest.digest('hex') === declared.sha256, 'actual complete Debian source original hash differs');
      }
      const actual = sdk.members.filter(row => row.path.startsWith(parent + '/'));
      need(actual.length === names.size && actual.every(row => names.has(row.path)), 'unregistered extra Debian source original member');
      need(total + sourceBytes <= limits.sourceMaterialBytes, 'SDK context/input/Debian domains exceed shared source budget');
    }
    need(qleverSdkOriginalsView(capability) === sdk, 'SDK source custody changed');
    facts.sdkRelatedOriginalCustodyVerified = true; facts.debianDscAndAllSourceArchiveBytesVerified = true;
    facts.debianSourcePackageInstances = seen.size; facts.debianSourceOriginalBytes = sourceBytes;
    pending.add('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    pending.add('qlever-sdk-dpkg-ownership-to-actual-input-source-coverage-not-yet-verified');
    pending.add('qlever-sdk-generated-input-and-full-toolchain-source-causality-not-yet-verified');
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({verified: false, pending: Object.freeze([...pending]), facts: Object.freeze(facts)});
}

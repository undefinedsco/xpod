import { createHash } from 'node:crypto';
import { officialBun142RuntimeView } from './legal-bun-runtime';
/** Combines actual full snapshot identity with the one official-target issuer.
 * No caller data or foreign/controller executable is executed or registered. */
export function inspectAfsVerifierRuntimeOriginals(input: {
  readonly target: string; readonly executable: Readonly<{sha256: string; bytes: number}>;
  readonly originals?: readonly unknown[];
}): Readonly<{verified: boolean; pending: readonly string[]; facts: Readonly<Record<string, unknown>>}> {
  const pending: string[] = [], facts: Record<string, unknown> = {};
  try {
    const views = (input.originals ?? []).map(cap => ({cap, view: officialBun142RuntimeView(cap)})).filter(row => row.view?.target === input.target);
    if (views.length !== 1) throw Error('afs-fresh-target-Bun-official-original-missing-or-ambiguous');
    const {cap, view} = views[0]!;
    if (!view || view.version !== '1.4.2' || view.executableSha256 !== input.executable.sha256 || view.executableBytes !== input.executable.bytes)
      throw Error('afs-fresh-target-Bun-official-executable-bytes-differ');
    const checksums = view.readChecksums();
    if (createHash('sha256').update(checksums).digest('hex') !== view.checksumsSha256) throw Error('afs-fresh-target-Bun-checksums-original-differs');
    if (officialBun142RuntimeView(cap) !== view) throw Error('afs-fresh-target-Bun-custody-changed');
    facts.targetBunOfficialOriginalVerified = true;
    facts.targetBunVersion = view.version; facts.targetBunCommit = view.commit; facts.targetBunRevision = view.revision;
    facts.targetBunExecutableSha256 = view.executableSha256; facts.targetBunArchiveSha256 = view.archiveSha256;
  } catch (error) { facts.targetBunOfficialOriginalVerified = false; pending.push((error as Error).message); }
  return Object.freeze({verified: pending.length === 0, pending: Object.freeze(pending), facts: Object.freeze(facts)});
}

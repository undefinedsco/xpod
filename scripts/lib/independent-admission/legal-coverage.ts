import type { CollectedArtifactMember } from './artifact-contract';
export type LegalCoverageAxis = 'exact-source' | 'transpiled-source' | 'physical-original' | 'compiler-original';
export interface LegalCoverageEntry { path: string; sha256: string; bytes: number; axis: LegalCoverageAxis; original: string }
export interface LegalCoverageReport { entries: LegalCoverageEntry[]; uncovered: { path: string; reason: string }[]; complete: boolean }
/** A pure accounting primitive. It cannot issue source, original or permission
 * authority. The legal adapter adds an entry only after checking its real caps,
 * exact bytes, applicable original grant and retained notices. */
export class LegalCoverageLedger {
  private readonly members: Map<string, CollectedArtifactMember>;
  private readonly entries = new Map<string, LegalCoverageEntry>();
  public constructor(members: readonly CollectedArtifactMember[]) {
    if (members.length > 100000) throw Error('Legal coverage member budget exceeded');
    this.members = new Map(members.map(member => [member.path, member]));
    if (this.members.size !== members.length) throw Error('Duplicate legal coverage member');
  }
  public cover(path: string, axis: LegalCoverageAxis, original: string): void {
    const member = this.members.get(path); if (!member) throw Error('Coverage path is not an actual archive member');
    if (!original) throw Error('Coverage original binding required');
    if (!this.entries.has(path)) this.entries.set(path, { path, sha256: member.sha256, bytes: member.bytes, axis, original });
  }
  public report(): LegalCoverageReport {
    const uncovered = [...this.members.keys()].filter(name => !this.entries.has(name)).map(name => ({ path: name, reason: uncoveredLegalReason(name) }));
    return { entries: [...this.entries.values()], uncovered, complete: uncovered.length === 0 };
  }
}
export function uncoveredLegalReason(name: string): string {
  if (/\.(?:node|so(?:\.\d+)*|dylib|a|wasm|exe)$/u.test(name) || /(?:^|\/)(?:qlever|solidfs|agentfs)$/u.test(name)) return 'Native bytes require original native grant scope';
  if (name.startsWith('node_modules/')) return 'Physical third-party bytes lack complete applicable original grant coverage';
  if (name.startsWith('provenance/') || /(?:^|\/)licenses\//u.test(name)) return 'Generated provenance or retained legal material lacks an applicable original binding';
  if (name.startsWith('static/')) return 'Static or UI generated output lacks verified source and grant mapping';
  if (/\.d\.[cm]?ts$/u.test(name)) return 'Generated declaration lacks verified source and grant mapping';
  if (/\.jsonld$/u.test(name) || name.includes('/components/')) return 'Generated component output lacks verified source and grant mapping';
  return 'Archive member lacks verified exact source or complete generated-output grant mapping';
}

export function isNativeLegalMaterial(bytes: Buffer): boolean {
  const magic = bytes.subarray(0, 4).toString('hex');
  return ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', '0061736d'].includes(magic)
    || bytes.subarray(0, 2).toString() === 'MZ' || bytes.subarray(0, 4).toString() === '!<ar';
}

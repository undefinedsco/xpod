import { sql } from 'drizzle-orm';
import { executeQuery, executeStatement, type IdentityDatabase } from '../../identity/drizzle/db';
import { parseMembershipAuthorityBinding, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { MatrixError } from './MatrixError';

/** Rebuildable candidate data. No membership truth, lease, secret, or validation result. */
export interface MembershipAuthorityCandidate {
  sourceIri: string;
  sourcePodId: string;
  sourceRoot: string;
  ownerWebId: string;
  binding: MembershipAuthorityBinding;
}

function parseCandidate(value: unknown): MembershipAuthorityCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 5 || keys.some(key => ![ 'sourceIri', 'sourcePodId', 'sourceRoot', 'ownerWebId', 'binding' ].includes(String(key)))) return undefined;
  for (const key of [ 'sourceIri', 'sourcePodId', 'sourceRoot', 'ownerWebId' ]) {
    if (typeof record[key] !== 'string' || (record[key] as string).trim().length === 0) return undefined;
  }
  const binding = parseMembershipAuthorityBinding(record.binding);
  if (!binding) return undefined;
  return { sourceIri: record.sourceIri as string, sourcePodId: record.sourcePodId as string,
    sourceRoot: record.sourceRoot as string, ownerWebId: record.ownerWebId as string, binding };
}

/** SQL is an operational locator only. Every consumer must re-prove the source and current lease. */
export class MembershipAuthorityLocator {
  private readonly ready: Promise<void>;
  public constructor(private readonly db: IdentityDatabase) {
    this.ready = executeStatement(db, sql`CREATE TABLE IF NOT EXISTS xpod_matrix_membership_authority_locator (
      source_iri TEXT PRIMARY KEY, candidate TEXT NOT NULL
    )`);
  }
  public async remember(value: MembershipAuthorityCandidate): Promise<void> {
    const candidate = parseCandidate(value);
    if (!candidate) throw new MatrixError(403, 'M_FORBIDDEN', 'Membership locator accepts only a strict nonsecret candidate');
    await this.ready;
    await executeStatement(this.db, sql`INSERT INTO xpod_matrix_membership_authority_locator (source_iri, candidate)
      VALUES (${candidate.sourceIri}, ${JSON.stringify(candidate)})
      ON CONFLICT (source_iri) DO UPDATE SET candidate = excluded.candidate`);
  }
  public async find(sourceIri: string): Promise<MembershipAuthorityCandidate | undefined> {
    await this.ready;
    const { rows } = await executeQuery<{ candidate: string }>(this.db,
      sql`SELECT candidate FROM xpod_matrix_membership_authority_locator WHERE source_iri = ${sourceIri}`);
    if (!rows[0]) return undefined;
    let candidate: MembershipAuthorityCandidate | undefined;
    try { candidate = parseCandidate(JSON.parse(rows[0].candidate)); } catch { /* An invalid cache row is discarded. */ }
    if (!candidate || candidate.sourceIri !== sourceIri) { await this.forget(sourceIri); return undefined; }
    return candidate;
  }
  public async forget(sourceIri: string): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`DELETE FROM xpod_matrix_membership_authority_locator WHERE source_iri = ${sourceIri}`);
  }
  public async wipe(): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`DELETE FROM xpod_matrix_membership_authority_locator`);
  }
}

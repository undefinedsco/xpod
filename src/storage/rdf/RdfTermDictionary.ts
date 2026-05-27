import { createHash } from 'node:crypto';
import { DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import type { SqliteDatabase } from '../SqliteRuntime';
import type { RdfTermKind, RdfTermRow } from './types';
import { isRdfNumericDatatype, rdfNumericValue } from './RdfTermSemantics';

interface RdfTermIdentity {
  kind: RdfTermKind;
  value: string;
  datatypeId: number | null;
  lang: string | null;
  normalizedText: string | null;
  numericValue: number | null;
  hash: string;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

export class RdfTermDictionary {
  private readonly termCache = new Map<string, number>();
  private readonly idCache = new Map<number, Term>();

  public constructor(private readonly db: SqliteDatabase) {}

  public initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rdf_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        datatype_id INTEGER,
        lang TEXT,
        hash TEXT NOT NULL,
        normalized_text TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (kind, value, datatype_id, lang)
      );

      CREATE INDEX IF NOT EXISTS rdf_terms_hash ON rdf_terms (hash);
      CREATE INDEX IF NOT EXISTS rdf_terms_kind_value ON rdf_terms (kind, value);
      CREATE INDEX IF NOT EXISTS rdf_terms_kind_datatype ON rdf_terms (kind, datatype_id);
      CREATE INDEX IF NOT EXISTS rdf_terms_kind_lang ON rdf_terms (kind, lang);
      CREATE INDEX IF NOT EXISTS rdf_terms_normalized_text ON rdf_terms (normalized_text);
    `);
    this.ensureNumericValueColumn();
    this.db.exec('CREATE INDEX IF NOT EXISTS rdf_terms_kind_numeric_value ON rdf_terms (kind, numeric_value);');
    this.backfillNumericValues();
  }

  public getOrCreate(term: Term): number {
    const identity = this.toIdentity(term);
    const cacheKey = this.identityCacheKey(identity);
    const cached = this.termCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.findId(identity);
    if (existing !== undefined) {
      this.termCache.set(cacheKey, existing);
      return existing;
    }

    const stmt = this.db.prepare(`
      INSERT INTO rdf_terms (kind, value, datatype_id, lang, hash, normalized_text, numeric_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      identity.kind,
      identity.value,
      identity.datatypeId,
      identity.lang,
      identity.hash,
      identity.normalizedText,
      identity.numericValue,
    );
    const id = Number(result.lastInsertRowid);
    this.termCache.set(cacheKey, id);
    this.idCache.set(id, term);
    return id;
  }

  public find(term: Term): number | undefined {
    const identity = this.toIdentity(term);
    const cacheKey = this.identityCacheKey(identity);
    const cached = this.termCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const id = this.findId(identity);
    if (id !== undefined) {
      this.termCache.set(cacheKey, id);
    }
    return id;
  }

  public termForId(id: number): Term {
    const cached = this.idCache.get(id);
    if (cached) {
      return cached;
    }

    const row = this.db
      .prepare<RdfTermRow>('SELECT * FROM rdf_terms WHERE id = ?')
      .get(id);
    if (!row) {
      throw new Error(`RDF term not found: ${id}`);
    }

    const term = this.rowToTerm(row);
    this.idCache.set(id, term);
    return term;
  }

  public rowsForIds(ids: number[]): Map<number, Term> {
    const uniqueIds = Array.from(new Set(ids));
    const result = new Map<number, Term>();
    const missing: number[] = [];

    for (const id of uniqueIds) {
      const cached = this.idCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) {
      return result;
    }

    const placeholders = missing.map(() => '?').join(', ');
    const rows = this.db
      .prepare<RdfTermRow>(`SELECT * FROM rdf_terms WHERE id IN (${placeholders})`)
      .all(...missing);

    for (const row of rows) {
      const term = this.rowToTerm(row);
      this.idCache.set(row.id, term);
      result.set(row.id, term);
    }

    return result;
  }

  public idsByValuePrefix(kind: RdfTermKind | RdfTermKind[], prefix: string): number[] {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare<{ id: number }>(`
        SELECT id FROM rdf_terms
        WHERE kind IN (${kinds.map(() => '?').join(', ')})
          AND value >= ?
          AND value < ?
      `)
      .all(...kinds, prefix, `${prefix}\uffff`);
    return rows.map((row) => row.id);
  }

  public idsByNormalizedTextContains(kind: RdfTermKind | RdfTermKind[], text: string): number[] {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.length === 0) {
      return [];
    }
    const needle = normalizeSearchText(text);
    const rows = this.db
      .prepare<{ id: number; value: string }>(`
        SELECT id, value FROM rdf_terms
        WHERE kind IN (${kinds.map(() => '?').join(', ')})
          AND normalized_text LIKE ? ESCAPE '\\'
      `)
      .all(...kinds, `%${escapeLikePattern(needle)}%`);
    return rows
      .filter((row) => row.value.includes(text))
      .map((row) => row.id);
  }

  public idsByNormalizedTextSuffix(kind: RdfTermKind | RdfTermKind[], suffix: string): number[] {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.length === 0) {
      return [];
    }
    const needle = normalizeSearchText(suffix);
    const rows = this.db
      .prepare<{ id: number; value: string }>(`
        SELECT id, value FROM rdf_terms
        WHERE kind IN (${kinds.map(() => '?').join(', ')})
          AND normalized_text LIKE ? ESCAPE '\\'
      `)
      .all(...kinds, `%${escapeLikePattern(needle)}`);
    return rows
      .filter((row) => row.value.endsWith(suffix))
      .map((row) => row.id);
  }

  public idsByNormalizedTextRegex(kind: RdfTermKind | RdfTermKind[], pattern: string, flags?: string): number[] {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare<RdfTermRow>(`
        SELECT * FROM rdf_terms
        WHERE kind IN (${kinds.map(() => '?').join(', ')})
          AND normalized_text IS NOT NULL
      `)
      .all(...kinds);
    const regex = new RegExp(pattern, flags);
    return rows
      .filter((row) => regex.test(row.value))
      .map((row) => row.id);
  }

  public count(): number {
    const row = this.db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_terms').get();
    return row?.count ?? 0;
  }

  private findId(identity: RdfTermIdentity): number | undefined {
    const row = identity.datatypeId === null && identity.lang === null
      ? this.db
          .prepare<{ id: number }>(`
            SELECT id FROM rdf_terms
            WHERE kind = ?
              AND value = ?
              AND datatype_id IS NULL
              AND lang IS NULL
            LIMIT 1
          `)
          .get(identity.kind, identity.value)
      : identity.datatypeId === null
        ? this.db
            .prepare<{ id: number }>(`
              SELECT id FROM rdf_terms
              WHERE kind = ?
                AND value = ?
                AND datatype_id IS NULL
                AND lang = ?
              LIMIT 1
            `)
            .get(identity.kind, identity.value, identity.lang)
        : identity.lang === null
          ? this.db
              .prepare<{ id: number }>(`
                SELECT id FROM rdf_terms
                WHERE kind = ?
                  AND value = ?
                  AND datatype_id = ?
                  AND lang IS NULL
                LIMIT 1
              `)
              .get(identity.kind, identity.value, identity.datatypeId)
          : this.db
              .prepare<{ id: number }>(`
                SELECT id FROM rdf_terms
                WHERE kind = ?
                  AND value = ?
                  AND datatype_id = ?
                  AND lang = ?
                LIMIT 1
              `)
              .get(identity.kind, identity.value, identity.datatypeId, identity.lang);
    return row?.id;
  }

  private toIdentity(term: Term): RdfTermIdentity {
    switch (term.termType) {
      case 'NamedNode':
        return this.identity('iri', term.value, null, null, term.value, null);
      case 'BlankNode':
        return this.identity('blank', term.value, null, null, term.value, null);
      case 'DefaultGraph':
        return this.identity('default_graph', '', null, null, null, null);
      case 'Literal': {
        const datatypeValue = term.datatype?.value || XSD_STRING;
        const datatypeId = datatypeValue === XSD_STRING && !term.language
          ? null
          : this.getOrCreate(DataFactory.namedNode(datatypeValue));
        return this.identity(
          'literal',
          term.value,
          datatypeId,
          term.language || null,
          term.value,
          this.numericValueForLiteral(term.value, datatypeValue),
        );
      }
      case 'Variable':
        throw new Error(`Variables cannot be indexed as RDF terms: ${term.value}`);
      case 'Quad':
        throw new Error('Nested RDF-star quads are not supported by the first SolidRdfEngine index');
      default: {
        const exhaustive: never = term;
        throw new Error(`Unsupported RDF term: ${String(exhaustive)}`);
      }
    }
  }

  private identity(
    kind: RdfTermKind,
    value: string,
    datatypeId: number | null,
    lang: string | null,
    normalizedText: string | null,
    numericValue: number | null,
  ): RdfTermIdentity {
    const hash = createHash('sha256')
      .update(kind)
      .update('\0')
      .update(value)
      .update('\0')
      .update(String(datatypeId ?? ''))
      .update('\0')
      .update(lang ?? '')
      .digest('hex');
    return {
      kind,
      value,
      datatypeId,
      lang,
      normalizedText: normalizedText ? normalizedText.toLowerCase() : null,
      numericValue,
      hash,
    };
  }

  private numericValueForLiteral(value: string, datatypeValue: string): number | null {
    if (!isRdfNumericDatatype(datatypeValue)) {
      return null;
    }
    const numeric = rdfNumericValue(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private ensureNumericValueColumn(): void {
    const columns = this.db.prepare<{ name: string }>('PRAGMA table_info(rdf_terms)').all();
    if (columns.some((column) => column.name === 'numeric_value')) {
      return;
    }
    this.db.exec('ALTER TABLE rdf_terms ADD COLUMN numeric_value REAL;');
  }

  private backfillNumericValues(): void {
    const rows = this.db.prepare<RdfTermRow>(`
      SELECT literal.*
      FROM rdf_terms literal
      JOIN rdf_terms datatype ON datatype.id = literal.datatype_id
      WHERE literal.kind = 'literal'
        AND literal.numeric_value IS NULL
        AND datatype.kind = 'iri'
    `).all();
    const update = this.db.prepare('UPDATE rdf_terms SET numeric_value = ? WHERE id = ?');
    for (const row of rows) {
      const datatype = this.termForId(row.datatype_id as number);
      if (datatype.termType !== 'NamedNode') {
        continue;
      }
      const numericValue = this.numericValueForLiteral(row.value, datatype.value);
      if (numericValue !== null) {
        update.run(numericValue, row.id);
      }
    }
  }

  private identityCacheKey(identity: RdfTermIdentity): string {
    return [
      identity.kind,
      identity.value,
      identity.datatypeId ?? '',
      identity.lang ?? '',
    ].join('\u001f');
  }

  private rowToTerm(row: RdfTermRow): Term {
    switch (row.kind) {
      case 'iri':
        return DataFactory.namedNode(row.value);
      case 'blank':
        return DataFactory.blankNode(row.value);
      case 'default_graph':
        return DataFactory.defaultGraph();
      case 'literal': {
        if (row.lang) {
          return DataFactory.literal(row.value, row.lang);
        }
        if (row.datatype_id) {
          const datatype = this.termForId(row.datatype_id);
          if (datatype.termType === 'NamedNode' && datatype.value !== XSD_STRING && datatype.value !== RDF_LANG_STRING) {
            return DataFactory.literal(row.value, datatype);
          }
        }
        return DataFactory.literal(row.value);
      }
      default:
        throw new Error(`Unsupported RDF term kind in dictionary row: ${(row as RdfTermRow).kind}`);
    }
  }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase();
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

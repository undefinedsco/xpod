/**
 * Parse JSON-LD mapping files into TriplesMap[].
 *
 * Handles R2RML (rr:) prefixed properties and udfs: filter extensions.
 * Does NOT use a full JSON-LD processor — just expands prefixes from @context.
 */

import { readFileSync } from 'fs';
import type {
  TriplesMap,
  LogicalTable,
  SubjectMap,
  PredicateObjectMap,
  ObjectMap,
  Filters,
  FilterWhitelistEntry,
  FilterBlacklistEntry,
  FilterTimeRange,
} from './types';

// ============================================
// Prefix expansion
// ============================================

type Context = Record<string, string>;

function buildContext(raw: unknown): Context {
  const ctx: Context = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === 'string') {
        ctx[key] = val;
      }
    }
  }
  return ctx;
}

/** Expand a prefixed term like "rr:tableName" using the @context map. */
function expand(term: string, ctx: Context): string {
  if (term.startsWith('http://') || term.startsWith('https://')) return term;
  const colon = term.indexOf(':');
  if (colon > 0) {
    const prefix = term.slice(0, colon);
    const local = term.slice(colon + 1);
    if (ctx[prefix]) return `${ctx[prefix]}${local}`;
  }
  return term;
}

/** Get a property value by its expanded IRI, trying common prefixed forms. */
function prop(node: Record<string, unknown>, iri: string, ctx: Context): unknown {
  // Try direct key first
  if (node[iri] !== undefined) return node[iri];
  // Try all prefixed forms
  for (const [prefix, ns] of Object.entries(ctx)) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      const key = `${prefix}:${local}`;
      if (node[key] !== undefined) return node[key];
    }
  }
  return undefined;
}

const RR = 'http://www.w3.org/ns/r2rml#';
const UDFS = 'https://undefineds.co/ns#';

// ============================================
// Node helpers
// ============================================

function strVal(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj['@id'] === 'string') return obj['@id'];
    if (typeof obj['@value'] === 'string') return obj['@value'];
  }
  return undefined;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ============================================
// Parsers for sub-structures
// ============================================

function parseLogicalTable(node: unknown, ctx: Context): LogicalTable {
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  return {
    tableName: strVal(prop(obj, `${RR}tableName`, ctx)),
    sqlQuery: strVal(prop(obj, `${RR}sqlQuery`, ctx)),
  };
}

function parseSubjectMap(node: unknown, ctx: Context): SubjectMap {
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  const template = strVal(prop(obj, `${RR}template`, ctx)) ?? '';
  const classVal = prop(obj, `${RR}class`, ctx);
  const cls = classVal ? strVal(classVal) : undefined;
  return { template, class: cls ? expand(cls, ctx) : undefined };
}

function parseObjectMap(node: unknown, ctx: Context): ObjectMap {
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  return {
    column: strVal(prop(obj, `${RR}column`, ctx)),
    template: strVal(prop(obj, `${RR}template`, ctx)),
    constant: strVal(prop(obj, `${RR}constant`, ctx)),
    datatype: (() => {
      const dt = prop(obj, `${RR}datatype`, ctx);
      const raw = strVal(dt);
      return raw ? expand(raw, ctx) : undefined;
    })(),
    language: strVal(prop(obj, `${RR}language`, ctx)),
  };
}

function parsePredicateObjectMap(node: unknown, ctx: Context): PredicateObjectMap {
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  const predRaw = prop(obj, `${RR}predicate`, ctx);
  const predStr = strVal(predRaw) ?? '';
  const omRaw = prop(obj, `${RR}objectMap`, ctx);
  return {
    predicate: expand(predStr, ctx),
    objectMap: parseObjectMap(omRaw, ctx),
  };
}

function parseFilters(node: unknown, ctx: Context): Filters | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;

  const whitelist = asArray(prop(obj, `${UDFS}whitelist`, ctx)).map((entry) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const col = strVal(prop(e, `${UDFS}column`, ctx)) ?? '';
    const vals = asArray(prop(e, `${UDFS}values`, ctx)).map((v) => String(v));
    return { column: col, values: vals } as FilterWhitelistEntry;
  });

  const blacklist = asArray(prop(obj, `${UDFS}blacklist`, ctx)).map((entry) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const col = strVal(prop(e, `${UDFS}column`, ctx)) ?? '';
    const vals = asArray(prop(e, `${UDFS}values`, ctx)).map((v) => String(v));
    return { column: col, values: vals } as FilterBlacklistEntry;
  });

  const trRaw = prop(obj, `${UDFS}timeRange`, ctx);
  let timeRange: FilterTimeRange | undefined;
  if (trRaw && typeof trRaw === 'object') {
    const tr = trRaw as Record<string, unknown>;
    timeRange = {
      column: strVal(prop(tr, `${UDFS}column`, ctx)) ?? '',
      after: strVal(prop(tr, `${UDFS}after`, ctx)),
      before: strVal(prop(tr, `${UDFS}before`, ctx)),
    };
  }

  if (whitelist.length === 0 && blacklist.length === 0 && !timeRange) return undefined;

  return {
    whitelist: whitelist.length > 0 ? whitelist : undefined,
    blacklist: blacklist.length > 0 ? blacklist : undefined,
    timeRange,
  };
}

// ============================================
// Main parser
// ============================================

function parseTriplesMap(node: Record<string, unknown>, ctx: Context): TriplesMap {
  const id = (typeof node['@id'] === 'string' ? node['@id'] : '');

  const ltRaw = prop(node, `${RR}logicalTable`, ctx);
  const smRaw = prop(node, `${RR}subjectMap`, ctx);
  const pomRaw = asArray(prop(node, `${RR}predicateObjectMap`, ctx));
  const filterRaw = prop(node, `${UDFS}filter`, ctx);

  return {
    id,
    logicalTable: parseLogicalTable(ltRaw, ctx),
    subjectMap: parseSubjectMap(smRaw, ctx),
    predicateObjectMaps: pomRaw.map((p) => parsePredicateObjectMap(p, ctx)),
    filters: parseFilters(filterRaw, ctx),
  };
}

/**
 * Parse a JSON-LD mapping file and return TriplesMap[].
 */
export function parseMappingFile(filePath: string): TriplesMap[] {
  const raw = readFileSync(filePath, 'utf-8');
  const doc = JSON.parse(raw) as Record<string, unknown>;

  const ctx = buildContext(doc['@context']);
  const graph = asArray(doc['@graph']);

  // If no @graph, treat the document itself as a single map (if it has rr:logicalTable)
  if (graph.length === 0) {
    const lt = prop(doc, `${RR}logicalTable`, ctx);
    if (lt) return [parseTriplesMap(doc, ctx)];
    return [];
  }

  const maps: TriplesMap[] = [];
  for (const entry of graph) {
    if (!entry || typeof entry !== 'object') continue;
    const node = entry as Record<string, unknown>;
    // Only parse nodes that are rr:TriplesMap
    const typeVal = node['@type'];
    const types = asArray(typeVal).map((t) => expand(String(t), ctx));
    if (types.includes(`${RR}TriplesMap`)) {
      maps.push(parseTriplesMap(node, ctx));
    }
  }

  return maps;
}

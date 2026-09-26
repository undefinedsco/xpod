/**
 * Canonical JSON for Matrix event hashing and signing.
 *
 * The rules come from the Matrix specification's appendices: the shortest UTF-8
 * encoding, object keys sorted by Unicode code point, integers only, and no
 * escaped non-ASCII characters. `canonicalize` (RFC 8785) happens to agree with
 * the examples in the specification, but RFC 8785 is a different document, so
 * this module implements the specification directly and the tests pin both the
 * specification's vectors and the supplementary cases.
 */
export class CanonicalJsonError extends Error {}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function encodeCanonicalJson(value: unknown): string {
  return encodeValue(value);
}

function encodeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) return `[${value.map(item => encodeValue(item)).join(',')}]`;
  if (typeof value === 'object') return encodeObject(value as Record<string, unknown>);
  throw new CanonicalJsonError(`Unsupported JSON value: ${typeof value}`);
}

/**
 * Integers within the IEEE-754 safe range, without exponents or decimal places.
 * Floats and negative zero are rejected rather than silently rounded.
 */
function encodeNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(`Canonical JSON allows integers in the safe range only: ${value}`);
  }
  if (Object.is(value, -0)) {
    throw new CanonicalJsonError('Canonical JSON does not allow negative zero');
  }
  return String(value);
}

/** Keys sorted by code point, not by locale or by UTF-16 code unit order. */
function encodeObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort(compareByCodePoint);
  return `{${keys.map(key => `${encodeString(key)}:${encodeValue(value[key])}`).join(',')}}`;
}

function compareByCodePoint(left: string, right: string): number {
  const a = [ ...left ];
  const b = [ ...right ];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * Shortest encoding: only the escapes the grammar requires, everything else in
 * UTF-8. Control characters without a dedicated escape use `\u00XX` with
 * lowercase hex.
 */
function encodeString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    switch (character) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default:
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    }
  }
  return `${out}"`;
}

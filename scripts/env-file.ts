import * as dotenv from 'dotenv';

/**
 * Safe serialization of `KEY=value` lines for dotenv files.
 *
 * A bare assignment makes dotenv treat an inline `#` as a comment: writing
 * `TEST_SOLID_WEBID=http://host/alice/profile/card#me` loads as `http://host/alice/profile/card`,
 * silently dropping the fragment. That turned a canonical WebID into a different RDF subject and
 * made a strict issuer-identity check fail on a fixture bug rather than a production one. Quoting
 * the value is what dotenv's own parser needs to keep it exact, so every generated assignment goes
 * through here instead of string interpolation.
 *
 * Quoting is not a single fixed rule, because dotenv's parser is not a general quoter: a `#` after a
 * single quote can still start a comment (a legal WebID like `…?hint='#me` would be truncated), while
 * double quotes rewrite a literal backslash-n into a newline. So the delimiter is *chosen and then
 * checked*: each candidate is fed back through dotenv's own parser and only accepted when the value
 * comes out byte-identical. A value no delimiter can carry is rejected explicitly rather than
 * silently corrupted.
 */

/** The key used for the throwaway round-trip probe; never written to a real env file. */
const ROUNDTRIP_KEY = '__XPOD_ENV_ROUNDTRIP_PROBE__';

/** Matches a value that cannot live on a single `KEY=value` line. */
const UNREPRESENTABLE = /[\r\n]/u;

/** One `KEY=value` line with the value quoted and escaped for dotenv. */
export function formatEnvAssignment(key: string, value: string): string {
  return `${key}=${quoteEnvValue(value)}`;
}

/** Whether dotenv parses `body` back to exactly `value`. */
function roundTrips(value: string, body: string): boolean {
  const parsed = dotenv.parse(`${ROUNDTRIP_KEY}=${body}\n`);
  return Object.prototype.hasOwnProperty.call(parsed, ROUNDTRIP_KEY) && parsed[ROUNDTRIP_KEY] === value;
}

/** A dotenv quoted value that survives round-tripping through dotenv's own parser. */
export function quoteEnvValue(value: string): string {
  // A real newline or carriage return cannot be represented on one assignment line at all, and
  // would also break the `^KEY=.*$` upsert contract, so reject it instead of corrupting the value.
  if (UNREPRESENTABLE.test(value)) {
    throw new Error('Cannot serialize an env value containing a newline or carriage return');
  }
  // Single quotes are fully literal for the common case (fragments, `$`, backslashes and even
  // embedded single quotes) and are the only delimiter that keeps a literal backslash-n intact.
  // Double quotes cover the one case they miss: a single quote immediately before a `#`, where
  // dotenv would otherwise stop early. Whichever candidate actually round-trips wins.
  for (const candidate of [ `'${value}'`, `"${value}"` ]) {
    if (roundTrips(value, candidate)) {
      return candidate;
    }
  }
  throw new Error('Cannot serialize an env value containing a quote/comment combination dotenv cannot round-trip');
}

/**
 * Replace or append each assignment in an env file body, preserving every other line.
 *
 * Existing lines of the same key are replaced wholesale (including a previously quoted value), so
 * re-running setup cannot accumulate duplicate assignments that a later `dotenv.config` would let
 * shadow the intended one.
 */
export function upsertEnvContent(content: string, updates: Record<string, string>): string {
  let next = content;
  for (const [ key, value ] of Object.entries(updates)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
    const line = formatEnvAssignment(key, value);
    if (regex.test(next)) {
      // A string replacement would treat `$&`, `$`` and `$'` inside the value as replacement
      // patterns and splice the matched text in. A callback returns `line` verbatim.
      next = next.replace(regex, () => line);
    } else {
      next += `\n${line}`;
    }
  }
  return next.trim() + '\n';
}

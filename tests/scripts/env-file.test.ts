import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import { formatEnvAssignment, quoteEnvValue, upsertEnvContent } from '../../scripts/env-file';

/**
 * A WebID's fragment is data, not a comment. These are dummy values only: the point is that a
 * generated dotenv file round-trips the exact canonical WebID (origin + path + fragment) through
 * dotenv's own parser, which is what the integration fixture chain depends on.
 */
const WEB_ID = 'http://localhost:32929/test-integration-dummy/profile/card#me';

describe('dotenv fixture serialization', () => {
  it('loses a WebID fragment when written unquoted', () => {
    // This is the historical bug, pinned so a regression cannot be mistaken for an auth change.
    const parsed = dotenv.parse(`TEST_SOLID_WEBID=${WEB_ID}\n`);
    expect(parsed.TEST_SOLID_WEBID).toBe(WEB_ID.split('#')[0]);
    expect(parsed.TEST_SOLID_WEBID).not.toBe(WEB_ID);
  });

  it('round-trips the exact WebID when written through the serializer', () => {
    const parsed = dotenv.parse(`${formatEnvAssignment('TEST_SOLID_WEBID', WEB_ID)}\n`);
    expect(parsed.TEST_SOLID_WEBID).toBe(WEB_ID);
    expect(parsed.TEST_SOLID_WEBID).toContain('#me');
  });

  it('keeps special characters, quotes and backslashes intact', () => {
    const values = [
      'a#b',
      'http://host/path?x=1#frag',
      'with space',
      'quote"inside',
      'back\\slash',
      'dollar$sign',
      "single'quote",
    ];
    for (const value of values) {
      const parsed = dotenv.parse(`${formatEnvAssignment('VALUE', value)}\n`);
      expect(parsed.VALUE).toBe(value);
    }
  });

  it('replaces an existing assignment without duplicating the key or touching other lines', () => {
    const original = [
      'CSS_BASE_URL=http://localhost:32929',
      `TEST_SOLID_WEBID=${WEB_ID}`,
      'KEEP=this',
    ].join('\n') + '\n';

    const next = upsertEnvContent(original, { TEST_SOLID_WEBID: WEB_ID });
    const parsed = dotenv.parse(next);

    expect(parsed.TEST_SOLID_WEBID).toBe(WEB_ID);
    expect(parsed.KEEP).toBe('this');
    // Exactly one assignment for the key, so a later loader cannot see two conflicting values.
    expect(next.match(/^TEST_SOLID_WEBID=/gmu)).toHaveLength(1);
  });

  it('appends a new key while preserving the rest of the file', () => {
    const next = upsertEnvContent('EXISTING=1\n', { ADDED: WEB_ID });
    const parsed = dotenv.parse(next);
    expect(parsed.EXISTING).toBe('1');
    expect(parsed.ADDED).toBe(WEB_ID);
  });

  it('quotes an empty value so it stays present rather than disappearing', () => {
    expect(quoteEnvValue('')).toBe("''");
    expect(dotenv.parse(`${formatEnvAssignment('EMPTY', '')}\n`).EMPTY).toBe('');
  });

  it('round-trips replacement-pattern characters through upsert and replaces existing keys', () => {
    // `$&`, `$`` and `$'` are substitution patterns in String.prototype.replace; a string
    // replacement would splice the matched line back into the value. A callback must not.
    const values = {
      AMPER: 'a$&b',
      BACKTICK: 'a$`b',
      PRIME: "a$'b",
      MIXED_QUOTES: `q"'both`,
      BACKSLASH_N: 'a\\nb',
      TRAILING_SQUOTE: "a'",
    };
    // Every key already exists, so this exercises the replace branch (not only the append branch).
    const content = [
      'KEEP=1',
      ...Object.keys(values).map(key => `${key}=stale-value`),
    ].join('\n') + '\n';
    const next = upsertEnvContent(content, values);
    const parsed = dotenv.parse(next);
    for (const [ key, value ] of Object.entries(values)) {
      expect(parsed[key]).toBe(value);
      // Exactly one assignment per key: no stale duplicate an earlier loader could shadow.
      expect(next.match(new RegExp(`^${key}=`, 'gmu'))).toHaveLength(1);
    }
    expect(parsed.KEEP).toBe('1');
    expect(next).not.toContain('KEEP=1$&');
  });

  it('round-trips a legal WebID whose query holds an apostrophe before the fragment', () => {
    // A `#` after a single quote would be read as a comment by dotenv's single-quote branch, so this
    // value has to be written with the delimiter that actually validates.
    const value = "https://example.test/card?hint='#me";
    const line = formatEnvAssignment('TEST_SOLID_WEBID', value);
    expect(dotenv.parse(`${line}\n`).TEST_SOLID_WEBID).toBe(value);
    expect(dotenv.parse(`${line}\n`).TEST_SOLID_WEBID).toContain('#me');
  });

  it('round-trips an apostrophe plus fragment without losing the fragment', () => {
    const value = "https://example.test/card?hint='#fragment";
    expect(dotenv.parse(`${formatEnvAssignment('V', value)}\n`).V).toBe(value);
  });

  it('explicitly rejects a value dotenv cannot round-trip instead of truncating it', () => {
    // Both a single quote before a `#` and an embedded double quote are present: no candidate
    // delimiter preserves it, so silent truncation is replaced by a loud rejection.
    expect(() => quoteEnvValue(`mix"'both#frag`)).toThrow(/round-trip/u);
    expect(() => upsertEnvContent('', { BAD: `mix"'both#frag` })).toThrow(/round-trip/u);
  });

  it('rejects a value that cannot be represented on one assignment line', () => {
    expect(() => quoteEnvValue('a\nb')).toThrow(/newline/u);
    expect(() => quoteEnvValue('a\rb')).toThrow(/newline/u);
  });
});

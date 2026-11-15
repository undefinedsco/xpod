/**
 * Centralized RC database configuration materializer.
 *
 * The REAL `materializeRcDatabaseConfiguration` from this repository is driven
 * with synthetic env maps. It must keep the current APP_ENV_FILE credentials
 * untouched while deriving the dedicated RC PostgreSQL hostname, and the strict
 * validator must still reject the shared production host when called directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { requireRepoModule } from './rc-dedicated-postgres-fixture.mjs';

const boundary = requireRepoModule('scripts/check-rc-deployment-boundary.cjs');
const NS = 'ns-iknkxtc8';
const RC = 'xpod-rc-rdf-postgres';
// Percent-encoded credential bytes: @ / : ' " ; ${x}. They must survive as-is.
const PW = 'p%40ss%2Fw%3Ard%27%22%3B%24%7Bx%7D';

const url = (host, password = PW, db = 'xpod_rc', role = 'xpod_rc', port = '5432') =>
  `postgresql://${role}:${password}@${host}:${port}/${db}`;

function entries(identity, sparql = identity, extra = {}) {
  return new Map(Object.entries({
    CSS_IDENTITY_DB_URL: identity,
    CSS_SPARQL_ENDPOINT: sparql,
    CSS_REDIS_CLIENT: 'redis://cache:6379/7',
    CSS_MINIO_BUCKET_NAME: 'xpod-rc',
    UNRELATED_SETTING: 'keep-me',
    ...extra,
  }));
}

test('the current shared service host is rebound to the dedicated RC service', () => {
  for (const host of [ 'xpod-rdf-postgres', `xpod-rdf-postgres.${NS}`,
    `xpod-rdf-postgres.${NS}.svc`, `xpod-rdf-postgres.${NS}.svc.cluster.local` ]) {
    const result = boundary.materializeRcDatabaseConfiguration(entries(url(host)), NS);
    assert.equal(result.entries.get('CSS_IDENTITY_DB_URL'), url(RC));
    assert.equal(result.entries.get('CSS_SPARQL_ENDPOINT'), url(RC));
    assert.deepEqual(result.sourceHosts, [ host, host ]);
    assert.equal(result.derivedHost, RC);
  }
});

test('dedicated-host input is idempotent', () => {
  const first = boundary.materializeRcDatabaseConfiguration(entries(url(RC)), NS);
  const second = boundary.materializeRcDatabaseConfiguration(first.entries, NS);
  assert.equal(second.entries.get('CSS_IDENTITY_DB_URL'), url(RC));
});

test('credentials and non-database entries are preserved byte for byte', () => {
  const input = entries(url('xpod-rdf-postgres'));
  const result = boundary.materializeRcDatabaseConfiguration(input, NS);
  const rendered = result.entries.get('CSS_IDENTITY_DB_URL');
  assert.ok(rendered.includes(`xpod_rc:${PW}@${RC}:5432/xpod_rc`), rendered);
  for (const [ key, value ] of input) {
    if (key === 'CSS_IDENTITY_DB_URL' || key === 'CSS_SPARQL_ENDPOINT') continue;
    assert.equal(result.entries.get(key), value, key);
  }
});

test('scheme variants are preserved', () => {
  const result = boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres').replace('postgresql://', 'postgres://')), NS);
  assert.match(result.entries.get('CSS_IDENTITY_DB_URL'), /^postgres:\/\//);
});

test('an exact alias is rebound coherently', () => {
  const original = url('xpod-rdf-postgres');
  const result = boundary.materializeRcDatabaseConfiguration(
    entries(original, original, { DATABASE_URL: original }), NS);
  assert.equal(result.entries.get('DATABASE_URL'), url(RC));
  assert.ok(result.rebasedKeys.includes('DATABASE_URL'));
});

test('mismatched identity/RDF credentials fail', () => {
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres'), url('xpod-rdf-postgres', 'other')), NS),
  /credentials must match/);
});

test('production roles and databases fail before any mutation', () => {
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres', PW, 'xpod_cn')), NS), /must target the xpod_rc database/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres', PW, 'xpod_rc', 'postgres')), NS), /must use the xpod_rc role/);
});

test('public production hosts, localhost and arbitrary hosts fail', () => {
  for (const host of [ 'id.undefineds.cn', 'id.undefineds.co', 'localhost', '127.0.0.1',
    'xpod-rdf-postgres.evil.example', 'db.internal' ]) {
    assert.throws(() => boundary.materializeRcDatabaseConfiguration(entries(url(host)), NS),
      /not an accepted RC database service/, host);
  }
});

test('query, fragment and non-5432 ports fail', () => {
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(`${url('xpod-rdf-postgres')}?sslmode=require`), NS), /query or fragment/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(`${url('xpod-rdf-postgres')}#frag`), NS), /query or fragment/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres', PW, 'xpod_rc', 'xpod_rc', '5433')), NS), /port 5432/);
});

test('a conflicting alias fails closed instead of guessing', () => {
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres'), url('xpod-rdf-postgres'),
      { DATABASE_URL: url('xpod-rc-rdf-postgres') }), NS), /conflicting RC database authority/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    entries(url('xpod-rdf-postgres'), url('xpod-rdf-postgres'),
      { CSS_TASK_DB_URL: url('xpod-rdf-postgres', 'different') }), NS),
  /conflicting RC database authority/);
});

test('missing or non-string database entries fail', () => {
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(new Map(), NS),
    /missing required RC secret key/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration(
    new Map([ [ 'CSS_IDENTITY_DB_URL', 42 ], [ 'CSS_SPARQL_ENDPOINT', url('xpod-rdf-postgres') ] ]), NS),
  /missing required RC secret key/);
  assert.throws(() => boundary.materializeRcDatabaseConfiguration([], NS), /must be a Map/);
});

test('parser failures never leak the raw URL, password or decoder text', () => {
  // Synthetic secrets only. `new URL()` throws ERR_INVALID_URL carrying the
  // whole raw string (password included) on `error.input`, and a cause chain
  // would serialise it; `decodeURIComponent` throws a bare decoder message.
  const HOSTILE = 'se%40cretP4ss%3Bw0rd';
  const RAW_SECRET = 'rawSecretDoNotLeak';
  const cases = [
    // invalid port -> ERR_INVALID_URL with .input
    `postgresql://xpod_rc:${HOSTILE}@xpod-rdf-postgres:999999999/xpod_rc`,
    // malformed percent escape in the role
    `postgresql://xpod_rc%zz:${HOSTILE}@xpod-rdf-postgres:5432/xpod_rc`,
    // malformed percent escape in the password
    `postgresql://xpod_rc:se%zzret@xpod-rdf-postgres:5432/xpod_rc`,
    // not a URL at all, carrying a secret-looking token
    `this is not a url ${RAW_SECRET}`,
    // scheme-less secret token
    `totally-${RAW_SECRET}-not-a-url`,
  ];
  for (const raw of cases) {
    const input = new Map([
      [ 'CSS_IDENTITY_DB_URL', raw ],
      [ 'CSS_SPARQL_ENDPOINT', raw ],
    ]);
    let caught;
    try { boundary.materializeRcDatabaseConfiguration(input, NS); }
    catch (error) { caught = error; }
    assert.ok(caught, `expected a rejection for ${raw.slice(0, 12)}…`);

    // The parser's own fields must be gone, not merely unused.
    assert.equal(caught.input, undefined, 'error.input must have been deleted');
    assert.equal(caught.cause, undefined, 'error.cause must have been deleted');
    assert.equal(caught.name, 'RcDatabaseConfigurationError');
    assert.match(caught.message, /^CSS_(IDENTITY_DB_URL|SPARQL_ENDPOINT) /,
      'the message must name only the configuration key');

    const surfaces = [
      caught.message,
      caught.stack,
      String(caught),
      JSON.stringify(caught),
      JSON.stringify({ name: caught.name, message: caught.message }),
      JSON.stringify(Object.getOwnPropertyNames(caught).map((key) => [ key, caught[key] ])),
    ].join(' | ');
    for (const secret of [ HOSTILE, RAW_SECRET, 'Invalid URL', 'URI malformed' ]) {
      assert.equal(surfaces.includes(secret), false, `${secret} leaked into the error surface`);
    }
  }
});

test('valid percent-encoded credentials survive the hardened parser', () => {
  // Decoding is used only for validation; the emitted URL keeps the raw,
  // percent-encoded userinfo byte for byte.
  const result = boundary.materializeRcDatabaseConfiguration(entries(url('xpod-rdf-postgres')), NS);
  const rendered = result.entries.get('CSS_IDENTITY_DB_URL');
  assert.ok(rendered.includes(PW), rendered);
  assert.equal(rendered.includes('%40'), true);
  assert.equal(rendered.includes('%2F'), true);
  assert.equal(rendered.includes('%27'), true);
  assert.doesNotThrow(() => boundary.validateDatabases(result.entries, NS));
});

test('the strict validator still rejects the shared host when called directly', () => {
  for (const host of [ 'xpod-rdf-postgres', `xpod-rdf-postgres.${NS}.svc`,
    `xpod-rdf-postgres.${NS}.svc.cluster.local`, 'production-postgres' ]) {
    assert.throws(() => boundary.validateDatabases(entries(url(host)), NS), /RC-only PostgreSQL/, host);
  }
});

test('the materialized output passes the strict validator', () => {
  const result = boundary.materializeRcDatabaseConfiguration(entries(url('xpod-rdf-postgres')), NS);
  assert.doesNotThrow(() => boundary.validateDatabases(result.entries, NS));
});

/**
 * RC-dedicated PostgreSQL bootstrap SQL.
 *
 * The REAL command from deploy/sealos/rc/postgres-bootstrap.yaml is extracted
 * and executed with `sh` against stub `pg_isready`/`psql` binaries that record
 * their argv and stdin. This proves the shell semantics (quoted heredoc, psql
 * variable binding) without a cluster or a real password. Synthetic adversarial
 * passwords only.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  bootstrapManifestPath,
  read,
  tempDir,
  writeExecutable,
  yamlObjects,
} from './rc-dedicated-postgres-fixture.mjs';

const job = yamlObjects(read(bootstrapManifestPath))[0];
const script = job.spec.template.spec.containers[0].command[2];

const ADVERSARIAL = [
  "O'Brien",
  "'; DROP DATABASE postgres; --",
  'back\\slash',
  'line1\nline2',
  "quote' semi; slash\\ newline\nend",
  'double"quote',
  '$dollar$tag$',
  '`backtick`$(id)',
];

function runWithPassword(t, password) {
  const directory = tempDir(t, 'xpod-rc-bootstrap-sql-');
  const bin = path.join(directory, 'bin');
  const record = path.join(directory, 'sql.log');
  mkdirSync(bin);
  writeExecutable(path.join(bin, 'pg_isready'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'psql'), `#!/bin/sh
{
  printf 'ARGV:'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\\nSTDIN:\\n'
  cat
  printf '\\n---\\n'
} >> ${JSON.stringify(record)}
exit 0
`);
  const result = spawnSync('sh', ['-c', script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      PGPASSWORD: 'admin-synthetic',
      PGUSER: 'pgadmin',
      PGDATABASE: 'postgres',
      XPOD_RC_PASSWORD: password,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { result, log: read(record) };
}

test('heredoc is quoted so the shell never expands SQL text', () => {
  assert.match(script, /<<'SQL'/);
  assert.equal(/<<SQL\b/.test(script), false, 'an unquoted heredoc would interpolate the shell');
});

test('password is bound through a psql variable, never inline SQL or argv', () => {
  assert.match(script, /\\getenv rc_password XPOD_RC_PASSWORD/);
  assert.match(script, /PASSWORD :'rc_password'/);
  assert.equal(/PASSWORD\s+'/.test(script), false, 'the shell must not build the quoted literal');
  assert.equal(script.includes('eval'), false);
  assert.equal(/psql[^\n]*-v\s+pw=/.test(script), false);
});

test('role is created non-superuser and re-altered on every run', () => {
  assert.match(script, /CREATE ROLE xpod_rc LOGIN;/);
  assert.match(script, /ALTER ROLE xpod_rc WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB/);
});

test('app-role grants cover only the extension schema and the app role', () => {
  // The extensions ship no GRANT and a custom schema has no default PUBLIC
  // USAGE, so the minimum resolvable-object/DML/sequence grants live here.
  // Statements may span lines (ALTER DEFAULT PRIVILEGES ... ON TABLES), so
  // normalise whitespace per semicolon-terminated statement before inspecting.
  const statements = script.split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => /^(GRANT|ALTER DEFAULT PRIVILEGES)/.test(statement));
  assert.ok(statements.length >= 3, 'expected the shipped scoped grants');
  for (const statement of statements) {
    assert.match(statement, /\bxpod_rdf\b/, `grant must stay on the extension schema: ${statement}`);
    assert.match(statement, /\bTO xpod_rc$/, `grant must target the app role: ${statement}`);
  }
  // Exactly the reviewed privilege set, nothing broader.
  for (const expected of [
    'GRANT USAGE ON SCHEMA xpod_rdf TO xpod_rc;',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA xpod_rdf TO xpod_rc;',
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA xpod_rdf TO xpod_rc;',
  ]) assert.ok(script.includes(expected), expected);
  assert.equal((script.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA xpod_rdf/g) ?? []).length, 2);
});

test('grants never include PUBLIC, GRANT ALL, superuser or ownership transfer', () => {
  for (const forbidden of [
    'TO PUBLIC', 'TO public', 'GRANT ALL', 'WITH SUPERUSER', 'WITH CREATEROLE',
    'WITH CREATEDB', 'ALTER ROLE xpod_rc SUPERUSER', 'ALTER ROLE xpod_rc CREATEROLE',
    'ALTER ROLE xpod_rc CREATEDB', 'REASSIGN OWNED', 'OWNER TO xpod_rc',
    'ALTER SCHEMA xpod_rdf OWNER', 'SECURITY DEFINER',
  ]) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
  // Role attributes are only ever removed, never granted.
  assert.match(script, /ALTER ROLE xpod_rc WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB/);
  assert.equal(/\bGRANT\s+(?:SUPERUSER|CREATEROLE|CREATEDB)\b/.test(script), false);
  // No production database or shared instance may be named by a grant.
  for (const line of script.split('\n').filter((entry) => /GRANT/.test(entry))) {
    assert.equal(/xpod_cn|xpod_co|xpod-rdf-postgres/.test(line), false, line);
  }
});

test('grants follow extension installation in the same admin-owned block', () => {
  const extensionsAt = script.indexOf('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
  const firstGrantAt = script.indexOf('GRANT USAGE ON SCHEMA xpod_rdf TO xpod_rc;');
  assert.ok(extensionsAt > 0 && firstGrantAt > extensionsAt,
    'grants must run after the extension objects exist');
  // The grants are issued by the bootstrap administrator, not by xpod_rc
  // itself: the heredoc must not switch to the app role for provisioning.
  const grantBlock = script.slice(extensionsAt, firstGrantAt);
  assert.equal(/\bSET ROLE\b|\bSET SESSION AUTHORIZATION\b|-U xpod_rc/.test(grantBlock), false);
});

test('the D4 authentication probe follows the ALTER ROLE', () => {
  const alter = script.indexOf('ALTER ROLE xpod_rc');
  const probe = script.indexOf('-U xpod_rc -d xpod_rc');
  assert.ok(alter > 0 && probe > alter, 'auth probe must come after ALTER ROLE');
  assert.match(script, /PGPASSWORD="\$XPOD_RC_PASSWORD"/);
});

test('the bootstrap only ever drops the RC database', () => {
  const drops = [...script.matchAll(/DROP DATABASE (?:IF EXISTS )?([A-Za-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(drops)], [ 'xpod_rc' ]);
  assert.equal(/xpod_cn|xpod_co/.test(script), false, 'production databases must never be named');
});

test('no production admin secret or shared instance is referenced', () => {
  assert.equal(script.includes('POSTGRES_PASSWORD'), false);
  assert.equal(script.includes('xpod-rdf-postgres'), false);
  assert.match(script, /-h xpod-rc-rdf-postgres/);
});

for (const password of ADVERSARIAL) {
  test(`adversarial password ${JSON.stringify(password)} cannot inject SQL`, (t) => {
    const { result, log } = runWithPassword(t, password);
    assert.equal(result.status, 0, result.stderr);
    const sqlBlocks = log.split('STDIN:').slice(1).join('\n');
    assert.equal(sqlBlocks.includes(password), false,
      'password text may only arrive via psql \\getenv, never the shell heredoc');
    assert.match(log, /PASSWORD :'rc_password'/);
    for (const fragment of [ 'DROP DATABASE postgres;', '$(id)', '`id`' ]) {
      if (password.includes(fragment)) {
        assert.equal(log.includes(`${fragment}\n`), false, `injected ${fragment} must not be executed SQL`);
      }
    }
    for (const line of log.split('\n').filter((entry) => entry.startsWith('ARGV:'))) {
      assert.equal(line.includes(password), false, `password leaked into argv: ${line}`);
    }
  });
}

test('the executed bootstrap really emits the grants after extension installation', (t) => {
  const { result, log } = runWithPassword(t, "O'Brien-scoped-grants");
  assert.equal(result.status, 0, result.stderr);
  const blocks = log.split('STDIN:').slice(1);
  assert.ok(blocks.length >= 2, 'role/database block and extension block');
  const extensionBlock = blocks.find((block) => block.includes('CREATE EXTENSION IF NOT EXISTS xpod_qlever'));
  assert.ok(extensionBlock, 'extension block executed');
  const extensionAt = extensionBlock.indexOf('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
  for (const statement of [
    'GRANT USAGE ON SCHEMA xpod_rdf TO xpod_rc;',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA xpod_rdf TO xpod_rc;',
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA xpod_rdf TO xpod_rc;',
  ]) {
    const at = extensionBlock.indexOf(statement);
    assert.ok(at > extensionAt, `${statement} must follow CREATE EXTENSION`);
  }
  assert.equal(/TO PUBLIC|GRANT ALL|REASSIGN OWNED|OWNER TO xpod_rc/.test(extensionBlock), false);
});

/**
 * RC-dedicated PostgreSQL bootstrap SQL.
 *
 * The REAL command from deploy/sealos/rc/postgres-bootstrap.yaml is extracted
 * and executed with `sh` against stub `pg_isready`/`psql` binaries that record
 * their argv and stdin. This proves the shell semantics (quoted heredoc, psql
 * variable binding) without a cluster or a real password. Synthetic adversarial
 * passwords only.
 *
 * The command also passes through the kubelet's command/args expansion before
 * the container ever runs: a literal `$$` is collapsed to `$` by
 * ExpandContainerCommandAndArgs. The boundary tests below model that expansion
 * exactly and feed the EXPANDED script to the shell, so a legacy `DO $$` body
 * is caught here without pretending to execute PostgreSQL.
 *
 * Missing-variable semantics follow Kubernetes MappingFuncFor:
 * MappingFuncFor returns "$(NAME)" unchanged when the name is absent, while an
 * explicit empty binding returns "". Own-property lookup mirrors Go's map
 * lookup, so inherited names like constructor/__proto__ are not bindings.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

function runWithPassword(t, password, options = {}) {
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
  const result = spawnSync('sh', ['-c', options.script ?? script], {
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

/**
 * Faithful subset of the kubelet's expansion for container command/args.
 *
 * Source: kubernetes/kubernetes pkg/kubelet/container/helpers.go
 *         ExpandContainerCommandAndArgs -> expansion.Expand for every entry, and
 *         third_party/forked/golang/expansion/expand.go:
 *           - MappingFuncFor returns syntaxWrap(input) = "$(NAME)" when the
 *             variable is absent; an explicit empty value returns "".
 *           - tryReadVariableName: "$$" is an escaped operator (one literal "$");
 *             any other "$" stays literal together with the following rune.
 * There is no unbraced "$NAME" expansion.
 */
function expandKubelet(input, env) {
  const mapping = (name) => Object.hasOwn(env, name) ? env[name] : `$(${name})`;
  let out = '';
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '$' || index + 1 >= input.length) { out += input[index]; continue; }
    const next = input[index + 1];
    if (next === '$') { out += '$'; index += 1; continue; }
    if (next === '(') {
      const close = input.indexOf(')', index + 2);
      if (close < 0) { out += '$('; index += 1; continue; }
      out += mapping(input.slice(index + 2, close));
      index = close;
      continue;
    }
    out += '$' + next;
    index += 1;
  }
  return out;
}

/** The real container command after the kubelet would have expanded it. */
function expandedBootstrapCommand() {
  const container = job.spec.template.spec.containers[0];
  const env = Object.fromEntries((container.env ?? []).map((entry) => [entry.name, entry.value ?? '']));
  const command = container.command.map((entry) => expandKubelet(entry, env));
  return { command, script: command[2] };
}

test('kubelet command expansion collapses legacy "DO $$" but preserves the named tag', () => {
  // The regression this guards: the kubelet, not the shell, turns $$ into $.
  assert.equal(expandKubelet('DO $$ BEGIN END $$;', {}), 'DO $ BEGIN END $;');
  assert.equal(expandKubelet('DO $xpod_rc$ BEGIN END $xpod_rc$;', {}), 'DO $xpod_rc$ BEGIN END $xpod_rc$;');
  // $(VAR) is the only expanded form; absent stays literal, explicit empty is empty.
  assert.equal(expandKubelet('$OPEN', { OPEN: 'value' }), '$OPEN');
  assert.equal(expandKubelet('$(OPEN)', { OPEN: 'value' }), 'value');
  assert.equal(expandKubelet('$(MISSING)', {}), '$(MISSING)');
  assert.equal(expandKubelet('$(EMPTY)', { EMPTY: '' }), '');
  assert.equal(expandKubelet('$$(OPEN)', { OPEN: 'value' }), '$(OPEN)');
  assert.equal(expandKubelet('cost $$5', {}), 'cost $5');
  // Inherited names must not resolve as bindings (Go map lookup is own-key only).
  assert.equal(expandKubelet('$(constructor)', {}), '$(constructor)');
  assert.equal(expandKubelet('$(__proto__)', {}), '$(__proto__)');
  assert.equal(expandKubelet('$(toString)', {}), '$(toString)');

  // The current command must not carry a collapsible bare $$ ...
  assert.equal(/\$\$/.test(script), false, 'bare $$ would be collapsed by the kubelet');
  // ... while a legacy variant demonstrably corrupts the SQL after expansion,
  // so this test fails on the old bytes instead of mirroring the new ones.
  const legacy = script.replaceAll('$xpod_rc$', () => '$$');
  assert.match(expandKubelet(legacy, {}), /DO \$\s/);

  const expanded = expandedBootstrapCommand().script;
  const tags = [...expanded.matchAll(/DO \$([A-Za-z_][A-Za-z0-9_]*)\$/g)].map((match) => match[1]);
  assert.ok(tags.length >= 2, 'both PL/pgSQL blocks survive expansion with a named tag');
  for (const tag of new Set(tags)) assert.ok(expanded.includes(`$${tag}$;`), `named tag ${tag} must be closed`);
  assert.equal(/DO \$(?![A-Za-z_])/.test(expanded), false, 'no collapsed "DO $" may survive expansion');
});

test('the kubelet-expanded command reaches the shell with its SQL intact', (t) => {
  const { result, log } = runWithPassword(t, "O'Brien-expanded", { script: expandedBootstrapCommand().script });
  assert.equal(result.status, 0, result.stderr);
  const blocks = log.split('STDIN:').slice(1);
  assert.ok(blocks.length >= 2, 'role/database block and extension block');
  assert.ok(blocks.some((block) => block.includes('DO $xpod_rc$')), 'named tag reaches psql');
  assert.equal(blocks.some((block) => /DO \$(?![A-Za-z_])/.test(block)), false,
    'the shell must never receive a collapsed DO $');
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


/**
 * REAL PostgreSQL regression for the affected SQL path (opt-in).
 *
 * Set XPOD_FULL_POSTGRES_IMAGE to an immutable PG17 image (the canonical
 * NATIVE_PG_IMAGE digest) to execute the ACTUAL
 * kubelet-expanded script in a throwaway container. The private canonical image
 * is unavailable on ordinary PRs, so the case is skipped there; the default
 * suite above stays hermetic. This is the only check that proves the SQL runs.
 */
const liveImage = process.env.XPOD_FULL_POSTGRES_IMAGE;

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, ...options });
}

test('REAL PostgreSQL: expanded bootstrap creates the app role/db/extensions and resets on a second run',
  { skip: liveImage ? false : 'set XPOD_FULL_POSTGRES_IMAGE to an immutable PG17 image; the private canonical image is unavailable on ordinary PRs' },
  (t) => {
    assert.match(liveImage, /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/, 'XPOD_FULL_POSTGRES_IMAGE must be immutable');
    const name = `xpod-rc-bootstrap-real-${randomUUID()}`;
    const adminPassword = 'synthetic-admin-only';
    const start = docker(['run', '-d', '--name', name,
      '--add-host', 'xpod-rc-rdf-postgres:127.0.0.1',
      '-e', 'POSTGRES_USER=xpod_rc_admin',
      '-e', `POSTGRES_PASSWORD=${adminPassword}`,
      // Force password (scram) auth on the TCP path the script uses; a trust
      // rule would make the "old password rejected" assertion meaningless.
      '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      liveImage]);
    assert.equal(start.status, 0, start.stderr);
    // Register cleanup only after the container was actually started, so a
    // start failure is not masked by removing a container that never existed.
    t.after(() => {
      const removed = docker(['rm', '-f', '-v', name]);
      assert.equal(removed.status, 0, `owned container ${name} must be removed with its anonymous volumes`);
    });

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'xpod_rc_admin', '-q']).status === 0) {
        ready = true;
        break;
      }
      spawnSync('sleep', ['1']);
    }
    assert.ok(ready, 'real PostgreSQL did not become ready');

    // The shell receives exactly the bytes the kubelet would hand it.
    const { script: expandedScript } = expandedBootstrapCommand();
    const directory = tempDir(t, 'xpod-rc-bootstrap-real-sql-');
    const scriptPath = path.join(directory, 'bootstrap.sh');
    writeFileSync(scriptPath, expandedScript, { mode: 0o600 });
    const copied = docker(['cp', scriptPath, `${name}:/tmp/bootstrap.sh`]);
    assert.equal(copied.status, 0, copied.stderr);

    // Two runs: special-character passwords must survive psql quoting, and the
    // second run must reset the logical database/role to the new password.
    const passwords = ["O'Brien\\slash", 'a"b$c`d`'];
    for (const [index, password] of passwords.entries()) {
      const run = docker(['exec', '-e', 'PGUSER=xpod_rc_admin', '-e', `PGPASSWORD=${adminPassword}`,
        '-e', 'PGDATABASE=postgres', '-e', `XPOD_RC_PASSWORD=${password}`,
        name, 'sh', '/tmp/bootstrap.sh']);
      assert.equal(run.status, 0, `bootstrap run ${index + 1}: ${run.stderr}`);
    }

    // The app role authenticates with the CURRENT password only, in the app DB.
    const auth = docker(['exec', '-e', `PGPASSWORD=${passwords.at(-1)}`, name,
      'psql', '-h', '127.0.0.1', '-U', 'xpod_rc', '-d', 'xpod_rc', '-Atc', 'select current_user']);
    assert.equal(auth.status, 0, auth.stderr);
    assert.equal(auth.stdout.trim(), 'xpod_rc');
    const stale = docker(['exec', '-e', `PGPASSWORD=${passwords[0]}`, name,
      'psql', '-h', '127.0.0.1', '-U', 'xpod_rc', '-d', 'xpod_rc', '-Atc', 'select 1']);
    assert.notEqual(stale.status, 0, 'the previous password must no longer authenticate');

    const catalog = docker(['exec', '-e', `PGPASSWORD=${adminPassword}`, name,
      'psql', '-U', 'xpod_rc_admin', '-h', '127.0.0.1', '-d', 'xpod_rc', '-Atc',
      "select 'role:'||rolname||':'||rolsuper||':'||rolcreaterole||':'||rolcreatedb from pg_roles where rolname='xpod_rc';"
      + "select 'db:'||datname||':'||pg_get_userbyid(datdba) from pg_database where datname='xpod_rc';"
      + "select 'ext:'||extname||'='||extversion from pg_extension where extname in ('vector','xpod_rdf','xpod_qlever') order by extname;"]);
    assert.equal(catalog.status, 0, catalog.stderr);
    const lines = catalog.stdout.trim().split('\n');
    assert.deepEqual(lines.filter((line) => line.startsWith('role:')), [ 'role:xpod_rc:false:false:false' ]);
    assert.deepEqual(lines.filter((line) => line.startsWith('db:')), [ 'db:xpod_rc:xpod_rc' ]);
    const extensions = Object.fromEntries(lines.filter((line) => line.startsWith('ext:'))
      .map((line) => line.slice('ext:'.length).split('=')));
    // Only the versions the bootstrap SQL itself requires; vector is presence-only.
    assert.equal(extensions.xpod_rdf, '0.2.0');
    assert.equal(extensions.xpod_qlever, '0.4.0');
    assert.ok(extensions.vector && extensions.vector.length > 0, 'vector extension must be installed');
  });

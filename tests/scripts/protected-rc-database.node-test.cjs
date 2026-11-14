const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const readinessScript = path.join(repoRoot, 'scripts/verify-protected-rc-database.sh');
const root = path.join(repoRoot, '.test-data/protected-rc-database');
fs.mkdirSync(root, { recursive: true });

/**
 * The stub psql records argv/stdin and answers the two catalog queries. The
 * readiness script itself is the REAL checked-in shell script; only the server
 * is simulated. `SCENARIO=mismatch` reports the database as needing bootstrap,
 * i.e. the readiness assertion fails while the SQL stayed read-only.
 */
const PSQL_STUB = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const query = args.includes('-Atc') ? args[args.indexOf('-Atc') + 1] : fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.RECORD, JSON.stringify({ args, query, options: process.env.PGOPTIONS }) + '\\n');
if (query === 'SHOW server_version_num') {
  console.log(process.env.SCENARIO === 'pg16' ? '160010' : '170006');
} else if (['missing', 'query-error'].includes(process.env.SCENARIO)) {
  process.exit(1);
} else {
  console.log('BEGIN\\n' + (process.env.SCENARIO === 'mismatch'
    ? 'rc-only-pg-bootstrap-required' : 'rc-only-pg-ready') + '\\nROLLBACK');
}
`;

for (const scenario of ['ready', 'pg16', 'missing', 'mismatch', 'query-error']) {
  test(`RC-only database readiness preflight ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    try {
      const fake = path.join(dir, 'psql');
      fs.writeFileSync(fake, PSQL_STUB, { mode: 0o700 });
      const record = path.join(dir, 'calls.jsonl');
      const result = spawnSync('/bin/sh', [readinessScript], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { PATH: dir, POSTGRES_USER: 'fixture', POSTGRES_PASSWORD: 'private-fixture', RECORD: record, SCENARIO: scenario },
      });
      assert.equal(result.status, scenario === 'ready' ? 0 : 1, result.stdout + result.stderr);
      const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, scenario === 'pg16' ? 1 : 2);
      for (const call of calls) {
        // The whole preflight is read-only, including the session default.
        assert.equal(call.options, '-c default_transaction_read_only=on');
        assert.ok(call.args.includes('-X'));
        assert.ok(call.args.includes('ON_ERROR_STOP=1'));
        assert.match(call.query, /^(SHOW server_version_num|BEGIN READ ONLY;)/);
        // No DDL/DML statement text. Column names such as rolcreaterole are
        // identifiers inside a SELECT, not statements, so match statement
        // keywords only at a line/statement boundary.
        assert.doesNotMatch(call.query, /(^|;|\n)\s*(DROP|CREATE|ALTER|GRANT|TRUNCATE|DELETE|INSERT|UPDATE)\b/i);
        assert.ok(!call.args.includes('private-fixture'), 'password must never be argv');
      }
      if (calls[1]) {
        assert.match(calls[1].query, /BEGIN READ ONLY;/);
        assert.match(calls[1].query, /ROLLBACK;/);
        assert.match(calls[1].query, /rc-only-pg-ready/);
      }
      assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('readiness binds the RC-only server, role and exact extension versions', () => {
  const script = fs.readFileSync(readinessScript, 'utf8');
  assert.equal(script.includes('xpod-rdf-postgres'), false, 'the shared production instance must not be named');
  assert.match(script, /xpod-rc-rdf-postgres/);
  assert.match(script, /SHOW server_version_num/);
  assert.match(script, /17\?\?\?\?/);
  assert.match(script, /BEGIN READ ONLY/);
  assert.match(script, /default_transaction_read_only=on/);
  assert.match(script, /NOT rolsuper/);
  assert.match(script, /NOT rolcreaterole/);
  assert.match(script, /NOT rolcreatedb/);
  assert.match(script, /datdba\)[^\n]*= 'xpod_rc'|pg_get_userbyid\(datdba\)/);
  assert.match(script, /extname = 'vector'/);
  assert.match(script, /extname = 'xpod_rdf' AND extversion = '0\.2\.0'/);
  assert.match(script, /extname = 'xpod_qlever' AND extversion = '0\.4\.0'/);
  assert.doesNotMatch(script, /DROP DATABASE|CREATE DATABASE|CREATE EXTENSION|ALTER SCHEMA/);
});

test('protected preflight runs against the RC-only StatefulSet before app deployment', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/candidate.yml'), 'utf8');
  const preflight = workflow.indexOf('scripts/verify-protected-rc-database.sh');
  assert.ok(preflight > 0);
  assert.ok(preflight < workflow.indexOf('- name: Create runtime secrets'));
  assert.ok(preflight < workflow.indexOf('- name: Deploy RC image by digest'));
  assert.match(workflow, /exec -i statefulset\/xpod-rc-rdf-postgres -- sh -s < scripts\/verify-protected-rc-database\.sh/);
  assert.equal(/exec -i statefulset\/xpod-rdf-postgres --/.test(workflow), false);
  // PG creation lives only inside the dedicated bootstrap Job template.
  assert.doesNotMatch(workflow, /DROP DATABASE|CREATE DATABASE|CREATE EXTENSION|ALTER SCHEMA/);
});

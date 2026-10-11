const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve('.test-data/protected-rc-database');
fs.mkdirSync(root, { recursive: true });
for (const scenario of ['ready', 'pg16', 'missing', 'mismatch', 'query-error']) {
  test(`protected database preflight ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    try {
      const fake = path.join(dir, 'psql');
      fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const query=args.includes('-Atc')?args[args.indexOf('-Atc')+1]:fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.RECORD,JSON.stringify({args,query,options:process.env.PGOPTIONS})+'\\n');if(query==='SHOW server_version_num')console.log(process.env.SCENARIO==='pg16'?'160010':'170006');else if(['missing','query-error'].includes(process.env.SCENARIO))process.exit(1);else console.log('BEGIN\\n'+(process.env.SCENARIO==='mismatch'?'protected-rc-migration-required':'protected-rc-ready')+'\\nROLLBACK');\n`, { mode: 0o700 });
      const record = path.join(dir, 'calls.jsonl');
      const result = spawnSync('/bin/sh', ['scripts/verify-protected-rc-database.sh'], { encoding: 'utf8', env: { PATH: dir, POSTGRES_USER: 'fixture', POSTGRES_PASSWORD: 'private-fixture', RECORD: record, SCENARIO: scenario } });
      assert.equal(result.status, scenario === 'ready' ? 0 : 1);
      const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, scenario === 'pg16' ? 1 : 2);
      for (const call of calls) {
        assert.equal(call.options, '-c default_transaction_read_only=on');
        assert.ok(call.args.includes('-X')); assert.ok(call.args.includes('ON_ERROR_STOP=1'));
        assert.doesNotMatch(call.query, /DROP|CREATE|ALTER|GRANT|TRUNCATE|DELETE|INSERT|UPDATE/i);
        assert.ok(!call.args.includes('private-fixture'));
      }
      if (calls[1]) assert.match(calls[1].query, /^BEGIN READ ONLY;/);
      assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
test('protected preflight precedes shared deployment writes', () => {
  const workflow = fs.readFileSync('.github/workflows/candidate.yml', 'utf8');
  const gate = workflow.indexOf('scripts/verify-protected-rc-database.sh');
  assert.ok(gate > 0 && gate < workflow.indexOf('- name: Create runtime secrets'));
  assert.doesNotMatch(workflow, /DROP DATABASE|CREATE DATABASE|CREATE EXTENSION|ALTER SCHEMA/);
});

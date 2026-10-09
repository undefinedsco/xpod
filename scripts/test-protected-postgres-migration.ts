import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PG16 = 'sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a';
const PG17 = 'ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:1199698c789fb65897e4b0bd370f7faa959bcbdd3499784af256ad5bb8f0a5f3';
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }

interface ProcessReceipt { name: string; exit: number | null; signal: string | null; actualWait: boolean; rawClosed: boolean; groupAbsent: boolean; stdoutHash: string; stderrHash: string; }
export interface FixtureReport { scope: string; ok: boolean; nonce: string; assertions: string[]; cleanup: { containersAbsent: boolean; volumesAbsent: boolean; networkAbsent: boolean }; receipts: ProcessReceipt[]; }

export async function runProtectedMigrationFixture(): Promise<{ report: FixtureReport; evidenceDirectory: string }> {
  const nonce = randomUUID().replace(/-/gu, '').slice(0, 16);
  const prefix = `xpod-pg-fixture-${nonce}`;
  const root = path.resolve('.test-data/protected-pg-migration', nonce);
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const sourceHash = hash(await readFile(path.resolve('scripts/lib/protected-postgres-migration.ts')));
  const harnessHash = hash(await readFile(fileURLToPath(import.meta.url)));
  await writeFile(path.join(root, 'source-binding.safe.json'), JSON.stringify({ productionSourceSHA256: sourceHash, fixtureScriptSHA256: harnessHash }), { mode: 0o600, flag: 'wx' });
  const password = `fixture-${randomUUID()}`;
  const names = { source: `${prefix}-source`, target: `${prefix}-target`, network: `${prefix}-net`, sourceVolume: `${prefix}-source-data`, targetVolume: `${prefix}-target-data` };
  const receipts: ProcessReceipt[] = [];
  const assertions: string[] = [];
  const report: FixtureReport = { scope: 'Owned local PG16/PG17 controlled fixture only; NOT real Gateway/Pod or production database migration', ok: false, nonce, assertions, cleanup: { containersAbsent: false, volumesAbsent: false, networkAbsent: false }, receipts };
  let sequence = 0;
  async function exec(name: string, args: string[], input?: string, acceptable = [0], binary = 'docker', additionalEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const child = spawn(binary, args, { detached: true, env: { ...process.env, POSTGRES_PASSWORD: password, ...additionalEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', b => out.push(Buffer.from(b))); child.stderr.on('data', b => err.push(Buffer.from(b)));
    child.stdin.end(input);
    const kill = (signal: NodeJS.Signals): void => { if (child.pid) try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } };
    const timer = setTimeout(() => kill('SIGTERM'), 120_000); const forced = setTimeout(() => kill('SIGKILL'), 125_000);
    const result = await new Promise<{ exit: number | null; signal: string | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (exit, signal) => resolve({ exit, signal })); }).finally(() => { clearTimeout(timer); clearTimeout(forced); });
    const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
    const rawName = `${String(++sequence).padStart(3, '0')}-${name}`;
    await writeFile(path.join(root, `${rawName}.stdout.private.log`), stdout, { mode: 0o600 });
    await writeFile(path.join(root, `${rawName}.stderr.private.log`), stderr, { mode: 0o600 });
    let absent = false; if (child.pid) try { process.kill(-child.pid, 0); } catch (e) { absent = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    receipts.push({ name: rawName, ...result, actualWait: true, rawClosed: true, groupAbsent: absent, stdoutHash: hash(stdout), stderrHash: hash(stderr) });
    assert(!stdout.includes(password) && !stderr.includes(password), 'fixture secret emitted to process output');
    assert(absent && result.signal === null && result.exit !== null && acceptable.includes(result.exit), `fixture process failed: ${rawName}`);
    return stdout.toString();
  }
  const clients: pg.Client[] = [];
  let sourceClient: pg.Client | undefined;
  let beforeInventory: unknown;
  async function client(url: string): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: url }); await c.connect(); clients.push(c); return c;
  }
  async function waitReady(name: string): Promise<void> {
    for (let n = 0; n < 60; n++) {
      const result = await exec('ready', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], undefined, [0, 1, 2]);
      if (result.includes('accepting connections')) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('owned fixture readiness deadline');
  }
  async function inventory(c: pg.Client): Promise<unknown> {
    const queries = {
      roles: `SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolpassword FROM pg_authid WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname`,
      roleSettings: `SELECT coalesce(r.rolname,'') role,coalesce(d.datname,'') database,s.setconfig FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase ORDER BY 1,2`,
      membership: `SELECT roleid::regrole::text,member::regrole::text,grantor::regrole::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2,3`,
      schemas: `SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl::text FROM pg_namespace WHERE nspname IN ('rdf_a','rdf_b') ORDER BY 1`,
      tables: `SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('rdf_a','rdf_b') ORDER BY 1,2`,
      acl: `SELECT defaclrole::regrole::text,n.nspname,defaclobjtype,defaclacl::text FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace ORDER BY 1,2,3`,
      explicitRelationPrivileges: `SELECT n.nspname,c.relname,pg_get_userbyid(a.grantor) grantor,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,a.privilege_type,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname IN ('rdf_a','rdf_b') ORDER BY 1,2,3,4,5,6`,
      explicitColumnPrivileges: `SELECT n.nspname,c.relname,col.attname,pg_get_userbyid(a.grantor) grantor,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,a.privilege_type,a.is_grantable FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE n.nspname IN ('rdf_a','rdf_b') ORDER BY 1,2,3,4,5,6,7`,
      extensions: `SELECT extname,extversion,n.nspname,pg_get_userbyid(extowner) owner FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1`,
      indices: `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('rdf_a','rdf_b') ORDER BY 1,2,3`,
      sequence: `SELECT last_value::text,is_called FROM rdf_a.event_seq`,
      rows: `SELECT id,subject,predicate,object,payload,body,v::text FROM rdf_a.quads ORDER BY id`,
      secondary: `SELECT * FROM rdf_b.audit ORDER BY id`,
      rich: `SELECT id,state,encode(bytes,'hex') bytes,payload,nullable FROM rdf_b.rich ORDER BY id`,
      types: `SELECT t.typname,t.typtype,pg_get_userbyid(t.typowner) owner,t.typacl::text,format_type(t.typbasetype,t.typtypmod) base,t.typdefault,ARRAY(SELECT enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY enumsortorder) labels FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='rdf_b' ORDER BY 1`,
      routines: `SELECT proname,pg_get_functiondef(p.oid) definition,pg_get_userbyid(proowner) owner,proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=pronamespace WHERE n.nspname='rdf_b' ORDER BY 1`,
      triggers: `SELECT tgname,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rdf_b' AND NOT t.tgisinternal ORDER BY 1`,
      comments: `SELECT i.type,i.identity,d.description FROM pg_description d CROSS JOIN LATERAL pg_identify_object(d.classoid,d.objoid,d.objsubid) i WHERE i.schema IN ('rdf_a','rdf_b') ORDER BY 1,2`,
      lob: `SELECT oid,pg_get_userbyid(lomowner) owner,lomacl::text,encode(lo_get(oid),'hex') bytes FROM pg_largeobject_metadata ORDER BY oid`,
      fts: `SELECT id FROM rdf_a.quads WHERE body_index @@ plainto_tsquery('english','solid migration') ORDER BY id`,
      vec: `SELECT id FROM rdf_a.quads ORDER BY v <-> '[1,0,0]'::vector,id LIMIT 3`,
      settings: `SELECT datname,pg_get_userbyid(datdba) owner,datacl::text FROM pg_database WHERE datname='fixture'`,
    };
    const output: Record<string, unknown> = {};
    for (const [name, sql] of Object.entries(queries)) output[name] = (await c.query(sql)).rows;
    return output;
  }
  try {
    await exec('network-create', ['network', 'create', names.network]);
    for (const volume of [names.sourceVolume, names.targetVolume]) await exec('volume-create', ['volume', 'create', volume]);
    const emptyInit = path.join(root, 'empty-target-init'); await mkdir(emptyInit, { mode: 0o755 }); await chmod(emptyInit, 0o755);
    for (const [name, volume, image] of [[names.source, names.sourceVolume, PG16], [names.target, names.targetVolume, PG17]]) {
      const targetInit = name === names.target ? ['--mount', `type=bind,src=${emptyInit},dst=/docker-entrypoint-initdb.d,readonly`] : [];
      await exec('container-start', ['run', '-d', '--name', name, '--network', names.network, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${name === names.source ? 'fixture' : 'postgres'}`, '-v', `${volume}:/var/lib/postgresql/data`, '--mount', `type=bind,src=${root},dst=${root}`, ...targetInit, image]);
      await waitReady(name);
    }
    const urls: string[] = [];
    for (const name of [names.source, names.target]) {
      const ports = JSON.parse(await exec('owned-port', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
      const port = ports['5432/tcp'][0].HostPort;
      urls.push(`postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${name === names.source ? 'fixture' : 'postgres'}`);
    }
    const source = await client(urls[0]), target = await client(urls[1]);
    sourceClient = source;
    const pristineTarget: Record<string, unknown> = {};
    for (const [label, sql] of Object.entries({
      namespaces: "SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl::text FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)(_|$)' ORDER BY 1",
      types: "SELECT n.nspname,t.typname,t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)(_|$)' ORDER BY 1,2",
      functions: "SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)(_|$)' ORDER BY 1,2",
      extensions: 'SELECT extname,extversion FROM pg_extension ORDER BY 1',
      database: 'SELECT datname,pg_get_userbyid(datdba) owner,datacl::text FROM pg_database WHERE datname=current_database()',
      defaultAcl: 'SELECT * FROM pg_default_acl',
      databaseRoleSettings: 'SELECT * FROM pg_db_role_setting',
      largeObjects: 'SELECT oid FROM pg_largeobject_metadata',
      memberships: 'SELECT r.rolname AS role,m.rolname AS member,g.rolname AS grantor,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor ORDER BY r.rolname COLLATE "C",m.rolname COLLATE "C",g.rolname COLLATE "C"',
    })) pristineTarget[label] = (await target.query(sql)).rows;
    await writeFile(path.join(root, 'pristine-target.private.json'), JSON.stringify(pristineTarget, null, 2), { mode: 0o600, flag: 'wx' });
    const businessNamespaces = pristineTarget.namespaces as Array<{ nspname: string; owner: string; nspacl: string }>;
    const initialDatabase = (pristineTarget.database as Array<{ owner: string; datacl: string | null }>)[0];
    assert(businessNamespaces.length === 1 && businessNamespaces[0].nspname === 'public' && businessNamespaces[0].owner === 'pg_database_owner' && businessNamespaces[0].nspacl === '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}', 'pristine target namespace/ACL baseline');
    assert(initialDatabase.owner === 'postgres' && initialDatabase.datacl === null, 'pristine target database/ACL baseline');
    assert((pristineTarget.extensions as Array<{extname: string}>).every(e => e.extname === 'plpgsql'), 'pristine target extension baseline');
    for (const key of ['types','functions','defaultAcl','databaseRoleSettings','largeObjects']) assert((pristineTarget[key] as unknown[]).length === 0, `pristine target ${key} baseline`);
    const baselinePredicates: Record<string, boolean> = {};
    const bootstrapMemberships = ['pg_read_all_settings', 'pg_read_all_stats', 'pg_stat_scan_tables'].map(role => ({ role, member: 'pg_monitor', grantor: 'postgres', admin_option: false, inherit_option: true, set_option: true }));
    baselinePredicates.unexpectedBootstrapMemberships = JSON.stringify(pristineTarget.memberships) !== JSON.stringify(bootstrapMemberships);
    const namespace = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)(_|$)'";
    for (const [key, sql] of Object.entries({
      customSchema: `SELECT 1 FROM pg_namespace n WHERE ${namespace} AND n.nspname <> 'public' LIMIT 1`,
      routines: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace} LIMIT 1`,
      types: `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${namespace} LIMIT 1`,
      extensions: "SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql' LIMIT 1",
      defaultACL: 'SELECT 1 FROM pg_default_acl LIMIT 1', databaseRoleSettings: 'SELECT 1 FROM pg_db_role_setting LIMIT 1', largeObjects: 'SELECT 1 FROM pg_largeobject_metadata LIMIT 1',
      databaseACL: "SELECT 1 FROM pg_database WHERE datname=current_database() AND (datacl IS NOT NULL OR datdba<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) LIMIT 1",
      publicACL: "SELECT 1 FROM pg_namespace WHERE nspname='public' AND (pg_get_userbyid(nspowner)<>'pg_database_owner' OR nspacl::text IS DISTINCT FROM '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}') LIMIT 1",
      relations: `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} LIMIT 1`,
      customRoles: "SELECT 1 FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> current_user LIMIT 1", businessDatabase: "SELECT 1 FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' LIMIT 1",
    })) baselinePredicates[key] = Boolean((await target.query(sql)).rowCount);
    await writeFile(path.join(root, 'pristine-predicates.safe.json'), JSON.stringify(baselinePredicates, null, 2), { mode: 0o600, flag: 'wx' });
    assert(Object.values(baselinePredicates).every(value => value === false), 'pristine target preflight predicates');
    assertions.push('pristine PG17 baseline independently empty from initial owned init directory; image binaries unchanged');
    await source.query(`CREATE ROLE fixture_owner LOGIN PASSWORD 'fixture-owner-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE fixture_reader LOGIN PASSWORD 'fixture-reader-password' NOINHERIT;
CREATE ROLE fixture_writer NOLOGIN;
CREATE ROLE "fixture quoted'role" NOLOGIN;
COMMENT ON ROLE fixture_owner IS 'fixture role provenance';
ALTER ROLE fixture_reader SET statement_timeout='7s';
ALTER ROLE fixture_reader IN DATABASE fixture SET statement_timeout='11s';
GRANT fixture_writer TO fixture_reader WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
CREATE EXTENSION vector;
CREATE SCHEMA rdf_a AUTHORIZATION fixture_owner;
CREATE SCHEMA rdf_b AUTHORIZATION fixture_owner;
SET ROLE fixture_owner;
CREATE SEQUENCE rdf_a.event_seq START 101 INCREMENT 7;
CREATE TABLE rdf_a.quads(id bigint DEFAULT nextval('rdf_a.event_seq') PRIMARY KEY,subject text NOT NULL,predicate text NOT NULL,object text,payload jsonb,body text,body_index tsvector GENERATED ALWAYS AS (to_tsvector('english',body)) STORED,v vector(3));
CREATE TABLE rdf_b.audit(id bigint PRIMARY KEY,note text);
CREATE TYPE rdf_b.lifecycle AS ENUM ('new','ready');
CREATE DOMAIN rdf_b.positive_integer AS integer CHECK (VALUE > 0);
CREATE TABLE rdf_b.rich(id rdf_b.positive_integer PRIMARY KEY, state rdf_b.lifecycle, bytes bytea, payload jsonb, nullable text);
INSERT INTO rdf_b.rich VALUES(1,'ready',decode('0001ff','hex'),'{"unicode":"中文"}'::jsonb,NULL);
CREATE FUNCTION rdf_b.audit_touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.note := NEW.note || ':trigger'; RETURN NEW; END$$;
CREATE TRIGGER audit_touch BEFORE INSERT ON rdf_b.audit FOR EACH ROW EXECUTE FUNCTION rdf_b.audit_touch();
COMMENT ON TABLE rdf_b.rich IS 'fixture rich table';
COMMENT ON COLUMN rdf_b.rich.bytes IS 'bytea preserved';
COMMENT ON TYPE rdf_b.lifecycle IS 'enum preserved';
INSERT INTO rdf_a.quads(subject,predicate,object,payload,body,v) VALUES ('urn:s:1','urn:p','中文','{"a":1}'::jsonb,'solid migration exact','[1,0,0]'),('urn:s:2','urn:p',NULL,'[1,2]'::jsonb,'unrelated archive','[0,1,0]'),('urn:s:3','urn:p','line'||chr(10)||'break','null'::jsonb,'solid migration second','[0.8,0.2,0]');
INSERT INTO rdf_b.audit VALUES(1,'retained'),(2,'多schema');
CREATE INDEX quads_body_fts ON rdf_a.quads USING gin(body_index);
CREATE INDEX quads_vec ON rdf_a.quads USING hnsw(v vector_l2_ops);
GRANT USAGE ON SCHEMA rdf_a,rdf_b TO fixture_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA rdf_a,rdf_b TO fixture_reader;
GRANT USAGE,SELECT ON SEQUENCE rdf_a.event_seq TO fixture_reader;
GRANT USAGE ON SCHEMA rdf_a,rdf_b TO "fixture quoted'role";
GRANT ALL PRIVILEGES ON rdf_b.rich TO "fixture quoted'role" WITH GRANT OPTION;
GRANT UPDATE(object) ON rdf_a.quads TO "fixture quoted'role" WITH GRANT OPTION;
GRANT USAGE ON SCHEMA rdf_b TO PUBLIC;
GRANT SELECT ON rdf_b.audit TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA rdf_a GRANT SELECT ON TABLES TO fixture_reader;
RESET ROLE;
SELECT lo_from_bytea(424242,decode('000102ff','hex'));
ALTER LARGE OBJECT 424242 OWNER TO fixture_owner;
GRANT SELECT ON LARGE OBJECT 424242 TO fixture_reader;`);
    const sourceBefore = await inventory(source);
    beforeInventory = sourceBefore;
    await writeFile(path.join(root, 'source-before.private.json'), JSON.stringify(sourceBefore), { mode: 0o600 });
    // Host PG URLs are rewritten only inside fixture-owned Docker wrappers.
    const wrapperDir = path.join(root, 'client-bin'); await mkdir(wrapperDir, { mode: 0o700 });
    const route = urls.map((url, i) => ({ hostPort: new URL(url).port, host: i === 0 ? names.source : names.target }));
    for (const executable of ['pg_dump', 'pg_dumpall', 'pg_restore']) {
      const wrapper = `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';\nconst routes=${JSON.stringify(route)};\nconst route=routes.find(r=>r.hostPort===process.env.PGPORT);if(!route||process.env.PGHOST!=='127.0.0.1')process.exit(72);\nconst args=process.argv.slice(2);\nconst p=spawn('docker',['exec','-i','-e','PGPASSWORD','-e','PGUSER','-e','PGDATABASE','-e','PGOPTIONS','-e','PGHOST='+route.host,'-e','PGPORT=5432',${JSON.stringify(names.target)},${JSON.stringify(executable)},...args],{stdio:'inherit'});p.on('error',()=>process.exit(70));p.on('close',(code,signal)=>process.exit(signal?71:code??70));\n`;
      await writeFile(path.join(wrapperDir, executable), wrapper, { mode: 0o700 });
    }
    const migration = await import('./lib/protected-postgres-migration');
    const binaries = { pgDump: path.join(wrapperDir, 'pg_dump'), pgDumpAll: path.join(wrapperDir, 'pg_dumpall'), pgRestore: path.join(wrapperDir, 'pg_restore') };
    const backupDir = path.join(root, 'backup');
    const exported = await migration.exportProtectedPostgres({ sourceUrl: urls[0], outDir: backupDir, binaries });
    const manifestSha256 = String(exported.manifestSHA256);
    assertions.push('production export completed');
    async function verifyCommand(directory: string, label: string): Promise<void> {
      const receipt = JSON.parse(await readFile(path.join(directory, `${label}.receipt.private.json`), 'utf8'));
      assert(receipt.actualExit === 0 && receipt.signal === null && receipt.groupAbsent === true && receipt.interrupted === false, `production command exit/absence: ${label}`);
      for (const channel of ['stdout', 'stderr']) {
        const raw = await readFile(path.join(directory, receipt[`${channel}Path`]));
        assert(hash(raw) === receipt[`${channel}SHA256`] && !raw.includes(password), `production command rawhash/no-secret: ${label}`);
        assert(((await stat(path.join(directory, receipt[`${channel}Path`]))).mode & 0o777) === 0o600, `production command raw privacy: ${label}`);
      }
    }
    await verifyCommand(backupDir, 'pg-dump'); await verifyCommand(backupDir, 'pg-dumpall');
    assertions.push('production export commands actual exit0/closed raw hashes/private0600/group absence independently verified');
    assert(hash(await readFile(path.resolve('scripts/lib/protected-postgres-migration.ts'))) === sourceHash, 'production source changed during fixture');
    async function rejected(label: string, operation: () => Promise<unknown>, expected: string): Promise<void> {
      let reason = ''; try { await operation(); } catch (error) { reason = error instanceof Error ? error.message : 'unknown'; }
      const safeReasons = ['target-must-be-independent-pg17','target-existing-tablespace-rejected','target-existing-membership-rejected','target-existing-database-rejected','target-existing-business-object-rejected','target-not-empty','invalid-backup-authority','backup-bytes-changed','pg-dump-failed'];
      await writeFile(path.join(root, `negative-${label}.result.safe.json`), JSON.stringify({ label, expected, actual: safeReasons.includes(reason) ? reason : reason ? 'unexpected-private-error' : 'no-rejection', passed: reason === expected }), { mode: 0o600, flag: 'wx' });
      if (reason) await writeFile(path.join(root, `negative-${label}.error.private.log`), reason, { mode: 0o600, flag: 'wx' });
      assert(reason === expected, `negative gate did not reject as expected: ${label}`);
      assertions.push(`negative ${label}: ${expected}`);
    }
    const restore = (label: string, options: Partial<Parameters<typeof migration.restoreProtectedPostgres>[0]> = {}) => migration.restoreProtectedPostgres({ targetUrl: urls[1], backupDir, manifestSha256, binaries, outDir: path.join(root, label), ...options });
    async function noSourceObjectsCreated(): Promise<void> {
      assert((await target.query("SELECT 1 FROM pg_roles WHERE rolname IN ('fixture_owner','fixture_reader','fixture_writer')")).rowCount === 0, 'negative restore created source roles');
      assert((await target.query("SELECT 1 FROM pg_database WHERE datname='fixture'")).rowCount === 0, 'negative restore created source database');
    }
    const tablespaceDirectory = `/tmp/${prefix}-tablespace`;
    await exec('tablespace-directory-create', ['exec', names.target, 'mkdir', tablespaceDirectory]);
    await exec('tablespace-directory-owner', ['exec', names.target, 'chown', 'postgres:postgres', tablespaceDirectory]);
    await target.query(`CREATE TABLESPACE fixture_existing_tablespace LOCATION '${tablespaceDirectory}'`);
    await rejected('existing-target-tablespace', () => restore('negative-existing-tablespace'), 'target-existing-tablespace-rejected');
    assert((await target.query("SELECT pg_tablespace_location(oid) location FROM pg_tablespace WHERE spcname='fixture_existing_tablespace'")).rows[0]?.location === tablespaceDirectory, 'negative changed target tablespace');
    await noSourceObjectsCreated();
    await target.query('DROP TABLESPACE fixture_existing_tablespace');
    await exec('tablespace-directory-remove', ['exec', names.target, 'rmdir', tablespaceDirectory]);
    await target.query('GRANT pg_read_all_data TO postgres');
    await rejected('existing-target-membership', () => restore('negative-existing-membership'), 'target-existing-membership-rejected');
    assert((await target.query("SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname='pg_read_all_data' AND m.rolname='postgres'")).rowCount === 1, 'negative changed target membership');
    await noSourceObjectsCreated();
    await target.query('REVOKE pg_read_all_data FROM postgres');
    await rejected('same-cluster', () => restore('negative-same', { targetUrl: urls[0] }), 'target-must-be-independent-pg17');
    await target.query('CREATE DATABASE fixture');
    await rejected('existing-target-database', () => restore('negative-existing-database'), 'target-existing-database-rejected');
    await target.query('DROP DATABASE fixture');
    await target.query('CREATE FUNCTION public.fixture_existing_function() RETURNS integer LANGUAGE sql AS $$SELECT 42$$');
    await rejected('existing-target-function', () => restore('negative-existing-function'), 'target-existing-business-object-rejected');
    assert((await target.query('SELECT public.fixture_existing_function() AS value')).rows[0].value === 42, 'negative changed existing target function');
    await target.query('DROP FUNCTION public.fixture_existing_function()');
    await target.query('CREATE SCHEMA fixture_existing_schema');
    await rejected('existing-empty-custom-schema', () => restore('negative-existing-schema'), 'target-existing-business-object-rejected');
    assert((await target.query("SELECT 1 FROM pg_namespace WHERE nspname='fixture_existing_schema'")).rowCount === 1, 'negative deleted existing target schema');
    await target.query('DROP SCHEMA fixture_existing_schema');
    await rejected('bad-authority', () => restore('negative-sha', { manifestSha256: '0'.repeat(64) }), 'invalid-backup-authority');
    await exec('cli-secret-output-negative', [path.resolve('scripts/protected-postgres-migration.ts'), 'restore', '--target-env', 'FIXTURE_MIGRATION_TARGET', '--backup', backupDir, '--out', path.join(root, 'cli-secret-output'), '--manifest-sha256', '0'.repeat(64)], undefined, [1], process.execPath, { FIXTURE_MIGRATION_TARGET: urls[1] });
    assertions.push('actual CLI failure stdout/stderr contain no fixture connection secret');
    await target.query('CREATE TABLE public.nonempty_fixture(id integer)');
    await rejected('nonempty-target', () => restore('negative-nonempty'), 'target-existing-business-object-rejected');
    await target.query('DROP TABLE public.nonempty_fixture');
    const tampered = path.join(root, 'tampered-backup'); await cp(backupDir, tampered, { recursive: true }); await chmod(tampered, 0o700);
    const manifestFile = path.join(tampered, 'backup.manifest.private.json');
    const altered = JSON.parse(await readFile(manifestFile, 'utf8')); altered.snapshot += '-tampered';
    await writeFile(manifestFile, JSON.stringify(altered), { mode: 0o600 });
    const alteredReceipt = JSON.parse(await readFile(path.join(tampered, 'backup.receipt.safe.json'), 'utf8')); alteredReceipt.manifestSHA256 = hash(await readFile(manifestFile));
    await writeFile(path.join(tampered, 'backup.receipt.safe.json'), JSON.stringify(alteredReceipt), { mode: 0o600 });
    await rejected('manifest-and-receipt-tamper', () => restore('negative-both', { backupDir: tampered }), 'invalid-backup-authority');
    const corrupt = path.join(root, 'corrupt-backup'); await cp(backupDir, corrupt, { recursive: true }); await chmod(corrupt, 0o700);
    await writeFile(path.join(corrupt, 'database.dump.private'), 'corrupt fixture dump', { mode: 0o600 });
    await rejected('corrupt-dump', () => restore('negative-corrupt', { backupDir: corrupt }), 'backup-bytes-changed');
    const missingTools = path.join(root, 'missing-tools');
    await rejected('missing-tools', () => migration.exportProtectedPostgres({ sourceUrl: urls[0], outDir: missingTools, binaries: { ...binaries, pgDump: path.join(root, 'absent-pg-dump') } }), 'pg-dump-failed');
    const missingReceipt = JSON.parse(await readFile(path.join(missingTools, 'pg-dump.receipt.private.json'), 'utf8'));
    assert(missingReceipt.spawnErrorCode === 'ENOENT' && missingReceipt.groupAbsent === true && missingReceipt.actualExit !== 0, 'missing tool actual spawn/absence receipt');
    for (const channel of ['stdout','stderr']) assert(hash(await readFile(path.join(missingTools,missingReceipt[`${channel}Path`]))) === missingReceipt[`${channel}SHA256`], 'missing tool actual closed rawhash');
    assertions.push('missing tool actual ENOENT/closed raw hashes/group absence independently verified');
    for (const name of ['database.dump.private','globals.sql.private','backup.manifest.private.json']) assert(((await stat(path.join(backupDir,name))).mode & 0o777) === 0o600, 'backup material permissions');
    assertions.push('private backup files mode 0600; independent manifest authority retained by caller');
    await migration.restoreProtectedPostgres({ targetUrl: urls[1], backupDir, manifestSha256, outDir: path.join(root, 'restore'), binaries });
    await verifyCommand(path.join(root, 'restore'), 'pg-restore');
    assertions.push('production PG17 restore completed');
    const restoredUrl = new URL(urls[1]); restoredUrl.pathname = '/fixture';
    const restoredClient = await client(restoredUrl.href);
    const targetAfter = await inventory(restoredClient), sourceAfter = await inventory(source);
    assert(hash(await readFile(path.resolve('scripts/lib/protected-postgres-migration.ts'))) === sourceHash, 'production source changed during fixture');
    assert(JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), 'source inventory changed');
    assert(JSON.stringify(sourceBefore) === JSON.stringify(targetAfter), 'source/target independent inventory differs');
    const privileges = (await restoredClient.query(`SELECT
      (has_table_privilege('fixture_owner','rdf_a.quads','SELECT') AND has_table_privilege('fixture_owner','rdf_a.quads','INSERT') AND has_table_privilege('fixture_owner','rdf_a.quads','UPDATE') AND has_table_privilege('fixture_owner','rdf_a.quads','DELETE')) owner_crud,
      (SELECT pg_get_userbyid(relowner)='fixture_owner' FROM pg_class WHERE oid='rdf_a.quads'::regclass) owner_identity_retained,
      has_table_privilege('fixture_owner','rdf_a.quads','MAINTAIN') owner_effective_maintain_observed,
      has_table_privilege('fixture_owner','rdf_a.quads','MAINTAIN WITH GRANT OPTION') owner_intrinsic_grant_option,
      has_table_privilege('fixture_reader','rdf_a.quads','SELECT') reader_select,
      has_table_privilege('fixture_reader','rdf_a.quads','MAINTAIN') reader_maintain,
      has_table_privilege($1,'rdf_b.rich','SELECT WITH GRANT OPTION') quoted_select_grantable,
      (has_table_privilege($1,'rdf_b.rich','INSERT WITH GRANT OPTION') AND has_table_privilege($1,'rdf_b.rich','UPDATE WITH GRANT OPTION') AND has_table_privilege($1,'rdf_b.rich','DELETE WITH GRANT OPTION') AND has_table_privilege($1,'rdf_b.rich','TRUNCATE WITH GRANT OPTION') AND has_table_privilege($1,'rdf_b.rich','REFERENCES WITH GRANT OPTION') AND has_table_privilege($1,'rdf_b.rich','TRIGGER WITH GRANT OPTION')) quoted_all_source_privileges_grantable,
      has_column_privilege($1,'rdf_a.quads','object','UPDATE WITH GRANT OPTION') quoted_column_update_grantable,
      (has_table_privilege($1,'rdf_a.quads','MAINTAIN') OR has_table_privilege($1,'rdf_b.rich','MAINTAIN')) quoted_maintain,
      has_table_privilege('fixture_writer','rdf_b.audit','SELECT') public_select,
      has_table_privilege('fixture_writer','rdf_b.audit','MAINTAIN') public_maintain,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname IN ('rdf_a','rdf_b') AND a.privilege_type='MAINTAIN') any_explicit_maintain`, ["fixture quoted'role"])).rows[0];
    assert(privileges.owner_crud && privileges.owner_identity_retained && privileges.owner_intrinsic_grant_option && privileges.reader_select && !privileges.reader_maintain && privileges.quoted_select_grantable && privileges.quoted_all_source_privileges_grantable && privileges.quoted_column_update_grantable && !privileges.quoted_maintain && privileges.public_select && !privileges.public_maintain && !privileges.any_explicit_maintain, 'restored independent privilege semantics');
    await writeFile(path.join(root, 'privilege-semantics.safe.json'), JSON.stringify(privileges, null, 2), { mode: 0o600, flag: 'wx' });
    assertions.push('owner identity/CRUD retained and effective MAINTAIN only observed; explicit ACL independently has no MAINTAIN; reader/quoted/PUBLIC no MAINTAIN; nonowner ALL and column grant options retained');
    assertions.push('source unchanged; catalog/data/roles/ACL/defaultACL/sequence/extensions/index/FTS/VEC equal');
    await writeFile(path.join(root, 'target-after.private.json'), JSON.stringify(targetAfter), { mode: 0o600 });
    report.ok = true;
  } catch (error) {
    await writeFile(path.join(root, 'failure.private.log'), String(error instanceof Error ? error.stack : error), { mode: 0o600 });
  } finally {
    const endingSourceHash = hash(await readFile(path.resolve('scripts/lib/protected-postgres-migration.ts')));
    const endingHarnessHash = hash(await readFile(fileURLToPath(import.meta.url)));
    await writeFile(path.join(root, 'source-ending-binding.safe.json'), JSON.stringify({ productionSourceSHA256: endingSourceHash, sameAsStart: endingSourceHash === sourceHash, fixtureScriptSHA256: endingHarnessHash, harnessSameAsStart: endingHarnessHash === harnessHash, status: report.ok ? 'passed' : 'failed-debug-only' }), { mode: 0o600, flag: 'wx' });
    if (endingSourceHash !== sourceHash || endingHarnessHash !== harnessHash) report.ok = false;
    if (sourceClient && beforeInventory) {
      try {
        const after = await inventory(sourceClient);
        await writeFile(path.join(root, 'source-after.private.json'), JSON.stringify(after), { mode: 0o600 });
        const unchanged = JSON.stringify(after) === JSON.stringify(beforeInventory);
        assertions.push(`independent source unchanged after success/failure: ${unchanged}`);
        if (!unchanged) report.ok = false;
      } catch { assertions.push('independent source recheck failed'); report.ok = false; }
    }
    for (const c of clients) await c.end().catch(() => undefined);
    for (const name of [names.source, names.target]) await exec('owned-container-remove', ['rm', '-f', name], undefined, [0, 1]);
    for (const volume of [names.sourceVolume, names.targetVolume]) await exec('owned-volume-remove', ['volume', 'rm', volume], undefined, [0, 1]);
    await exec('owned-network-remove', ['network', 'rm', names.network], undefined, [0, 1]);
    const containers = await exec('absence-containers', ['ps', '-aq', '--filter', `name=^${prefix}-`]);
    const volumes = await exec('absence-volumes', ['volume', 'ls', '-q', '--filter', `name=${prefix}-`]);
    const networks = await exec('absence-network', ['network', 'ls', '-q', '--filter', `name=^${names.network}$`]);
    report.cleanup = { containersAbsent: !containers.trim(), volumesAbsent: !volumes.trim(), networkAbsent: !networks.trim() };
    report.ok &&= Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(root, 'fixture.safe.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return { report, evidenceDirectory: root };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runProtectedMigrationFixture().then(({ report, evidenceDirectory }) => { process.stdout.write(`${JSON.stringify({ ok: report.ok, evidenceDirectory, scope: report.scope })}\n`); process.exitCode = report.ok ? 0 : 1; }).catch(() => { process.stderr.write('Protected fixture supervisor failed; inspect private evidence\n'); process.exitCode = 70; });
}

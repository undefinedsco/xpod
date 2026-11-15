import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { finished, pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Client } from 'pg';

export interface MigrationBinaries { pgDump?: string; pgDumpAll?: string; pgRestore?: string }
export interface ExportOptions { sourceUrl: string; outDir: string; binaries?: MigrationBinaries; commandTimeoutMs?: number; signal?: AbortSignal }
export interface RestoreOptions { targetUrl: string; backupDir: string; outDir: string; manifestSha256: string; binaries?: MigrationBinaries; commandTimeoutMs?: number; signal?: AbortSignal }
interface Identity { systemIdentifier: string; database: string; version: number; user: string }
interface CommandReceipt { command: string; args: string[]; pid?: number; actualExit: number | null; signal: string | null; spawnErrorCode?: string; stdoutSHA256: string | null; stderrSHA256: string | null; logClosureFailed?: boolean; stdoutPath: string; stderrPath: string; groupAbsent: boolean; interrupted: boolean }
interface Inventory { catalog: Record<string, unknown[]>; tables: Array<{ schema: string; name: string; rows: number; sha256: string }>; sequences: unknown[]; largeObjects: Array<{ oid: number; owner: string; acl: string | null; bytes: number; sha256: string }> }
interface BackupManifest { schemaVersion: 1; kind: 'protected-postgres-backup'; status: 'ok'; source: Identity; snapshot: string; inventory: Inventory; globals: { roles: Record<string, unknown>[]; memberships: Record<string, unknown>[]; tablespaces: Record<string, unknown>[] }; files: Record<string, string>; commands: CommandReceipt[] }

export function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
export function quoteLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
// PostgreSQL 17 initdb's pg_monitor grants, also verified on the pristine fixture.
// The grantor is the selected initdb bootstrap identity, not a fixed role name.
export function isPristinePg17Memberships(memberships: Record<string,unknown>[], bootstrapUser: string): boolean {
  const baselineRoles = ['pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables'];
  return memberships.length === baselineRoles.length && baselineRoles.every((role) =>
    memberships.filter((entry) => entry.role === role && entry.member === 'pg_monitor' &&
      entry.grantor === bootstrapUser && entry.admin_option === false &&
      entry.inherit_option === true && entry.set_option === true).length === 1);
}
async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function privateDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { mode: 0o700 });
  await chmod(resolved, 0o700);
  return resolved;
}
async function save(file: string, value: unknown): Promise<void> { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
async function connection(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: 'xpod-protected-postgres-migration' });
  await client.connect();
  await client.query("SET timezone='UTC'; SET datestyle='ISO, YMD'; SET intervalstyle='postgres'; SET extra_float_digits=3; SET bytea_output='hex'; SET search_path=pg_catalog; SET standard_conforming_strings=on");
  return client;
}
async function identity(client: Client): Promise<Identity> {
  const row = (await client.query("SELECT (pg_control_system()).system_identifier::text AS system_identifier,current_database() AS database,current_setting('server_version_num')::integer AS version,current_user AS username")).rows[0];
  if (!(await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper) throw new Error('superuser-required');
  return { systemIdentifier: row.system_identifier, database: row.database, version: row.version, user: row.username };
}
async function globals(client: Client): Promise<BackupManifest['globals']> {
  const roles = (await client.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolpassword,rolvaliduntil::text,rolbypassrls,(SELECT setconfig FROM pg_db_role_setting WHERE setrole=pg_authid.oid AND setdatabase=0) AS rolconfig,shobj_description(oid,'pg_authid') AS comment,(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',s.provider,'label',s.label) ORDER BY s.provider COLLATE \"C\"),'[]'::jsonb) FROM pg_shseclabel s WHERE s.classoid='pg_authid'::regclass AND s.objoid=pg_authid.oid) AS security_labels FROM pg_authid WHERE rolname !~ '^pg_' ORDER BY rolname COLLATE \"C\"")).rows;
  const version = Number((await client.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
  const memberships = (await client.query(`SELECT r.rolname AS role,m.rolname AS member,g.rolname AS grantor,a.admin_option,${version >= 160000 ? 'a.inherit_option' : 'm.rolinherit'} AS inherit_option,${version >= 160000 ? 'a.set_option' : 'true'} AS set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor ORDER BY r.rolname COLLATE "C",m.rolname COLLATE "C",g.rolname COLLATE "C"`)).rows;
  const tablespaces = (await client.query("SELECT spcname,pg_get_userbyid(spcowner) AS owner,spcacl::text AS acl,spcoptions,pg_tablespace_location(oid) AS location FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global') ORDER BY spcname COLLATE \"C\"")).rows;
  return { roles, memberships, tablespaces };
}
const USER_NAMESPACE = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)(_|$)'";
const FOREIGN_OBJECT_GUARDS: Record<string, string> = {
  foreignDataWrappers: 'SELECT 1 FROM pg_foreign_data_wrapper LIMIT 1',
  foreignServers: 'SELECT 1 FROM pg_foreign_server LIMIT 1',
  userMappings: 'SELECT 1 FROM pg_user_mapping LIMIT 1',
};
async function catalog(client: Client): Promise<Record<string, unknown[]>> {
  const queries: Record<string, string> = {
    namespaces: `SELECT n.nspname,pg_get_userbyid(n.nspowner) AS owner,n.nspacl::text AS acl FROM pg_namespace n WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C"`,
    relations: `SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','p','v','m','S','f') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
    relationACLGrants: `SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(a.grantor) AS grantor,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,a.grantee=0 AS public_grantee,a.privilege_type,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','p','v','m','S','f') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",pg_get_userbyid(a.grantor) COLLATE "C",a.grantee=0,(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C"`,
    columns: `SELECT n.nspname,c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,a.attacl::text AS acl,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attnum`,
    indexes: `SELECT n.nspname,t.relname AS table_name,i.relname,pg_get_indexdef(i.oid) AS definition,x.indisvalid,x.indisready FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",i.relname COLLATE "C"`,
    views: `SELECT n.nspname,c.relname,c.relkind,pg_get_viewdef(c.oid,false) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} AND c.relkind IN ('v','m') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
    extensions: 'SELECT e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner) AS owner,e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname COLLATE "C"',
    defaultACL: 'SELECT pg_get_userbyid(d.defaclrole) AS owner,coalesce(n.nspname,\'\') AS namespace,d.defaclobjtype,d.defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY pg_get_userbyid(d.defaclrole) COLLATE "C",coalesce(n.nspname,\'\') COLLATE "C",d.defaclobjtype',
    database: 'SELECT pg_get_userbyid(datdba) AS owner,datacl::text AS acl,pg_encoding_to_char(encoding) AS encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()',
    databaseSettings: "SELECT CASE WHEN s.setrole=0 THEN 'PUBLIC' ELSE pg_get_userbyid(s.setrole) END AS role,s.setconfig FROM pg_db_role_setting s WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY (CASE WHEN s.setrole=0 THEN 'PUBLIC' ELSE pg_get_userbyid(s.setrole) END) COLLATE \"C\"",
    constraints: `SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid,false) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",k.conname COLLATE "C"`,
    routines: `SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,p.prokind,CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) ELSE null END AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
    policies: `SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,ARRAY(SELECT CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END FROM unnest(p.polroles) x ORDER BY (CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END) COLLATE "C") AS roles,pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",p.polname COLLATE "C"`,
    triggers: `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,false) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} AND NOT t.tgisinternal ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",t.tgname COLLATE "C"`,
    types: `SELECT n.nspname,t.typname,t.typtype,pg_get_userbyid(t.typowner) AS owner,t.typacl::text AS acl,format_type(t.typbasetype,t.typtypmod) AS base,t.typnotnull,t.typdefault,ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS enum_labels,ARRAY(SELECT pg_get_constraintdef(k.oid,false) FROM pg_constraint k WHERE k.contypid=t.oid ORDER BY k.conname COLLATE "C") AS constraints FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C"`,
    comments: `SELECT i.type,i.schema,i.name,i.identity,d.objsubid,d.description FROM pg_description d CROSS JOIN LATERAL pg_identify_object(d.classoid,d.objoid,d.objsubid) i WHERE (i.schema IS NOT NULL AND i.schema NOT IN ('pg_catalog','information_schema') AND i.schema !~ '^pg_(toast|temp)(_|$)') OR d.classoid IN ('pg_extension'::regclass,'pg_largeobject'::regclass) ORDER BY i.type COLLATE "C",i.identity COLLATE "C",d.objsubid`,
    securityLabels: `SELECT i.type,i.schema,i.name,i.identity,s.provider,s.label FROM pg_seclabel s CROSS JOIN LATERAL pg_identify_object(s.classoid,s.objoid,s.objsubid) i WHERE (i.schema IS NOT NULL AND i.schema NOT IN ('pg_catalog','information_schema') AND i.schema !~ '^pg_(toast|temp)(_|$)') OR s.classoid IN ('pg_extension'::regclass,'pg_largeobject'::regclass) ORDER BY i.type COLLATE "C",i.identity COLLATE "C",s.provider COLLATE "C"`,
    databaseComments: "SELECT shobj_description(oid,'pg_database') AS comment,(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',s.provider,'label',s.label) ORDER BY s.provider COLLATE \"C\"),'[]'::jsonb) FROM pg_shseclabel s WHERE s.classoid='pg_database'::regclass AND s.objoid=pg_database.oid) AS security_labels FROM pg_database WHERE datname=current_database()",
  };
  const result: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(queries)) result[name] = (await client.query(sql)).rows;
  return result;
}
async function sequences(client: Client): Promise<unknown[]> {
  const rows = (await client.query(`SELECT n.nspname,c.relname,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  for (const row of rows) Object.assign(row, (await client.query(`SELECT last_value::text,is_called FROM ${quoteIdentifier(row.nspname)}.${quoteIdentifier(row.relname)}`)).rows[0]);
  return rows;
}
async function inventory(client: Client): Promise<Inventory> {
  // Foreign endpoints and mappings may exist without foreign tables. Their
  // external data and authorization are outside this logical restore contract.
  for (const sql of Object.values(FOREIGN_OBJECT_GUARDS)) {
    if ((await client.query(sql)).rowCount) throw new Error('foreign-objects-not-supported');
  }
  const result: Inventory = { catalog: await catalog(client), tables: [], sequences: await sequences(client), largeObjects: [] };
  const tables = (await client.query(`SELECT n.nspname,c.relname,c.relkind,c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','m','f') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  if (tables.some((table) => table.relkind === 'f')) throw new Error('foreign-tables-not-supported');
  for (const table of tables) {
    const hash = createHash('sha256'); let count = 0;
    if(table.relkind==='m' && !table.relispopulated) {
      result.tables.push({schema:table.nspname,name:table.relname,rows:0,sha256:hash.digest('hex')}); continue;
    }
    await client.query(`DECLARE migration_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ONLY ${quoteIdentifier(table.nspname)}.${quoteIdentifier(table.relname)} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    for (;;) {
      const batch = (await client.query('FETCH FORWARD 1000 FROM migration_rows')).rows;
      if (!batch.length) break;
      for (const row of batch) { hash.update(`${Buffer.byteLength(row.row)}:${row.row}\n`); count += 1; }
    }
    await client.query('CLOSE migration_rows');
    result.tables.push({ schema: table.nspname, name: table.relname, rows: count, sha256: hash.digest('hex') });
  }
  const objects = (await client.query('SELECT oid,pg_get_userbyid(lomowner) AS owner,lomacl::text AS acl FROM pg_largeobject_metadata ORDER BY oid')).rows;
  for (const object of objects) {
    const hash = createHash('sha256'); let bytes = 0;
    for (;;) {
      const chunk = (await client.query('SELECT lo_get($1::oid,$2::bigint,1048576) AS bytes',[object.oid,bytes])).rows[0].bytes as Buffer;
      hash.update(chunk); bytes += chunk.length; if (chunk.length < 1048576) break;
    }
    result.largeObjects.push({ oid: Number(object.oid), owner: object.owner, acl: object.acl, bytes, sha256: hash.digest('hex') });
  }
  return result;
}
async function pgEnvironment(url: string, directory: string): Promise<{ env: NodeJS.ProcessEnv; args: string[]; cleanup(): Promise<void> }> {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search) throw new Error('unsupported-postgres-connection-url');
  const host = parsed.hostname; const port = parsed.port || '5432'; const user = decodeURIComponent(parsed.username); const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!host || !user || !database) throw new Error('incomplete-postgres-connection-url');
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: host, PGPORT: port, PGUSER: user, PGDATABASE: database, PGPASSWORD: decodeURIComponent(parsed.password), PGOPTIONS: '-c timezone=UTC -c datestyle=ISO,YMD -c intervalstyle=postgres -c extra_float_digits=3 -c bytea_output=hex' };
  delete env.PGPASSFILE; delete env.PGSERVICE; delete env.PGSERVICEFILE;
  return { env, args: ['--no-password'], cleanup: async () => { delete env.PGPASSWORD; } };
}
export async function runProtectedPostgresCommand(binary: string, args: string[], env: NodeJS.ProcessEnv, directory: string, label: string, control: { commandTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandReceipt> {
  const stdoutPath = `${label}.stdout.private.log`; const stderrPath = `${label}.stderr.private.log`;
  const stdout = createWriteStream(path.join(directory,stdoutPath),{flags:'wx',mode:0o600});
  const stderr = createWriteStream(path.join(directory,stderrPath),{flags:'wx',mode:0o600});
  const child = spawn(binary,args,{env,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const groupAbsent = (): boolean => {
    if (!child.pid) return true;
    try { process.kill(-child.pid,0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code==='ESRCH'; }
  };
  let interrupted = false; let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    interrupted=true;
    if (child.pid && !groupAbsent()) {
      try { process.kill(-child.pid,'SIGTERM'); } catch { /* The exact owned group may already be absent. */ }
      if (!escalation) escalation=setTimeout(()=>{ if(child.pid && !groupAbsent()) { try {process.kill(-child.pid,'SIGKILL');} catch {} } },5_000);
    }
  };
  const timeout=setTimeout(stop,control.commandTimeoutMs ?? 6*60*60*1000);
  control.signal?.addEventListener('abort',stop,{once:true});
  if(control.signal?.aborted) stop();
  let spawnFailed=false; let spawnErrorCode: string | undefined;
  const closed = new Promise<{actualExit:number|null;signal:string|null}>((resolve)=>{
    child.on('error',(error:NodeJS.ErrnoException)=>{
      spawnFailed=true;spawnErrorCode=error.code;
      child.stdout.unpipe(stdout);child.stderr.unpipe(stderr);
      child.stdout.destroy();child.stderr.destroy();
      stdout.end();stderr.end();
      resolve({actualExit:null,signal:null});
    });
    child.on('close',(actualExit,signal)=>resolve({actualExit,signal}));
  });
  let logClosureFailed = false;
  const logs = Promise.allSettled([finished(stdout),finished(stderr)].map((promise) => promise.catch((error) => { logClosureFailed=true; stop(); throw error; })));
  let result: {actualExit:number|null;signal:string|null};
  try {
    result = await closed;
    if (!groupAbsent()) stop();
    // Keep escalation armed until every process in the exact owned group is gone.
    for(let attempt=0;attempt<110 && !groupAbsent();attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    if (!groupAbsent() && child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
    for(let attempt=0;attempt<60 && !groupAbsent();attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    await logs;
  } finally {
    clearTimeout(timeout); if(escalation) clearTimeout(escalation);
    control.signal?.removeEventListener('abort',stop);
  }
  const logHash = async (filename: string): Promise<string | null> => {
    try { const handle=await open(path.join(directory,filename),'r'); try {await handle.sync();} finally {await handle.close();} return await fileDigest(path.join(directory,filename)); }
    catch { logClosureFailed=true; return null; }
  };
  const stdoutSHA256=await logHash(stdoutPath); const stderrSHA256=await logHash(stderrPath);
  const receipt: CommandReceipt={command:binary,args,pid:child.pid,...result,...(spawnErrorCode?{spawnErrorCode}:{}),stdoutSHA256,stderrSHA256,stdoutPath,stderrPath,groupAbsent:groupAbsent(),interrupted,...(logClosureFailed?{logClosureFailed:true}:{})};
  await save(path.join(directory, `${label}.receipt.private.json`), receipt);
  if (spawnFailed || receipt.actualExit !== 0 || receipt.signal !== null || !receipt.groupAbsent || interrupted || logClosureFailed) throw new Error(`${label}-failed`);
  return receipt;
}

export async function exportProtectedPostgres(options: ExportOptions): Promise<Record<string, unknown>> {
  const directory = await privateDirectory(options.outDir);
  const client = await connection(options.sourceUrl); let pg: Awaited<ReturnType<typeof pgEnvironment>> | undefined;
  try {
    const source = await identity(client);
    if (source.version < 160000 || source.version >= 170000) throw new Error('source-must-be-pg16');
    const beforeGlobals = await globals(client); const beforeSequences = await sequences(client);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot as string;
    const snapshotInventory = await inventory(client);
    pg = await pgEnvironment(options.sourceUrl, directory);
    const commands: CommandReceipt[] = [];
    const dump = path.join(directory, 'database.dump.private'); const globalFile = path.join(directory, 'globals.sql.private');
    await writeFile(dump,'',{mode:0o600,flag:'wx'}); await writeFile(globalFile,'',{mode:0o600,flag:'wx'});
    commands.push(await runProtectedPostgresCommand(options.binaries?.pgDump ?? 'pg_dump', [...pg.args, '--format=custom', '--create', '--snapshot', snapshot, '--file', dump], pg.env, directory, 'pg-dump',options));
    await chmod(dump, 0o600);
    commands.push(await runProtectedPostgresCommand(options.binaries?.pgDumpAll ?? 'pg_dumpall', [...pg.args, '--globals-only', '--file', globalFile], pg.env, directory, 'pg-dumpall',options));
    await chmod(globalFile, 0o600);
    if (!(await stat(dump)).size || !(await stat(globalFile)).size) throw new Error('empty-backup-material');
    await client.query('COMMIT');
    const after = await identity(client);
    if (digest(after) !== digest(source) || digest(await globals(client)) !== digest(beforeGlobals) || digest(await sequences(client)) !== digest(beforeSequences)
      || digest(await catalog(client)) !== digest(snapshotInventory.catalog)) throw new Error('source-global-sequence-or-catalog-drift');
    const manifest: BackupManifest = { schemaVersion: 1, kind: 'protected-postgres-backup', status: 'ok', source, snapshot, inventory: snapshotInventory, globals: beforeGlobals,
      files: { 'database.dump.private': await fileDigest(dump), 'globals.sql.private': await fileDigest(globalFile) }, commands };
    await save(path.join(directory, 'backup.manifest.private.json'), manifest);
    const receipt = { schemaVersion: 1, status: 'ok', source, snapshot, tableCount: snapshotInventory.tables.length, inventorySHA256: digest(snapshotInventory), globalsSHA256: digest(beforeGlobals), manifestSHA256: await fileDigest(path.join(directory, 'backup.manifest.private.json')), files: manifest.files, sourceIdentityUnchanged: true, sourceCatalogGlobalsSequencesUnchanged: true };
    await save(path.join(directory, 'backup.receipt.safe.json'), receipt);
    return receipt;
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); await pg?.cleanup(); }
}

/** Structured catalog restoration preserves bootstrap conflicts without deleting dump DDL. */
export function roleStatements(role: Record<string, unknown>, create: boolean): string[] {
  const name = quoteIdentifier(String(role.rolname));
  const flags = [['rolsuper','SUPERUSER'],['rolinherit','INHERIT'],['rolcreaterole','CREATEROLE'],['rolcreatedb','CREATEDB'],['rolcanlogin','LOGIN'],['rolreplication','REPLICATION'],['rolbypassrls','BYPASSRLS']].map(([key, flag]) => role[key] ? flag : `NO${flag}`);
  const statements = [`${create ? 'CREATE' : 'ALTER'} ROLE ${name} WITH ${flags.join(' ')} CONNECTION LIMIT ${Number(role.rolconnlimit)} PASSWORD ${role.rolpassword === null ? 'NULL' : quoteLiteral(String(role.rolpassword))}${role.rolvaliduntil === null ? '' : ` VALID UNTIL ${quoteLiteral(String(role.rolvaliduntil))}`}`];
  if (!create) statements.push(`ALTER ROLE ${name} RESET ALL`);
  statements.push(`COMMENT ON ROLE ${name} IS ${role.comment === null ? 'NULL' : quoteLiteral(String(role.comment))}`);
  for(const label of (role.security_labels as Array<{provider:string;label:string}>) ?? []) statements.push(`SECURITY LABEL FOR ${quoteIdentifier(label.provider)} ON ROLE ${name} IS ${quoteLiteral(label.label)}`);
  for (const setting of (role.rolconfig as string[] | null) ?? []) {
    const index = setting.indexOf('='); if (index < 1) throw new Error('invalid-role-configuration');
    statements.push(`ALTER ROLE ${name} SET ${quoteIdentifier(setting.slice(0,index))} TO ${quoteLiteral(setting.slice(index+1))}`);
  }
  return statements;
}

export async function restoreProtectedPostgres(options: RestoreOptions): Promise<Record<string, unknown>> {
  const directory = await privateDirectory(options.outDir); const backup = path.resolve(options.backupDir);
  const manifestFile = path.join(backup, 'backup.manifest.private.json');
  const manifestBytes=await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as BackupManifest;
  const authority = JSON.parse(await readFile(path.join(backup, 'backup.receipt.safe.json'), 'utf8')) as { manifestSHA256: string };
  if (!/^[a-f0-9]{64}$/.test(options.manifestSha256) || manifest.schemaVersion !== 1 || manifest.kind !== 'protected-postgres-backup' || manifest.status !== 'ok' || createHash('sha256').update(manifestBytes).digest('hex') !== options.manifestSha256 || authority.manifestSHA256 !== options.manifestSha256) throw new Error('invalid-backup-authority');
  const sourceGrants=manifest.inventory.catalog.relationACLGrants as Array<Record<string,unknown>>;
  if (!Array.isArray(sourceGrants)) throw new Error('backup-relation-acl-authority-missing');
  // Copy into a fresh private input boundary, hashing those actual bytes before target writes.
  for (const name of ['database.dump.private','globals.sql.private']) {
    const destination=path.join(directory,name);
    await pipeline(createReadStream(path.join(backup,name)),createWriteStream(destination,{flags:'wx',mode:0o600}));
    const handle=await open(destination,'r'); try {await handle.sync();} finally {await handle.close();}
    if (await fileDigest(destination) !== manifest.files[name]) throw new Error('backup-bytes-changed');
  }
  const client = await connection(options.targetUrl); let restored: Client | undefined; let pg: Awaited<ReturnType<typeof pgEnvironment>> | undefined;
  try {
    const target = await identity(client);
    if (target.version < 170000 || target.version >= 180000 || target.systemIdentifier === manifest.source.systemIdentifier) throw new Error('target-must-be-independent-pg17');
    if (manifest.globals.tablespaces.length) throw new Error('restore-custom-tablespaces-requires-safe-mapping');
    const databases = (await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate')).rows.map((row) => row.datname);
    if (databases.some((name) => name !== 'postgres') || databases.includes(manifest.source.database)) throw new Error('target-existing-database-rejected');
    if(target.database!=='postgres') throw new Error('target-bootstrap-database-required');
    const targetGlobals = await globals(client);
    const guardQueries: Record<string,string> = {
      ...FOREIGN_OBJECT_GUARDS,
      customNamespaces: `SELECT 1 FROM pg_namespace n WHERE ${USER_NAMESPACE} AND n.nspname <> 'public' LIMIT 1`,
      routines: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${USER_NAMESPACE} LIMIT 1`,
      types: `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${USER_NAMESPACE} LIMIT 1`,
      extensions: "SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql' LIMIT 1",
      defaultACL: 'SELECT 1 FROM pg_default_acl LIMIT 1',
      databaseSettings: 'SELECT 1 FROM pg_db_role_setting LIMIT 1',
      largeObjects: 'SELECT 1 FROM pg_largeobject_metadata LIMIT 1',
      databaseACL: "SELECT 1 FROM pg_database WHERE datname=current_database() AND (datacl IS NOT NULL OR datdba<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) LIMIT 1",
      publicNamespaceACL: "SELECT 1 FROM pg_namespace WHERE nspname='public' AND (pg_get_userbyid(nspowner)<>'pg_database_owner' OR nspacl::text IS DISTINCT FROM '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}') LIMIT 1",
      relations: `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${USER_NAMESPACE} LIMIT 1`,
    };
    const rejected: Record<string,boolean> = { customTablespaces: targetGlobals.tablespaces.length > 0, memberships: !isPristinePg17Memberships(targetGlobals.memberships,target.user) };
    for(const [name,sql] of Object.entries(guardQueries)) rejected[name]=Boolean((await client.query(sql)).rowCount);
    await save(path.join(directory,'target.preflight.private.json'),{schemaVersion:1,target,databases,rejected,catalog:await catalog(client),globals:targetGlobals});
    if(rejected.customTablespaces) throw new Error('target-existing-tablespace-rejected');
    if(rejected.memberships) throw new Error('target-existing-membership-rejected');
    if(Object.entries(rejected).some(([name,value])=>name!=='relations' && value)) throw new Error('target-existing-business-object-rejected');
    if(rejected.relations) throw new Error('target-not-empty');
    if (targetGlobals.roles.some((role) => role.rolname !== target.user)) throw new Error('target-existing-role-rejected');
    const bootstrapSource = manifest.globals.roles.find((role) => role.rolname === target.user);
    if (bootstrapSource && (!bootstrapSource.rolsuper || (bootstrapSource.rolvaliduntil === null && targetGlobals.roles[0].rolvaliduntil !== null))) throw new Error('unsupported-bootstrap-role-restoration');
    for (const role of manifest.globals.roles) if (role.rolname !== target.user) for (const sql of roleStatements(role,true)) await client.query(sql);
    for (const membership of manifest.globals.memberships) {
      await client.query(`SET SESSION AUTHORIZATION ${quoteIdentifier(String(membership.grantor))}`);
      try { await client.query(`GRANT ${quoteIdentifier(String(membership.role))} TO ${quoteIdentifier(String(membership.member))} WITH ADMIN ${membership.admin_option ? 'TRUE' : 'FALSE'}, INHERIT ${membership.inherit_option ? 'TRUE' : 'FALSE'}, SET ${membership.set_option ? 'TRUE' : 'FALSE'}`); }
      finally { await client.query('RESET SESSION AUTHORIZATION'); }
    }
    pg = await pgEnvironment(options.targetUrl, directory);
    const command = await runProtectedPostgresCommand(options.binaries?.pgRestore ?? 'pg_restore', [...pg.args, '--dbname', 'postgres', '--create', '--exit-on-error', path.join(directory,'database.dump.private')], pg.env, directory, 'pg-restore',options);
    if (await fileDigest(path.join(directory,'database.dump.private')) !== manifest.files['database.dump.private']) throw new Error('restore-input-bytes-changed');
    const restoredUrl = new URL(options.targetUrl); restoredUrl.pathname = `/${encodeURIComponent(manifest.source.database)}`;
    restored = await connection(restoredUrl.href);
    // PG17 ALL table grants include MAINTAIN, which did not exist on the PG16
    // source. Restore explicit source authorization instead of hiding that drift.
    const explicitTables=(manifest.inventory.catalog.relations as Array<Record<string,unknown>>).filter((relation)=>relation.acl!==null && relation.relkind!=='S');
    for (const relation of explicitTables) {
      const maintained=(await restored.query("SELECT pg_get_userbyid(a.grantor) AS grantor,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,a.grantee=0 AS public_grantee FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname=$1 AND c.relname=$2 AND a.privilege_type='MAINTAIN'",[relation.nspname,relation.relname])).rows;
      for (const grant of maintained) {
        if (sourceGrants.some((source)=>source.nspname===relation.nspname && source.relname===relation.relname && source.grantor===grant.grantor && source.grantee===grant.grantee && source.public_grantee===grant.public_grantee && source.privilege_type==='MAINTAIN')) continue;
        // An earlier CASCADE may already have removed a dependent MAINTAIN grant.
        const remaining=await restored.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname=$1 AND c.relname=$2 AND a.privilege_type='MAINTAIN' AND pg_get_userbyid(a.grantor)=$3 AND (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)=$4 AND (a.grantee=0)=$5",[relation.nspname,relation.relname,grant.grantor,grant.grantee,grant.public_grantee]);
        if (!remaining.rowCount) continue;
        await restored.query(`SET SESSION AUTHORIZATION ${quoteIdentifier(grant.grantor)}`);
        try {
          await restored.query(`REVOKE MAINTAIN ON TABLE ${quoteIdentifier(String(relation.nspname))}.${quoteIdentifier(String(relation.relname))} FROM ${grant.public_grantee ? 'PUBLIC' : quoteIdentifier(grant.grantee)} CASCADE`);
        } finally { await restored.query('RESET SESSION AUTHORIZATION'); }
      }
    }
    await restored.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await inventory(restored); await restored.query('COMMIT');
    const expectedSHA256=digest(manifest.inventory); const actualSHA256=digest(actual);
    await save(path.join(directory,'restore.inventory.private.json'),{schemaVersion:1,expectedSHA256,actualSHA256,expected:manifest.inventory,actual});
    const differenceCategories = [
      ...Object.keys(manifest.inventory.catalog).filter((name)=>digest(manifest.inventory.catalog[name])!==digest(actual.catalog[name])).map((name)=>`catalog.${name}`),
      ...(['tables','sequences','largeObjects'] as const).filter((name)=>digest(manifest.inventory[name])!==digest(actual[name])),
    ];
    await save(path.join(directory,'restore.inventory.safe.json'),{schemaVersion:1,expectedSHA256,actualSHA256,differenceCategories});
    if (actualSHA256 !== expectedSHA256) throw new Error('restored-inventory-mismatch');
    const bootstrap = manifest.globals.roles.find((role) => role.rolname === target.user);
    if (bootstrap) for (const sql of roleStatements(bootstrap,false)) await client.query(sql);
    const actualGlobals = await globals(client);
    actualGlobals.roles = actualGlobals.roles.filter((role) => manifest.globals.roles.some((sourceRole) => sourceRole.rolname === role.rolname));
    if (digest(actualGlobals) !== digest(manifest.globals)) throw new Error('restored-global-state-mismatch');
    const result = { schemaVersion: 1, status: 'ok', source: manifest.source, target: await identity(restored), backupManifestSHA256: authority.manifestSHA256, inventorySHA256: digest(actual), globalsSHA256: digest(actualGlobals), independentTarget: true, command };
    await save(path.join(directory,'restore.receipt.safe.json'),result); return result;
  } finally { await restored?.query('ROLLBACK').catch(() => undefined); await restored?.end(); await client.end(); await pg?.cleanup(); }
}

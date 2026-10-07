#!/usr/bin/env bun
// Direct RC deployment admission. No database initialization or shared-resource writes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const GZ_SERVER = 'https://gzg.sealos.run:6443';
const GZ_NAMESPACE = 'ns-iknkxtc8';
const GZ_HOSTS = ['id', 'pods', 'api'].map(role => `undefineds-gz-rc-${role}.sealosgzg.site`);
const PG_IMAGE = 'ghcr.io/undefinedsco/xpod-rdf-postgres@sha256:156b6ef3a27d5ee43b8aa54c16583b288cfb33e47e532aaa1f377515f187fed5';
const SOURCE_DATABASE = 'undefineds-gz-postgresql-postgresql.ns-iknkxtc8.svc:5432/xpod_rc';
const OWNER = 'xpod.undefineds.co/rc-run-owner';
const OWNERSHIP = 'xpod.undefineds.co/rc-run-ownership';
const insist = (ok, message) => { if (!ok) throw new Error(message); };

function validateBoundary(server, namespace) {
  insist(server === GZ_SERVER && namespace === GZ_NAMESPACE, 'unexpected GZ cluster or namespace');
}
function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    insist(match && !Object.hasOwn(env, match[1]), 'invalid or duplicate RC environment key');
    env[match[1]] = match[2];
  }
  return env;
}
function preparedDatabase(env) {
  const parse = value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('prepared PostgreSQL URLs are required'); }
    insist(['postgres:', 'postgresql:'].includes(url.protocol) && !url.search && !url.hash,
      'PostgreSQL query or fragment overrides are not admitted');
    return url;
  };
  const identity = parse(env.CSS_IDENTITY_DB_URL), rdf = parse(env.CSS_SPARQL_ENDPOINT);
  const authority = url => JSON.stringify([url.hostname, url.port || '5432', url.pathname,
    decodeURIComponent(url.username), decodeURIComponent(url.password)]);
  insist(authority(identity) === authority(rdf), 'identity and RDF must use the same prepared PostgreSQL database');
  const match = /^([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.ns-iknkxtc8\.svc(?:\.cluster\.local)?$/.exec(identity.hostname);
  insist(match && identity.pathname === '/xpod_rc' && (!identity.port || identity.port === '5432')
    && identity.username && identity.password, 'prepared database must be isolated xpod_rc in GZ');
  insist(!['undefineds-gz-postgresql-postgresql', 'xpod-rdf-postgres-rc', 'xpod-rc-postgres'].includes(match[1]),
    'old shared or ephemeral PostgreSQL is not the prepared clone');
  for (const key of ['DATABASE_URL', 'CSS_TASK_DB_URL']) {
    insist(!env[key] || authority(parse(env[key])) === authority(identity), 'conflicting database write authority');
  }
  return { service: match[1], database: 'xpod_rc', url: identity };
}
function preparedPgClientOptions(database, port) {
  insist(/^\d+$/.test(String(port)) && Number(port) > 0 && Number(port) <= 65535, 'invalid forwarding port');
  // Never let connection-string query parameters override the owned forwarding authority.
  // pg retains its normal TLS policy (including PGSSLMODE); no SSL downgrade is imposed here.
  return { host: '127.0.0.1', port: Number(port), user: decodeURIComponent(database.url.username),
    password: decodeURIComponent(database.url.password), database: database.database,
    connectionTimeoutMillis: 10000, statement_timeout: 15000, query_timeout: 20000 };
}
function objectIdentity(object, kind, name) {
  insist(object?.kind === kind && object.metadata?.name === name
    && object.metadata.namespace === GZ_NAMESPACE && object.metadata.uid && object.metadata.resourceVersion
    && !object.metadata.deletionTimestamp, 'GZ resource identity is missing or changed');
  return { kind, name, uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion };
}
function serverBlocks(text) {
  const blocks = [];
  text = text.replace(/#.*$/gm, '');
  const pattern = /\bserver\s*\{/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 1, index = pattern.lastIndex;
    for (; index < text.length && depth; index++) {
      if (text[index] === '{') depth++;
      if (text[index] === '}') depth--;
    }
    insist(depth === 0, 'incomplete shared Gateway configuration');
    blocks.push(text.slice(pattern.lastIndex, index - 1));
    pattern.lastIndex = index;
  }
  return blocks;
}
function verifySharedRoutes(gateway, ingresses) {
  const identities = [objectIdentity(gateway, 'ConfigMap', 'gateway')];
  const configs = Object.values(gateway.data ?? {}).filter(value => typeof value === 'string' && /\bserver\s*\{/.test(value));
  insist(configs.length === 1, 'shared Gateway configuration is ambiguous');
  const blocks = serverBlocks(configs[0]);
  for (const [index, host] of GZ_HOSTS.entries()) {
    const candidates = blocks.filter(block => new RegExp(`\\bserver_name\\s+${host.replaceAll('.', '\\.')}\\s*;`).test(block));
    const block = candidates[0];
    const port = [8082, 8083, 8081][index];
    insist(candidates.length === 1 && new RegExp(`\\blisten\\s+${port}\\s*;`).test(block), 'canonical GZ Gateway route is missing');
    const upstreams = [...block.matchAll(/\bproxy_pass\s+(\S+)\s*;/g)].map(match => match[1]);
    insist(upstreams.length === 1 && ['http://xpod-rc:80', 'http://xpod-rc', `http://xpod-rc.${GZ_NAMESPACE}.svc.cluster.local:80`].includes(upstreams[0]),
      'canonical GZ Gateway upstream differs');
    const matches = ingresses.items.filter(entry => entry.spec?.rules?.some(rule => rule.host === host));
    insist(matches.length === 1, 'canonical GZ Ingress is ambiguous');
    const ingress = matches[0];
    identities.push(objectIdentity(ingress, 'Ingress', ingress.metadata.name));
    const rule = ingress.spec.rules.find(entry => entry.host === host);
    insist(rule.http.paths.length === 1 && rule.http.paths[0].path === '/' && rule.http.paths[0].pathType === 'Prefix'
      && rule.http.paths[0].backend.service.name === 'gateway' && rule.http.paths[0].backend.service.port.number === port
      && ingress.spec.tls?.some(tls => tls.hosts?.includes(host) && tls.secretName), 'canonical GZ Ingress/TLS route differs');
  }
  return identities;
}
function verifyPreparedPod(service, pods, workload) {
  objectIdentity(service, 'Service', service.metadata.name);
  const candidates = pods.items.filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running'
    && pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
  insist(candidates.length === 1, 'prepared PostgreSQL must have one ready primary Pod');
  const pod = candidates[0];
  objectIdentity(pod, 'Pod', pod.metadata.name);
  const postgres = pod.spec.containers.find(entry => entry.image?.endsWith('@' + PG_IMAGE.split('@')[1]));
  const state = pod.status.containerStatuses?.find(entry => entry.name === postgres?.name);
  insist(postgres && state?.ready && state.imageID?.endsWith(PG_IMAGE.split('@')[1]), 'prepared PostgreSQL imageID differs from canonical PG156');
  const owner = pod.metadata.ownerReferences?.find(entry => entry.controller === true);
  objectIdentity(workload, 'StatefulSet', owner?.name);
  insist(owner?.uid === workload.metadata.uid && workload.metadata.labels?.['xpod.undefineds.co/rc-database'] === 'prepared-pg17'
    && workload.metadata.annotations?.['xpod.undefineds.co/rc-clone-source'] === SOURCE_DATABASE
    && /^[a-f0-9]{64}$/.test(workload.metadata.annotations?.['xpod.undefineds.co/rc-clone-archive-sha256'] ?? ''), 'prepared clone provenance is missing');
  return pod;
}
function verifyPreparedStorage(pod, claims, volumes, forbiddenPVCUIDs, forbiddenPVUIDs = []) {
  const postgres = pod.spec.containers.find(entry => entry.image?.endsWith('@' + PG_IMAGE.split('@')[1]));
  const entries = postgres?.env?.filter(entry => entry.name === 'PGDATA');
  const pgdata = entries?.[0]?.value;
  insist(entries?.length === 1 && typeof pgdata === 'string' && pgdata.startsWith('/')
    && path.posix.normalize(pgdata) === pgdata && !pgdata.includes('$'), 'literal canonical PGDATA is required');
  const mounts = postgres.volumeMounts?.filter(mount => pgdata === mount.mountPath || pgdata.startsWith(mount.mountPath + '/')) ?? [];
  insist(mounts.length === 1 && !mounts[0].subPath && !mounts[0].subPathExpr && !mounts[0].readOnly,
    'PGDATA must be backed by one independent persistent volume');
  const volume = pod.spec.volumes?.find(entry => entry.name === mounts[0].name);
  insist(volume?.persistentVolumeClaim?.claimName && Object.keys(volume).every(key => ['name','persistentVolumeClaim'].includes(key)),
    'container-layer, emptyDir and hostPath databases are not prepared clones');
  const pvc = claims.find(entry => entry.metadata.name === volume.persistentVolumeClaim.claimName);
  objectIdentity(pvc, 'PersistentVolumeClaim', volume.persistentVolumeClaim.claimName);
  insist(pvc.status?.phase === 'Bound' && pvc.spec?.volumeName && !forbiddenPVCUIDs.includes(pvc.metadata.uid),
    'prepared database PVC must be independently Bound');
  const pv = volumes.find(entry => entry.metadata.name === pvc.spec.volumeName);
  insist(pv?.kind === 'PersistentVolume' && pv.metadata.uid && pv.metadata.resourceVersion && !forbiddenPVUIDs.includes(pv.metadata.uid) && !pv.metadata.deletionTimestamp && pv.status?.phase === 'Bound'
    && pv.spec?.claimRef?.uid === pvc.metadata.uid && pv.spec.claimRef.name === pvc.metadata.name
    && pv.spec.claimRef.namespace === GZ_NAMESPACE && !pv.spec.hostPath,
    'prepared PVC/PV binding differs');
  return {pgdata,pvcName:pvc.metadata.name,pvcUID:pvc.metadata.uid,pvName:pv.metadata.name,pvUID:pv.metadata.uid};
}
function verifyPreparedEndpoints(service, pod, endpoints) {
  objectIdentity(endpoints, 'Endpoints', service.metadata.name);
  const ports = service.spec?.ports?.filter(entry => entry.port === 5432 && (!entry.protocol || entry.protocol === 'TCP')) ?? [];
  insist(ports.length === 1, 'prepared Service PostgreSQL port differs');
  const target = ports[0].targetPort ?? ports[0].port;
  const resolved = typeof target === 'number' ? target : pod.spec.containers.flatMap(container => container.ports ?? [])
    .filter(port => port.name === target && (!port.protocol || port.protocol === 'TCP'));
  insist(resolved === 5432 || (Array.isArray(resolved) && resolved.length === 1 && resolved[0].containerPort === 5432),
    'prepared Service target port differs');
  const subsets = endpoints.subsets ?? [];
  insist(subsets.length === 1 && subsets[0].ports?.length === 1 && subsets[0].ports[0].port === 5432
    && (!subsets[0].ports[0].protocol || subsets[0].ports[0].protocol === 'TCP')
    && !subsets[0].notReadyAddresses?.length && subsets[0].addresses?.length === 1
    && subsets[0].addresses[0].targetRef?.kind === 'Pod' && subsets[0].addresses[0].targetRef.uid === pod.metadata.uid,
    'prepared runtime Service must resolve only to the admitted ready Pod');
}
function verifyRestoreAdmission(config, workload, pod, storage, source) {
  objectIdentity(config, 'ConfigMap', workload.metadata.annotations?.['xpod.undefineds.co/rc-clone-restore-admission']);
  insist(config.immutable === true, 'restore admission must be immutable');
  const record = JSON.parse(config.data?.['admission.json'] ?? 'null');
  insist(record?.server === GZ_SERVER && record.namespace === GZ_NAMESPACE && record.source?.service === SOURCE_DATABASE
    && record.source.podUID === source.podUID && JSON.stringify([...(record.source.pvcUIDs ?? [])].sort()) === JSON.stringify([...source.pvcUIDs].sort())
    && Number.isSafeInteger(record.archive?.bytes) && record.archive.bytes > 0
    && /^[a-f0-9]{64}$/.test(record.archive.sha256) && record.archive.sha256 === workload.metadata.annotations?.['xpod.undefineds.co/rc-clone-archive-sha256'],
    'source archive or current source volume identity differs from full restore admission');
  for (const stage of [record.dump, record.restore]) insist(stage?.exit === 0 && stage.actualWait === true
    && stage.rawClosedBeforeHash === true && stage.ownedGroupAbsentAfterWait === true && /^[a-f0-9]{64}$/.test(stage.rawSHA256 ?? ''),
    'dump or restore producer is not successfully closed');
  const postgres = pod.spec.containers.find(entry => entry.image?.endsWith('@' + PG_IMAGE.split('@')[1]));
  const actual = pod.status.containerStatuses.find(entry => entry.name === postgres?.name)?.imageID;
  insist(record.target?.workloadUID === workload.metadata.uid && record.target.podUID === pod.metadata.uid
    && record.target.pvcUID === storage.pvcUID && record.target.pvUID === storage.pvUID && record.target.dataDirectory === storage.pgdata
    && record.target.canonicalSourceImage === PG_IMAGE && record.target.specImage === postgres?.image && record.target.actualImageID === actual
    && record.validation?.ownersAndACL === true && record.validation.allUserObjectsAndData === true && record.validation.extensionCompatibility === true,
    'full restore target or ownership, data and extension validation differs');
  return record;
}
function sourceVolumeAuthority() {
  const name = SOURCE_DATABASE.split('.')[0], service = get('service',name);
  objectIdentity(service,'Service',name);
  const selector = Object.entries(service.spec?.selector ?? {}).map(([key,value]) => `${key}=${value}`).join(',');
  insist(selector, 'source database Pod authority is missing');
  const pods = JSON.parse(kube(['-n',GZ_NAMESPACE,'get','pods','-l',selector,'-o','json'])).items;
  const ready = pods.filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running'
    && pod.status.conditions?.some(entry => entry.type === 'Ready' && entry.status === 'True'));
  insist(ready.length === 1, 'source database ready Pod authority is ambiguous');
  const pod = ready[0]; objectIdentity(pod,'Pod',pod.metadata.name);
  const names = pod.spec.volumes?.filter(volume => volume.persistentVolumeClaim).map(volume => volume.persistentVolumeClaim.claimName) ?? [];
  insist(names.length > 0, 'source database PVC authority is missing');
  const claims = get('persistentvolumeclaims').items;
  const sourceClaims = names.map(name => { const claim = claims.find(entry => entry.metadata.name === name); objectIdentity(claim,'PersistentVolumeClaim',name); return claim; });
  const legacy = JSON.parse(kube(['-n',GZ_NAMESPACE,'get','statefulset','xpod-rdf-postgres-rc','--ignore-not-found','-o','json']) || 'null');
  const oldNames = new Set();
  // Resolve known retained legacy claims to their real UIDs even when its scaled-down controller is gone.
  for (const claim of claims) if (claim.metadata.labels?.app === 'xpod-rdf-postgres-rc'
    || /^.+-xpod-rdf-postgres-rc-\d+$/.test(claim.metadata.name)) oldNames.add(claim.metadata.uid);
  if (legacy) {
    objectIdentity(legacy,'StatefulSet','xpod-rdf-postgres-rc');
    for (const claim of claims) {
      const template = legacy.spec?.volumeClaimTemplates?.some(entry => claim.metadata.name.startsWith(`${entry.metadata.name}-${legacy.metadata.name}-`));
      if (template || claim.metadata.ownerReferences?.some(entry => entry.uid === legacy.metadata.uid)) oldNames.add(claim.metadata.uid);
    }
  }
  const source = {service:SOURCE_DATABASE,podUID:pod.metadata.uid,pvcUIDs:sourceClaims.map(claim => claim.metadata.uid)};
  const forbiddenClaims = claims.filter(claim => [...source.pvcUIDs,...oldNames].includes(claim.metadata.uid));
  const forbiddenPVs = forbiddenClaims.map(claim => {
    insist(claim.spec?.volumeName, 'source or legacy database volume binding is missing');
    const pv = get('persistentvolume',claim.spec.volumeName);
    insist(pv?.metadata?.uid, 'source or legacy PV identity is missing');
    return pv.metadata.uid;
  });
  return {source,claims,forbidden:[...source.pvcUIDs,...oldNames],forbiddenPVs};
}
function verifyDatabaseFacts(facts) {
  insist(Number(facts.version) >= 170000 && Number(facts.version) < 180000
    && ['vector', 'xpod_rdf', 'xpod_qlever'].every(name => facts.extensions?.includes(name))
    && facts.native?.abiVersion === 1 && facts.native.ready === true, 'prepared PG17 native ABI or required extensions are missing');
}
function kube(args, input, timeout = 120000) {
  return execFileSync('kubectl', args, { input, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}
function get(kind, name) { return JSON.parse(kube(['-n', GZ_NAMESPACE, 'get', kind, ...(name ? [name] : []), '-o', 'json'])); }
function boundary() {
  const current = JSON.parse(kube(['config', 'view', '--minify', '-o', 'json']));
  validateBoundary(current.clusters?.[0]?.cluster?.server, process.env.SEALOS_NAMESPACE);
  insist(current.contexts?.[0]?.context?.namespace === GZ_NAMESPACE, 'kubeconfig namespace differs from GZ');
}
function writePrivate(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); }
function preparedWorkloadProjection(workload) {
  const { name, namespace, uid, resourceVersion } = workload.metadata;
  return { kind: workload.kind, metadata: { name, namespace, uid, resourceVersion }, spec: { template: { spec: {
    containers: workload.spec.template.spec.containers.map(({ name, image }) => ({ name, image })),
    imagePullSecrets: (workload.spec.template.spec.imagePullSecrets ?? []).map(({ name }) => ({ name })),
  } } } };
}
async function withPortForward(pod, remotePort, check, deadlines = {}) {
  const readyMs = deadlines.readyMs ?? 30000, checkMs = deadlines.checkMs ?? 90000, stopMs = deadlines.stopMs ?? 5000;
  insist([readyMs, checkMs, stopMs].every(value => Number.isInteger(value) && value > 0), 'invalid forwarding deadline');
  insist(process.env.RUNNER_TEMP, 'runner private directory is required');
  const prefix = path.join(process.env.RUNNER_TEMP, `forward-${randomUUID()}`);
  const raw = `${prefix}.raw.log`, rawFD = fs.openSync(raw, 'wx', 0o600);
  const receipt = { sourceSha: process.env.GITHUB_SHA ?? null, server: GZ_SERVER, namespace: GZ_NAMESPACE,
    podUID: pod.metadata.uid ?? null, remotePort, startedUTC: new Date().toISOString(), pid: null, pgid: null, actualWait: false,
    exit: null, signal: null, spawnError: null, readyTimeout: false, checkTimeout: false,
    rawLimit: false, prematureExit: false, cleanupRequested: false, forcedStop: false, checkPassed: false };
  let forward, closed = false, rawBytes = 0, readiness = '', rejectReady, resolveReady, portReady = false;
  let closeResolve;
  const closePromise = new Promise(resolve => { closeResolve = resolve; });
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const absent = () => {
    if (!receipt.pgid) return true;
    try { process.kill(-receipt.pgid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  const stop = signal => {
    if (!receipt.pgid) return;
    try { process.kill(-receipt.pgid, signal); } catch (error) { if (error.code !== 'ESRCH') receipt.cleanupError = error.code; }
  };
  const boundedClose = async milliseconds => {
    let timer;
    try { return await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const writeRaw = chunk => {
    rawBytes += chunk.length;
    if (rawBytes <= 1024 * 1024) fs.writeSync(rawFD, chunk);
    else { receipt.rawLimit = true; rejectReady(new Error('owned forwarding raw limit')); stop('SIGTERM'); }
  };
  let readyTimer, checkTimer, result, failure;
  try {
    // Each producer owns an independent process group, including inherited pipe writers.
    forward = spawn('kubectl', ['-n', GZ_NAMESPACE, 'port-forward', `pod/${pod.metadata.name}`, `:${remotePort}`, '--address', '127.0.0.1'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    receipt.pid = receipt.pgid = forward.pid ?? null;
    forward.on('error', error => { receipt.spawnError = error.code ?? 'spawn-error'; rejectReady(new Error('owned forwarding spawn failed')); });
    forward.on('exit', (code, signal) => {
      receipt.exit = code; receipt.signal = signal;
      if (!receipt.cleanupRequested) receipt.prematureExit = true;
      rejectReady(new Error('owned forwarding exited'));
    });
    forward.on('close', (code, signal) => {
      receipt.exit = code; receipt.signal = signal; receipt.actualWait = true; closed = true; closeResolve();
    });
    forward.stderr.on('data', writeRaw);
    forward.stdout.on('data', chunk => {
      writeRaw(chunk);
      if (portReady || receipt.rawLimit) return;
      readiness += chunk.toString();
      const match = /Forwarding from 127\.0\.0\.1:(\d+) ->/.exec(readiness);
      if (match) { portReady = true; resolveReady(match[1]); }
    });
    readyTimer = setTimeout(() => { receipt.readyTimeout = true; rejectReady(new Error('owned forwarding deadline')); }, readyMs);
    const port = await readyPromise; clearTimeout(readyTimer);
    result = await Promise.race([Promise.resolve().then(() => check(port)), new Promise((resolve, reject) => {
      checkTimer = setTimeout(() => { receipt.checkTimeout = true; reject(new Error('owned forwarding consumer deadline')); }, checkMs);
    })]);
    receipt.checkPassed = true;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(readyTimer); clearTimeout(checkTimer);
    receipt.cleanupRequested = true; stop('SIGTERM');
    await boundedClose(stopMs);
    if (!closed || !absent()) { receipt.forcedStop = true; stop('SIGKILL'); await boundedClose(stopMs); }
    const absenceDeadline = Date.now() + stopMs;
    while (!absent() && Date.now() < absenceDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    receipt.ownedGroupAbsentAfterWait = absent();
    // Close our raw sink even on failed child closure; failed receipts cannot admit facts.
    forward?.stdout.removeAllListeners('data'); forward?.stderr.removeAllListeners('data');
    if (!closed) { forward?.stdout.destroy(); forward?.stderr.destroy(); }
    fs.closeSync(rawFD); receipt.rawClosedBeforeHash = true;
    receipt.rawSHA256 = createHash('sha256').update(fs.readFileSync(raw)).digest('hex');
    receipt.closedUTC = new Date().toISOString();
    receipt.elapsedMilliseconds = Date.parse(receipt.closedUTC) - Date.parse(receipt.startedUTC);
    writePrivate(`${prefix}.receipt.json`, receipt);
  }
  const expectedStop = (receipt.exit === 0 && receipt.signal === null) || receipt.signal === 'SIGTERM'
    || (receipt.forcedStop && receipt.signal === 'SIGKILL');
  insist(expectedStop && !failure && receipt.checkPassed && receipt.actualWait && receipt.ownedGroupAbsentAfterWait
    && !receipt.spawnError && !receipt.prematureExit && !receipt.readyTimeout && !receipt.checkTimeout
    && !receipt.rawLimit && !receipt.cleanupError, 'owned forwarding or consumer closure failed');
  return result;
}
async function inspectDatabase(database, pod) {
  const { Client } = require('pg');
  return withPortForward(pod, 5432, async port => {
    const client = new Client(preparedPgClientOptions(database, port));
    try {
      await client.connect(); await client.query('BEGIN READ ONLY');
      const result = await client.query("SELECT json_build_object('version', current_setting('server_version_num')::int, 'dataDirectory', current_setting('data_directory'), 'extensions', (SELECT array_agg(extname ORDER BY extname) FROM pg_extension), 'native', xpod_rdf.native_sparql_capabilities()) AS facts");
      verifyDatabaseFacts(result.rows[0].facts); await client.query('ROLLBACK');
      return result.rows[0].facts;
    } finally { await client.end(); }
  });
}
async function preflight(temp) {
  boundary();
  insist(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ''), 'exact RC source SHA is required');
  const env = parseEnv(fs.readFileSync(path.join(temp, 'xpod-rc.env'), 'utf8'));
  const database = preparedDatabase(env);
  const service = get('service', database.service);
  const selector = Object.entries(service.spec?.selector ?? {}).map(([key, value]) => `${key}=${value}`).join(',');
  insist(selector, 'prepared PostgreSQL Service must select owned Pods');
  const pods = JSON.parse(kube(['-n', GZ_NAMESPACE, 'get', 'pods', '-l', selector, '-o', 'json']));
  const ready = pods.items.filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running');
  insist(ready.length === 1, 'prepared PostgreSQL primary is ambiguous');
  const owner = ready[0].metadata.ownerReferences?.find(entry => entry.controller === true);
  insist(owner?.kind === 'StatefulSet', 'prepared PostgreSQL must be an independent StatefulSet');
  const workload = get('statefulset', owner.name);
  const pod = verifyPreparedPod(service, pods, workload);
  verifyPreparedEndpoints(service,pod,get('endpoints',database.service));
  const authority = sourceVolumeAuthority();
  const targetClaimNames = pod.spec.volumes?.filter(entry => entry.persistentVolumeClaim).map(entry => entry.persistentVolumeClaim.claimName) ?? [];
  const claims = targetClaimNames.map(name => get('persistentvolumeclaim',name));
  const volumes = claims.map(claim => get('persistentvolume',claim.spec.volumeName));
  const storage = verifyPreparedStorage(pod,claims,volumes,authority.forbidden,authority.forbiddenPVs);
  const admissionName = workload.metadata.annotations?.['xpod.undefineds.co/rc-clone-restore-admission'];
  insist(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(admissionName ?? ''), 'actual full restore admission record is required');
  const restoreConfig = get('configmap',admissionName);
  const restored = verifyRestoreAdmission(restoreConfig,workload,pod,storage,authority.source);
  const ingresses = get('ingress');
  const identities = verifySharedRoutes(get('configmap', 'gateway'), ingresses);
  const gatewayService = get('service', 'gateway');
  identities.push(objectIdentity(gatewayService, 'Service', 'gateway'));
  insist(gatewayService.spec.selector?.app === 'gateway' && [8081,8082,8083].every(port => gatewayService.spec.ports?.some(entry => entry.port === port && entry.targetPort === port)), 'existing shared Gateway selector or ports differ');
  for (const ingress of ingresses.items.filter(entry => entry.spec?.rules?.some(rule => GZ_HOSTS.includes(rule.host)))) {
    for (const tls of ingress.spec.tls) {
      if (!tls.hosts?.some(host => GZ_HOSTS.includes(host))) continue;
      const metadata = JSON.parse(kube(['-n', GZ_NAMESPACE, 'get', 'secret', tls.secretName, '-o', 'jsonpath={.metadata}']));
      identities.push(objectIdentity({kind:'Secret',metadata}, 'Secret', tls.secretName));
    }
  }
  const rcDeployment = get('deployment', 'xpod-rc');
  insist(rcDeployment.spec?.selector?.matchLabels?.app === 'xpod-rc' && rcDeployment.spec.template.metadata.labels?.app === 'xpod-rc'
    && rcDeployment.spec.template.spec.containers?.filter(entry => entry.name === 'xpod').length === 1, 'existing RC workload identity differs');
  identities.push(objectIdentity(rcDeployment, 'Deployment', 'xpod-rc'),
    objectIdentity(get('service', 'xpod-rc'), 'Service', 'xpod-rc'), objectIdentity(get('configmap', 'xpod-rc-config'), 'ConfigMap', 'xpod-rc-config'));
  const facts = await inspectDatabase(database, pod);
  insist(facts.dataDirectory === storage.pgdata, 'actual PostgreSQL data_directory differs from the admitted PVC mount');
  const after = get('pod', pod.metadata.name);
  const postgresName = pod.spec.containers.find(entry => entry.image?.endsWith('@' + PG_IMAGE.split('@')[1])).name;
  const admittedImage = pod.status.containerStatuses.find(entry => entry.name === postgresName).imageID;
  insist(after.metadata.uid === pod.metadata.uid && after.status?.containerStatuses?.some(entry => entry.name === postgresName && entry.ready && entry.imageID === admittedImage), 'prepared database Pod changed during admission');
  verifyPreparedEndpoints(get('service',database.service),after,get('endpoints',database.service));
  const finalAuthority = sourceVolumeAuthority();
  const freshStorage = verifyPreparedStorage(after,claims.map(claim => get('persistentvolumeclaim',claim.metadata.name)),volumes.map(volume => get('persistentvolume',volume.metadata.name)),finalAuthority.forbidden,finalAuthority.forbiddenPVs);
  verifyRestoreAdmission(get('configmap',admissionName),get('statefulset',workload.metadata.name),after,freshStorage,finalAuthority.source);
  writePrivate(path.join(temp, 'prepared-pg-workload.json'), preparedWorkloadProjection(workload));
  writePrivate(path.join(temp, 'gz-rc-prerequisites.json'), { status: 'ok', sourceSha: process.env.GITHUB_SHA, server: GZ_SERVER, namespace: GZ_NAMESPACE,
    fullRestoreStatus:'verified', restoreAdmissionUID:restoreConfig.metadata.uid, archiveSHA256:restored.archive.sha256, storage, databaseService: database.service, pgImage: PG_IMAGE, pgPodUID: pod.metadata.uid, pgWorkloadUID: workload.metadata.uid, facts, identities });
}
function deleteOwned(kind, entry, nonce) {
  insist(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(entry.name ?? '') && entry.name.length <= 63 && entry.uid && nonce, 'owned deletion identity is invalid');
  const metadataText = kube(['-n', GZ_NAMESPACE, 'get', kind, entry.name, '--ignore-not-found', '-o', 'jsonpath={.metadata}']);
  if (!metadataText) return 'verified-absent';
  const metadata = JSON.parse(metadataText);
  insist(metadata.uid === entry.uid && metadata.annotations?.[OWNER] === nonce, 'owned resource changed; deletion refused');
  const api = kind === 'deployment' ? 'apis/apps/v1' : 'api/v1';
  const plural = {deployment:'deployments',service:'services',secret:'secrets'}[kind];
  insist(plural, 'unsupported owned cleanup');
  kube(['delete', '--raw', `/${api}/namespaces/${GZ_NAMESPACE}/${plural}/${entry.name}`, '-f', '-'],
    JSON.stringify({apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:entry.uid},propagationPolicy:'Foreground'}));
  kube(['-n', GZ_NAMESPACE, 'wait', '--for=delete', `${kind}/${entry.name}`, '--timeout=120s']);
  insist(!kube(['-n',GZ_NAMESPACE,'get',kind,entry.name,'--ignore-not-found','-o','jsonpath={.metadata.uid}']).trim(), 'owned resource still present after deletion wait');
  return 'verified-absent';
}
function buildManagedExecutor(record, id) {
  const name = `xpod-rc-inngest-${id}`;
  insist(/^\d+-\d+$/.test(id) && name.length <= 63 && record.nonce && record.secrets?.length === 2, 'invalid RC executor identity');
  const YAML = require('yaml');
  const objects = ['inngest-service.yaml','inngest-deployment.yaml'].map(file => YAML.parse(
    fs.readFileSync(path.join(__dirname,'../deploy/sealos/cloud',file),'utf8')));
  for (const object of objects) {
    object.metadata = {name,namespace:GZ_NAMESPACE,labels:{app:name},annotations:{[OWNER]:record.nonce}};
    if (object.kind === 'Service') object.spec.selector = {app:name};
    else {
      object.spec.selector.matchLabels = {app:name};
      object.spec.template.metadata = {labels:{app:name},annotations:{[OWNER]:record.nonce}};
      const spec = object.spec.template.spec;
      spec.automountServiceAccountToken = false; spec.securityContext = {seccompProfile:{type:'RuntimeDefault'}};
      const container = spec.containers[0];
      insist(container.command?.[0] === 'inngest' && container.args?.[0] === 'start', 'existing managed Inngest protocol changed');
      container.args[container.args.indexOf('--sdk-url') + 1] = 'http://xpod-rc/api/inngest';
      container.envFrom = [{secretRef:{name:record.secrets[0].name}}];
      container.securityContext = {allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}};
    }
  }
  return objects;
}
function createExecutor(temp) {
  boundary();
  const recordFile = path.join(temp,'rc-run-secrets.json'), record = JSON.parse(fs.readFileSync(recordFile,'utf8'));
  const admission = JSON.parse(fs.readFileSync(path.join(temp,'gz-rc-prerequisites.json'),'utf8'));
  insist(admission.status === 'ok' && admission.namespace === GZ_NAMESPACE && admission.sourceSha === process.env.GITHUB_SHA && record.sourceSha === admission.sourceSha, 'source-bound prepared admission is required');
  const objects = buildManagedExecutor(record, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  const rc = get('deployment','xpod-rc');
  const old = rc.metadata.annotations?.[OWNERSHIP];
  if (old) {
    const previous = JSON.parse(old);
    insist(previous.nonce === rc.metadata.annotations?.[OWNER], 'previous run ownership differs');
    ownershipForDeployment(previous);
    record.previous = unreclaimedOwnership(previous);
  }
  record.executor = {name:objects[0].metadata.name,status:'pending'}; writePrivate(recordFile,record);
  for (const object of objects) {
    const kind = object.kind.toLowerCase();
    insist(!kube(['-n',GZ_NAMESPACE,'get',kind,object.metadata.name,'--ignore-not-found','-o','jsonpath={.metadata.uid}']).trim(), 'RC executor name already exists');
  }
  for (const object of objects) {
    const kind = object.kind.toLowerCase();
    record.executor[`${kind}Attempted`] = true; writePrivate(recordFile,record);
    const uid = kube(['-n',GZ_NAMESPACE,'create','-f','-','-o','jsonpath={.metadata.uid}'],JSON.stringify(object)).trim();
    insist(uid, 'RC executor birth acknowledgement is missing');
    record.executor[`${kind}UID`] = uid; writePrivate(recordFile,record);
    const metadata = JSON.parse(kube(['-n',GZ_NAMESPACE,'get',kind,object.metadata.name,'-o','jsonpath={.metadata}']));
    insist(metadata.uid === uid && metadata.annotations?.[OWNER] === record.nonce, 'RC executor birth ownership changed');
  }
  kube(['-n',GZ_NAMESPACE,'rollout','status',`deployment/${record.executor.name}`,'--timeout=300s'],undefined,320000);
  const ready = get('deployment',record.executor.name);
  insist(ready.metadata.uid === record.executor.deploymentUID && ready.metadata.annotations?.[OWNER] === record.nonce
    && ready.status?.availableReplicas >= 1 && ready.spec.template.spec.containers?.some(container => container.name === 'inngest'
      && container.envFrom?.some(entry => entry.secretRef?.name === record.secrets[0].name)), 'RC executor rollout identity or availability failed');
  record.executor.status = 'ready'; writePrivate(recordFile,record);
}
function cleanupExecutorRecord(record) {
  if (!record.executor) return;
  const executor = record.executor;
  const consumers = [...get('pods').items,...get('deployments').items];
  if (consumers.some(object => JSON.stringify(object.spec).includes(`http://${executor.name}:8288`))) {
    executor.cleanup = 'retained-while-referenced'; return;
  }
  for (const kind of ['deployment','service']) {
    if (!executor[`${kind}UID`]) { insist(!executor[`${kind}Attempted`], 'unacknowledged executor birth retained'); continue; }
    executor[`${kind}Cleanup`] = deleteOwned(kind,{name:executor.name,uid:executor[`${kind}UID`]},record.nonce);
  }
  executor.cleanup = 'verified-absent';
}
function ownershipForDeployment(record, depth = 0) {
  insist(depth < 64 && record?.nonce && Array.isArray(record.secrets), 'run ownership history is incomplete or exceeds its bound');
  const secrets = record.secrets.map(entry => {
    insist(entry.name && entry.uid, 'unknown Secret birth cannot be published as ownership');
    return {name:entry.name,uid:entry.uid};
  });
  const executor = record.executor;
  insist(executor?.name && executor.deploymentUID && executor.serviceUID, 'unknown executor birth cannot be published as ownership');
  const projected = {sourceSha:record.sourceSha,nonce:record.nonce,secrets,
    executor:{name:executor.name,status:executor.status,deploymentUID:executor.deploymentUID,serviceUID:executor.serviceUID}};
  if (record.previous) projected.previous = ownershipForDeployment(record.previous,depth + 1);
  insist(Buffer.byteLength(JSON.stringify(projected)) <= 128 * 1024, 'run ownership annotation budget exceeded');
  return projected;
}
function unreclaimedOwnership(record) {
  if (!record) return undefined;
  const previous = unreclaimedOwnership(record.previous);
  const resources = [['deployment', record.executor.name], ['service', record.executor.name],
    ...record.secrets.map(secret => ['secret', secret.name])];
  // Only proven absence retires an identity. Present or replaced objects remain tracked;
  // a failed read aborts admission before any executor birth rather than guessing absence.
  const absent = resources.every(([kind, name]) => !kube(['-n', GZ_NAMESPACE, 'get', kind, name,
    '--ignore-not-found', '-o', 'jsonpath={.metadata}']).trim());
  if (absent) return previous;
  const retained = { ...record };
  if (previous) retained.previous = previous;
  else delete retained.previous;
  return retained;
}
function cleanupExecutor(temp, previous = false) {
  boundary();
  const file = path.join(temp,'rc-run-secrets.json'); if (!fs.existsSync(file)) return;
  const current = JSON.parse(fs.readFileSync(file,'utf8'));
  let record = previous ? current.previous : current, failed = false, depth = 0;
  try {
    while (record) {
      insist(depth++ < 64, 'run ownership cleanup history exceeds its bound');
      try {
        cleanupExecutorRecord(record);
        if (previous) {
          const consumers = [...get('pods').items,...get('deployments').items];
          for (const secret of record.secrets ?? []) {
            if (consumers.some(object => JSON.stringify(object.spec).includes(JSON.stringify(secret.name)))) { secret.cleanup='retained-while-referenced'; continue; }
            secret.cleanup=deleteOwned('secret',secret,record.nonce);
          }
        }
      } catch { record.cleanup = 'failed-retained'; failed = true; }
      record = previous ? record.previous : null;
    }
  } finally { writePrivate(file,current); }
  insist(!failed, 'owned historical cleanup failed; unresolved identities retained');
}
function runSecrets(temp, cleanup = false) {
  boundary();
  const recordFile = path.join(temp, 'rc-run-secrets.json');
  if (cleanup) {
    if (!fs.existsSync(recordFile)) return;
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const pods = get('pods'); const deployments = get('deployments');
    for (const entry of record.secrets) {
      const used = [...pods.items, ...deployments.items].some(object => JSON.stringify(object.spec).includes(JSON.stringify(entry.name)));
      if (used) { entry.cleanup = 'retained-while-referenced'; continue; }
      entry.cleanup = deleteOwned('secret',entry,record.nonce);
    }
    writePrivate(recordFile, record); return;
  }
  const id = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  insist(/^\d+-\d+$/.test(id), 'run identity is required for RC Secrets');
  const name = `${process.env.XPOD_RUNTIME_SECRET_NAME}-${id}`;
  insist(/^[a-z0-9][-a-z0-9]*[a-z0-9]$/.test(name) && name.length <= 63, 'versioned runtime Secret name is invalid');
  const seedName = `xpod-rc-seed-${id}`;
  const record = { sourceSha:process.env.GITHUB_SHA ?? null, nonce: randomUUID(), secrets: [] }; writePrivate(recordFile, record);
  for (const [secretName, stringData] of [[name, parseEnv(fs.readFileSync(path.join(temp, 'xpod-rc.env'), 'utf8'))],
    [seedName, { 'rc.json': fs.readFileSync(path.join(temp, 'xpod-rc-seed.json'), 'utf8') }]]) {
    const manifest = { apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace: GZ_NAMESPACE, annotations: { [OWNER]: record.nonce } }, type: 'Opaque', stringData };
    // create is atomic; a collided or unacknowledged object has no birth UID and is preserved.
    const uid = kube(['-n', GZ_NAMESPACE, 'create', '-f', '-', '-o', 'jsonpath={.metadata.uid}'], JSON.stringify(manifest)).trim();
    insist(uid, 'RC Secret creation acknowledgement is missing');
    record.secrets.push({ name: secretName, uid }); writePrivate(recordFile, record);
  }
  fs.appendFileSync(process.env.GITHUB_ENV, `XPOD_RUNTIME_SECRET_NAME=${name}\nXPOD_RC_SEED_SECRET_NAME=${seedName}\n`);
}
function scaleOwnedRc(temp) {
  boundary();
  const recordFile = path.join(temp, 'rc-run-secrets.json');
  const admissionFile = path.join(temp, 'gz-rc-prerequisites.json');
  if (!fs.existsSync(recordFile) || !fs.existsSync(admissionFile)) return;
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const admission = JSON.parse(fs.readFileSync(admissionFile, 'utf8'));
  const deployment = get('deployment', 'xpod-rc');
  const expected = admission.identities.find(entry => entry.kind === 'Deployment' && entry.name === 'xpod-rc');
  insist(expected?.uid === deployment.metadata.uid && deployment.metadata.annotations?.[OWNER] === record.nonce && record.secrets.length === 2
    && record.secrets.every(entry => JSON.stringify(deployment.spec).includes(JSON.stringify(entry.name))), 'RC scale ownership changed');
  kube(['-n', GZ_NAMESPACE, 'scale', 'deployment/xpod-rc', '--replicas=0', `--resource-version=${deployment.metadata.resourceVersion}`]);
  kube(['-n', GZ_NAMESPACE, 'wait', '--for=delete', 'pod', '-l', 'app=xpod-rc', '--timeout=300s']);
}
const PRODUCTION_TARGET = 'xpod-cn';
function verifyProductionTarget(deployment, service, gateway, ingresses, baseUrl) {
  insist(baseUrl === 'https://id.undefineds.cn', 'canonical CN production base differs');
  objectIdentity(deployment, 'Deployment', PRODUCTION_TARGET);
  objectIdentity(service, 'Service', PRODUCTION_TARGET);
  objectIdentity(gateway, 'ConfigMap', 'gateway');
  insist(deployment.spec?.selector?.matchLabels?.app === PRODUCTION_TARGET
    && deployment.spec.template.metadata.labels?.app === PRODUCTION_TARGET
    && service.spec.selector?.app === PRODUCTION_TARGET
    && service.spec.ports?.some(entry => entry.port === 80 && entry.targetPort === 'http'), 'CN workload or Service selector differs');
  const containers = deployment.spec.template.spec.containers;
  insist(containers.filter(entry => entry.name === 'xpod').length === 1, 'CN container identity differs');
  const configs = Object.values(gateway.data ?? {}).filter(value => typeof value === 'string' && /\bserver\s*\{/.test(value));
  insist(configs.length === 1, 'CN Gateway configuration is ambiguous');
  const blocks = serverBlocks(configs[0]);
  for (const [index, role] of ['id','pods','api'].entries()) {
    const host = `${role}.undefineds.cn`, port = [8082,8083,8081][index];
    const matches = blocks.filter(block => block.includes(`server_name ${host};`));
    insist(matches.length === 1 && new RegExp(`\\blisten\\s+${port}\\s*;`).test(matches[0])
      && matches[0].includes(`proxy_pass http://xpod-cn.${GZ_NAMESPACE}.svc.cluster.local:80;`), 'canonical CN Gateway route differs');
    const ingressMatches = ingresses.items.filter(entry => entry.spec?.rules?.some(rule => rule.host === host));
    insist(ingressMatches.length === 1, 'canonical CN Ingress differs');
    objectIdentity(ingressMatches[0], 'Ingress', ingressMatches[0].metadata.name);
    const backend = ingressMatches[0].spec.rules.find(rule => rule.host === host).http?.paths?.find(entry => entry.path === '/')?.backend?.service;
    insist(backend?.name === 'gateway' && backend.port?.number === port, 'CN Ingress upstream differs');
  }
  return containers.findIndex(entry => entry.name === 'xpod');
}
function productionPreflight(temp) {
  boundary();
  const deployment = get('deployment', PRODUCTION_TARGET);
  const index = verifyProductionTarget(deployment, get('service', PRODUCTION_TARGET), get('configmap', 'gateway'), get('ingress'), process.env.PUBLIC_BASE_URL);
  const previousImage = deployment.spec.template.spec.containers[index].image;
  insist(/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/.test(previousImage), 'CN previous immutable image is missing');
  writePrivate(path.join(temp, 'gz-production-target.json'), { uid: deployment.metadata.uid, previousImage });
  fs.appendFileSync(process.env.GITHUB_ENV, `TARGET_DEPLOYMENT=${PRODUCTION_TARGET}\n`);
}
function productionImage(temp, rollback = false) {
  boundary();
  const recordFile = path.join(temp, 'gz-production-target.json');
  if (rollback && !fs.existsSync(path.join(temp, 'gz-production-promoted.json'))) return;
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const deployment = get('deployment', PRODUCTION_TARGET);
  const index = verifyProductionTarget(deployment, get('service', PRODUCTION_TARGET), get('configmap', 'gateway'), get('ingress'), process.env.PUBLIC_BASE_URL);
  const before = deployment.spec.template.spec.containers[index].image;
  const image = rollback ? record.previousImage : process.env.TARGET_IMAGE;
  insist(deployment.metadata.uid === record.uid && before === (rollback ? process.env.TARGET_IMAGE : record.previousImage)
    && /^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/.test(image), 'CN workload changed; image mutation refused');
  const operations = [
    {op:'test',path:'/metadata/uid',value:record.uid},
    {op:'test',path:'/metadata/resourceVersion',value:deployment.metadata.resourceVersion},
    {op:'test',path:`/spec/template/spec/containers/${index}/name`,value:'xpod'},
    {op:'test',path:`/spec/template/spec/containers/${index}/image`,value:before},
    {op:'replace',path:`/spec/template/spec/containers/${index}/image`,value:image},
  ];
  kube(['-n', GZ_NAMESPACE, 'patch', 'deployment', PRODUCTION_TARGET, '--type=json', '-p', JSON.stringify(operations), '-o', 'name']);
  if (!rollback) writePrivate(path.join(temp, 'gz-production-promoted.json'), {uid:record.uid,image});
}
async function productionHealth(temp) {
  boundary();
  const record = JSON.parse(fs.readFileSync(path.join(temp, 'gz-production-promoted.json'), 'utf8'));
  const deployment = get('deployment', PRODUCTION_TARGET);
  insist(deployment.metadata.uid === record.uid, 'CN deployment changed during health gate');
  const pods = JSON.parse(kube(['-n', GZ_NAMESPACE, 'get', 'pods', '-l', `app=${PRODUCTION_TARGET}`, '-o', 'json']));
  const ready = pods.items.filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running'
    && pod.status.containerStatuses?.some(entry => entry.name === 'xpod' && entry.ready && entry.imageID?.endsWith(record.image.split('@')[1])));
  insist(ready.length >= 1, 'CN exact-image ready Pod is missing');
  const pod = ready[0]; objectIdentity(pod, 'Pod', pod.metadata.name);
  const owner = pod.metadata.ownerReferences?.find(entry => entry.controller === true);
  insist(owner?.kind === 'ReplicaSet', 'CN Pod has no workload controller');
  const replica = get('replicaset', owner.name);
  objectIdentity(replica, 'ReplicaSet', owner.name);
  const deploymentOwner = replica.metadata.ownerReferences?.find(entry => entry.controller === true);
  insist(replica.metadata.uid === owner.uid && deploymentOwner?.kind === 'Deployment' && deploymentOwner.uid === record.uid
    && deploymentOwner.name === PRODUCTION_TARGET && pod.spec.containers?.some(entry => entry.name === 'xpod' && entry.image === record.image), 'CN direct Pod controller or spec image differs');
  await withPortForward(pod, 3000, async port => {
    const response = await fetch(`http://127.0.0.1:${port}/service/status`, {signal:AbortSignal.timeout(15000)});
    insist(response.status === 200, 'CN direct Pod health failed'); await response.arrayBuffer();
  });
  const after = get('pod', pod.metadata.name);
  insist(after.metadata.uid === pod.metadata.uid && after.status?.containerStatuses?.some(entry => entry.name === 'xpod' && entry.ready && entry.imageID?.endsWith(record.image.split('@')[1])), 'CN Pod changed during health gate');
}
async function main() {
  const temp = process.env.RUNNER_TEMP; insist(temp, 'runner private directory is required');
  if (process.argv[2] === 'boundary') boundary();
  else if (process.argv[2] === 'preflight') await preflight(temp);
  else if (process.argv[2] === 'production-health') await productionHealth(temp);
  else if (process.argv[2] === 'production-preflight') productionPreflight(temp);
  else if (process.argv[2] === 'promote-production-image') productionImage(temp);
  else if (process.argv[2] === 'rollback-production-image') productionImage(temp, true);
  else if (process.argv[2] === 'scale-owned-rc') scaleOwnedRc(temp);
  else if (process.argv[2] === 'create-run-executor') createExecutor(temp);
  else if (process.argv[2] === 'cleanup-run-executor') cleanupExecutor(temp);
  else if (process.argv[2] === 'cleanup-previous-run') cleanupExecutor(temp,true);
  else if (process.argv[2] === 'create-run-secrets') runSecrets(temp);
  else if (process.argv[2] === 'cleanup-run-secrets') runSecrets(temp, true);
  else throw new Error('unknown GZ RC admission command');
}
if (require.main === module) main().catch(() => { console.error('GZ RC admission or owned cleanup failed; mutation refused'); process.exitCode = 1; });
module.exports = { GZ_SERVER, GZ_NAMESPACE, GZ_HOSTS, PG_IMAGE, SOURCE_DATABASE, validateBoundary, parseEnv, preparedDatabase, preparedPgClientOptions, verifyPreparedStorage, verifyPreparedEndpoints, verifyRestoreAdmission,
  verifySharedRoutes, verifyPreparedPod, verifyDatabaseFacts, objectIdentity, runSecrets, verifyProductionTarget, withPortForward, preparedWorkloadProjection, buildManagedExecutor, ownershipForDeployment, OWNER, OWNERSHIP };

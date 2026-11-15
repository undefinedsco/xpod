#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

function validateBoundary(config, namespace) {
  const context = config.contexts?.find(entry => entry.name === config['current-context'])?.context;
  const server = config.clusters?.find(entry => entry.name === context?.cluster)?.cluster?.server;
  if (server !== 'https://gzg.sealos.run:6443' || namespace !== 'ns-iknkxtc8') {
    throw new Error('RC requires the GZ cluster and namespace ns-iknkxtc8');
  }
}

// RC runs its own PostgreSQL server. The shared production host is explicitly
// NOT acceptable, so a stale APP_ENV_FILE cannot silently point RC back at
// xpod_cn/xpod_co's instance.
const RC_POSTGRES_NAME = 'xpod-rc-rdf-postgres';
const SHARED_POSTGRES_NAME = 'xpod-rdf-postgres';
const RC_DATABASE = '/xpod_rc';
const RC_ROLE = 'xpod_rc';
const DB_KEYS = [ 'CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT' ];
const ALIAS_KEYS = [ 'DATABASE_URL', 'CSS_TASK_DB_URL' ];

function hostVariants(name, namespace) {
  return [ name, `${name}.${namespace}`, `${name}.${namespace}.svc`,
    `${name}.${namespace}.svc.cluster.local` ];
}

function rcPostgresHosts(namespace) {
  return hostVariants(RC_POSTGRES_NAME, namespace);
}

// Hosts an RC credential may currently name. The shared production service is
// accepted ONLY as a credentialed input to be rebound here; this module never
// connects to it, and the strict validator below keeps rejecting it.
function acceptedSourceHosts(namespace) {
  return [ ...hostVariants(SHARED_POSTGRES_NAME, namespace), ...rcPostgresHosts(namespace) ];
}

const DATABASE_URL_SHAPE = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<authority>[^/?#]*)(?<path>[^?#]*)(?<query>\?[^#]*)?(?<fragment>#.*)?$/;

/** Split a raw URL string without letting `URL` normalise credentials. */
function splitRawDatabaseUrl(raw) {
  const match = DATABASE_URL_SHAPE.exec(raw);
  if (!match || match.groups === undefined) return null;
  const { scheme, authority, path, query, fragment } = match.groups;
  const at = authority.lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = authority.slice(0, at);
  const hostport = authority.slice(at + 1);
  const colon = hostport.lastIndexOf(':');
  const host = colon < 0 ? hostport : hostport.slice(0, colon);
  const port = colon < 0 ? '' : hostport.slice(colon + 1);
  return {
    raw, scheme, userinfo, host, port,
    path: path ?? '', query: query ?? '', fragment: fragment ?? '',
    userinfoAt: authority, hasQuery: Boolean(query), hasFragment: Boolean(fragment),
  };
}

// Never let a parser error carry the raw URL, a password or a cause chain:
// Node's ERR_INVALID_URL keeps the whole input on `error.input`, and a cause
// object would serialise it into logs. Only the entry name is reported.
function sanitized(key, detail) {
  const error = new Error(`${key} ${detail}`);
  error.name = 'RcDatabaseConfigurationError';
  delete error.input;
  delete error.cause;
  return error;
}

function requireRcDatabaseUrl(key, raw, namespace) {
  if (typeof raw !== 'string' || raw === '') throw sanitized(key, 'is missing or not a string');
  const parts = splitRawDatabaseUrl(raw);
  if (!parts) throw sanitized(key, 'must be a valid PostgreSQL URL');
  if (!['postgres', 'postgresql'].includes(parts.scheme.toLowerCase())) {
    throw sanitized(key, 'must use postgres:// or postgresql://');
  }
  if (parts.hasQuery || parts.hasFragment) {
    throw sanitized(key, 'must not carry a query or fragment');
  }
  if (parts.port && parts.port !== '5432') throw sanitized(key, 'must use port 5432');
  if (parts.path !== RC_DATABASE) throw sanitized(key, `must target the ${RC_ROLE} database`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw sanitized(key, 'must be a valid PostgreSQL URL');
  }
  let username;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    // A malformed percent escape in the role is a URL problem, not a role one.
    throw sanitized(key, 'has an invalid percent-encoded role');
  }
  if (username !== RC_ROLE) throw sanitized(key, `must use the ${RC_ROLE} role`);
  let password;
  try {
    // `URL` already validates the escapes it exposes; decoding here keeps the
    // raw encoded form for the rebind while proving it is decodable.
    password = decodeURIComponent(url.password);
  } catch {
    throw sanitized(key, 'has an invalid percent-encoded password');
  }
  if (!password) throw sanitized(key, 'must carry a password');
  if (!acceptedSourceHosts(namespace).includes(parts.host)) {
    throw sanitized(key, 'host is not an accepted RC database service');
  }
  return { parts, password: url.password };
}

/**
 * Rebind the two RC database URLs to the dedicated RC PostgreSQL service,
 * preserving every other byte of every entry.
 *
 * This is release-infrastructure configuration, not application Pod IRI
 * compatibility: the final host is derived from the rendered RC Service, so no
 * operator has to maintain a second copy of the hostname.
 *
 * Rules:
 *   - the source host must be an exact shared or dedicated Kubernetes service
 *     variant; public production hosts, localhost and arbitrary hosts fail;
 *   - role, database, scheme, port, path and percent-encoded credentials are
 *     preserved exactly — only the hostname is rewritten;
 *   - optional DATABASE_URL / CSS_TASK_DB_URL aliases must be byte-identical to
 *     one of the two original URLs and are rebound the same way; anything else
 *     is ambiguous and fails closed;
 *   - every non-database entry is returned unchanged;
 *   - the strict validator is applied to the rendered result.
 */
function materializeRcDatabaseConfiguration(entries, namespace = 'ns-iknkxtc8') {
  if (!(entries instanceof Map)) throw new Error('RC environment entries must be a Map');
  const originals = new Map();
  for (const key of DB_KEYS) {
    const value = entries.get(key);
    if (typeof value !== 'string' || value === '') {
      throw new Error(`missing required RC secret key: ${key}`);
    }
    originals.set(key, value);
  }
  const parsed = DB_KEYS.map(key => requireRcDatabaseUrl(key, originals.get(key), namespace));
  if (parsed[0].password !== parsed[1].password) {
    throw new Error('RC identity and RDF database credentials must match');
  }

  // Rebuild from the raw pieces so the port, percent-encoded userinfo, path,
  // query and fragment survive untouched; only the host is replaced.
  const rebind = (parts) => {
    const authority = `${parts.userinfo}@${RC_POSTGRES_NAME}`
      + (parts.port ? `:${parts.port}` : '');
    return `${parts.scheme}://${authority}${parts.path}${parts.query}${parts.fragment}`;
  };

  const rendered = new Map(entries);
  for (const key of DB_KEYS) {
    const parts = splitRawDatabaseUrl(originals.get(key));
    rendered.set(key, rebind(parts));
  }

  for (const key of ALIAS_KEYS) {
    if (!entries.has(key)) continue;
    const value = entries.get(key);
    const source = DB_KEYS.find(candidate => originals.get(candidate) === value);
    if (!source) {
      throw new Error(`conflicting RC database authority: ${key}`);
    }
    if (typeof value !== 'string') throw new Error(`conflicting RC database authority: ${key}`);
    const aliasParsed = requireRcDatabaseUrl(key, value, namespace);
    if (aliasParsed.password !== parsed[0].password) {
      throw new Error(`conflicting RC database authority: ${key}`);
    }
    rendered.set(key, rebind(aliasParsed.parts));
  }

  // The strict validator runs on the RENDERED entries and still rejects the
  // shared production host when called directly on raw input.
  validateDatabases(rendered, namespace);
  return {
    entries: rendered,
    rebasedKeys: DB_KEYS.concat(ALIAS_KEYS.filter(key => entries.has(key))),
    sourceHosts: DB_KEYS.map(key => splitRawDatabaseUrl(originals.get(key)).host),
    derivedHost: RC_POSTGRES_NAME,
  };
}

function validateDatabases(entries, namespace = 'ns-iknkxtc8') {
  const hosts = rcPostgresHosts(namespace);
  const urls = ['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT'].map(key => {
    let url;
    try { url = new URL(entries.get(key)); } catch { throw new Error(`invalid RC database URL: ${key}`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !hosts.includes(url.hostname)
      || (url.port && url.port !== '5432') || url.pathname !== '/xpod_rc'
      || url.username !== 'xpod_rc' || !url.password || url.search || url.hash) {
      throw new Error(`${key} must use the isolated xpod_rc role/database on the RC-only PostgreSQL`);
    }
    return url;
  });
  if (urls[0].password !== urls[1].password) {
    throw new Error('RC identity and RDF database credentials must match');
  }
  for (const key of ['DATABASE_URL', 'CSS_TASK_DB_URL']) {
    if (entries.has(key) && entries.get(key) !== entries.get('CSS_IDENTITY_DB_URL')
      && entries.get(key) !== entries.get('CSS_SPARQL_ENDPOINT')) {
      throw new Error(`conflicting RC database authority: ${key}`);
    }
  }
}

if (require.main === module) {
  const config = JSON.parse(execFileSync('kubectl', ['config', 'view', '--minify', '-o', 'json'], { encoding: 'utf8' }));
  validateBoundary(config, process.env.SEALOS_NAMESPACE);
}

module.exports = {
  validateBoundary, validateDatabases, rcPostgresHosts, acceptedSourceHosts,
  materializeRcDatabaseConfiguration, splitRawDatabaseUrl,
  RC_POSTGRES_NAME, SHARED_POSTGRES_NAME,
};

export interface SettingsEvidenceRow { label: string; value: string; detail?: string }

export function projectStorageBackends(env: Record<string, string>, secrets: Record<string, { configured: boolean }> = {}): SettingsEvidenceRow[] {
  return [
    { label: 'Files', value: env.CSS_ROOT_FILE_PATH || 'Runtime default', detail: 'Authority file storage root' },
    { label: 'Object storage', value: env.MINIO_ENDPOINT || env.XPOD_STORAGE_S3_ENDPOINT ? 'Configured' : 'Not configured', detail: env.MINIO_ENDPOINT || env.XPOD_STORAGE_S3_ENDPOINT || 'Filesystem fallback' },
    { label: 'Identity database', value: configured(env, secrets, 'CSS_IDENTITY_DB_URL'), detail: databaseKind(env.CSS_IDENTITY_DB_URL) },
    { label: 'Cache / coordination', value: configured(env, secrets, 'REDIS_URL'), detail: env.REDIS_URL ? 'Redis' : 'Runtime fallback' },
    { label: 'RDF / Quadstore', value: configured(env, secrets, 'CSS_SPARQL_ENDPOINT'), detail: rdfBackendKind(env.CSS_SPARQL_ENDPOINT) },
  ];
}

/**
 * Cloud coordination is a property of what the node is actually doing, not of
 * the edition string compiled into it. A `local` node that is registered and
 * cluster-managed still has cloud settings worth showing, and this used to hide
 * them by reading `XPOD_EDITION` alone.
 */
export interface CloudCoordinationEvidence {
  registered: boolean;
  managed: boolean;
  /** A coordinated public domain means the cluster issued this node a route. */
  domainAllocated: boolean;
}

export function projectSystemCapabilities(evidence: CloudCoordinationEvidence): { cloud: boolean } {
  return { cloud: evidence.registered || evidence.managed || evidence.domainAllocated };
}

function configured(env: Record<string, string>, secrets: Record<string, { configured: boolean }>, key: string): string {
  return env[key] || secrets[key]?.configured ? 'Configured' : 'Runtime default';
}
function databaseKind(value: string | undefined): string { return value?.startsWith('postgres') ? 'PostgreSQL' : value ? 'SQLite / configured database' : 'SQLite default'; }

/**
 * Name the RDF backend from the endpoint scheme.
 *
 * Treating any configured endpoint as PostgreSQL reported the default local
 * SQLite quadstore (`sqlite:./data/quadstore.sqlite`) as PostgreSQL RDF.
 */
function rdfBackendKind(value: string | undefined): string {
  if (!value) return 'Local Quadstore';
  if (value.startsWith('postgres')) return 'PostgreSQL RDF';
  if (value.startsWith('sqlite')) return 'SQLite Quadstore';
  if (value.startsWith('http')) return 'Remote SPARQL endpoint';
  return 'Configured SPARQL endpoint';
}

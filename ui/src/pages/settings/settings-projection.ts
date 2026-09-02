export interface SettingsEvidenceRow { label: string; value: string; detail?: string }

export function projectStorageBackends(env: Record<string, string>, secrets: Record<string, { configured: boolean }> = {}): SettingsEvidenceRow[] {
  return [
    { label: 'Files', value: env.CSS_ROOT_FILE_PATH || 'Runtime default', detail: 'Authority file storage root' },
    { label: 'Object storage', value: env.MINIO_ENDPOINT || env.XPOD_STORAGE_S3_ENDPOINT ? 'Configured' : 'Not configured', detail: env.MINIO_ENDPOINT || env.XPOD_STORAGE_S3_ENDPOINT || 'Filesystem fallback' },
    { label: 'Identity database', value: configured(env, secrets, 'CSS_IDENTITY_DB_URL'), detail: databaseKind(env.CSS_IDENTITY_DB_URL) },
    { label: 'Cache / coordination', value: configured(env, secrets, 'REDIS_URL'), detail: env.REDIS_URL ? 'Redis' : 'Runtime fallback' },
    { label: 'RDF / Quadstore', value: configured(env, secrets, 'CSS_SPARQL_ENDPOINT'), detail: env.CSS_SPARQL_ENDPOINT ? 'PostgreSQL RDF' : 'Local Quadstore' },
  ];
}

export function projectSystemCapabilities(env: Record<string, string | undefined>): { cloud: boolean } {
  return { cloud: env.XPOD_EDITION === 'cloud' || Boolean(env.XPOD_CLOUD_API_ENDPOINT) };
}

function configured(env: Record<string, string>, secrets: Record<string, { configured: boolean }>, key: string): string {
  return env[key] || secrets[key]?.configured ? 'Configured' : 'Runtime default';
}
function databaseKind(value: string | undefined): string { return value?.startsWith('postgres') ? 'PostgreSQL' : value ? 'SQLite / configured database' : 'SQLite default'; }

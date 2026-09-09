import { describe, expect, test } from 'bun:test';
import { projectStorageBackends, projectSystemCapabilities } from './settings-projection';

describe('system settings projection', () => {
  test('reports storage configuration without measured usage', () => {
    const rows = projectStorageBackends({ CSS_ROOT_FILE_PATH: '/data', MINIO_ENDPOINT: 'https://minio.example', CSS_IDENTITY_DB_URL: 'postgres://redacted', REDIS_URL: 'redis://redacted', CSS_SPARQL_ENDPOINT: 'postgres://redacted' }, { CSS_IDENTITY_DB_URL: { configured: true }, REDIS_URL: { configured: true }, CSS_SPARQL_ENDPOINT: { configured: true } });
    expect(rows.map((row) => row.label)).toEqual(['Files', 'Object storage', 'Identity database', 'Cache / coordination', 'RDF / Quadstore']);
    expect(JSON.stringify(rows)).not.toContain('usage');
    expect(rows[2]?.value).toBe('Configured');
  });

  test('hides Cloud unless the runtime edition supports coordination', () => {
    expect(projectSystemCapabilities({ XPOD_EDITION: 'local' }).cloud).toBe(false);
    expect(projectSystemCapabilities({ XPOD_EDITION: 'cloud' }).cloud).toBe(true);
  });
});

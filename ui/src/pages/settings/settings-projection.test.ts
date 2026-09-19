import { describe, expect, test } from 'bun:test';
import { projectStorageBackends, projectSystemCapabilities } from './settings-projection';

describe('system settings projection', () => {
  test('reports storage configuration without measured usage', () => {
    const rows = projectStorageBackends({ CSS_ROOT_FILE_PATH: '/data', MINIO_ENDPOINT: 'https://minio.example', CSS_IDENTITY_DB_URL: 'postgres://redacted', REDIS_URL: 'redis://redacted', CSS_SPARQL_ENDPOINT: 'postgres://redacted' }, { CSS_IDENTITY_DB_URL: { configured: true }, REDIS_URL: { configured: true }, CSS_SPARQL_ENDPOINT: { configured: true } });
    expect(rows.map((row) => row.label)).toEqual(['Files', 'Object storage', 'Identity database', 'Cache / coordination', 'RDF / Quadstore']);
    expect(JSON.stringify(rows)).not.toContain('usage');
    expect(rows[2]?.value).toBe('Configured');
  });

  test('names the RDF backend from the endpoint scheme instead of assuming PostgreSQL', () => {
    const detail = (endpoint?: string): string | undefined => projectStorageBackends(
      endpoint ? { CSS_SPARQL_ENDPOINT: endpoint } : {},
      endpoint ? { CSS_SPARQL_ENDPOINT: { configured: true } } : {},
    ).find((row) => row.label === 'RDF / Quadstore')?.detail;

    // The default local install runs SQLite and used to be reported as PostgreSQL.
    expect(detail('sqlite:./data/quadstore.sqlite')).toBe('SQLite Quadstore');
    expect(detail('postgres://user:pass@db:5432/xpod')).toBe('PostgreSQL RDF');
    expect(detail('http://qlever.internal:7001/api')).toBe('Remote SPARQL endpoint');
    expect(detail()).toBe('Local Quadstore');
  });

  test('shows Cloud for any node the cluster actually coordinates', () => {
    // Coordination is observed, not inferred from the compiled edition: this
    // node reports edition `local` while being registered and cluster-managed.
    expect(projectSystemCapabilities({ registered: true, managed: true, domainAllocated: true }).cloud).toBe(true);
    expect(projectSystemCapabilities({ registered: true, managed: false, domainAllocated: false }).cloud).toBe(true);
    expect(projectSystemCapabilities({ registered: false, managed: false, domainAllocated: true }).cloud).toBe(true);
    expect(projectSystemCapabilities({ registered: false, managed: false, domainAllocated: false }).cloud).toBe(false);
  });
});

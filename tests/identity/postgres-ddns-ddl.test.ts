import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('postgres identity ddl', () => {
  it('includes DDNS and service token tables in ensurePostgresTables bootstrap SQL', () => {
    const source = readFileSync(new URL('../../src/identity/drizzle/db.ts', import.meta.url), 'utf8');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS identity_ddns_domain');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS identity_ddns_record');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS identity_service_token');
  });
});

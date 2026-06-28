import { describe, expect, it } from 'vitest';
import { appendPgRdfSearchSourceFilters } from '../../../src/storage/rdf/RdfSearchSourceFilter';

describe('appendPgRdfSearchSourceFilters', () => {
  it('guards PostgreSQL source prefix filters with C-collation range and starts_with', () => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    appendPgRdfSearchSourceFilters({
      sourcePrefix: 'https://pod.example/alice/.data/chat/default/',
      localPathPrefix: '.data/chat/default/',
      deniedSourcePrefixes: ['https://pod.example/alice/.data/private/'],
    }, conditions, params);

    const sql = conditions.join(' AND ');
    expect(sql).toContain('COLLATE "C"');
    expect(sql).toContain('starts_with(source.source,');
    expect(sql).toContain('starts_with(source.local_path,');
    expect(sql).toContain('NOT (');
    expect(params).toEqual([
      'https://pod.example/alice/.data/chat/default/',
      'https://pod.example/alice/.data/chat/default/\uffff',
      'https://pod.example/alice/.data/chat/default/',
      '.data/chat/default/',
      '.data/chat/default/\uffff',
      '.data/chat/default/',
      'https://pod.example/alice/.data/private/',
      'https://pod.example/alice/.data/private/\uffff',
      'https://pod.example/alice/.data/private/',
    ]);
  });
});

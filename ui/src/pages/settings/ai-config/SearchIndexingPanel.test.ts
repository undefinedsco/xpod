import { describe, expect, test } from 'bun:test';
import { isManualBackendSelection } from './SearchIndexingPanel';

describe('SearchIndexingPanel backend disclosure', () => {
  test('keeps runtime-specific choices hidden until Auto is disabled', () => {
    expect(isManualBackendSelection('auto')).toBe(false);
    expect(isManualBackendSelection('fts5')).toBe(true);
    expect(isManualBackendSelection('pgvector')).toBe(true);
  });
});

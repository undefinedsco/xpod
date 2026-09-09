import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getRdfStats } from '../../api/admin';
import IndexSubjectPanel, { type IndexSubjectKind } from './IndexSubjectPanel';

vi.mock('../../api/admin', () => ({ getRdfStats: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stats = {
  available: true as const,
  engine: 'postgres-rdf' as const,
  generatedAt: '2026-08-09T10:00:00.000Z',
  stats: {
    factsBytes: 1024,
    derivedBytes: 2048,
    totalBytes: 3072,
    totalToFactsRatio: 3,
    derivedToFactsRatio: 2,
    lifecycle: {
      status: 'ready' as const,
      driver: 'postgres',
      openCount: 2,
      lastReadyAt: '2026-08-09T09:59:58.000Z',
      coldStart: {
        startedAt: '2026-08-09T09:59:57.000Z',
        readyAt: '2026-08-09T09:59:58.000Z',
        durationMs: 1000,
        phases: [{ name: 'indexes', durationMs: 800 }],
        customIndexDeferred: false,
        maintenanceEnabled: true,
        ownsTextIndex: true,
        ownsVectorIndex: true,
      },
    },
    rdf3x: {
      factsDataVersion: 12,
      rdf3xFactsDataVersion: 10,
      refreshLag: 2,
      syncedWithFacts: false,
      pendingSources: 3,
    },
    pgAcceleration: {
      profile: 'native', requested: true, available: true, enabled: true,
      provider: 'postgres', version: '17', capabilities: ['fts', 'vector'],
      requiredCapabilities: ['fts'], activeOperators: ['text-search'],
      customIndexes: [{ name: 'rdf_fts', permutation: 'pos', columns: ['object'] }],
    },
    derivedCache: {
      cacheBytes: 4096, maxCacheBytes: 8192, cachePressure: 0.5, maxScopeBytes: 4096,
      scopeVersionCount: 1, scopeEntries: [], largestScopeBytes: 2048, largestScopePressure: 0.25,
      evictionCount: 4,
      evictions: { factsVersion: 1, ttl: 1, maxEntries: 1, payloadBytes: 1, scopeBytes: 0, totalBytes: 4, templateTtl: 0, templateMaxEntries: 0, templateBytes: 0 },
      queryResultPayloadBytes: 2048, materializedResultPayloadBytes: 1024, queryTemplateBytes: 1024,
    },
    slowQueries: { entryCount: 0, maxEntries: 50, entries: [] },
  },
  benchmarkReports: { roots: [], reportCount: 0, skippedFiles: 0, errors: [], reports: [] },
};

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
}

async function render(kind: IndexSubjectKind) {
  installDom();
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(<IndexSubjectPanel kind={kind} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { container, root };
}

async function unmount(root: Root) { await act(async () => root.unmount()); }

describe('IndexSubjectPanel', () => {
  beforeEach(() => (getRdfStats as ReturnType<typeof vi.fn>).mockResolvedValue(stats));

  test('renders text-index lifecycle, ownership, freshness and backend evidence', async () => {
    const { container, root } = await render('fts');
    expect(container.textContent).toContain('Ready');
    expect(container.textContent).toContain('Postgres 17');
    expect(container.textContent).toContain('2 versions behind');
    expect(container.textContent).toContain('rdf_fts');
    await unmount(root);
  });

  test('renders retrieval-point synchronization evidence', async () => {
    const { container, root } = await render('retrieval-points');
    expect(container.textContent).toContain('Pending sources');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Facts version');
    expect(container.textContent).toContain('12');
    await unmount(root);
  });

  test('renders total and derived storage in index overview', async () => {
    const { container, root } = await render('overview');
    expect(container.textContent).toContain('Derived storage');
    expect(container.textContent).toContain('2 KB');
    expect(container.textContent).toContain('Generated');
    await unmount(root);
  });
});

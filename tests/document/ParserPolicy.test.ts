import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_PARSER_POLICY,
  evaluateParserRequest,
  planSystemPrefetch,
} from '../../src/document/ParserPolicy';

describe('ParserPolicy', () => {
  it('allows an agent parser decision within hard and soft budgets', () => {
    const result = evaluateParserRequest(DEFAULT_DOCUMENT_PARSER_POLICY, {
      owner: 'agent',
      source: 'https://pod.example/alice/docs/report.pdf',
      pageRange: '1-20',
      reason: 'Need a structure probe for this PDF.',
      expectedUse: 'structure-probe',
    }, {
      runUsedPages: 0,
      fileUsedPagesToday: 0,
      providerUsedPagesToday: 100,
      providerDailyPages: 20_000,
    });

    expect(result.status).toBe('allow');
    expect(result.pageCount).toBe(20);
    expect(result.budget.runRemainingPages).toBe(500);
    expect(result.budget.providerSoftRemainingPagesToday).toBe(15_900);
  });

  it('requires user confirmation when the agent exceeds the exposed soft daily budget', () => {
    const result = evaluateParserRequest(DEFAULT_DOCUMENT_PARSER_POLICY, {
      owner: 'agent',
      source: 'https://pod.example/alice/docs/report.pdf',
      pageRange: '101-200',
      reason: 'Need more pages to answer the user.',
      expectedUse: 'answer-evidence',
    }, {
      runUsedPages: 0,
      fileUsedPagesToday: 0,
      providerUsedPagesToday: 15_950,
      providerDailyPages: 20_000,
    });

    expect(result.status).toBe('needs_user_confirmation');
    expect(result.reasons).toContain('provider_soft_budget_exceeded');
  });

  it('denies missing reason for agent-owned parsing', () => {
    const result = evaluateParserRequest(DEFAULT_DOCUMENT_PARSER_POLICY, {
      owner: 'agent',
      source: 'https://pod.example/alice/docs/report.pdf',
      pageRange: '1-20',
      expectedUse: 'structure-probe',
    }, {
      runUsedPages: 0,
      fileUsedPagesToday: 0,
      providerUsedPagesToday: 0,
      providerDailyPages: 20_000,
    });

    expect(result.status).toBe('deny');
    expect(result.reasons).toContain('agent_reason_required');
  });

  it('plans system prefetch for detail scrolling without an agent reason', () => {
    const prefetch = planSystemPrefetch(DEFAULT_DOCUMENT_PARSER_POLICY, {
      source: 'https://pod.example/alice/docs/report.pdf',
      trigger: 'user-scroll-near-unparsed-page',
      visiblePage: 25,
      totalPages: 100,
      parsedRanges: ['1-25'],
    });

    expect(prefetch).toMatchObject({
      owner: 'system-prefetch',
      source: 'https://pod.example/alice/docs/report.pdf',
      pageRange: '26-35',
      trigger: 'user-scroll-near-unparsed-page',
      lookAheadPages: 10,
    });
  });
});

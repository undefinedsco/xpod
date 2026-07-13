import { describe, expect, it } from 'vitest';
import {
  buildSourceUsageContext,
  chooseL0SourceSummaryPlan,
  createL0SourceSummary,
} from '../../src/document/L0SourceSummary';

describe('L0SourceSummary', () => {
  it('uses chat context when file mentions are high confidence', () => {
    const plan = chooseL0SourceSummaryPlan({
      source: 'https://pod.example/alice/files/contract.pdf',
      sourceUsageContext: {
        source: 'https://pod.example/alice/files/contract.pdf',
        mentions: [
          {
            surface: 'chat',
            resource: 'chat/default/2026/06/18/messages.ttl#m1',
            excerpt: '这是合同初稿，先帮我看风险点。',
            mentionedAs: 'contract.pdf',
            timestamp: '2026-06-18T00:00:00.000Z',
            confidence: 'high',
          },
        ],
        recentActions: [],
      },
      lightweightPreviewAvailable: true,
    });

    expect(plan.action).toBe('create-l0');
    expect(plan.mode).toBe('context-inferred');
    expect(plan.evidence).toContain('message-context');
  });

  it('chooses lightweight preview when context is weak', () => {
    const plan = chooseL0SourceSummaryPlan({
      source: 'https://pod.example/alice/files/scan001.pdf',
      sourceUsageContext: {
        source: 'https://pod.example/alice/files/scan001.pdf',
        mentions: [],
        recentActions: [],
      },
      lightweightPreviewAvailable: true,
    });

    expect(plan.action).toBe('create-l0');
    expect(plan.mode).toBe('lightweight-preview');
    expect(plan.previewSuggestion).toEqual({ pages: '1', bytes: 65536 });
  });

  it('escalates to reader when the user needs layout evidence', () => {
    const plan = chooseL0SourceSummaryPlan({
      source: 'https://pod.example/alice/files/table.pdf',
      sourceUsageContext: {
        source: 'https://pod.example/alice/files/table.pdf',
        mentions: [],
        recentActions: [],
      },
      requestedEvidence: 'table-extraction',
      lightweightPreviewAvailable: true,
    });

    expect(plan.action).toBe('reader-required');
  });

  it('creates an auditable L0 summary with bounded source context excerpts', () => {
    const summary = createL0SourceSummary({
      source: 'https://pod.example/alice/files/contract.pdf',
      summary: '可能是合同初稿。',
      mode: 'context-inferred',
      confidence: 'high',
      evidence: ['message-context'],
      sourceUsageContext: {
        source: 'https://pod.example/alice/files/contract.pdf',
        mentions: [
          {
            surface: 'chat',
            resource: 'chat/default/2026/06/18/messages.ttl#m1',
            excerpt: 'x'.repeat(500),
            timestamp: '2026-06-18T00:00:00.000Z',
            confidence: 'high',
          },
        ],
        recentActions: [],
      },
    });

    expect(summary.readerConfirmed).toBe(false);
    expect(summary.mode).toBe('context-inferred');
    expect(summary.sourceUsageContext?.mentions[0].excerpt?.length).toBeLessThanOrEqual(240);
  });

  it('builds source usage context from chat text and attachment records', () => {
    const context = buildSourceUsageContext({
      source: 'https://pod.example/alice/files/contract.pdf',
      records: [
        {
          surface: 'chat',
          resource: 'chat/default/2026/06/18/messages.ttl#m1',
          text: '请看 contract.pdf，这是客户合同初稿，重点看付款条款。',
          timestamp: '2026-06-18T00:00:00.000Z',
        },
        {
          surface: 'upload',
          resource: 'upload/contract',
          action: 'uploaded',
          attachment: {
            name: 'contract.pdf',
            url: 'https://pod.example/alice/files/contract.pdf',
          },
          timestamp: '2026-06-18T00:01:00.000Z',
        },
      ],
    });

    expect(context.mentions).toHaveLength(2);
    expect(context.mentions[0]).toMatchObject({
      surface: 'chat',
      mentionedAs: 'contract.pdf',
      confidence: 'medium',
    });
    expect(context.recentActions).toEqual([
      {
        action: 'uploaded',
        resource: 'upload/contract',
        timestamp: '2026-06-18T00:01:00.000Z',
        actor: undefined,
      },
    ]);
  });

});

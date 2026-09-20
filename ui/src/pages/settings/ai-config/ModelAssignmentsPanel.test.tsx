import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import {
  ModelAssignmentRow,
  RebuildStatusLine,
  embeddingModelSwitch,
  rebuildInFlight,
  rebuildStatusFrom,
  rebuildTargetForCapabilities,
} from './ModelAssignmentsPanel';
import type { AiConfigLifecycleSnapshot, AiConfigPolicy } from '../../../api/ai-config';

const policy = (embeddingModel?: string): AiConfigPolicy => ({
  models: embeddingModel ? { embeddingModel } : {},
  lifecycle: { automaticIndexing: true, refreshAfterSourceUpdate: true, removeAfterSourceDeletion: true },
} as AiConfigPolicy);

const lifecycleWith = (
  job: Partial<AiConfigLifecycleSnapshot['recent'][number]> | undefined,
  pending = 0,
): AiConfigLifecycleSnapshot => ({
  pending,
  recent: job
    ? [{ id: 'job-1', target: 'vector', status: 'queued', createdAt: '2026-09-19T00:00:00.000Z', ...job }]
    : [],
} as AiConfigLifecycleSnapshot);

const baseProps = {
  label: 'Embedding',
  name: 'embeddingModel' as const,
  description: 'Creates vectors for semantic search.',
  testing: false,
  onChange: vi.fn(),
  onTest: vi.fn(),
};

describe('ModelAssignmentRow', () => {
  test('shows the default state once and aligns the select with a same-height test button', () => {
    const html = renderToStaticMarkup(
      <ModelAssignmentRow {...baseProps} models={[]} />,
    );

    expect(html.match(/System default/gu)).toHaveLength(1);
    expect(html).toContain('sm:grid-cols-[minmax(0,1fr)_4.5rem]');
    expect(html).toContain('h-10 w-full self-start');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('Creates vectors for semantic search.');
  });

  test('reserves the shared status row for an explicit model or probe result', () => {
    const html = renderToStaticMarkup(
      <ModelAssignmentRow
        {...baseProps}
        value="/settings/providers/openai.ttl#embedding-small"
        testResult="ready"
        models={[{
          id: 'embedding-small',
          displayName: 'Embedding Small',
          owner: 'openai',
          ref: '/settings/providers/openai.ttl#embedding-small',
          capabilities: ['embedding'],
        }]}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Connected · credential ready · openai · Probe succeeded');
    expect(html).toContain('sm:col-span-2');
  });
});

describe('embedding model switch', () => {
  test('only an embedding assignment change asks for a rebuild', () => {
    const current = policy('/settings/providers/openai.ttl#embedding-small');
    expect(embeddingModelSwitch({ embeddingModel: '/settings/providers/openai.ttl#embedding-large' }, current))
      .toEqual({
        from: '/settings/providers/openai.ttl#embedding-small',
        to: '/settings/providers/openai.ttl#embedding-large',
      });
    expect(embeddingModelSwitch({ embeddingModel: '/settings/providers/openai.ttl#embedding-small' }, current))
      .toBeUndefined();
    // 切聊天模型不动向量索引，不该弹确认；表单没碰过 embedding 行也不算切换。
    expect(embeddingModelSwitch({ chatModel: '/settings/providers/openai.ttl#gpt-5' }, current)).toBeUndefined();
    expect(embeddingModelSwitch({}, current)).toBeUndefined();
    // 清空选择同样换掉了向量模型。
    expect(embeddingModelSwitch({ embeddingModel: '' }, current)).toEqual({
      from: '/settings/providers/openai.ttl#embedding-small',
      to: undefined,
    });
  });

  test('picks the rebuild target the deployment can actually run', () => {
    expect(rebuildTargetForCapabilities({ textBackends: [], vectorBackends: [], rebuildSupported: true, rebuildTargets: ['fts', 'vector'] })).toBe('vector');
    expect(rebuildTargetForCapabilities({ textBackends: [], vectorBackends: [], rebuildSupported: true, rebuildTargets: ['all'] })).toBe('all');
    expect(rebuildTargetForCapabilities({ textBackends: [], vectorBackends: [], rebuildSupported: false, rebuildTargets: [] })).toBeUndefined();
  });
});

describe('rebuild status', () => {
  test('reports queued, running progress, completion and failure', () => {
    expect(rebuildStatusFrom(lifecycleWith({ status: 'queued' }, 1)))
      .toMatchObject({ phase: 'queued', pending: 1 });
    expect(rebuildStatusFrom(lifecycleWith({ status: 'running', progress: 40 }, 1)))
      .toMatchObject({ phase: 'running', progress: 40 });
    expect(rebuildStatusFrom(lifecycleWith({ status: 'succeeded', progress: 100 })))
      .toMatchObject({ phase: 'succeeded', progress: 100 });
    expect(rebuildStatusFrom(lifecycleWith({ status: 'failed', error: 'pod unreachable' })))
      .toMatchObject({ phase: 'failed', error: 'pod unreachable' });
  });

  test('renders the running state with progress while the queue is draining', () => {
    const running = renderToStaticMarkup(
      <RebuildStatusLine lifecycle={lifecycleWith({ status: 'running', progress: 45 }, 2)} />,
    );
    expect(running).toContain('role="status"');
    expect(running).toContain('索引重建进行中');
    expect(running).toContain('45%');
    expect(running).toContain('队列 2');

    const idle = renderToStaticMarkup(<RebuildStatusLine lifecycle={lifecycleWith(undefined)} />);
    expect(idle).toBe('');
  });

  test('warns before saving when the deployment cannot rebuild', () => {
    const html = renderToStaticMarkup(
      <RebuildStatusLine lifecycle={lifecycleWith(undefined)} fallbackNotice="模型已保存；此运行时不支持重建索引，请稍后手动重建。" />,
    );
    expect(html).toContain('此运行时不支持重建索引');
  });
});

describe('rebuild lock', () => {
  test('locks switching while a rebuild is queued or running, and unlocks once it settles', () => {
    expect(rebuildInFlight(lifecycleWith({ status: 'queued' }, 1))).toBe(true);
    expect(rebuildInFlight(lifecycleWith({ status: 'running', progress: 30 }, 1))).toBe(true);
    expect(rebuildInFlight(lifecycleWith({ status: 'succeeded', progress: 100 }))).toBe(false);
    expect(rebuildInFlight(lifecycleWith({ status: 'failed', error: 'boom' }))).toBe(false);
    expect(rebuildInFlight(lifecycleWith(undefined))).toBe(false);
    // 点击确认到第一份快照之间也必须锁住，避免连点两次排队两次重建。
    expect(rebuildInFlight(undefined, true)).toBe(true);
  });

  test('renders the embedding row locked with the reason while rebuilding', () => {
    const html = renderToStaticMarkup(
      <ModelAssignmentRow
        {...baseProps}
        models={[]}
        disabled
        notice="索引重建进行中，完成后才能再次切换向量模型。"
      />,
    );

    expect(html).toContain('disabled');
    expect(html).toContain('索引重建进行中，完成后才能再次切换向量模型。');
    expect(html).toContain('data-testid="model-assignment-notice"');
  });
});

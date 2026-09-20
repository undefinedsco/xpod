import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfigLifecycleSnapshot } from '../../../api/ai-config';

/**
 * The flow the product asks for: switching the embedding model must announce the
 * rebuild, wait for a second confirmation, and only then save and queue the
 * rebuild - with the switch locked while a rebuild is in flight.
 *
 * Runs under vitest (jsdom + `importOriginal`), not `bun test`: the partial module
 * mock below needs vitest's original-module access to keep the real pure helpers
 * under test. The bun:test files in this directory are the pure ones
 * (`AiConfigContext.test.ts`, `SearchIndexingPanel.test.ts`, `form-state.test.ts`).
 */
const save = vi.fn(async () => {});
const saveAndRebuild = vi.fn(async () => {});
// Read lazily by the mocked context: `vi.mock` factories are hoisted above this
// module body, but the mocked module is only imported at the bottom of the file,
// so the state below is already initialised when the factory runs. Kept free of
// `vi.hoisted` so the file runs under vitest and `bun test` alike.
const state: { lifecycle?: AiConfigLifecycleSnapshot } = {};

const EMBEDDING_SMALL = '/settings/providers/openai.ttl#embedding-small';
const EMBEDDING_LARGE = '/settings/providers/openai.ttl#embedding-large';
const CHAT = '/settings/providers/openai.ttl#gpt-5';

vi.mock('./AiConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AiConfigContext')>();
  return {
    ...actual,
    useAiConfig: () => ({
      config: { models: { embeddingModel: EMBEDDING_SMALL, chatModel: CHAT } },
      capabilities: { textBackends: [], vectorBackends: [], rebuildSupported: true, rebuildTargets: ['fts', 'vector'] },
      lifecycle: state.lifecycle,
      models: [
        { id: 'embedding-small', displayName: 'Embedding Small', owner: 'openai', ref: EMBEDDING_SMALL, capabilities: ['embedding'] },
        { id: 'embedding-large', displayName: 'Embedding Large', owner: 'openai', ref: EMBEDDING_LARGE, capabilities: ['embedding'] },
        { id: 'gpt-5', displayName: 'GPT-5', owner: 'openai', ref: CHAT, capabilities: ['chat'] },
      ],
      loading: false,
      saving: false,
      rebuilding: false,
      error: undefined,
      reload: vi.fn(),
      save,
      rebuild: vi.fn(),
      saveAndRebuild,
    }),
  };
});

vi.mock('../../../solid/useXpodSolidRuntime', () => ({
  useXpodSolidRuntime: () => ({ fetch: vi.fn(async () => new Response('{}')) }),
}));

const { ModelAssignmentsPanel } = await import('./ModelAssignmentsPanel');

const embeddingSelect = () => screen.getByLabelText('Embedding model') as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: /Save configuration|Saving/u });
const dialogTitle = '切换向量模型并重建索引？';

beforeEach(() => {
  save.mockClear();
  saveAndRebuild.mockClear();
  state.lifecycle = undefined;
});

afterEach(() => {
  cleanup();
});

describe('embedding model switch flow', () => {
  it('announces the rebuild and waits for confirmation before saving anything', async () => {
    render(<ModelAssignmentsPanel />);

    expect(screen.queryByText(/切换向量模型会重建索引/u)).toBeNull();
    fireEvent.change(embeddingSelect(), { target: { value: EMBEDDING_LARGE } });

    // 1. 提示会重建（保存之前）。
    expect(screen.getByText(/切换向量模型会重建索引/u)).toBeTruthy();

    // 2. 点保存不落库，先弹二次确认。
    fireEvent.click(saveButton());
    expect(save).not.toHaveBeenCalled();
    expect(saveAndRebuild).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(dialogTitle)).toBeTruthy();
    // 弹窗里写清楚从哪个模型换到哪个模型。
    expect(within(dialog).getByText(/Embedding Large · openai/u)).toBeTruthy();
    expect(within(dialog).getByText(/Embedding Small · openai/u)).toBeTruthy();

    // 3. 取消：什么都不做。
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(save).not.toHaveBeenCalled();
    expect(saveAndRebuild).not.toHaveBeenCalled();
  });

  it('saves and queues the vector rebuild only after the confirmation', async () => {
    render(<ModelAssignmentsPanel />);
    fireEvent.change(embeddingSelect(), { target: { value: EMBEDDING_LARGE } });
    fireEvent.click(saveButton());

    fireEvent.click(screen.getByRole('button', { name: '确认切换并重建' }));

    expect(save).not.toHaveBeenCalled();
    expect(saveAndRebuild).toHaveBeenCalledTimes(1);
    expect(saveAndRebuild).toHaveBeenCalledWith(
      { models: expect.objectContaining({ embeddingModel: EMBEDDING_LARGE }) },
      'vector',
    );
  });

  it('saves a chat-only change without asking about a rebuild', async () => {
    render(<ModelAssignmentsPanel />);
    fireEvent.change(screen.getByLabelText('General / Chat model'), { target: { value: CHAT } });
    fireEvent.click(saveButton());

    expect(screen.queryByText(dialogTitle)).toBeNull();
    expect(saveAndRebuild).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ models: expect.objectContaining({ chatModel: CHAT }) });
  });

  it('asks for the same confirmation when the defaults clear the embedding model', async () => {
    render(<ModelAssignmentsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(save).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(dialogTitle)).toBeTruthy();
    expect(within(dialog).getByText('系统默认')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认切换并重建' }));
    expect(saveAndRebuild).toHaveBeenCalledWith(
      { models: expect.objectContaining({ embeddingModel: null }) },
      'vector',
    );
  });

  it('locks the embedding switch while a rebuild is running', async () => {
    state.lifecycle = {
      pending: 1,
      recent: [{ id: 'job-1', target: 'vector', status: 'running', progress: 30, createdAt: '2026-09-19T00:00:00.000Z' }],
    } as unknown as AiConfigLifecycleSnapshot;
    render(<ModelAssignmentsPanel />);

    expect(embeddingSelect().disabled).toBe(true);
    expect(screen.getByText(/索引重建进行中，完成后才能再次切换向量模型/u)).toBeTruthy();
    expect(screen.getByText(/索引重建进行中 · 30% · 队列 1/u)).toBeTruthy();

    // 即使强行触发变更，也不会弹确认、不会保存。
    fireEvent.change(embeddingSelect(), { target: { value: EMBEDDING_LARGE } });
    fireEvent.click(saveButton());
    expect(screen.queryByText(dialogTitle)).toBeNull();
    expect(saveAndRebuild).not.toHaveBeenCalled();
  });

  it('unlocks the switch once the rebuild settles', async () => {
    state.lifecycle = {
      pending: 0,
      recent: [{ id: 'job-1', target: 'vector', status: 'succeeded', progress: 100, createdAt: '2026-09-19T00:00:00.000Z' }],
    } as unknown as AiConfigLifecycleSnapshot;
    render(<ModelAssignmentsPanel />);

    expect(embeddingSelect().disabled).toBe(false);
    expect(screen.getByText(/索引重建完成 · 100%/u)).toBeTruthy();
  });
});

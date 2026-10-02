// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PodBody } from '../../../../packages/pod-settings/src/PodBody';
import type { PodBodyProps } from '../../../../packages/pod-settings/src/contract';

afterEach(cleanup);
function props(overrides: Partial<PodBodyProps> = {}): PodBodyProps {
  return {
    section: 'models', models: [{ id: 'embeddingModel', label: '语义检索', group: '向量', defaultLabel: '' }], embeddingLabel: 'Current', embeddingValue: 'old',
    embeddingModels: [{ ref: 'new', label: 'New embedding', source: 'own', capabilities: ['embedding'] }], canChangeEmbedding: true,
    search: [{ id: 'vectorEnabled', label: '语义检索', checked: true, description: '资料片段会发给向量模型的服务商。' }], maintenance: [], jobs: [], rebuildTargets: ['vector'],
    backgroundAccess: { granted: false }, usage: [], onSection: vi.fn(), onModel: vi.fn(), onTest: vi.fn(), onToggle: vi.fn(), onEmbedding: vi.fn(), onRebuild: vi.fn(), onGrant: vi.fn(), onRevoke: vi.fn(), ...overrides,
  };
}
describe('shared Pod body', () => {
  it('keeps the semantic model read-only in model settings', () => {
    const value = props(); render(<PodBody {...value} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去更换 ›' }));
    expect(value.onSection).toHaveBeenCalledWith('search');
    expect(value.onModel).not.toHaveBeenCalled();
  });
  it('only switches embedding after the explicit rebuild acknowledgement', async () => {
    const value = props({ section: 'search' }); render(<PodBody {...value} />);
    expect(screen.getByText('资料片段会发给向量模型的服务商。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'own' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new' } });
    expect(screen.getByText('更换后会重建全部语义索引，重建期间只能全文检索。')).toBeTruthy();
    expect(value.onEmbedding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更换并重建索引' }));
    await waitFor(() => expect(value.onEmbedding).toHaveBeenCalledWith('new'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps a failed switch open for retry', async () => {
    const value = props({ section: 'search', onEmbedding: vi.fn().mockRejectedValue(new Error('failed')) }); render(<PodBody {...value} />);
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'own' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '更换并重建索引' }));
    expect(await screen.findByText('操作未完成，请重试。')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('offers a direct allow action for missing background authorization', async () => {
    const value = props({ section: 'apps' }); render(<PodBody {...value} />);
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(value.onGrant).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
  });
  it('only renders progress actually supplied by individual jobs', () => {
    render(<PodBody {...props({ section: 'search', jobs: [{ id: '1', label: '语义索引', status: 'running' }] })} />);
    expect(screen.getByText('进行中')).toBeTruthy();
    expect(screen.queryByText(/0%/)).toBeNull();
  });
  it('clears the selected model when its source changes', () => {
    render(<PodBody {...props({ section: 'search' })} />);
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'own' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'platform' } });
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: '更换并重建索引' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps rebuild availability tied to the selected target', async () => {
    const value = props({ section: 'search' }); render(<PodBody {...value} />);
    fireEvent.click(screen.getByRole('button', { name: '重建' }));
    expect(value.onRebuild).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('重建哪部分'), { target: { value: 'vector' } });
    fireEvent.click(screen.getByRole('button', { name: '重建' }));
    expect(value.onRebuild).toHaveBeenCalledWith('vector');
    await screen.findByText('重建已排队');
  });
  it('prevents cancellation and Escape while embedding is being saved', async () => {
    let finish!: () => void;
    const value = props({ section: 'search', onEmbedding: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    render(<PodBody {...value} />);
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'own' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '更换并重建索引' }));
    expect((screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(value.onEmbedding).toHaveBeenCalledOnce();
    fireEvent.pointerDown(document.body);
    fireEvent.focusIn(document.body);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText('来源') as HTMLSelectElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('更换已保存，重建已排队')).toBeTruthy();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    render(<PodBody {...props({ section: 'search' })} />);
    const trigger = screen.getByRole('button', { name: '更换' });
    trigger.focus(); fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
  it('keeps keyboard focus inside the dialog at both tab boundaries', () => {
    render(<PodBody {...props({ section: 'search' })} />);
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    const first = screen.getByLabelText('来源');
    const last = screen.getByRole('button', { name: '关闭' });
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
  it('disables submission if the selected model becomes unavailable', () => {
    const value = props({ section: 'search' });
    const view = render(<PodBody {...value} />);
    fireEvent.click(screen.getByRole('button', { name: '更换' }));
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'own' } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new' } });
    view.rerender(<PodBody {...value} embeddingModels={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '更换并重建索引' }));
    expect(value.onEmbedding).not.toHaveBeenCalled();
  });

});

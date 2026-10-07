import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { aiModelResource } from '@undefineds.co/models';
import { aiConfigModelRef } from '@undefineds.co/models/ai-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  models: [] as Array<{ id: string; provider: string; modelType: 'chat' }>,
  config: { models: {} as Record<string, string> },
  webId: 'https://id.example/alice/profile/card#me',
  currentPod: { podUrl: 'https://id.example/alice/', webId: 'https://id.example/alice/profile/card#me', database: {} },
}));
vi.mock('../../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => mocks }));
vi.mock('../../../api/ai-config', () => ({ fetchAiConfig: async () => ({ config: mocks.config, capabilities: {}, lifecycle: {} }) }));
vi.mock('../../../extensions/XpodAiConnectionsPodStore', () => ({ createXpodAiConnectionsPodStore: () => ({ listModels: async () => mocks.models }) }));

import { AiConfigProvider, useAiConfig } from './AiConfigContext';
import * as clientApi from '../../../api/ai-connections';
import { createAiConnectionsClient } from '@undefineds.co/ai-connections/client';

function Catalog() {
  const { gatewayCatalog } = useAiConfig();
  return <output>{gatewayCatalog.status}:{gatewayCatalog.models.map(model => model.id).join(',')}</output>;
}
beforeEach(() => { mocks.models = []; mocks.config = { models: {} }; vi.clearAllMocks(); mocks.webId = 'https://id.example/alice/profile/card#me'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AI Config authenticated Gateway catalog', () => {
  it('matches a persisted canonical assignment to the mounted Pod model option', async () => {
    const relative = aiConfigModelRef('openai', 'fixture-gpt-acceptance');
    const canonical = aiModelResource.buildIri(mocks.currentPod.podUrl, { id: aiModelResource.parseRef(relative)!.resourceId });
    mocks.models = [{ id: 'fixture-gpt-acceptance', provider: 'openai', modelType: 'chat' }];
    mocks.config = { models: { chatModel: canonical } };
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }));
    function Assignment() {
      const { config, models, loading } = useAiConfig();
      return <output>{loading ? 'loading' : `${config?.models.chatModel === models[0]?.ref}:${models[0]?.ref}`}</output>;
    }
    render(<AiConfigProvider><Assignment /></AiConfigProvider>);
    await screen.findByText(`true:${canonical}`);
  });
  it('retains real platform aliases and arbitrary Gateway ownership', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'linx', owned_by: 'cloud' }, { id: 'linx-lite', owned_by: 'platform' }] }), { headers: { 'content-type': 'application/json' } }));
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await waitFor(() => expect(screen.getByText('available:linx,linx-lite')).toBeTruthy());
    expect(mocks.fetch).toHaveBeenCalledWith('https://id.example/v1/models', expect.objectContaining({ method: 'GET', credentials: 'omit' }));
  });
  it('keeps HTTP 200 empty distinct from authorization and transport failures', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }));
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await waitFor(() => expect(screen.getByText('available:')).toBeTruthy());
  });
  it.each([401, 403])('uses the existing transport HTTP %s classification without displaying raw error content', async status => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'private-server-error' }), { status, headers: { 'content-type': 'application/json' } }));
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await waitFor(() => expect(screen.getByText('unauthorized:')).toBeTruthy());
    expect(screen.queryByText(/private-server-error/)).toBeNull();
  });
  it('shows a network failure as a read error', async () => {
    mocks.fetch.mockRejectedValue(new Error('private-network-error'));
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await waitFor(() => expect(screen.getByText('error:')).toBeTruthy());
    expect(screen.queryByText(/private-network-error/)).toBeNull();
  });
  it('shows a server failure as a read error rather than a disconnected or empty catalog', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'private-server-error' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await screen.findByText('error:');
    expect(screen.queryByText(/private-server-error/)).toBeNull();
  });
  it('reports a host without the optional catalog reader as unable to read the catalog', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }));
    const client = createAiConnectionsClient({ webId: mocks.webId, podBaseUrl: mocks.currentPod.podUrl, authenticatedFetch: mocks.fetch });
    vi.spyOn(clientApi, 'createXpodAiConnectionsClient').mockReturnValue({ ...client, listGatewayCatalogModels: undefined });
    render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await screen.findByText('error:');
  });
  it('does not reuse the old identity catalog when a new identity is loading', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'linx', owned_by: 'cloud' }] }), { headers: { 'content-type': 'application/json' } }));
    const view = render(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await screen.findByText('available:linx');
    const pending: Array<(response: Response) => void> = [];
    mocks.fetch.mockImplementation(() => new Promise<Response>(resolve => { pending.push(resolve); }));
    mocks.webId = 'https://id.example/bob/profile/card#me';
    view.rerender(<AiConfigProvider><Catalog /></AiConfigProvider>);
    await screen.findByText('loading:');
    expect(screen.queryByText('available:linx')).toBeNull();
    view.unmount();
    for (const resolve of pending) resolve(new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }));
  });
});

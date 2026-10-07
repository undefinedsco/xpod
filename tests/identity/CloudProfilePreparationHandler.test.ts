import { describe, expect, it, vi } from 'vitest';
import { RepresentationMetadata, type JsonInteractionHandlerInput } from '@solid/community-server';
import { CloudProfileCreator } from '../../src/provision/CloudProfileCreator';
import { CloudProfilePreparationHandler } from '../../src/identity/CloudProfilePreparationHandler';

function fixture() {
  const prepare = vi.fn(async () => ({ webId: 'https://id.example/alice/profile/card#me', webIdLink: 'link-a' }));
  const handler = new CloudProfilePreparationHandler({ prepare } as unknown as CloudProfileCreator);
  const input: JsonInteractionHandlerInput = { method: 'POST', accountId: 'account-a', json: { podName: 'alice' },
    target: { path: 'https://id.example/.account/account-a/profile/' }, metadata: new RepresentationMetadata() };
  return { prepare, handler, input };
}

describe('CloudProfilePreparationHandler', () => {
  it('uses only the CSS authenticated Account and returns its prepared identity', async () => {
    const f = fixture();
    expect(await f.handler.handle(f.input)).toEqual({ json: { webId: 'https://id.example/alice/profile/card#me', webIdLink: 'link-a' } });
    expect(f.prepare).toHaveBeenCalledWith('account-a', 'alice');
  });
  it('rejects unauthenticated requests', async () => {
    const f = fixture();
    delete f.input.accountId;
    await expect(f.handler.handle(f.input)).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'DELETE'])('rejects %s', async (method) => {
    const f = fixture();
    await expect(f.handler.handle({ ...f.input, method })).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { podName: '' }, { podName: 42 }, { podName: ' alice ' },
    { podName: 'alice', accountId: 'account-b' }, { podName: 'alice', webId: 'https://other.example/card#me' }])('rejects invalid or identity-overriding body %j', async (json) => {
    const f = fixture();
    await expect(f.handler.handle({ ...f.input, json })).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('propagates profile allocation conflicts', async () => {
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error('name occupied'));
    await expect(f.handler.handle(f.input)).rejects.toThrow('name occupied');
  });
});

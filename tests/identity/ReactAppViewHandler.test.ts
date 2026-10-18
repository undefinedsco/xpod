import { readableToString } from '@solid/community-server';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { ReactAppViewHandler } from '../../src/identity/ReactAppViewHandler';

describe('ReactAppViewHandler auth bootstrap context', () => {
  it('protects OAuth callback documents from caching and referrer leakage', async () => {
    const handler = new ReactAppViewHandler({ getPath: () => '/.account/' } as never, './ui/public/auth.html');
    const representation = await handler.handle({ operation: { target: { path: '/.account/login/wechat/callback/' } } } as never);
    expect(representation.metadata.get(DataFactory.namedNode('urn:xpod:external-login:cache-control'))?.value).toBe('no-store');
    expect(representation.metadata.get(DataFactory.namedNode('urn:xpod:external-login:referrer-policy'))?.value).toBe('no-referrer');
    expect(await readableToString(representation.data)).toContain('name="referrer" content="no-referrer"');
  });
  it('safely embeds the active OIDC provisionCode for the React auth app', async () => {
    const handler = new ReactAppViewHandler(
      { getPath: () => '/.account/' } as never,
      './ui/public/auth.html',
    );

    const representation = await handler.handle({
      operation: {
        target: { path: '/.account/login/password/register/' },
      },
      oidcInteraction: {
        params: {
          provisionCode: 'signed-<local>&"scope$&',
        },
      },
    } as never);

    const html = await readableToString(representation.data);
    expect(html).toContain('"provisionCode":"signed-\\u003clocal\\u003e\\u0026\\"scope$\\u0026"');
    expect(html).not.toContain('signed-<local>');
  });

  it('omits provisionCode when the OIDC interaction has no Local scope', async () => {
    const handler = new ReactAppViewHandler(
      { getPath: () => '/.account/' } as never,
      './ui/public/auth.html',
    );

    const representation = await handler.handle({
      operation: {
        target: { path: '/.account/login/password/' },
      },
      oidcInteraction: {
        params: {},
      },
    } as never);

    const html = await readableToString(representation.data);
    expect(html).toContain('"authenticating":true');
    expect(html).not.toContain('provisionCode');
  });
});

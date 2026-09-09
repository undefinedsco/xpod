// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { useXpodProfileCardIdentity } from './useXpodProfileCardIdentity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe({ runtime = runtimeValue(), accountIdentity = { displayName: 'Account Alice', username: 'account-alice' } }: {
  runtime?: XpodSolidRuntimeValue;
  accountIdentity?: { displayName?: string; username?: string; id?: string; webId?: string };
}) {
  const identity = useXpodProfileCardIdentity({ runtime, accountIdentity });
  return (
    <dl>
      <dt>Name</dt><dd>{identity.displayName}</dd>
      <dt>Username</dt><dd>{identity.username ?? 'none'}</dd>
      <dt>Avatar</dt><dd>{identity.avatarUrl ?? 'none'}</dd>
      <dt>Note</dt><dd>{identity.note ?? 'none'}</dd>
      <dt>Region</dt><dd>{identity.region ?? 'none'}</dd>
      <dt>Loading</dt><dd>{identity.loading ? 'loading' : 'idle'}</dd>
      <dt>Source</dt><dd>{identity.source}</dd>
    </dl>
  );
}

describe('useXpodProfileCardIdentity', () => {
  test('starts from account identity and upgrades from the authenticated WebID profile', async () => {
    const blobUrl = 'blob:xpod-avatar';
    const createObjectURL = vi.fn(() => blobUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://id.example/alice/profile/card') {
        return new Response(`
          @prefix foaf: <http://xmlns.com/foaf/0.1/> .
          @prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
          <#me> vcard:fn "Alice Profile" ;
            foaf:nick "alice" ;
            vcard:note "Personal Pod" ;
            vcard:region "Shanghai" ;
            vcard:hasPhoto <https://id.example/alice/avatar.png> .
        `, { headers: { 'content-type': 'text/turtle' } });
      }
      if (url === 'https://id.example/alice/avatar.png') {
        return new Response(new Blob(['avatar'], { type: 'image/png' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const view = render(<Probe runtime={runtimeValue({ fetch: fetchImpl })} />);

    expect(screen.getByText('Account Alice')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Alice Profile')).toBeTruthy());
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('Personal Pod')).toBeTruthy();
    expect(screen.getByText('Shanghai')).toBeTruthy();
    expect(screen.getByText(blobUrl)).toBeTruthy();
    expect(screen.getByText('webid-profile')).toBeTruthy();

    view.unmount();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);
  });

  test('keeps the account fallback when profile fetch fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 })) as typeof fetch;

    render(<Probe runtime={runtimeValue({ fetch: fetchImpl })} />);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(screen.getByText('Account Alice')).toBeTruthy();
    expect(screen.getByText('account-alice')).toBeTruthy();
    expect(screen.getByText('account')).toBeTruthy();
  });

  test('derives a reasonable fallback username from WebID when account has no name', () => {
    render(<Probe runtime={runtimeValue({ state: { status: 'anonymous' }, webId: undefined })} accountIdentity={{ webId: 'https://id.example/alice/profile/card#me' }} />);

    expect(screen.getAllByText('alice')).toHaveLength(2);
    expect(screen.getByText('account')).toBeTruthy();
  });

  test('drops a resolved WebID profile as soon as the runtime becomes anonymous', async () => {
    const blobUrl = 'blob:xpod-avatar';
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => blobUrl),
      revokeObjectURL,
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://id.example/alice/profile/card') {
        return new Response(`
          @prefix foaf: <http://xmlns.com/foaf/0.1/> .
          @prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
          <#me> vcard:fn "Alice Profile" ;
            foaf:nick "alice-profile" ;
            vcard:hasPhoto <https://id.example/alice/avatar.png> .
        `, { headers: { 'content-type': 'text/turtle' } });
      }
      return new Response(new Blob(['avatar'], { type: 'image/png' }), { status: 200 });
    }) as typeof fetch;
    const accountIdentity = {
      displayName: 'Account Alice',
      username: 'account-alice',
      webId: 'https://id.example/alice/profile/card#me',
    };
    const authenticated = runtimeValue({ fetch: fetchImpl });
    const view = render(<Probe runtime={authenticated} accountIdentity={accountIdentity} />);

    await waitFor(() => expect(screen.getByText('Alice Profile')).toBeTruthy());
    view.rerender(<Probe
      runtime={runtimeValue({
        fetch: fetchImpl,
        state: { status: 'anonymous' },
        webId: undefined,
        podUrl: undefined,
      })}
      accountIdentity={accountIdentity}
    />);

    expect(screen.getByText('Account Alice')).toBeTruthy();
    expect(screen.getByText('account-alice')).toBeTruthy();
    expect(screen.getByText('account')).toBeTruthy();
    expect(screen.queryByText('Alice Profile')).toBeNull();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl));
  });

  test('does not let a slower previous WebID profile replace the current identity', async () => {
    let resolveAlice: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === 'https://id.example/alice/profile/card') {
        return new Promise<Response>((resolve) => { resolveAlice = resolve; });
      }
      if (String(input) === 'https://id.example/bob/profile/card') {
        return Promise.resolve(new Response(`
          @prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
          <#me> vcard:fn "Bob Profile" .
        `, { headers: { 'content-type': 'text/turtle' } }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    }) as typeof fetch;
    const alice = runtimeValue({ fetch: fetchImpl });
    const bobWebId = 'https://id.example/bob/profile/card#me';
    const bob = runtimeValue({
      fetch: fetchImpl,
      state: { status: 'authenticated', webId: bobWebId, podUrl: 'https://pod.example/bob/' },
      webId: bobWebId,
      podUrl: 'https://pod.example/bob/',
    });
    const view = render(<Probe runtime={alice} accountIdentity={{ displayName: 'Account Alice', username: 'alice' }} />);

    await waitFor(() => expect(resolveAlice).toBeTypeOf('function'));
    view.rerender(<Probe runtime={bob} accountIdentity={{ displayName: 'Account Bob', username: 'bob' }} />);
    await waitFor(() => expect(screen.getByText('Bob Profile')).toBeTruthy());
    resolveAlice?.(new Response(`
      @prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
      <#me> vcard:fn "Late Alice Profile" .
    `, { headers: { 'content-type': 'text/turtle' } }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('Bob Profile')).toBeTruthy();
    expect(screen.queryByText('Late Alice Profile')).toBeNull();
  });
});

function runtimeValue(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  const fetchImpl = overrides.fetch ?? vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
  return {
    session: { getSnapshot: () => ({ status: 'authenticated', webId: 'https://id.example/alice/profile/card#me' }) } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: fetchImpl,
    state: { status: 'authenticated', webId: 'https://id.example/alice/profile/card#me', podUrl: 'https://pod.example/alice/' },
    webId: 'https://id.example/alice/profile/card#me',
    podUrl: 'https://pod.example/alice/',
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

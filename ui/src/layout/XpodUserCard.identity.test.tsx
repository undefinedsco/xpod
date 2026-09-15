// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodUserCard } from './XpodUserCard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test.each([502, 200])('renders and copies Alice WebID while Account Bob is active (profile %s)', async (status) => {
  const webId = 'https://id.example/alice/profile/card#me';
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const fetchImpl = vi.fn(async () => new Response(status === 200
    ? '@prefix vcard: <http://www.w3.org/2006/vcard/ns#> . <#me> vcard:fn "Alice Profile" .'
    : '', { status, headers: { 'content-type': 'text/turtle' } }));
  const account = {
    isLoggedIn: true, accountState: { status: 'authenticated' },
    identity: { id: 'bob-account-id', displayName: 'Account Bob', username: 'bob' },
  } as AuthContextType;
  const runtime = { state: { status: 'authenticated', webId }, webId, fetch: fetchImpl } as unknown as XpodSolidRuntimeValue;
  render(<AuthContext.Provider value={account}>
    <XpodSolidRuntimeContext.Provider value={runtime}><XpodUserCard /></XpodSolidRuntimeContext.Provider>
  </AuthContext.Provider>);
  fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
  if (status === 200) await screen.findByRole('heading', { name: 'Alice Profile' });
  else await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  expect(screen.queryByText('Account Bob')).toBeNull();
  expect(screen.queryByText('@bob')).toBeNull();
  expect(screen.queryByText('@bob-account-id')).toBeNull();
  expect(screen.getByText('@alice')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Xpod ID' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(webId));
});

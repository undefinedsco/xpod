// @vitest-environment jsdom
import { createContext } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime, refetchBrowserXpodAccount } from '../helpers/browserXpodRuntime';

const AccountContext = createContext<unknown>(null);
const RuntimeContext = createContext<unknown>(null);
// Execute the browser callback against a real mounted React tree in JSDOM.
const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Page;

afterEach(() => { cleanup(); document.body.replaceChildren(); });

test('browser probes follow the committed Account and Pod through switches and logout', async () => {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  function values(id: string | undefined, pod = id) {
    const status = id ? 'authenticated' : 'anonymous';
    const webId = id ? `https://id.example/${id}#me` : undefined;
    const podUrl = pod ? `https://storage.example/${pod}/` : undefined;
    return {
      account: {
        accountState: { status }, identity: { id }, isAnonymous: () => !id,
        refetchControls: vi.fn(), controls: { account: { webId: `https://id.example/${id}/webid` } },
      },
      runtime: {
        state: { status }, session: { getSnapshot: () => ({ status, webId }) },
        selectedStorage: podUrl ? { webId, storageUrl: podUrl } : undefined,
        fetch: vi.fn(async () => new Response(id ?? 'anonymous')),
      },
    };
  }
  function tree(value: ReturnType<typeof values>) {
    return <AccountContext.Provider value={value.account}>
      <RuntimeContext.Provider value={value.runtime}><span>mounted host</span></RuntimeContext.Provider>
    </AccountContext.Provider>;
  }
  const initial = values('alice');
  const view = render(tree(initial), { container });
  for (const value of [initial, values('bob'), values('bob', 'bob-second'), values(undefined)]) {
    view.rerender(tree(value));
    expect(await readBrowserXpodAccount(page)).toMatchObject({ status: value.account.accountState.status, id: value.account.identity.id });
    expect(await readBrowserXpodRuntime(page)).toMatchObject({
      ...value.runtime.session.getSnapshot(), podUrl: value.runtime.selectedStorage?.storageUrl,
    });
    await refetchBrowserXpodAccount(page);
    expect(value.account.refetchControls).toHaveBeenCalledTimes(1);
    if (value.runtime.selectedStorage) {
      await fetchBrowserXpodPod(page, 'private.txt');
      expect(value.runtime.fetch).toHaveBeenCalledWith(`${value.runtime.selectedStorage.storageUrl}private.txt`, undefined);
    }
  }
});

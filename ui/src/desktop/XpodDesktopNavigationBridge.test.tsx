// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { XpodDesktopNavigationBridge } from './XpodDesktopNavigationBridge';

afterEach(() => {
  cleanup();
  window.xpodDesktop = undefined;
  window.history.replaceState(null, '', '/');
});

test('tray navigation updates the real Router without remounting the host owner', () => {
  let navigateFromTray: ((route: string) => void) | undefined;
  const mounts = vi.fn();
  const unmounts = vi.fn();
  const unsubscribe = vi.fn();
  window.xpodDesktop = {
    setIdentity: vi.fn(),
    onNavigate(navigate) {
      navigateFromTray = navigate;
      return unsubscribe;
    },
  };
  function HostOwner() {
    useEffect(() => { mounts(); return unmounts; }, []);
    return <BrowserRouter>
      <XpodDesktopNavigationBridge />
      <Routes>
        <Route path="/ai-connections" element={<main>Connections</main>} />
        <Route path="/status" element={<main>Status</main>} />
      </Routes>
    </BrowserRouter>;
  }
  window.history.replaceState(null, '', '/ai-connections');
  const view = render(<HostOwner />);
  act(() => navigateFromTray?.('/status?tab=services#gateway'));
  expect(screen.getByText('Status')).toBeTruthy();
  expect(window.location.pathname + window.location.search + window.location.hash)
    .toBe('/status?tab=services#gateway');
  act(() => navigateFromTray?.('/ai-connections'));
  expect(screen.getByText('Connections')).toBeTruthy();
  expect(mounts).toHaveBeenCalledTimes(1);
  expect(unmounts).not.toHaveBeenCalled();
  act(() => navigateFromTray?.('https://other.example/status'));
  expect(window.location.pathname).toBe('/ai-connections');
  view.unmount();
  expect(unsubscribe).toHaveBeenCalled();
});

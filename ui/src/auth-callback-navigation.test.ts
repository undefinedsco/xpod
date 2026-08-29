import { describe, expect, test, vi } from 'vitest';
import {
  callbackProductAppForDestination,
  createCallbackNavigation,
  resolveCallbackProductDestination,
} from './auth-callback-navigation';

const canonicalSurfaceDestinations = [
  ['/dashboard/overview', 'dashboard'],
  ['/status/overview', 'dashboard'],
  ['/network', 'dashboard'],
  ['/settings/pod', 'settings'],
  ['/ai-connections', 'settings'],
  ['/ai-config/model-assignments', 'settings'],
] as const;

describe('auth callback navigation', () => {
  test.each(canonicalSurfaceDestinations)(
    'keeps the canonical %s surface in the callback document',
    (pathname) => {
      const replaceState = vi.fn();
      const replace = vi.fn();
      const navigation = createCallbackNavigation({
        location: {
          origin: 'https://app.example',
          replace,
        },
        history: { replaceState },
      });

      navigation.replace(`https://app.example${pathname}?from=callback#ready`);

      expect(replaceState).toHaveBeenCalledWith(
        {},
        '',
        `${pathname}?from=callback#ready`,
      );
      expect(replace).not.toHaveBeenCalled();
    },
  );

  test('selects the product app for every canonical callback surface', () => {
    for (const [pathname, app] of canonicalSurfaceDestinations) {
      expect(callbackProductAppForDestination(`https://app.example${pathname}`, 'https://app.example')).toBe(app);
    }
    expect(callbackProductAppForDestination('https://evil.example/status/overview', 'https://app.example')).toBeUndefined();
    expect(callbackProductAppForDestination('https://app.example/app/', 'https://app.example')).toBeUndefined();
    expect(callbackProductAppForDestination('https://app.example/status-escape', 'https://app.example')).toBeUndefined();
  });

  test('resolves the exact product location used by the callback handoff', () => {
    expect(resolveCallbackProductDestination(
      'https://app.example/ai-config/model-assignments?from=callback#ready',
      'https://app.example',
    )).toEqual({
      app: 'settings',
      pathname: '/ai-config/model-assignments',
      target: '/ai-config/model-assignments?from=callback#ready',
    });
    expect(resolveCallbackProductDestination(
      'https://evil.example/ai-config/model-assignments',
      'https://app.example',
    )).toBeUndefined();
  });

  test('uses a full navigation for external or non-product destinations', () => {
    const replaceState = vi.fn();
    const replace = vi.fn();
    const navigation = createCallbackNavigation({
      location: {
        origin: 'https://app.example',
        replace,
      },
      history: { replaceState },
    });

    navigation.replace('https://evil.example/steal');
    navigation.replace('https://app.example/app/');
    navigation.replace('https://app.example/settings-escape');

    expect(replaceState).not.toHaveBeenCalled();
    expect(replace).toHaveBeenNthCalledWith(1, 'https://evil.example/steal');
    expect(replace).toHaveBeenNthCalledWith(2, 'https://app.example/app/');
    expect(replace).toHaveBeenNthCalledWith(3, 'https://app.example/settings-escape');
  });

});

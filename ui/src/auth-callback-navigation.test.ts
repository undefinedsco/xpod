import { describe, expect, test, vi } from 'vitest';
import { createCallbackNavigation } from './auth-callback-navigation';

describe('auth callback navigation', () => {
  test('keeps same-origin dashboard handoff in the callback document', () => {
    const replaceState = vi.fn();
    const replace = vi.fn();
    const navigation = createCallbackNavigation({
      location: {
        origin: 'https://app.example',
        replace,
      },
      history: { replaceState },
    });

    navigation.replace('https://app.example/dashboard/overview?tab=status#health');

    expect(replaceState).toHaveBeenCalledWith(
      {},
      '',
      '/dashboard/overview?tab=status#health',
    );
    expect(replace).not.toHaveBeenCalled();
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

    expect(replaceState).not.toHaveBeenCalled();
    expect(replace).toHaveBeenNthCalledWith(1, 'https://evil.example/steal');
    expect(replace).toHaveBeenNthCalledWith(2, 'https://app.example/app/');
  });
});

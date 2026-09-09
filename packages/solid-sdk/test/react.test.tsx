// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SolidRuntimeProvider, useSolidRuntime } from '../src/react';
import type { SolidRuntimeValue } from '../src/react';
import type { PodRuntime } from '../src/pod-runtime';
import type { SolidSessionRuntime } from '../src/session';

const session = {
  fetch: fetch,
  getSnapshot: () => ({ status: 'anonymous' as const }),
  initialize: async () => ({ status: 'anonymous' as const }),
  login: async () => undefined,
  logout: async () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} as unknown as SolidSessionRuntime;

function RuntimeConsumer() {
  const runtime = useSolidRuntime();
  return <output>{runtime.session.getSnapshot().status}:{runtime.pod ? 'pod' : 'identity-only'}</output>;
}

afterEach(() => cleanup());

describe('SolidRuntimeProvider', () => {
  it('renders an identity-only runtime without inventing a Pod capability', () => {
    const value: SolidRuntimeValue = { session };

    render(
      <SolidRuntimeProvider value={value}>
        <RuntimeConsumer />
      </SolidRuntimeProvider>,
    );

    expect(screen.getByRole('status').textContent).toBe('anonymous:identity-only');
  });

  it('remains source-compatible with a session plus Pod runtime', () => {
    const pod = {} as PodRuntime<unknown>;
    const value: SolidRuntimeValue = { session, pod, currentPod: undefined };

    render(
      <SolidRuntimeProvider value={value}>
        <RuntimeConsumer />
      </SolidRuntimeProvider>,
    );

    expect(screen.getByRole('status').textContent).toBe('anonymous:pod');
  });
});

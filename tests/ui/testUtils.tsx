import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

export interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  rerender: (element: ReactElement) => void;
}

export function render(element: ReactElement): RenderResult {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  return {
    container,
    rerender: (next: ReactElement) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

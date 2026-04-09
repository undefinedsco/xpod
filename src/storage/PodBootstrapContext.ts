import { AsyncLocalStorage } from 'node:async_hooks';

export interface PodBootstrapState {
  basePath: string;
}

export const podBootstrapContext = new AsyncLocalStorage<PodBootstrapState>();

export function isPodBootstrapPath(path: string): boolean {
  const state = podBootstrapContext.getStore();
  if (!state) {
    return false;
  }

  return path === state.basePath || path.startsWith(state.basePath);
}

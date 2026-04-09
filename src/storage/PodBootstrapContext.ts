import { AsyncLocalStorage } from 'node:async_hooks';

export interface PodBootstrapState {
  basePath: string;
  createdContainers: Set<string>;
  createdResources: Set<string>;
}

export const podBootstrapContext = new AsyncLocalStorage<PodBootstrapState>();

export function isPodBootstrapPath(path: string): boolean {
  const state = podBootstrapContext.getStore();
  if (!state) {
    return false;
  }

  return path === state.basePath || path.startsWith(state.basePath);
}

export function getPodBootstrapState(): PodBootstrapState | undefined {
  return podBootstrapContext.getStore();
}

import type { ResourceIdentifier } from '@solid/community-server';

/** Separate from resource locks: child writes and Pod deletion share this gate. */
export function podMutationLockIdentifier(storageUrl: string): ResourceIdentifier {
  return { path: `urn:xpod:pod-mutation:${storageUrl}` };
}

/** Global SPARQL updates can target any Pod, so they share a server namespace gate. */
export function podMutationNamespaceLockIdentifier(baseUrl: string): ResourceIdentifier {
  return { path: `urn:xpod:pod-mutation-namespace:${new URL(baseUrl.replace(/\/?$/u, '/')).href}` };
}

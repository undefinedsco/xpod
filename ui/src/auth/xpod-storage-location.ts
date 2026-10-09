import type { StorageLocationKind } from '@undefineds.co/shared-ui';

/**
 * Presentation-only guess of where a Pod lives, for the avatar corner badge:
 * a Pod served from this computer or its local network is an edge Pod, any other
 * host is Xpod Cloud. The badge never decides routing or access.
 */
export function xpodStorageLocationKind(storageUrl: string | undefined): StorageLocationKind {
  if (!storageUrl) return 'cloud';
  let host: string;
  try {
    host = new URL(storageUrl).hostname.toLowerCase();
  } catch {
    return 'cloud';
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'edge';
  if (host === '::1' || host === '[::1]') return 'edge';
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host)) return 'edge';
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(host)) return 'edge';
  return 'cloud';
}

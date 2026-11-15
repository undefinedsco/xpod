import { loadPeerSdk } from './peer.cjs';
/** A host may supply its admitted SDK build; otherwise callers use the real optional peer. */
export type SolidAuthnSdk = typeof import('@inrupt/solid-client-authn-node');
export type SolidAuthnSdkLoader = () => Promise<SolidAuthnSdk>;
let hostLoader: SolidAuthnSdkLoader | undefined;
let sdkPromise: Promise<SolidAuthnSdk> | undefined;

export function registerSolidAuthnSdkLoader(loader: SolidAuthnSdkLoader): void {
  if (hostLoader === loader) return;
  if (hostLoader || sdkPromise) throw new Error('Solid authentication SDK loader is already bound');
  hostLoader = loader;
}

export function loadSolidAuthnSdk(): Promise<SolidAuthnSdk> {
  if (!sdkPromise) {
    const loader = hostLoader ?? (() => Promise.resolve(loadPeerSdk()));
    // Cache failures too: a failed explicit host must never fall back to another authority.
    sdkPromise = Promise.resolve().then(loader);
  }
  return sdkPromise;
}

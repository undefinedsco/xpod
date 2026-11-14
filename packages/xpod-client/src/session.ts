import { loadPeerSdk } from './peer.cjs';
/** Explicit SDK interface; importing this subpath requires the optional SDK peer. */
export const Session = loadPeerSdk().Session;

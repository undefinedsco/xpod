import { PodSolidFsSyncer as Client } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsSyncer';
import { createServerSolidFsPodRequest, type PodSolidFsHttpClientOptions } from './PodSolidFsHttpClient';
export type PodSolidFsSyncerOptions = PodSolidFsHttpClientOptions;
export class PodSolidFsSyncer extends Client {
  public constructor(options: PodSolidFsSyncerOptions = {}) { super({ request: createServerSolidFsPodRequest(options) }); }
}

export { resolvePodResourceUrl } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsSyncer';

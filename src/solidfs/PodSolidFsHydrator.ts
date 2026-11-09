import { PodSolidFsHydrator as Client } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsHydrator';
import { createServerSolidFsPodRequest, type PodSolidFsHttpClientOptions } from './PodSolidFsHttpClient';
export type PodSolidFsHydratorOptions = PodSolidFsHttpClientOptions;
export class PodSolidFsHydrator extends Client {
  public constructor(options: PodSolidFsHydratorOptions = {}) { super({ request: createServerSolidFsPodRequest(options) }); }
}

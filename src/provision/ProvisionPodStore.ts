import { getLoggerFor } from 'global-logger-factory';
import {
  BadRequestHttpError,
  BasePodStore,
  OWNER_STORAGE_TYPE,
  POD_STORAGE_TYPE,
  type AccountLoginStorage,
  type PodManager,
  type PodSettings,
} from '@solid/community-server';

type ProvisionPodStorage = AccountLoginStorage<{
  [POD_STORAGE_TYPE]: {
    baseUrl: 'string';
    accountId: 'id:account';
  };
  [OWNER_STORAGE_TYPE]: {
    webId: 'string';
    visible: 'boolean';
    podId: 'id:pod';
  };
}>;

export const XPOD_REMOTE_PROVISIONED = 'xpodRemoteProvisioned';

function readRemoteStorageUrl(settings: PodSettings): string | undefined {
  if (settings[XPOD_REMOTE_PROVISIONED] !== true || typeof settings.storage !== 'string') {
    return undefined;
  }

  try {
    return new URL(settings.storage).toString();
  } catch {
    throw new BadRequestHttpError('Remote provisioned Pod requires an absolute storage URL.');
  }
}

/**
 * Keeps CSS account Pod records authoritative for Pods created on another Xpod.
 *
 * A remote Pod has already been created by {@link ProvisionPodCreator} through
 * the managed callback. Calling the Cloud PodManager again would create a
 * phantom Cloud Pod and BasePodStore would expose that internal path through
 * the account API. For explicitly marked remote Pods, persist the canonical
 * storage URL and owner only; standard Pod creation remains delegated to CSS.
 */
export class ProvisionPodStore extends BasePodStore {
  private readonly provisionLogger = getLoggerFor(this);
  private readonly provisionStorage: ProvisionPodStorage;
  private readonly provisionVisible: boolean;

  public constructor(
    storage: AccountLoginStorage<Record<string, never>>,
    manager: PodManager,
    visible = false,
  ) {
    super(storage, manager, visible);
    this.provisionStorage = storage as unknown as ProvisionPodStorage;
    this.provisionVisible = visible;
  }

  public override async create(accountId: string, settings: PodSettings, overwrite: boolean): Promise<string> {
    const remoteStorageUrl = readRemoteStorageUrl(settings);
    if (!remoteStorageUrl) {
      return super.create(accountId, settings, overwrite);
    }

    const pod = await this.provisionStorage.create(POD_STORAGE_TYPE, {
      baseUrl: remoteStorageUrl,
      accountId,
    });
    await this.provisionStorage.create(OWNER_STORAGE_TYPE, {
      podId: pod.id,
      webId: settings.webId,
      visible: this.provisionVisible,
    });

    this.provisionLogger.debug(`Recorded remote Pod ${remoteStorageUrl} for account ${accountId}`);
    return pod.id;
  }
}

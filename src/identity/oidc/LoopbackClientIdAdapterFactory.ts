import type { Adapter, AdapterPayload } from 'oidc-provider';
import {
  ClientIdAdapter,
  ClientIdAdapterFactory,
  type AdapterFactory,
  type RepresentationConverter,
} from '@solid/community-server';

function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function isNativeClientPayload(payload: AdapterPayload): boolean {
  if (payload.application_type === 'native') {
    return true;
  }

  const redirectUris = Array.isArray(payload.redirect_uris) ? payload.redirect_uris : [];
  return redirectUris.some((uri) => typeof uri === 'string' && isLoopbackRedirectUri(uri));
}

class LoopbackClientIdAdapter extends ClientIdAdapter {
  public override async find(id: string): Promise<AdapterPayload | void> {
    const payload = await super.find(id);
    if (!payload) {
      return payload;
    }

    if (isNativeClientPayload(payload)) {
      return {
        ...payload,
        application_type: 'native',
      };
    }

    return payload;
  }
}

export class LoopbackClientIdAdapterFactory extends ClientIdAdapterFactory {
  private readonly loopbackConverter: RepresentationConverter;

  public constructor(source: AdapterFactory, converter: RepresentationConverter) {
    super(source, converter);
    this.loopbackConverter = converter;
  }

  public override createStorageAdapter(name: string): Adapter {
    const adapter = this.source.createStorageAdapter(name);
    return new LoopbackClientIdAdapter(name, adapter, this.loopbackConverter);
  }
}

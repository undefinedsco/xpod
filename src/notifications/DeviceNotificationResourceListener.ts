import type { ResourceChangeEvent, ResourceChangeListener } from '../storage/ObservableResourceStore';
import type { DeviceNotificationOperation } from './device-notification-protocol';

export interface DeviceNotificationResourcePublisher {
  publish(event: { topic: string; object?: string; operation: DeviceNotificationOperation }): void;
}

export interface DeviceNotificationResourceListenerOptions {
  origin: string;
  hub: DeviceNotificationResourcePublisher;
}

export class DeviceNotificationResourceListener implements ResourceChangeListener {
  private readonly origin: URL;
  private readonly hub: DeviceNotificationResourcePublisher;

  public constructor(options: DeviceNotificationResourceListenerOptions) {
    this.origin = new URL(options.origin);
    this.hub = options.hub;
  }

  public async onResourceChanged(event: ResourceChangeEvent): Promise<void> {
    const object = this.toResourceUrl(event.path);
    this.hub.publish({
      topic: this.toParentTopic(object),
      object,
      operation: event.action,
    });
  }

  private toResourceUrl(path: string): string {
    try {
      return new URL(path).toString();
    } catch {
      return new URL(path, this.origin).toString();
    }
  }

  private toParentTopic(object: string): string {
    const url = new URL(object);
    if (url.pathname.endsWith('/')) {
      return url.toString();
    }
    const index = url.pathname.lastIndexOf('/');
    url.pathname = index >= 0 ? url.pathname.slice(0, index + 1) : '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
}

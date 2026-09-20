import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface ConfigNode {
  '@id'?: string;
  '@type'?: string;
  comment?: string;
  import?: string[];
  relativePath?: string;
  source?: { '@id'?: string };
  handlers?: Array<{ '@id'?: string }>;
  storage?: { '@id'?: string; relativePath?: string };
  socketMap?: { '@id'?: string };
  channelIndex?: { '@id'?: string };
  baseUrl?: { '@id'?: string };
  intervalMinutes?: number;
  maxDuration?: number;
  overrideInstance?: { '@id'?: string };
  overrideParameters?: ConfigNode;
}

interface ConfigFile {
  import?: string[];
  '@graph'?: ConfigNode[];
}

async function readConfig(file: string): Promise<ConfigFile> {
  return JSON.parse(await readFile(path.resolve(file), 'utf8')) as ConfigFile;
}

function findNode(config: ConfigFile, id: string): ConfigNode | undefined {
  return (config['@graph'] ?? []).find((node) => node['@id'] === id);
}

async function readNotificationConfig(): Promise<ConfigFile> {
  return readConfig('config/notifications.json');
}

describe('Notification channel lifecycle config', () => {
  it('loads the notification lifecycle config from the shared xpod base config', async() => {
    const base = await readConfig('config/xpod.base.json');

    expect(base.import).toContain('./notifications.json');
  });

  it('rewrites the WebSocket channel storer to reclaim channels when their last socket closes', async() => {
    const config = await readNotificationConfig();

    const storerOverride = (config['@graph'] ?? []).find((node) =>
      node.overrideInstance?.['@id'] === 'urn:solid-server:default:WebSocket2023Storer');

    expect(storerOverride?.overrideParameters).toMatchObject({
      '@type': 'ReclaimingWebSocket2023Storer',
      storage: { '@id': 'urn:solid-server:default:SubscriptionStorage' },
      socketMap: { '@id': 'urn:solid-server:default:WebSocketMap' },
    });
  });

  it('runs the orphan sweep as part of the CSS startup sequence with a bounded interval', async() => {
    const config = await readNotificationConfig();

    const sweeper = findNode(config, 'urn:undefineds:xpod:NotificationChannelSweeper');
    expect(sweeper).toMatchObject({
      '@type': 'NotificationChannelSweeper',
      storage: { '@id': 'urn:solid-server:default:SubscriptionStorage' },
      channelIndex: { '@id': 'urn:undefineds:xpod:NotificationChannelIndexStorage' },
      socketMap: { '@id': 'urn:solid-server:default:WebSocketMap' },
      baseUrl: { '@id': 'urn:solid-server:default:variable:baseUrl' },
    });
    // Bounded periodic sweep: at least once a minute, at most once an hour.
    expect(sweeper?.intervalMinutes).toBeGreaterThanOrEqual(1);
    expect(sweeper?.intervalMinutes).toBeLessThanOrEqual(60);

    const initializer = findNode(config, 'urn:solid-server:default:PrimaryParallelInitializer');
    expect(initializer?.['@type']).toBe('ParallelHandler');
    expect(initializer?.handlers?.map((handler) => handler['@id']))
      .toContain('urn:undefineds:xpod:NotificationChannelSweeper');
  });

  it('reads the channel records through the same key prefix the CSS subscription storage writes', async() => {
    const config = await readNotificationConfig();
    const cssStorage = await readConfig('node_modules/@solid/community-server/config/http/notifications/base/storage.json');

    const index = findNode(config, 'urn:undefineds:xpod:NotificationChannelIndexStorage');
    expect(index).toMatchObject({
      '@type': 'ContainerPathStorage',
      source: { '@id': 'urn:solid-server:default:KeyValueStorage' },
    });

    const cssSubscriptionStorage = (cssStorage['@graph'] ?? [])
      .find((node) => node['@id'] === 'urn:solid-server:default:SubscriptionStorage');
    expect(index?.relativePath).toBe(cssSubscriptionStorage?.storage?.relativePath);
  });

  it('caps the channel lifetime well below the CSS default of two weeks', async() => {
    const config = await readNotificationConfig();

    const subscriber = findNode(config, 'urn:solid-server:default:WebSocket2023Subscriber');
    // Only `maxDuration` is declared here: Components.js merges it into the CSS node that
    // defines the subscriber, so this must not turn into a full parameter replacement.
    expect(subscriber).not.toHaveProperty('channelType');
    expect(subscriber).not.toHaveProperty('storage');
    // Minutes, matching the CSS `NotificationSubscriber.maxDuration` parameter.
    expect(subscriber?.maxDuration).toBe(720);
    // Long enough for a long-lived page, short enough that a leak cannot accumulate for two weeks.
    expect(subscriber?.maxDuration).toBeGreaterThanOrEqual(60);
    expect(subscriber?.maxDuration).toBeLessThanOrEqual(24 * 60);
  });
});

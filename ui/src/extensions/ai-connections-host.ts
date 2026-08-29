import { createAiConnectionsExtension, type AiConnectionsController } from '@undefineds.co/ai-connections';
import {
  mountApplet,
  createSolidPermissionCapability,
  type AppletModule,
  type MountedTwoPaneApplet,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web';
import { useMemo } from 'react';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { createXpodAiClientConfigurationBridge } from '../api/ai-connections';
import type { XpodAuthValue } from '../auth/useXpodAuth';
import { useXpodAuth } from '../auth/useXpodAuth';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { createXpodAiConnectionsPodStore } from './XpodAiConnectionsPodStore';

const aiConnectionExtension = createAiConnectionsExtension();
const aiConnectionAppletId = aiConnectionExtension.manifest.contributes.applets[0]?.appId;
const discoveredAiConnectionsApplet = (aiConnectionAppletId
  ? aiConnectionExtension.applets[aiConnectionAppletId]
  : undefined) as AppletModule<SolidDatabase> | undefined;

if (!discoveredAiConnectionsApplet) {
  throw new Error('AI Connection extension did not contribute an applet');
}

const aiConnectionApplet = discoveredAiConnectionsApplet;

export function createXpodAiConnectionsHost(
  runtime: XpodSolidRuntimeValue,
  auth: Pick<XpodAuthValue, 'startLogin'>,
): WebExtensionHost<SolidDatabase> {
  const clientConfigurationPodUrl = runtime.currentPod?.podUrl
    ?? runtime.selectedStorage?.storageUrl
    ?? runtime.podUrl;
  const pod = runtime.currentPod
    ? { status: 'ready' as const, current: runtime.currentPod }
    : runtime.podError
      ? { status: 'error' as const, error: runtime.podError.error }
      : runtime.state.status === 'authenticated'
        ? { status: 'opening' as const }
        : runtime.state.status === 'error'
          ? { status: 'error' as const, error: runtime.state.error }
          : { status: 'unavailable' as const };
  const invocationFetch = window.fetch.bind(window);

  return {
    solid: {
      session: {
        getSnapshot: runtime.session.getSnapshot,
        subscribe: runtime.session.subscribe,
        fetch: runtime.fetch,
      },
      pod,
      permissions: {
        ...createSolidPermissionCapability({ fetch: runtime.fetch }),
      },
      requireLogin: async () => {
        await auth.startLogin();
      },
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    capabilities: {
      aiConnectionsPodStore: runtime.currentPod
        ? createXpodAiConnectionsPodStore({
          database: runtime.currentPod.database,
          authenticatedFetch: runtime.fetch,
          podUrl: runtime.currentPod.podUrl,
          webId: runtime.currentPod.webId,
          openAiSubscriptionImportAvailable: globalThis.xpodDesktop !== undefined,
        })
        : undefined,
      aiClientConfiguration: clientConfigurationPodUrl && (
        globalThis.xpodDesktop !== undefined || (
          runtime.aiClientConfiguration?.available === true &&
          runtime.aiClientConfiguration.authority === 'local-filesystem'
        ))
        ? createXpodAiClientConfigurationBridge({
          podUrl: clientConfigurationPodUrl,
          authenticatedFetch: runtime.fetch,
          invocationFetch,
        })
        : undefined,
    },
  };
}

export function useMountedAiConnectionsApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionsController> {
  const auth = useXpodAuth();
  const host = useMemo(() => createXpodAiConnectionsHost(runtime, auth), [auth, runtime]);
  return useMemo(() => {
    const mounted = mountApplet(aiConnectionApplet, host);
    if (mounted.layout !== 'two-pane') {
      throw new Error('AI Connection applet must use a two-pane layout');
    }
    return mounted as MountedTwoPaneApplet<AiConnectionsController>;
  }, [host]);
}

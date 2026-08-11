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
import {
  createXpodAiClientConfigurationBridge,
} from '../api/ai-connections';
import { createXpodLoginController } from '../auth/XpodLoginController';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { createXpodAiClientCredentialsCapability } from './XpodAiClientCredentials';
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

export function createXpodAiConnectionsHost(runtime: XpodSolidRuntimeValue): WebExtensionHost<SolidDatabase> {
  const loginController = createXpodLoginController({ runtime });
  const pod = runtime.currentPod
    ? { status: 'ready' as const, current: runtime.currentPod }
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
        await loginController.startLogin();
      },
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    capabilities: {
      aiClientCredentials: runtime.currentPod
        ? createXpodAiClientCredentialsCapability({
          accountBaseUrl: runtime.state.issuer ?? runtime.issuer,
          webId: runtime.currentPod.webId,
          fetch: invocationFetch,
        })
        : undefined,
      aiConnectionsPodStore: runtime.currentPod
        ? createXpodAiConnectionsPodStore({
          database: runtime.currentPod.database,
          authenticatedFetch: runtime.fetch,
          podUrl: runtime.currentPod.podUrl,
          webId: runtime.currentPod.webId,
        })
        : undefined,
      aiClientConfiguration: runtime.currentPod &&
        runtime.aiClientConfiguration?.available === true &&
        runtime.aiClientConfiguration.authority === 'local-filesystem'
        ? createXpodAiClientConfigurationBridge({
          podUrl: runtime.currentPod.podUrl,
          authenticatedFetch: runtime.fetch,
          invocationFetch,
        })
        : unsupportedAiClientConfiguration,
    },
  };
}

const unsupportedAiClientConfiguration = {
  inspect: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
  plan: async () => {
    throw new Error('Host does not support local client configuration. Use the manual setup instructions for your client.');
  },
  apply: async () => {
    throw new Error('Host does not support local client configuration. Use the manual setup instructions for your client.');
  },
  verify: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
  restore: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
};

export function useMountedAiConnectionsApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionsController> {
  const host = useMemo(() => createXpodAiConnectionsHost(runtime), [runtime]);
  return useMemo(() => {
    const mounted = mountApplet(aiConnectionApplet, host);
    if (mounted.layout !== 'two-pane') {
      throw new Error('AI Connection applet must use a two-pane layout');
    }
    return mounted as MountedTwoPaneApplet<AiConnectionsController>;
  }, [host]);
}

import { createAiConnectionExtension, type AiConnectionController } from '@undefineds.co/ai-connection';
import {
  mountApplet,
  type AppletModule,
  type MountedTwoPaneApplet,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web';
import { useMemo } from 'react';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { createServiceAccessGatewayFetch, createXpodAiClientConfigurationBridge } from '../api/ai-connection';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

const aiConnectionExtension = createAiConnectionExtension();
const aiConnectionAppletId = aiConnectionExtension.manifest.contributes.applets[0]?.appId;
const discoveredAiConnectionApplet = (aiConnectionAppletId
  ? aiConnectionExtension.applets[aiConnectionAppletId]
  : undefined) as AppletModule<SolidDatabase> | undefined;

if (!discoveredAiConnectionApplet) {
  throw new Error('AI Connection extension did not contribute an applet');
}

const aiConnectionApplet = discoveredAiConnectionApplet;

export function createXpodAiConnectionHost(runtime: XpodSolidRuntimeValue): WebExtensionHost<SolidDatabase> {
  const pod = runtime.currentPod
    ? { status: 'ready' as const, current: runtime.currentPod }
    : runtime.state.status === 'authenticated'
      ? { status: 'opening' as const }
      : runtime.state.status === 'error'
        ? { status: 'error' as const, error: runtime.state.error }
        : { status: 'unavailable' as const };

  return {
    solid: {
      session: {
        getSnapshot: runtime.session.getSnapshot,
        subscribe: runtime.session.subscribe,
        fetch: runtime.currentPod
          ? createServiceAccessGatewayFetch({
            podUrl: runtime.currentPod.podUrl,
            authenticatedFetch: runtime.fetch,
          })
          : runtime.fetch,
      },
      pod,
      permissions: {
        inspectAgentAccess: async (request) => ({
          status: 'granted',
          resources: request.resources,
        }),
        ensureAgentAccess: async (request) => ({
          status: 'granted',
          resources: request.resources,
        }),
        revokeAgentAccess: async (request) => ({
          status: 'missing',
          resources: request.resources,
        }),
      },
      requireLogin: async () => runtime.login(window.location.origin),
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    capabilities: {
      aiClientConfiguration: runtime.currentPod &&
        runtime.aiClientConfiguration?.available === true &&
        runtime.aiClientConfiguration.authority === 'local-filesystem'
        ? createXpodAiClientConfigurationBridge({
          podUrl: runtime.currentPod.podUrl,
          authenticatedFetch: runtime.fetch,
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

export function useMountedAiConnectionApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionController> {
  const host = useMemo(() => createXpodAiConnectionHost(runtime), [runtime]);
  return useMemo(() => {
    const mounted = mountApplet(aiConnectionApplet, host);
    if (mounted.layout !== 'two-pane') {
      throw new Error('AI Connection applet must use a two-pane layout');
    }
    return mounted as MountedTwoPaneApplet<AiConnectionController>;
  }, [host]);
}

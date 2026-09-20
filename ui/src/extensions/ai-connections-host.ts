import { createAiConnectionsExtension, type AiConnectionsController } from '@undefineds.co/ai-connections';
import {
  mountApplet,
  createSolidPermissionCapability,
  type AppletModule,
  type MountedTwoPaneApplet,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web';
import { useContext, useMemo } from 'react';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { SolidSessionSnapshot } from '@undefineds.co/solid-sdk';
import { createXpodAiClientConfigurationBridge } from '../api/ai-connections';
import { createXpodLoginController } from '../auth/XpodLoginController';
import { createAccountClientCredentialsCapability } from '../auth/account-client-credentials';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { createXpodAiConnectionsPodStore } from './XpodAiConnectionsPodStore';
import { createLazyPodCollectionsCapability } from './pod-collections-lazy-host';
import { createSolidNotificationsCapability } from './solid-notifications';

const aiConnectionExtension = createAiConnectionsExtension({ renderToaster: false });
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
  account?: Pick<AuthContextType, 'controls' | 'idpIndex' | 'bindAccountCapability'> | null,
): WebExtensionHost<SolidDatabase> {
  const loginController = createXpodLoginController({ runtime });
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
  const session = {
    // Read the live authority even while React still holds this host value.
    getSnapshot: () => runtime.session.getSnapshot(),
    subscribe: (listener: (snapshot: SolidSessionSnapshot) => void) => runtime.session.subscribe(listener),
    fetch: runtime.fetch,
  };
  /**
   * One notification transport per session. Every live table - the page's own
   * subscriptions and the `podCollections` capability below - shares it, so a
   * document watched by both still has exactly one channel.
   */
  const notifications = createSolidNotificationsCapability({
    fetch: runtime.fetch,
    session,
    document: typeof document === 'undefined' ? null : document,
    // The channel endpoint and the socket name the Pod's canonical origin,
    // which this host may not be able to reach. The runtime knows which
    // canonical origins this Gateway serves; the session transport applies the
    // same rule to fetch, but a raw WebSocket bypasses it.
    resolveLocalUrl: (url) => runtime.resolveLocalUrl?.(url) ?? url,
  });

  return {
    solid: {
      session,
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
      // One subscription per watched table document for this session; the
      // capability tears itself down when the session or the page goes away.
      solidNotifications: notifications,
      // The same notification primitive drives every live table: an applet
      // declares the table, this host turns it into a collection over the Pod
      // database, and no second socket path is opened for it. The engine behind
      // that declaration is fetched on first use (see the lazy front), so the
      // page's initial chunk does not carry it.
      podCollections: runtime.currentPod
        ? createLazyPodCollectionsCapability({
          database: runtime.currentPod.database,
          podUrl: runtime.currentPod.podUrl,
          feed: notifications,
        })
        : undefined,
      aiClientCredentials: account?.controls?.account?.clientCredentials && account.bindAccountCapability
        ? createAccountClientCredentialsCapability({
          collection: account.controls.account.clientCredentials,
          assertCurrent: account.bindAccountCapability(),
          accountIndex: account.idpIndex,
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
      aiClientConfiguration: clientConfigurationPodUrl && (
        globalThis.xpodDesktop !== undefined || (
          runtime.aiClientConfiguration?.available === true &&
          runtime.aiClientConfiguration.authority === 'local-filesystem'
        ))
        ? createXpodAiClientConfigurationBridge({
          podUrl: clientConfigurationPodUrl,
          controlPlaneOrigin: window.location.origin,
          authenticatedFetch: runtime.fetch,
          invocationFetch,
        })
        : undefined,
    },
  };
}

export function useMountedAiConnectionsApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionsController> {
  const account = useContext(AuthContext);
  const host = useMemo(() => createXpodAiConnectionsHost(runtime, account), [runtime, account]);
  // The capability is session-scoped and is not disposed from an effect: React
  // StrictMode's simulated unmount would tear down the very instance the next
  // setup reuses. Sockets are released by the applet that opened them, by the
  // pagehide/visibility rules, and by the capability's own session watch.
  return useMemo(() => {
    const mounted = mountApplet(aiConnectionApplet, host);
    if (mounted.layout !== 'two-pane') {
      throw new Error('AI Connection applet must use a two-pane layout');
    }
    return mounted as MountedTwoPaneApplet<AiConnectionsController>;
  }, [host]);
}

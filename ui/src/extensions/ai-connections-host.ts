import { createAiConnectionsExtension, type AiConnectionsController } from '@undefineds.co/ai-connections';
import {
  type AppletModule,
  type MountedTwoPaneApplet,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web';
import { useApplet } from '@undefineds.co/extension-sdk/react';
import { useMemo } from 'react';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { createAiConnectionsManagementFetch } from '../api/ai-connections';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

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
          ? createAiConnectionsManagementFetch(runtime.fetch)
          : runtime.fetch,
      },
      pod,
      requireLogin: async () => runtime.login(window.location.origin),
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    capabilities: {},
  };
}

export function useMountedAiConnectionsApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionsController> {
  const host = useMemo(() => createXpodAiConnectionsHost(runtime), [runtime]);
  const mounted = useApplet(aiConnectionApplet, host);
  if (!mounted || mounted.layout !== 'two-pane') {
    throw new Error('AI Connection applet must use a two-pane layout');
  }
  return mounted as MountedTwoPaneApplet<AiConnectionsController>;
}

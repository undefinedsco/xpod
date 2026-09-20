import type { OpenPodRuntime, SolidSessionRuntime } from '@undefineds.co/solid-sdk';
import type { PodModelDescriptor } from '@undefineds.co/models';
import type {
  PodCollection,
  PodCollectionOptions,
  PodSyncState,
  RowOf,
} from '@undefineds.co/pod-collections';
import { createElement, type ReactElement } from 'react';
import {
  defineAppletLayout as validateAppletLayout,
  type AppletLayoutType,
  AppletLayoutDescriptor,
  SinglePaneAppletLayoutDescriptor,
  ThreePaneAppletLayoutDescriptor,
  TwoPaneAppletLayoutDescriptor,
} from './layout';
import type { AppletManifest, ExtensionManifest } from './manifest';

export type {
  LoginEndpointDescriptor,
  RememberedWebIdLogin,
  StorageBinding,
  StorageSelectionState,
  WebIdAuthState,
  WebIdLoginActions,
  WebIdLoginRouteDescriptor,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';

export { defineAppletLayout } from './layout';
export type { AppletLayoutDescriptor } from './layout';

const validateRawAppletLayout = validateAppletLayout as (descriptor: unknown) => AppletLayoutDescriptor;

export type WebExtensionSessionStatus =
  | 'anonymous'
  | 'authenticating'
  | 'authenticated'
  | 'expired';

export type AiClientId = 'codex' | 'claude-code' | 'pi' | 'codebuddy';

export interface AiClientConfigurationStatus {
  status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored';
  message?: string;
  appliedKeyFingerprint?: string;
}

export interface AiClientConfigurationConfirmation {
  required: boolean;
  token: string;
  targetHash: string;
  message?: string;
}

export interface AiClientConfigurationPlan {
  planId: string;
  client: AiClientId;
  confirmation?: AiClientConfigurationConfirmation;
  changes: Array<{
    target: string;
    action: 'update' | 'createOrUpdate' | 'delete';
    backup: boolean;
  }>;
}

export interface AiClientConfigurationModel {
  id: string;
  displayName?: string;
  availability?: 'available' | 'unavailable';
  contextWindow?: number;
  inputModalities?: string[];
  capabilities?: string[];
}

export interface AiClientConfigurationCapability {
  readonly available?: boolean;
  readonly authority?: 'local-filesystem';
  readonly manualInstructions?: string;
  inspect(client: AiClientId): Promise<AiClientConfigurationStatus>;
  plan(input: {
    client: AiClientId;
    endpoint: string;
    activeModels?: AiClientConfigurationModel[];
  }): Promise<AiClientConfigurationPlan>;
  apply(input: {
    client: AiClientId;
    planId: string;
    apiKey: string;
    confirmation?: {
      token: string;
      targetHash: string;
    };
  }): Promise<{ applied: true }>;
  verify(input: {
    client: AiClientId;
    planId: string;
  }): Promise<AiClientConfigurationStatus>;
  launch?(client: AiClientId): Promise<{ launched: true }>;
  restore(client: AiClientId): Promise<AiClientConfigurationStatus>;
}

export interface AiConnectionsPodStore {
  listProviders(): Promise<unknown[]>;
  listModels?(): Promise<unknown[]>;
  /**
   * `settings/credentials.ttl`: the document credential rows live in, and
   * therefore the live-update topic of the credentials table.
   */
  credentialsTableDocument?(): string;
  /**
   * The document a provider's own row and its model rows live in
   * (`providers/<provider>.ttl`), and therefore that table's live-update topic.
   *
   * `instanceId` selects the document of a user-defined provider instance,
   * which owns its own document; catalog providers ignore it.
   */
  providerTableDocument?(provider: string, instanceId?: string): string;
  createApiKeyCredential?(provider: string, input: {
    offeringId?: string;
    apiKey: string;
    label?: string;
    baseUrl?: string;
    proxyUrl?: string;
    priority?: number;
    compatibility?: 'auto' | 'openai' | 'anthropic';
    /**
     * The row this credential must be written at.
     *
     * A live collection creates the row optimistically from the models
     * descriptor and then asks the store for the complete row at that id: the
     * secret envelope and the columns the descriptor does not declare are the
     * store's to write. The row already exists then, so the store updates it in
     * place instead of inserting a second one. Omitted = create a new id.
     */
    id?: string;
  }): Promise<unknown>;
  createLocalCredential?(provider: string, input: {
    authorizationMethodId?: string;
    offeringId?: string;
    label?: string;
    baseUrl?: string;
    priority?: number;
    /** See {@link AiConnectionsPodStore.createApiKeyCredential}. */
    id?: string;
  }): Promise<unknown>;
  saveOAuthCredential?(provider: string, input: AiConnectionsOAuthCredential): Promise<unknown>;
  updateOAuthCredential?(
    provider: string,
    credentialId: string,
    expectedVersion: number,
    input: AiConnectionsOAuthCredential,
  ): Promise<unknown>;
  updateProviderCredential?(provider: string, credentialId: string, input: {
    expectedVersion: number;
    label?: string;
    enabled?: boolean;
    priority?: number;
    baseUrl?: string;
    proxyUrl?: string;
  }): Promise<unknown>;
  markCredentialHealth?(
    provider: string,
    credentialId: string,
    health: 'healthy' | 'invalid' | 'expired' | 'unknown',
    expectedVersion: number,
  ): Promise<unknown>;
  deleteProviderCredential?(provider: string, credentialId: string): Promise<unknown | undefined>;
  readCredentialSecret?(provider: string, credentialId: string): Promise<Record<string, unknown>>;
  saveDiscoveredModels?(provider: string, credentialId: string, models: unknown[]): Promise<void>;
  saveModelSelection?(provider: string, models: AiConnectionsModelSelection[], credentialId?: string): Promise<void>;
}

/**
 * A durable model reference selected by an applet.
 *
 * `id` stays the upstream/public model id. `resourceId` is the canonical Pod
 * resource when one exists; `offeringId` disambiguates identical upstream ids
 * exposed by different commercial offerings.
 */
export interface AiConnectionsModelSelection {
  id: string;
  offeringId?: string;
  resourceId?: string;
}

export interface AiConnectionsOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  scope?: string;
  idToken?: string;
  accountSubject?: string;
  accountId?: string;
  accountLabel?: string;
  offeringId?: string;
  authorizationMethodId?: string;
  expectedVersion?: number;
}

export type WebExtensionSolidPodStatus =
  | 'unavailable'
  | 'opening'
  | 'ready'
  | 'error';

export type WebExtensionSolidSession = Readonly<Pick<
  SolidSessionRuntime,
  'fetch' | 'getSnapshot' | 'subscribe'
>>;

export type WebExtensionSolidPod<Database = unknown> =
  | {
    readonly status: 'unavailable';
  }
  | {
    readonly status: 'opening';
  }
  | {
    readonly status: 'ready';
    readonly current: OpenPodRuntime<Database>;
  }
  | {
    readonly status: 'error';
    readonly error: Error;
  };

export interface SolidAgentAccess {
  read?: boolean;
  append?: boolean;
  write?: boolean;
}

export interface SolidServiceAccessResource {
  id: string;
  url: string;
  mediaType: 'text/turtle';
  access: SolidAgentAccess;
}

export interface SolidServiceAccessRequest {
  appletId: string;
  service: { webId: string; label: string };
  resources: SolidServiceAccessResource[];
}

export interface SolidServiceAccessStatus {
  status: 'granted' | 'missing' | 'permissionDenied' | 'capabilityUnavailable';
  resources: SolidServiceAccessResource[];
  message?: string;
}

export interface SolidPermissionCapability {
  inspectAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
  ensureAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
  revokeAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
}

export interface WebExtensionSolidCapability<Database = unknown> {
  readonly session: WebExtensionSolidSession;
  readonly pod?: WebExtensionSolidPod<Database>;
  readonly permissions?: SolidPermissionCapability;
  requireLogin(): Promise<void>;
}

export interface WebExtensionNavigationCapability {
  openExternal(url: string): Promise<void>;
}

export interface WebExtensionHostCapabilities {
  aiClientConfiguration?: AiClientConfigurationCapability;
  aiConnectionsPodStore?: AiConnectionsPodStore;
  /** Account-owned credentials; the applet never receives the Account session token. */
  aiClientCredentials?: AiClientCredentialsCapability;
  /** Live updates for the Pod documents an applet is rendering. */
  solidNotifications?: SolidNotificationsCapability;
  /** Live Pod table collections; the applet declares the table, the host owns the I/O. */
  podCollections?: PodCollectionsCapability;
}

/**
 * Whether live Pod updates are reaching this page.
 *
 * `idle` covers "nothing is being watched", "still opening a channel" and
 * "paused because the tab is hidden"; `live` means at least one watched
 * document has an open channel; `unavailable` means live updates could not be
 * established at all, so the page must keep working from explicit reads only.
 */
export type SolidLiveUpdateState = 'idle' | 'live' | 'unavailable';

/**
 * One dirty signal from a watched Pod table document.
 *
 * It carries delivery metadata only - never table data, and never an opinion
 * about what the consumer should do with it. Conflict resolution, rollback,
 * pending/confirmed row state and "server wins" reconciliation belong to the
 * table consumer; this transport neither mutates nor interprets rows.
 *
 * A consumer that needs to tell a foreign change from the echo of its own write
 * must correlate `receivedAt` with the write windows it tracks itself: applet
 * writes do not travel through the notification channel, so the transport
 * cannot know whether a local write was in flight and does not guess.
 */
export interface SolidLiveUpdateSignal {
  /** The watched table document that changed. */
  topic: string;
  /** Per-topic delivery counter, starting at 1 and strictly increasing. */
  sequence: number;
  /** When this client received the signal, in epoch milliseconds. */
  receivedAt: number;
}

/**
 * Live updates for Pod table documents (Solid Notifications, WebSocketChannel2023).
 *
 * A table is one RDF document and that document is the topic; rows inside it are
 * never separate subscriptions. A signal only says "this document changed", so
 * the consumer re-reads through its own read path and coalesces bursts.
 */
export interface SolidNotificationsCapability {
  /**
   * Watch one table document.
   *
   * Listeners of the same topic share a single channel and a single socket; the
   * returned function detaches this listener, and detaching the last one closes
   * the socket and deletes the subscription. Watching a row IRI watches the
   * document that holds the row.
   *
   * We are given a plain resource URL: which documents a page watches is the
   * caller's decision, and no schema flag or registry declares it.
   */
  watch(topicUrl: string, listener: (signal: SolidLiveUpdateSignal) => void): () => void;
  /** Current state, for a status affordance that stays out of the way. */
  getState(): SolidLiveUpdateState;
  /** Observe {@link SolidNotificationsCapability.getState}. */
  subscribeState(listener: (state: SolidLiveUpdateState) => void): () => void;
  /** Drops every subscription; called when the page that wanted them goes away. */
  dispose(): void;
}

/**
 * The declaration an applet hands to {@link PodCollectionsCapability.define}.
 *
 * Everything schema-shaped comes from the table's models descriptor and its
 * drizzle table; the host fills in the I/O wiring (database, Pod URL, change
 * feed), so an applet never names a document, a predicate or a refetch policy.
 */
export type PodCollectionHostRequest<D extends PodModelDescriptor> =
  Omit<PodCollectionOptions<D>, 'database' | 'podUrl' | 'feed'>;

/**
 * Live Pod table collections (`docs/pod-collections.md` §6.4).
 *
 * A table is declared once, by the applet that renders it, and the host turns
 * that declaration into a live collection: reads land in the collection's own
 * view of the table, writes are optimistic and roll back on rejection, and the
 * host's change feed - the same notification primitive that drives
 * {@link SolidNotificationsCapability} - refreshes it. No polling is installed.
 */
export interface PodCollectionsCapability {
  /**
   * The collection for one table, loading whatever the host needs first.
   *
   * This is the accessor a page should use. A host may keep the collection
   * engine out of the page's initial bundle and fetch it on first use, so the
   * only honest answer to "give me this table" is a promise: a host whose engine
   * is already in memory answers on the next microtask, a deferring host answers
   * once the engine is there.
   *
   * Optional so that an eager host - one whose engine is unconditionally loaded -
   * needs nothing beyond {@link define}: a page falls back to `define` when this
   * is absent.
   */
  load?<D extends PodModelDescriptor>(
    descriptor: D,
    request: PodCollectionHostRequest<D>,
  ): Promise<PodCollection<RowOf<D>>>;
  /**
   * The collection for one table.
   *
   * One `(descriptor.uri, document)` pair is one collection: defining the same
   * table twice returns the same instance, so two pages of one applet share one
   * sync engine and one subscription instead of racing two.
   *
   * A table whose document the descriptor cannot derive throws
   * `layout_document_required`; the caller passes `document`/`scope` explicitly
   * rather than guessing a layout.
   *
   * This call is synchronous by contract, so a host that defers its engine (see
   * {@link load}) cannot answer it before that engine has arrived: such a host
   * reports the reservation instead of inventing a collection.
   */
  define<D extends PodModelDescriptor>(
    descriptor: D,
    request: PodCollectionHostRequest<D>,
  ): PodCollection<RowOf<D>>;
  /**
   * How the collection is keeping up: `live` when its change feed is
   * established, `unavailable` when it is read-once-plus-explicit-refresh,
   * `degraded` after a failed read. This is the availability signal a page
   * shows, in place of the transport's own state.
   */
  syncState<R extends { id: string }>(collection: PodCollection<R>): PodSyncState;
  /** Observe every collection's {@link PodCollectionsCapability.syncState}. */
  subscribeSyncState(listener: () => void): () => void;
  /** Releases every collection this capability created (session teardown). */
  dispose(): void;
}

export interface AiClientCredentialSummary {
  /** CSS label, i.e. the `client_id` inside the `sk-` wrapper. */
  clientId: string
  label?: string
  webId?: string
  /** Account resource used to destroy the credential. */
  resource: string
}

export interface AiClientCredentialsCapability {
  create(input: { name: string; webId: string }): Promise<{ apiKey: string; resource: string }>;
  /** Credentials the Account still knows about; the secret is never returned. */
  list(): Promise<AiClientCredentialSummary[]>;
  revoke(input: { clientId: string; resource: string; webId: string }): Promise<void>;
}

export interface WebExtensionHost<Database = unknown> {
  readonly solid: WebExtensionSolidCapability<Database>;
  readonly navigation: WebExtensionNavigationCapability;
  readonly capabilities: WebExtensionHostCapabilities;
}

export interface AppletSlotProps<TController, Database = unknown> {
  controller: TController;
  host: WebExtensionHost<Database>;
}

export type AppletSlot<TController, Database = unknown> =
  {
    bivarianceHack(props: AppletSlotProps<TController, Database>): ReactElement;
  }['bivarianceHack'];

export interface AppletLifecycle<TController, Database = unknown> {
  createController(host: WebExtensionHost<Database>): TController;
  activate?(
    controller: TController,
    host: WebExtensionHost<Database>,
  ): void | (() => void);
}

export interface TwoPaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'two-pane' };
  slots: TwoPaneAppletSlots<TController, Database>;
}

export interface DescriptorTwoPaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'two-pane' };
  layout: {
    descriptor: TwoPaneAppletLayoutDescriptor;
    slots: TwoPaneAppletSlots<TController, Database>;
  };
}

export interface DescriptorSinglePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'single-pane' };
  layout: {
    descriptor: SinglePaneAppletLayoutDescriptor;
    render: AppletSlot<TController, Database>;
  };
}

export interface DescriptorThreePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: Omit<AppletManifest, 'layout'> & { layout: 'three-pane' };
  layout: {
    descriptor: ThreePaneAppletLayoutDescriptor;
    slots: ThreePaneAppletSlots<TController, Database>;
  };
}

export type TwoPaneAppletSlots<TController, Database = unknown> = {
  listHeader: AppletSlot<TController, Database>;
  list: AppletSlot<TController, Database>;
  mainHeader: AppletSlot<TController, Database>;
  main: AppletSlot<TController, Database>;
};

export type ThreePaneAppletSlots<TController, Database = unknown> =
  TwoPaneAppletSlots<TController, Database> & {
    context: AppletSlot<TController, Database>;
  };

export interface MountedTwoPaneApplet<TController> {
  layout: 'two-pane';
  controller: TController;
  slots: {
    listHeader: ReactElement;
    list: ReactElement;
    mainHeader: ReactElement;
    main: ReactElement;
  };
}

export interface MountedSinglePaneApplet<TController> {
  layout: 'single-pane';
  controller: TController;
  element: ReactElement;
}

export interface MountedThreePaneApplet<TController> {
  layout: 'three-pane';
  controller: TController;
  contextConfig?: ThreePaneAppletLayoutDescriptor['context'];
  slots: {
    listHeader: ReactElement;
    list: ReactElement;
    mainHeader: ReactElement;
    main: ReactElement;
    context: ReactElement;
  };
}

export type MountedApplet<TController = unknown> =
  | MountedTwoPaneApplet<TController>
  | MountedSinglePaneApplet<TController>
  | MountedThreePaneApplet<TController>;

export function defineApplet<TController, Database = unknown>(
  applet: TwoPaneAppletModule<TController, Database>,
): TwoPaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: SinglePaneAppletModule<TController, Database>,
): SinglePaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorTwoPaneAppletModule<TController, Database>,
): DescriptorTwoPaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorSinglePaneAppletModule<TController, Database>,
): DescriptorSinglePaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorThreePaneAppletModule<TController, Database>,
): DescriptorThreePaneAppletModule<TController, Database>;

export function defineApplet(
  applet: AppletModule,
): AppletModule {
  return applet;
}

export function mountTwoPaneApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): Omit<MountedTwoPaneApplet<TController>, 'layout'>['slots'] & { controller: TController } {
  const mounted = mountResolvedApplet(applet, host);
  if (mounted.layout !== 'two-pane') {
    throw new Error(`Applet manifest declares ${applet.manifest.layout} but no two-pane slots were provided`);
  }

  return {
    controller: mounted.controller,
    listHeader: mounted.slots.listHeader,
    list: mounted.slots.list,
    mainHeader: mounted.slots.mainHeader,
    main: mounted.slots.main,
  };
}

export interface SinglePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'single-pane' };
  render: AppletSlot<TController, Database>;
}

export type AppletModule<Database = unknown> =
  | SinglePaneAppletModule<unknown, Database>
  | TwoPaneAppletModule<unknown, Database>
  | DescriptorSinglePaneAppletModule<unknown, Database>
  | DescriptorTwoPaneAppletModule<unknown, Database>
  | DescriptorThreePaneAppletModule<unknown, Database>;

export type WebExtensionAppletManifest =
  Omit<AppletManifest, 'layout'> & { layout: AppletLayoutType };

export interface WebExtensionManifest extends Omit<ExtensionManifest, 'contributes'> {
  contributes: Omit<ExtensionManifest['contributes'], 'applets'> & {
    applets: WebExtensionAppletManifest[];
  };
}

export function mountApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedTwoPaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedSinglePaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet: DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedThreePaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedApplet<TController>;

export function mountApplet(
  applet: AppletModule,
  host: WebExtensionHost,
): MountedApplet {
  return mountResolvedApplet(applet, host);
}

function mountResolvedApplet<TController, Database>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedApplet<TController> {
  const layout = resolveAppletLayout(applet);
  const controller = applet.createController(host);

  if (layout.type === 'single-pane') {
    return {
      layout: 'single-pane',
      controller,
      element: createElement(layout.render, { controller, host }),
    };
  }

  if (layout.type === 'two-pane') {
    return {
      layout: 'two-pane',
      controller,
      slots: {
        listHeader: createElement(layout.slots.listHeader, { controller, host }),
        list: createElement(layout.slots.list, { controller, host }),
        mainHeader: createElement(layout.slots.mainHeader, { controller, host }),
        main: createElement(layout.slots.main, { controller, host }),
      },
    };
  }

  return {
    layout: 'three-pane',
    controller,
    contextConfig: layout.contextConfig,
    slots: {
      listHeader: createElement(layout.slots.listHeader, { controller, host }),
      list: createElement(layout.slots.list, { controller, host }),
      mainHeader: createElement(layout.slots.mainHeader, { controller, host }),
      main: createElement(layout.slots.main, { controller, host }),
      context: createElement(layout.slots.context, { controller, host }),
    },
  };
}

type ResolvedAppletLayout<TController, Database> =
  | {
    type: 'single-pane';
    render: AppletSlot<TController, Database>;
  }
  | {
    type: 'two-pane';
    slots: TwoPaneAppletSlots<TController, Database>;
  }
  | {
    type: 'three-pane';
    contextConfig?: ThreePaneAppletLayoutDescriptor['context'];
    slots: ThreePaneAppletSlots<TController, Database>;
  };

function resolveAppletLayout<TController, Database>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
): ResolvedAppletLayout<TController, Database> {
  if ('layout' in applet) {
    const descriptorLayout = requireDescriptorLayout(applet.layout);
    const descriptor = validateRawAppletLayout(descriptorLayout.descriptor);
    const descriptorType = descriptor.type;
    if (applet.manifest.layout !== descriptorType) {
      throw new Error(
        `Applet manifest layout ${applet.manifest.layout} does not match descriptor layout ${descriptorType}`,
      );
    }

    if (descriptorType === 'single-pane') {
      if (!('render' in descriptorLayout)) {
        throw new Error('Applet descriptor single-pane render must be a function');
      }
      assertSlotFunction(descriptorLayout.render, 'Applet descriptor single-pane render');
      return {
        type: 'single-pane',
        render: descriptorLayout.render as AppletSlot<TController, Database>,
      };
    }

    if (!('slots' in descriptorLayout)) {
      throw new Error(`Applet descriptor declares ${descriptorType} but no slots were provided`);
    }

    if (descriptorType === 'two-pane') {
      assertTwoPaneSlots(descriptorLayout.slots, 'Applet descriptor two-pane');
      return {
        type: 'two-pane',
        slots: descriptorLayout.slots as TwoPaneAppletSlots<TController, Database>,
      };
    }

    assertThreePaneSlots(descriptorLayout.slots, 'Applet descriptor three-pane');

    return {
      type: 'three-pane',
      contextConfig: descriptor.context,
      slots: descriptorLayout.slots as ThreePaneAppletSlots<TController, Database>,
    };
  }

  if (applet.manifest.layout === 'single-pane') {
    if (!('render' in applet)) {
      throw new Error('Applet manifest declares single-pane but no single-pane renderer was provided');
    }
    assertSlotFunction(applet.render, 'Applet single-pane render');
    return {
      type: 'single-pane',
      render: applet.render,
    };
  }

  if (applet.manifest.layout === 'two-pane' && 'slots' in applet) {
    assertTwoPaneSlots(applet.slots, 'Applet two-pane');
    return {
      type: 'two-pane',
      slots: applet.slots,
    };
  }

  throw new Error(`Applet manifest declares ${applet.manifest.layout} but no supported applet layout was provided`);
}

function assertTwoPaneSlots<TController, Database>(
  slots: unknown,
  label: string,
): asserts slots is TwoPaneAppletSlots<TController, Database> {
  assertSlotContainer(slots, label);
  assertSlotFunction(slots.listHeader, `${label} slot listHeader`);
  assertSlotFunction(slots.list, `${label} slot list`);
  assertSlotFunction(slots.mainHeader, `${label} slot mainHeader`);
  assertSlotFunction(slots.main, `${label} slot main`);
}

function assertThreePaneSlots<TController, Database>(
  slots: unknown,
  label: string,
): asserts slots is ThreePaneAppletSlots<TController, Database> {
  assertTwoPaneSlots(slots, label);
  assertSlotFunction((slots as Record<string, unknown>).context, `${label} slot context`);
}

function assertSlotContainer(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} slots must be an object`);
  }
}

function assertSlotFunction(
  value: unknown,
  label: string,
): asserts value is AppletSlot<unknown> {
  if (typeof value !== 'function') {
    throw new Error(`${label} must be a function`);
  }
}

function requireDescriptorLayout(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Applet descriptor layout must be an object');
  }
  if (!('descriptor' in value) || value.descriptor === undefined) {
    throw new Error('Applet descriptor required');
  }
  return value;
}

export interface WebExtensionModule<Database = unknown> {
  manifest: WebExtensionManifest;
  applets: Record<string, AppletModule<Database>>;
}

export { createSolidPermissionCapability } from './solid-permissions';
export type { SolidPermissionCapabilityOptions } from './solid-permissions';

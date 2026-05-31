import './runtime/configure-drizzle-solid';
import { RepresentationPartialConvertingStore } from './storage/RepresentationPartialConvertingStore';
import { MinioDataAccessor } from './storage/accessors/MinioDataAccessor';
import { QuadstoreSparqlDataAccessor } from './storage/accessors/QuadstoreSparqlDataAccessor';
import { QuintStoreSparqlDataAccessor } from './storage/accessors/QuintStoreSparqlDataAccessor';
import { SolidRdfDataAccessor } from './storage/accessors/SolidRdfDataAccessor';
import { MixDataAccessor } from './storage/accessors/MixDataAccessor';
import { ConfigurableLoggerFactory } from './logging/ConfigurableLoggerFactory';
import { SubgraphQueryEngine } from './storage/sparql/SubgraphQueryEngine';
import { QuadstoreSparqlEngine, QuintstoreSparqlEngine } from './storage/sparql/CompatibilitySparqlEngine';
export type { SparqlEngine } from './storage/sparql/SubgraphQueryEngine';
export type {
  RdfEngineLike,
  RdfEngineStorageStats,
  RdfDerivedIndexRefreshResult,
  RdfIndexStats,
  RdfIndexSpaceObject,
  RdfIndexMetrics,
  RdfIndexPutOptions,
  RdfPatternQuery,
  RdfQuadIndexOptions,
  RdfQuadIndexScanResult,
  RdfShadowBackfillOptions,
  RdfShadowBackfillResult,
  RdfShadowDiff,
  RdfShadowScanResult,
  RdfSourceInput,
} from './storage/rdf/types';
export type { RdfSparqlCompileResult } from './storage/rdf/RdfSparqlAdapter';
export type { ShadowRdfQuintStoreOptions } from './storage/rdf/ShadowRdfQuintStore';
export type {
  SolidRdfSparqlEngineOptions,
  SolidRdfSparqlFallback,
} from './storage/rdf/SolidRdfSparqlEngine';
export type { PostgresRdfEngineOptions } from './storage/rdf/PostgresRdfEngine';
import { SubgraphSparqlHttpHandler } from './http/SubgraphSparqlHttpHandler';
import { QuotaAdminHttpHandler } from './http/quota/QuotaAdminHttpHandler';
import { SparqlUpdateResourceStore } from './storage/SparqlUpdateResourceStore';
import { ClusterIngressRouter } from './http/ClusterIngressRouter';
import { ClusterWebSocketConfigurator } from './http/ClusterWebSocketConfigurator';
import { EdgeNodeDirectDebugHttpHandler } from './http/EdgeNodeDirectDebugHttpHandler';
import { EdgeNodeProxyHttpHandler } from './http/EdgeNodeProxyHttpHandler';
import { RouterHttpHandler } from './http/RouterHttpHandler';
import { RouterHttpRoute } from './http/RouterHttpRoute';
import { TracingHandler } from './http/TracingHandler';
import { TerminalHttpHandler } from './http/terminal/TerminalHttpHandler';
import { EdgeNodeCertificateHttpHandler } from './http/admin/EdgeNodeCertificateHttpHandler';
import { ReservedSuffixIdentifierGenerator } from './pods/ReservedSuffixIdentifierGenerator';
import { DrizzleIndexedStorage } from './identity/drizzle/DrizzleIndexedStorage';
import { ValidatingIdentityProviderHttpHandler } from './identity/ValidatingIdentityProviderHttpHandler';
import { PostgresKeyValueStorage } from './storage/keyvalue/PostgresKeyValueStorage';
import { RedisKeyValueStorage } from './storage/keyvalue/RedisKeyValueStorage';
import { SqliteKeyValueStorage } from './storage/keyvalue/SqliteKeyValueStorage';
import { BaseKeyValueStorage } from './storage/keyvalue/BaseKeyValueStorage';
import { DrizzleQuotaService } from './quota/DrizzleQuotaService';
import { NoopQuotaService } from './quota/NoopQuotaService';
import { HttpEntitlementProvider, NoopEntitlementProvider } from './quota/EntitlementProvider';
import { PerAccountQuotaStrategy } from './storage/quota/PerAccountQuotaStrategy';
import { TencentDnsProvider } from './dns/tencent/TencentDnsProvider';
import { EdgeNodeDnsCoordinator } from './edge/EdgeNodeDnsCoordinator';
import { Dns01CertificateProvisioner } from './edge/Dns01CertificateProvisioner';
import { SimpleEdgeNodeTunnelManager, NoopEdgeNodeTunnelManager } from './edge/EdgeNodeTunnelManager';
import { FrpTunnelManager } from './edge/FrpTunnelManager';
import { AcmeCertificateManager } from './edge/acme/AcmeCertificateManager';
import { EdgeNodeHealthProbeService } from './edge/EdgeNodeHealthProbeService';
import { EdgeNodeAgent } from './edge/EdgeNodeAgent';
import { EdgeNodeCertificateService } from './service/EdgeNodeCertificateService';
import { createBandwidthThrottleTransform } from './util/stream/BandwidthThrottleTransform';
import { UsageTrackingStore } from './storage/quota/UsageTrackingStore';
import { EdgeNodeModeDetector } from './edge/EdgeNodeModeDetector';
import { ClusterIdentifierStrategy } from './util/identifiers/ClusterIdentifierStrategy';
import { CenterNodeRegistrationService } from './identity/CenterNodeRegistrationService';
import { PodRoutingHttpHandler } from './http/PodRoutingHttpHandler';
import { ReactAppViewHandler } from './identity/ReactAppViewHandler';
import { SqliteQuintStore } from './storage/quint/SqliteQuintStore';
import { PgQuintStore } from './storage/quint/PgQuintStore';
import { QuintStore } from './storage/quint/types';
import { RdfQuadIndex } from './storage/rdf/RdfQuadIndex';
import { Rdf3xIndex } from './storage/rdf/Rdf3xIndex';
import { RdfSparqlAdapter } from './storage/rdf/RdfSparqlAdapter';
import { RdfTermDictionary } from './storage/rdf/RdfTermDictionary';
import { ShadowRdfQuintStore } from './storage/rdf/ShadowRdfQuintStore';
import { SolidRdfEngine } from './storage/rdf/SolidRdfEngine';
import { PostgresRdfEngine } from './storage/rdf/PostgresRdfEngine';
import { SolidRdfSparqlEngine } from './storage/rdf/SolidRdfSparqlEngine';
import type { EdgeNodeCertificateProvisioner } from './edge/EdgeNodeCertificateProvisioner';
// Vector components
import { SqliteVectorStore, PostgresVectorStore } from './storage/vector/index';
import { VectorHttpHandler } from './http/vector/VectorHttpHandler';
import { ProviderRegistry } from './ai/service/ProviderRegistry';
import { ProviderRegistryImpl } from './ai/service/ProviderRegistryImpl';
import { EmbeddingService } from './ai/service/EmbeddingService';
import { EmbeddingServiceImpl } from './ai/service/EmbeddingServiceImpl';
import { CredentialReader } from './ai/service/CredentialReader';
import { CredentialReaderImpl } from './ai/service/CredentialReaderImpl';
import { VectorStore } from './storage/vector/VectorStore';
// Tunnel and Subdomain components
import { CloudflareTunnelProvider } from './tunnel/CloudflareTunnelProvider';
import { LocalTunnelProvider } from './tunnel/LocalTunnelProvider';
import { SubdomainService } from './subdomain/SubdomainService';
import { UrlAwareRedisLocker } from './storage/locking/UrlAwareRedisLocker';
// IdP/SP separation components
import { MultiDomainIdentifierStrategy } from './util/identifiers/MultiDomainIdentifierStrategy';
import { SubdomainPodIdentifierStrategy } from './util/identifiers/SubdomainPodIdentifierStrategy';
import { DisabledOidcHandler } from './identity/oidc/DisabledOidcHandler';
import { DisabledIdentityProviderHandler } from './identity/oidc/DisabledIdentityProviderHandler';
import { AutoDetectOidcHandler } from './identity/oidc/AutoDetectOidcHandler';
import { AutoDetectIdentityProviderHandler } from './identity/oidc/AutoDetectIdentityProviderHandler';
import { LoopbackClientIdAdapterFactory } from './identity/oidc/LoopbackClientIdAdapterFactory';
import { ScopedPickWebIdHandler } from './identity/oidc/ScopedPickWebIdHandler';
// Provision components
import { ProvisionPodCreator } from './provision/ProvisionPodCreator';
import { ProvisionCodeCodec } from './provision/ProvisionCodeCodec';
import { LocalPodProvisioningService } from './provision/LocalPodProvisioningService';

export type {
  DnsProvider,
  ListDnsRecordsInput,
  ListableDnsProvider,
  DeleteDnsRecordInput,
  DnsRecordSummary,
  UpsertDnsRecordInput,
} from './dns/DnsProvider';
export type { EdgeNodeCertificateProvisioner } from './edge/EdgeNodeCertificateProvisioner';
export type { EdgeNodeTunnelManager } from './edge/interfaces/EdgeNodeTunnelManager';
export type { QuotaService, AccountQuota } from './quota/QuotaService';
export type { EntitlementProvider, AccountEntitlement } from './quota/EntitlementProvider';
// Tunnel and Subdomain types
export type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './tunnel/TunnelProvider';
export type {
  SubdomainRegistration,
  ConnectivityResult,
  SubdomainServiceOptions,
} from './subdomain/SubdomainService';
// Export the new AppStaticAssetHandler
export { AppStaticAssetHandler } from './http/AppStaticAssetHandler';

export {
  RepresentationPartialConvertingStore,
  MinioDataAccessor,
  QuadstoreSparqlDataAccessor,
  QuintStoreSparqlDataAccessor,
  SolidRdfDataAccessor,
  MixDataAccessor,
  ConfigurableLoggerFactory,
  SparqlUpdateResourceStore,
  SubgraphQueryEngine,
  QuadstoreSparqlEngine,
  QuintstoreSparqlEngine,
  SubgraphSparqlHttpHandler,
  QuotaAdminHttpHandler,
  ClusterIngressRouter,
  ClusterWebSocketConfigurator,
  EdgeNodeDirectDebugHttpHandler,
  EdgeNodeProxyHttpHandler,
  RouterHttpHandler,
  RouterHttpRoute,
  TracingHandler,
  EdgeNodeCertificateHttpHandler,
  TerminalHttpHandler,
  ReservedSuffixIdentifierGenerator,
  DrizzleIndexedStorage,
  ValidatingIdentityProviderHttpHandler,
  PostgresKeyValueStorage,
  RedisKeyValueStorage,
  SqliteKeyValueStorage,
  BaseKeyValueStorage,
  DrizzleQuotaService,
  NoopQuotaService,
  HttpEntitlementProvider,
  NoopEntitlementProvider,
  PerAccountQuotaStrategy,
  TencentDnsProvider,
  EdgeNodeDnsCoordinator,
  Dns01CertificateProvisioner,
  SimpleEdgeNodeTunnelManager,
  NoopEdgeNodeTunnelManager,
  FrpTunnelManager,
  EdgeNodeHealthProbeService,
  EdgeNodeAgent,
  EdgeNodeCertificateService,
  AcmeCertificateManager,
  EdgeNodeModeDetector,
  ClusterIdentifierStrategy,
  UsageTrackingStore,
  CenterNodeRegistrationService,
  PodRoutingHttpHandler,
  ReactAppViewHandler,
  // Quint exports
  QuintStore,
  SqliteQuintStore,
  PgQuintStore,
  // RDF engine exports
  RdfTermDictionary,
  RdfQuadIndex,
  Rdf3xIndex,
  RdfSparqlAdapter,
  ShadowRdfQuintStore,
  SolidRdfEngine,
  PostgresRdfEngine,
  SolidRdfSparqlEngine,
  // Vector exports
  VectorStore,
  SqliteVectorStore,
  PostgresVectorStore,
  VectorHttpHandler,
  // Embedding exports
  ProviderRegistry,
  ProviderRegistryImpl,
  EmbeddingService,
  EmbeddingServiceImpl,
  CredentialReader,
  CredentialReaderImpl,
  // Tunnel and Subdomain exports
  CloudflareTunnelProvider,
  LocalTunnelProvider,
  SubdomainService,
  // IdP/SP separation exports
  MultiDomainIdentifierStrategy,
  SubdomainPodIdentifierStrategy,
  DisabledOidcHandler,
  DisabledIdentityProviderHandler,
  AutoDetectOidcHandler,
  AutoDetectIdentityProviderHandler,
  LoopbackClientIdAdapterFactory,
  ScopedPickWebIdHandler,
  UrlAwareRedisLocker,
  // Provision exports
  ProvisionPodCreator,
  ProvisionCodeCodec,
  LocalPodProvisioningService,
};

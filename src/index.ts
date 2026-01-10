import { RepresentationPartialConvertingStore } from './storage/RepresentationPartialConvertingStore';
import { MinioDataAccessor } from './storage/accessors/MinioDataAccessor';
import { QuadstoreSparqlDataAccessor } from './storage/accessors/QuadstoreSparqlDataAccessor';
import { QuintStoreSparqlDataAccessor } from './storage/accessors/QuintStoreSparqlDataAccessor';
import { MixDataAccessor } from './storage/accessors/MixDataAccessor';
import { ConfigurableLoggerFactory } from './logging/ConfigurableLoggerFactory';
import { SubgraphQueryEngine, QuadstoreSparqlEngine, QuintstoreSparqlEngine } from './storage/sparql/SubgraphQueryEngine';
export type { SparqlEngine } from './storage/sparql/SubgraphQueryEngine';
import { SubgraphSparqlHttpHandler } from './http/SubgraphSparqlHttpHandler';
import { QuotaAdminHttpHandler } from './http/quota/QuotaAdminHttpHandler';
import { EdgeNodeSignalHttpHandler } from './http/admin/EdgeNodeSignalHttpHandler';
import { SparqlUpdateResourceStore } from './storage/SparqlUpdateResourceStore';
import { ClusterIngressRouter } from './http/ClusterIngressRouter';
import { ClusterWebSocketConfigurator } from './http/ClusterWebSocketConfigurator';
import { EdgeNodeDirectDebugHttpHandler } from './http/EdgeNodeDirectDebugHttpHandler';
import { EdgeNodeProxyHttpHandler } from './http/EdgeNodeProxyHttpHandler';
import { SignalInterceptHttpHandler } from './http/SignalInterceptHttpHandler';
import { RouterHttpHandler } from './http/RouterHttpHandler';
import { RouterHttpRoute } from './http/RouterHttpRoute';
import { TracingHandler } from './http/TracingHandler';
import { TerminalHttpHandler } from './http/terminal/TerminalHttpHandler';
import { EdgeNodeCertificateHttpHandler } from './http/admin/EdgeNodeCertificateHttpHandler';
import { ReservedSuffixIdentifierGenerator } from './pods/ReservedSuffixIdentifierGenerator';
import { DrizzleIndexedStorage } from './identity/drizzle/DrizzleIndexedStorage';
import { PostgresKeyValueStorage } from './storage/keyvalue/PostgresKeyValueStorage';
import { RedisKeyValueStorage } from './storage/keyvalue/RedisKeyValueStorage';
import { DefaultQuotaService } from './quota/DefaultQuotaService';
import { DrizzleQuotaService } from './quota/DrizzleQuotaService';
import { NoopQuotaService } from './quota/NoopQuotaService';
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
import { ObservableResourceStore } from './storage/ObservableResourceStore';
export type { ResourceChangeEvent, ResourceChangeListener } from './storage/ObservableResourceStore';
import { EdgeNodeModeDetector } from './edge/EdgeNodeModeDetector';
import { ClusterIdentifierStrategy } from './util/identifiers/ClusterIdentifierStrategy';
import { CenterNodeRegistrationService } from './identity/CenterNodeRegistrationService';
import { PodRoutingHttpHandler } from './http/PodRoutingHttpHandler';
import { TieredMinioDataAccessor } from './storage/accessors/TieredMinioDataAccessor';
import { PodMigrationHttpHandler } from './http/cluster/PodMigrationHttpHandler';
import { PodMigrationService } from './service/PodMigrationService';
import { ReactAppViewHandler } from './identity/ReactAppViewHandler';
import { SqliteQuintStore } from './storage/quint/SqliteQuintStore';
import { PgQuintStore } from './storage/quint/PgQuintStore';
import { BaseQuintStore } from './storage/quint/BaseQuintStore';
import type { EdgeNodeCertificateProvisioner } from './edge/EdgeNodeCertificateProvisioner';
// Vector components
import { SqliteVectorStore, PostgresVectorStore } from './storage/vector/index';
// VectorIndexingListener 已弃用，索引逻辑移至 API Server 层
// export type { VectorStoreDefinition } from './storage/vector/VectorIndexingListener';
import { VectorHttpHandler } from './http/vector/VectorHttpHandler';
import { SearchHttpHandler } from './http/search/SearchHttpHandler';
import { ProviderRegistryImpl } from './embedding/ProviderRegistryImpl';
import { EmbeddingServiceImpl } from './embedding/EmbeddingServiceImpl';
import { CredentialReaderImpl } from './embedding/CredentialReaderImpl';
export type { MigratableDataAccessor, MigrationProgress } from './storage/MigratableDataAccessor';
// Note: isMigratableAccessor is a function, not exported to avoid componentsjs-generator issues
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
export type { QuotaService } from './quota/QuotaService';
// Export the new AppStaticAssetHandler
export { AppStaticAssetHandler } from './http/AppStaticAssetHandler';

export { 
    RepresentationPartialConvertingStore,
    MinioDataAccessor, 
    QuadstoreSparqlDataAccessor,
    QuintStoreSparqlDataAccessor,
    MixDataAccessor,
    ConfigurableLoggerFactory,
    SparqlUpdateResourceStore,
    SubgraphQueryEngine,
    QuadstoreSparqlEngine,
    QuintstoreSparqlEngine,
    SubgraphSparqlHttpHandler,
    QuotaAdminHttpHandler,
    EdgeNodeSignalHttpHandler,
    ClusterIngressRouter,
    ClusterWebSocketConfigurator,
    EdgeNodeDirectDebugHttpHandler,
    EdgeNodeProxyHttpHandler,
    SignalInterceptHttpHandler,
    RouterHttpHandler,
    RouterHttpRoute,
    TracingHandler,
    EdgeNodeCertificateHttpHandler,
    TerminalHttpHandler,
    ReservedSuffixIdentifierGenerator,
    DrizzleIndexedStorage,
    PostgresKeyValueStorage,
    RedisKeyValueStorage,
  DefaultQuotaService,
  DrizzleQuotaService,
    NoopQuotaService,
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
  ObservableResourceStore,
  CenterNodeRegistrationService,
  PodRoutingHttpHandler,
  TieredMinioDataAccessor,
  PodMigrationHttpHandler,
  PodMigrationService,
  ReactAppViewHandler,
  SqliteQuintStore,
  PgQuintStore,
  BaseQuintStore,
  // Vector exports
  SqliteVectorStore,
  PostgresVectorStore,
  // VectorIndexingListener - 已弃用
  VectorHttpHandler,
  SearchHttpHandler,
  ProviderRegistryImpl,
  EmbeddingServiceImpl,
  CredentialReaderImpl,
};

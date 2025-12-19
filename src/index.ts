import { RepresentationPartialConvertingStore } from './storage/RepresentationPartialConvertingStore';
import { LockingResourceStore } from './storage/LockingResourceStore';
import { MinioDataAccessor } from './storage/accessors/MinioDataAccessor';
import { QuadstoreSparqlDataAccessor } from './storage/accessors/QuadstoreSparqlDataAccessor';
import { MixDataAccessor } from './storage/accessors/MixDataAccessor';
import { ConfigurableLoggerFactory } from './logging/ConfigurableLoggerFactory';
import { DebugRedisLocker } from './util/locking/DebugRedisLocker';
import { SubgraphQueryEngine } from './storage/sparql/SubgraphQueryEngine';
import { SubgraphSparqlHttpHandler } from './http/SubgraphSparqlHttpHandler';
import { QuotaAdminHttpHandler } from './http/quota/QuotaAdminHttpHandler';
import { EdgeNodeSignalHttpHandler } from './http/admin/EdgeNodeSignalHttpHandler';
import { SparqlUpdateResourceStore } from './storage/SparqlUpdateResourceStore';
import { ClusterIngressRouter } from './http/ClusterIngressRouter';
import { ClusterWebSocketConfigurator } from './http/ClusterWebSocketConfigurator';
import { EdgeNodeDirectDebugHttpHandler } from './http/EdgeNodeDirectDebugHttpHandler';
import { EdgeNodeProxyHttpHandler } from './http/EdgeNodeProxyHttpHandler';
import { SignalInterceptHttpHandler } from './http/SignalInterceptHttpHandler';
import { RequestIdHttpHandler } from './http/RequestIdHttpHandler';
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
import { EdgeNodeModeDetector } from './edge/EdgeNodeModeDetector';
import { ClusterIdentifierStrategy } from './util/identifiers/ClusterIdentifierStrategy';
import { CenterNodeRegistrationService } from './identity/CenterNodeRegistrationService';
import { PodRoutingHttpHandler } from './http/PodRoutingHttpHandler';
import { TieredMinioDataAccessor } from './storage/accessors/TieredMinioDataAccessor';
import { PodMigrationHttpHandler } from './http/cluster/PodMigrationHttpHandler';
import { PodMigrationService } from './service/PodMigrationService';
import { ReactAppViewHandler } from './identity/ReactAppViewHandler';
import type { EdgeNodeCertificateProvisioner } from './edge/EdgeNodeCertificateProvisioner';
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
    MixDataAccessor,
    ConfigurableLoggerFactory,
    LockingResourceStore,
    DebugRedisLocker,
    SparqlUpdateResourceStore,
    SubgraphQueryEngine,
    SubgraphSparqlHttpHandler,
    QuotaAdminHttpHandler,
    EdgeNodeSignalHttpHandler,
    ClusterIngressRouter,
    ClusterWebSocketConfigurator,
    EdgeNodeDirectDebugHttpHandler,
    EdgeNodeProxyHttpHandler,
    SignalInterceptHttpHandler,
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
  CenterNodeRegistrationService,
  PodRoutingHttpHandler,
  TieredMinioDataAccessor,
  PodMigrationHttpHandler,
  PodMigrationService,
  ReactAppViewHandler,
};
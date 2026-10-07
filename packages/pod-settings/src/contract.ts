/** Host-provided view data. Persistence and authentication belong to the host adapter. */
export type PodSection = 'models' | 'search' | 'apps' | 'data';
export interface PodModel { ref: string; label: string; capabilities: string[]; source: 'platform' | 'own' }
export interface PodModelRow {
  id: string; group: string; label: string; value?: string; defaultLabel: string; models?: PodModel[];
  supported?: boolean;
  status?: 'loading' | 'available' | 'empty' | 'unauthorized' | 'error' | 'unavailable';
  testable?: boolean;
  /** Test a published Gateway model without saving a Pod override. */
  testValue?: string;
}
export interface PodToggle { id: string; label: string; checked: boolean; description?: string }
export interface PodJob { id: string; label: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; progress?: number }
export interface PodBodyProps {
  section: PodSection;
  busy?: boolean;
  error?: string;
  models: PodModelRow[];
  embeddingLabel: string;
  embeddingModels: PodModel[];
  embeddingValue?: string;
  canChangeEmbedding: boolean;
  search: PodToggle[];
  maintenance: PodToggle[];
  pending?: number;
  version?: string;
  jobs: PodJob[];
  rebuildTargets: Array<'all' | 'fts' | 'vector'>;
  backgroundAccess: { granted: boolean; loading?: boolean; busy?: boolean; error?: string };
  usage: Array<{ label: string; value: string }>;
  freeQuotaUrl?: string;
  accountUrl?: string;
  onSection(section: PodSection): void;
  onModel(id: string, value: string): Promise<void>;
  onTest(id: string, value: string): Promise<void>;
  onToggle(id: string, checked: boolean): Promise<void>;
  onEmbedding(value: string): Promise<void>;
  onRebuild(target: 'all' | 'fts' | 'vector'): Promise<void>;
  onGrant(): Promise<void>;
  onRevoke(): Promise<void>;
}

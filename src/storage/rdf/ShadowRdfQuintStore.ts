import type { Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import type { AsyncIterator } from 'asynciterator';
import type {
  AttributeMap,
  CompoundPattern,
  CompoundResult,
  QueryOptions,
  Quint,
  QuintPattern,
  QuintStore,
  StoreStats,
} from '../quint/types';
import { RdfQuadIndex } from './RdfQuadIndex';
import { RdfShadowComparator } from './RdfShadowComparator';
import type {
  RdfQuadIndexOptions,
  RdfSourceInput,
  RdfShadowAutoBackfillOptions,
  RdfShadowBackfillOptions,
  RdfShadowBackfillResult,
  RdfShadowScanResult,
} from './types';

export interface ShadowRdfQuintStoreOptions {
  compatibilityStore: QuintStore;
  index: RdfQuadIndex | RdfQuadIndexOptions;
  autoOpen?: boolean;
  autoBackfill?: boolean | RdfShadowAutoBackfillOptions;
}

/**
 * Shadow-first bridge from the existing TEXT QuintStore to the term-id RDF index.
 *
 * Reads keep using the compatibility store. Writes are mirrored into
 * RdfQuadIndex so callers can run explicit shadow comparisons before any query
 * path is switched to SolidRdfEngine.
 */
export class ShadowRdfQuintStore implements QuintStore {
  public readonly index: RdfQuadIndex;
  private readonly compatibilityStore: QuintStore;
  private readonly ownsIndex: boolean;
  private readonly comparator: RdfShadowComparator;
  private readonly autoBackfill?: boolean | RdfShadowAutoBackfillOptions;
  private opened = false;
  private opening: Promise<void> | null = null;
  private autoBackfilled = false;

  public constructor(options: ShadowRdfQuintStoreOptions) {
    this.compatibilityStore = options.compatibilityStore;
    this.autoBackfill = options.autoBackfill;
    if (options.index instanceof RdfQuadIndex) {
      this.index = options.index;
      this.ownsIndex = false;
    } else {
      this.index = new RdfQuadIndex(options.index);
      this.ownsIndex = true;
    }
    this.comparator = new RdfShadowComparator(this.index, this.compatibilityStore);
    if (options.autoOpen) {
      void this.open();
    }
  }

  public async open(): Promise<void> {
    if (this.opened) {
      return;
    }

    this.opening ??= this.openOnce().finally(() => {
      this.opening = null;
    });

    await this.opening;
  }

  private async openOnce(): Promise<void> {
    await this.compatibilityStore.open();
    this.index.open();
    this.opened = true;
    await this.runAutoBackfill();
  }

  public async close(): Promise<void> {
    if (this.opening) {
      await this.opening.catch(() => {});
    }
    await this.compatibilityStore.close();
    if (this.ownsIndex) {
      this.index.close();
    }
    this.opened = false;
    this.autoBackfilled = false;
  }

  public async get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]> {
    return this.compatibilityStore.get(pattern, options);
  }

  public match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): AsyncIterator<Quint> {
    return this.compatibilityStore.match(subject, predicate, object, graph);
  }

  public async getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]> {
    return this.compatibilityStore.getByGraphPrefix(prefix, options);
  }

  public async count(pattern: QuintPattern): Promise<number> {
    return this.compatibilityStore.count(pattern);
  }

  public async getCompound(compound: CompoundPattern, options?: QueryOptions): Promise<CompoundResult[]> {
    const getCompound = this.compatibilityStore.getCompound?.bind(this.compatibilityStore);
    if (!getCompound) {
      throw new Error('Compatibility QuintStore does not support compound queries');
    }
    return getCompound(compound, options);
  }

  public async getAttributes(
    subjects: string[],
    predicates: string[],
    graph?: Term,
  ): Promise<AttributeMap> {
    const getAttributes = this.compatibilityStore.getAttributes?.bind(this.compatibilityStore);
    if (!getAttributes) {
      throw new Error('Compatibility QuintStore does not support attribute queries');
    }
    return getAttributes(subjects, predicates, graph);
  }

  public async put(quint: Quint): Promise<void> {
    await this.compatibilityStore.put(quint);
    this.index.put(quint);
  }

  public async multiPut(quints: Quint[]): Promise<void> {
    await this.compatibilityStore.multiPut(quints);
    this.index.multiPut(quints);
  }

  public async replaceSource(quints: Quint[], source: RdfSourceInput): Promise<void> {
    await this.compatibilityStore.del({ graph: DataFactory.namedNode(source.source) });
    if (quints.length > 0) {
      await this.compatibilityStore.multiPut(quints);
    }
    this.index.replaceSource(quints, source);
  }

  public async deleteSource(source: string): Promise<number> {
    const deleted = await this.compatibilityStore.del({ graph: DataFactory.namedNode(source) });
    this.index.deleteSource(source);
    return deleted;
  }

  public async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    return this.compatibilityStore.updateEmbedding(pattern, embedding);
  }

  public async del(pattern: QuintPattern): Promise<number> {
    const deleted = await this.compatibilityStore.del(pattern);
    this.index.delete(pattern);
    return deleted;
  }

  public async multiDel(quints: Quint[]): Promise<void> {
    await this.compatibilityStore.multiDel(quints);
    for (const quint of quints) {
      this.index.delete({
        graph: quint.graph,
        subject: quint.subject,
        predicate: quint.predicate,
        object: quint.object,
      });
    }
  }

  public async stats(): Promise<StoreStats> {
    return this.compatibilityStore.stats();
  }

  public async clear(): Promise<void> {
    await this.compatibilityStore.clear();
    this.index.clear();
  }

  /**
   * Rebuild the term-id shadow index from the existing TEXT QuintStore.
   *
   * This is intentionally explicit: reads still use the compatibility store,
   * and callers decide when it is acceptable to clear/rebuild the shadow index.
   */
  public async backfillShadowIndex(options: RdfShadowBackfillOptions = {}): Promise<RdfShadowBackfillResult> {
    await this.open();

    const start = Date.now();
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1000));
    if (options.clear) {
      this.index.clear();
    }

    let scannedRows = 0;
    let indexedRows = 0;
    let batchCount = 0;

    while (true) {
      const batch = await this.compatibilityStore.get({}, {
        order: ['graph', 'subject', 'predicate', 'object'],
        limit: batchSize,
        offset: scannedRows,
      });
      if (batch.length === 0) {
        break;
      }

      scannedRows += batch.length;
      batchCount += 1;
      this.index.multiPut(batch);
      indexedRows += batch.length;

      if (batch.length < batchSize) {
        break;
      }
    }

    return {
      scannedRows,
      indexedRows,
      batchCount,
      durationMs: Date.now() - start,
    };
  }

  public async shadowGet(pattern: QuintPattern, options?: QueryOptions): Promise<RdfShadowScanResult> {
    return this.comparator.compareScan({ pattern, options });
  }

  private async runAutoBackfill(): Promise<void> {
    if (this.autoBackfilled || !this.shouldAutoBackfill()) {
      return;
    }
    this.autoBackfilled = true;
    await this.backfillShadowIndex(this.autoBackfillOptions());
  }

  private shouldAutoBackfill(): boolean {
    if (this.autoBackfill === true) {
      return true;
    }
    if (typeof this.autoBackfill === 'object') {
      return this.autoBackfill.enabled !== false;
    }
    return false;
  }

  private autoBackfillOptions(): RdfShadowBackfillOptions {
    if (typeof this.autoBackfill !== 'object') {
      return {};
    }
    return {
      clear: this.autoBackfill.clear,
      batchSize: this.autoBackfill.batchSize,
    };
  }
}

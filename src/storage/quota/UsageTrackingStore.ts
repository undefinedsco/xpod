import { Transform, Readable } from 'node:stream';
import {
  PassthroughStore,
  guardStream,
} from '@solid/community-server';
import type {
  ChangeMap,
  Representation,
  RepresentationPreferences,
  ResourceIdentifier,
  Conditions,
  ResourceStore,
} from '@solid/community-server';
import type { Quad, Term, Literal } from '@rdfjs/types';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { UsageRepository } from './UsageRepository';
import { createBandwidthThrottleTransform } from '../../util/stream/BandwidthThrottleTransform';

interface UsageTrackingStoreOptions {
  identityDbUrl?: string;
  defaultAccountBandwidthLimitBps?: number | null;
}

type UsageContext = {
  accountId: string;
  podId: string;
};

export class UsageTrackingStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  private readonly usageRepo?: UsageRepository;
  private readonly podLookup?: PodLookupRepository;
  private readonly defaultBandwidthLimit?: number | null;
  private static readonly XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  public constructor(source: T, options: UsageTrackingStoreOptions) {
    super(source);
    this.defaultBandwidthLimit = this.normalizeLimit(options.defaultAccountBandwidthLimitBps);
    if (options.identityDbUrl) {
      const db = getIdentityDatabase(options.identityDbUrl);
      this.podLookup = new PodLookupRepository(db);
      this.usageRepo = new UsageRepository(db);
    }
  }

  public override async addResource(container: ResourceIdentifier, representation: Representation, conditions?: Conditions): Promise<ChangeMap> {
    const context = await this.resolveContext(container);
    const previousSize = context ? await this.getExistingSize(container) : 0;
    const limit = context ? await this.resolveBandwidthLimit(context) : undefined;
    const { wrapped, sizePromise } = this.measureRepresentation(representation, limit);
    const change = await super.addResource(container, wrapped, conditions);
    const newSize = await sizePromise;
    await this.applyStorageUpdate(context, previousSize, newSize);
    await this.recordBandwidth(context, newSize, 0);
    return change;
  }

  public override async setRepresentation(identifier: ResourceIdentifier, representation: Representation, conditions?: Conditions): Promise<ChangeMap> {
    const context = await this.resolveContext(identifier);
    const previousSize = context ? await this.getExistingSize(identifier) : 0;
    const limit = context ? await this.resolveBandwidthLimit(context) : undefined;
    const { wrapped, sizePromise } = this.measureRepresentation(representation, limit);
    const change = await super.setRepresentation(identifier, wrapped, conditions);
    const newSize = await sizePromise;
    await this.applyStorageUpdate(context, previousSize, newSize);
    await this.recordBandwidth(context, newSize, 0);
    return change;
  }

  public override async getRepresentation(identifier: ResourceIdentifier, preferences: RepresentationPreferences, conditions?: Conditions): Promise<Representation> {
    const representation = await super.getRepresentation(identifier, preferences, conditions);
    const context = await this.resolveContext(identifier);
    if (!context || !representation?.data) {
      return representation;
    }
    const limit = await this.resolveBandwidthLimit(context);
    const { wrapped, sizePromise } = this.measureRepresentation(representation, limit);
    void sizePromise
      .then((size) => this.recordBandwidth(context, 0, size))
      .catch(() => undefined);
    return wrapped;
  }

  public override async deleteResource(identifier: ResourceIdentifier, conditions?: Conditions): Promise<ChangeMap> {
    const context = await this.resolveContext(identifier);
    const previousSize = context ? await this.getExistingSize(identifier) : 0;
    const change = await super.deleteResource(identifier, conditions);
    await this.applyStorageUpdate(context, previousSize, 0);
    return change;
  }

  private measureRepresentation(representation: Representation, limit?: number | null): { wrapped: Representation; sizePromise: Promise<number> } {
    if (!representation.data) {
      return {
        wrapped: representation,
        sizePromise: Promise.resolve(this.extractSize(representation)),
      };
    }

    let countedBytes = 0;
    const binary = representation.binary ?? false;
    const counter = binary ?
      new Transform({
        transform(chunk: unknown, encoding, callback): void {
          if (chunk instanceof Buffer) {
            countedBytes += chunk.length;
          } else if (typeof chunk === 'string') {
            countedBytes += Buffer.byteLength(chunk, encoding);
          }
          callback(null, chunk as any);
        },
      }) :
      new Transform({
        objectMode: true,
        transform: (chunk: unknown, _encoding, callback): void => {
          countedBytes += UsageTrackingStore.measureObjectChunkSize(chunk);
          callback(null, chunk as any);
        },
      });

    const transforms: Transform[] = [];
    const normalizedLimit = this.normalizeLimit(limit);
    if (normalizedLimit) {
      transforms.push(createBandwidthThrottleTransform({
        bytesPerSecond: normalizedLimit,
        objectMode: !binary,
        measure: binary ?
          undefined :
          (chunk: unknown): number => UsageTrackingStore.measureObjectChunkSize(chunk),
      }));
    }
    transforms.push(counter);

    let instrumented = representation.data as unknown as Readable;
    for (const transform of transforms) {
      instrumented = instrumented.pipe(transform) as unknown as Readable;
    }

    const countedStream = guardStream(instrumented);
    const sizePromise = new Promise<number>((resolve, reject) => {
      countedStream.on('end', () => resolve(countedBytes));
      countedStream.on('close', () => resolve(countedBytes));
      countedStream.on('error', reject);
      counter.on('error', reject);
    });

    return {
      wrapped: {
        ...representation,
        data: countedStream,
      },
      sizePromise: sizePromise.then((size) => (size !== 0 ? size : this.extractSize(representation)))
        .catch(() => this.extractSize(representation)),
    };
  }

  private extractSize(representation: Representation): number {
    const meta: any = representation as any;
    const candidate = meta.metadata?.contentLength;
    if (typeof candidate === 'number') {
      return candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  private async applyStorageUpdate(context: UsageContext | undefined, previousSize: number, newSize: number): Promise<void> {
    if (!context || !this.usageRepo) {
      return;
    }
    const normalizedPrevious = Math.max(0, Math.trunc(previousSize ?? 0));
    const normalizedNew = Math.max(0, Math.trunc(newSize ?? 0));
    const delta = normalizedNew - normalizedPrevious;
    if (delta !== 0) {
      await this.usageRepo.incrementUsage(context.accountId, context.podId, delta, 0, 0);
    }
  }

  private async getExistingSize(identifier: ResourceIdentifier): Promise<number> {
    if (!this.podLookup) {
      return 0;
    }
    try {
      const representation = await this.source.getRepresentation(identifier, {} as RepresentationPreferences);
      return await this.computeRepresentationSize(representation);
    } catch {
      return 0;
    }
  }

  private async computeRepresentationSize(representation: Representation): Promise<number> {
    if (!representation.data) {
      return this.extractSize(representation);
    }
    const binary = representation.binary ?? false;
    const stream = representation.data;
    let countedBytes = 0;

    return await new Promise<number>((resolve, reject) => {
      const removeListener = typeof (stream as any).off === 'function' ?
        (event: string, handler: (...args: any[]) => void): void => { (stream as any).off(event, handler); } :
        (event: string, handler: (...args: any[]) => void): void => { (stream as any).removeListener(event, handler); };
      const onData = (chunk: unknown): void => {
        if (binary) {
          if (chunk instanceof Buffer) {
            countedBytes += chunk.length;
          } else if (typeof chunk === 'string') {
            countedBytes += Buffer.byteLength(chunk);
          }
        } else {
          countedBytes += UsageTrackingStore.measureObjectChunkSize(chunk);
        }
      };

      const cleanup = (): void => {
        removeListener('data', onData);
        removeListener('error', onError);
        removeListener('end', onEnd);
        removeListener('close', onEnd);
      };

      const onEnd = (): void => {
        cleanup();
        resolve(countedBytes !== 0 ? countedBytes : this.extractSize(representation));
      };
      const onError = (error: unknown): void => {
        cleanup();
        reject(error);
      };

      stream.on('data', onData);
      stream.once('error', onError);
      stream.once('end', onEnd);
      stream.once('close', onEnd);
      if (typeof (stream as any).resume === 'function') {
        (stream as any).resume();
      }
    }).catch(() => this.extractSize(representation));
  }

  private async resolveContext(identifier: ResourceIdentifier): Promise<UsageContext | undefined> {
    if (!this.podLookup) {
      return undefined;
    }
    const pod = await this.podLookup.findByResourceIdentifier(identifier.path);
    if (!pod) {
      return undefined;
    }
    return {
      accountId: pod.accountId,
      podId: pod.podId,
    };
  }

  private async resolveBandwidthLimit(context: UsageContext): Promise<number | null | undefined> {
    if (!this.usageRepo) {
      return this.defaultBandwidthLimit;
    }
    const podRecord = await this.usageRepo.getPodUsage(context.podId);
    if (podRecord && podRecord.bandwidthLimitBps !== undefined) {
      return this.normalizeLimit(podRecord.bandwidthLimitBps);
    }
    const accountRecord = await this.usageRepo.getAccountUsage(context.accountId);
    if (accountRecord && accountRecord.bandwidthLimitBps !== undefined) {
      return this.normalizeLimit(accountRecord.bandwidthLimitBps);
    }
    return this.defaultBandwidthLimit;
  }

  private async recordBandwidth(context: UsageContext | undefined, ingress: number, egress: number): Promise<void> {
    if (!context || !this.usageRepo) {
      return;
    }
    const normalizedIngress = this.normalizeBandwidthDelta(ingress);
    const normalizedEgress = this.normalizeBandwidthDelta(egress);
    if (normalizedIngress === 0 && normalizedEgress === 0) {
      return;
    }
    await this.usageRepo.incrementUsage(context.accountId, context.podId, 0, normalizedIngress, normalizedEgress);
  }

  private normalizeLimit(limit?: number | null): number | null {
    if (limit == null) {
      return null;
    }
    const numeric = Number(limit);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return Math.max(0, Math.trunc(numeric));
  }

  private normalizeBandwidthDelta(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.trunc(value);
  }

  private static measureObjectChunkSize(chunk: unknown): number {
    if (chunk == null) {
      return 0;
    }
    if (chunk instanceof Buffer) {
      return chunk.length;
    }
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk, 'utf8');
    }
    if (UsageTrackingStore.isQuad(chunk)) {
      const serialized = UsageTrackingStore.quadToNQuads(chunk);
      return Buffer.byteLength(serialized, 'utf8');
    }
    return 0;
  }

  private static isQuad(candidate: unknown): candidate is Quad {
    if (!candidate || typeof candidate !== 'object') {
      return false;
    }
    const quad = candidate as Partial<Quad>;
    return !!quad.subject && !!quad.predicate && !!quad.object && quad.graph !== undefined;
  }

  private static quadToNQuads(quad: Quad): string {
    const subject = UsageTrackingStore.termToNQuads(quad.subject);
    const predicate = UsageTrackingStore.termToNQuads(quad.predicate);
    const object = UsageTrackingStore.termToNQuads(quad.object);
    const graph = quad.graph.termType === 'DefaultGraph' ? '' : ` ${UsageTrackingStore.termToNQuads(quad.graph)}`;
    return `${subject} ${predicate} ${object}${graph} .\n`;
  }

  private static termToNQuads(term: Term): string {
    switch (term.termType) {
      case 'NamedNode':
        return `<${term.value}>`;
      case 'BlankNode':
        return `_:${term.value}`;
      case 'Literal':
        return UsageTrackingStore.literalToNQuads(term as Literal);
      case 'DefaultGraph':
        return '';
      default:
        return `<${term.value}>`;
    }
  }

  private static literalToNQuads(literal: Literal): string {
    const escaped = UsageTrackingStore.escapeLiteral(literal.value);
    if (literal.language) {
      return `"${escaped}"@${literal.language}`;
    }
    const datatype = literal.datatype?.value;
    if (datatype && datatype !== UsageTrackingStore.XSD_STRING) {
      return `"${escaped}"^^<${datatype}>`;
    }
    return `"${escaped}"`;
  }

  private static escapeLiteral(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')
      .replace(/\b/g, '\\b');
  }
}

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { getLoggerFor } from 'global-logger-factory';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, BucketItemStat, CopyConditions } from 'minio';
import type { DataAccessor } from '@solid/community-server';
import {
  RepresentationMetadata,
  
  NotFoundHttpError,
  guardStream,
  isContainerIdentifier,
  isContainerPath,
  UnsupportedMediaTypeHttpError,
  CONTENT_TYPE_TERM,
  DC,
  LDP,
  POSIX,
  RDF,
  SOLID_META,
  XSD,
  addResourceMetadata,
  updateModifiedDate,
  toLiteral,
} from '@solid/community-server';
import type { Guarded } from '@solid/community-server';
import type { FileIdentifierMapper, ResourceLink } from '@solid/community-server';
import type { 
  ResourceIdentifier,
  Representation,
  MetadataRecord
} from '@solid/community-server';
import type { MigratableDataAccessor, MigrationProgress } from '../MigratableDataAccessor';

interface CacheEntry {
  path: string;
  size: number;
  lastAccess: number;
}

interface TieredMinioDataAccessorConfig {
  resourceMapper: FileIdentifierMapper;
  accessKey: string;
  secretKey: string;
  endpoint: string;
  bucketName: string;
  cachePath: string;
  cacheMaxSize: number; // bytes
  /** Current region identifier (e.g., "bj", "gz", "sh") */
  region?: string;
  /** Map of region identifier to bucket name for cross-region migration */
  regionBuckets?: Record<string, string>;
}

/**
 * TieredMinioDataAccessor extends MinioDataAccessor with a local cache layer.
 * 
 * Read: Check local cache first, if miss then fetch from COS and cache locally.
 * Write: Write to COS first (ensure durability), then cache locally.
 * 
 * Uses LRU eviction when cache exceeds maxSize.
 * 
 * Supports cross-region migration via MigratableDataAccessor interface.
 */
export class TieredMinioDataAccessor implements MigratableDataAccessor {
  protected readonly logger = getLoggerFor(this);
  protected readonly resourceMapper: FileIdentifierMapper;
  private readonly client: Client;
  private readonly bucketName: string;
  private readonly cachePath: string;
  private readonly cacheMaxSize: number;
  private readonly region?: string;
  private readonly regionBuckets: Record<string, string>;
  
  // LRU tracking: Map<cacheFilePath, lastAccessTime>
  private readonly cacheEntries: Map<string, CacheEntry> = new Map();
  private currentCacheSize = 0;
  
  // Active sync subscriptions for migration
  private readonly activeSyncs = new Map<string, { prefix: string; targetBucket: string }>();

  public constructor(config: TieredMinioDataAccessorConfig) {
    this.resourceMapper = config.resourceMapper;
    this.client = new Client({
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      endPoint: config.endpoint,
      useSSL: true,
    });
    this.bucketName = config.bucketName;
    this.cachePath = config.cachePath;
    this.cacheMaxSize = config.cacheMaxSize;
    this.region = config.region;
    this.regionBuckets = config.regionBuckets ?? {};
    
    // Ensure cache directory exists
    if (!existsSync(this.cachePath)) {
      mkdirSync(this.cachePath, { recursive: true });
    }
    
    // Initialize cache tracking from existing files
    this.initializeCacheTracking();
    
    this.logger.info(`TieredMinioDataAccessor initialized with endpoint: ${config.endpoint}, cache: ${config.cachePath}, maxSize: ${this.formatBytes(config.cacheMaxSize)}`);
  }

  /**
   * Scan existing cache directory and populate cache entries map.
   */
  private initializeCacheTracking(): void {
    try {
      this.scanCacheDir(this.cachePath);
      this.logger.info(`Cache initialized: ${this.cacheEntries.size} files, ${this.formatBytes(this.currentCacheSize)}`);
    } catch (error) {
      this.logger.warn(`Failed to scan cache directory: ${error}`);
    }
  }

  private scanCacheDir(dir: string): void {
    if (!existsSync(dir)) return;
    
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanCacheDir(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = statSync(fullPath);
          this.cacheEntries.set(fullPath, {
            path: fullPath,
            size: stats.size,
            lastAccess: stats.atimeMs,
          });
          this.currentCacheSize += stats.size;
        } catch {
          // File may have been deleted
        }
      }
    }
  }

  /**
   * Convert URL path to local cache file path.
   */
  private getCacheFilePath(identifier: ResourceIdentifier): string {
    const url = new URL(identifier.path);
    // Remove leading slash and encode special chars
    const relativePath = url.pathname.slice(1).replace(/[<>:"|?*]/g, '_');
    return join(this.cachePath, relativePath);
  }

  /**
   * Check if file exists in local cache.
   */
  private isCached(cacheFilePath: string): boolean {
    return existsSync(cacheFilePath);
  }

  /**
   * Update LRU access time for a cache entry.
   */
  private touchCache(cacheFilePath: string): void {
    const entry = this.cacheEntries.get(cacheFilePath);
    if (entry) {
      entry.lastAccess = Date.now();
    }
  }

  /**
   * Add file to cache tracking.
   */
  private addToCacheTracking(cacheFilePath: string, size: number): void {
    this.cacheEntries.set(cacheFilePath, {
      path: cacheFilePath,
      size,
      lastAccess: Date.now(),
    });
    this.currentCacheSize += size;
    
    // Trigger eviction if needed
    this.evictIfNeeded();
  }

  /**
   * Remove file from cache tracking.
   */
  private removeFromCacheTracking(cacheFilePath: string): void {
    const entry = this.cacheEntries.get(cacheFilePath);
    if (entry) {
      this.currentCacheSize -= entry.size;
      this.cacheEntries.delete(cacheFilePath);
    }
  }

  /**
   * Evict least recently used files until cache is under maxSize.
   */
  private evictIfNeeded(): void {
    if (this.currentCacheSize <= this.cacheMaxSize) {
      return;
    }

    // Sort by lastAccess (oldest first)
    const sortedEntries = [...this.cacheEntries.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    for (const [path, entry] of sortedEntries) {
      if (this.currentCacheSize <= this.cacheMaxSize * 0.8) {
        // Evict until 80% of max to avoid frequent evictions
        break;
      }

      try {
        unlinkSync(path);
        this.currentCacheSize -= entry.size;
        this.cacheEntries.delete(path);
        this.logger.debug(`Evicted from cache: ${path}`);
      } catch (error) {
        this.logger.warn(`Failed to evict cache file ${path}: ${error}`);
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes} B`;
  }

  // ============== DataAccessor Interface ==============

  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.');
    }
  }

  /**
   * Get data with cache-first strategy and cross-region fallback.
   * 
   * Read order:
   * 1. Local cache (fastest)
   * 2. Local bucket (current region)
   * 3. Fallback buckets (other regions) - enables instant migration
   * 
   * When reading from fallback bucket, optionally copy to local bucket (lazy migration).
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const cacheFilePath = this.getCacheFilePath(identifier);
    const url = new URL(identifier.path);

    // 1. Check local cache first
    if (this.isCached(cacheFilePath)) {
      this.logger.debug(`Cache hit: ${identifier.path}`);
      this.touchCache(cacheFilePath);
      const stream = createReadStream(cacheFilePath);
      return guardStream(stream);
    }

    // 2. Try local bucket first
    this.logger.debug(`Cache miss: ${identifier.path}`);
    let data: Buffer | null = null;
    let sourceLocation = 'local';

    try {
      data = await this.fetchFromBucket(this.bucketName, url.pathname);
    } catch (error) {
      // Local bucket failed, try fallback buckets
      if (this.supportsMigration()) {
        const fallbackResult = await this.fetchFromFallbackBuckets(url.pathname);
        if (fallbackResult) {
          data = fallbackResult.data;
          sourceLocation = fallbackResult.bucket;
          this.logger.debug(`Fallback read from ${sourceLocation}: ${identifier.path}`);
        }
      }
    }

    if (!data) {
      throw new NotFoundHttpError(`Resource not found: ${identifier.path}`);
    }

    // 3. Write to local cache
    await this.writeToCache(cacheFilePath, data, identifier.path);

    // 4. Lazy copy to local bucket if read from fallback
    if (sourceLocation !== 'local' && sourceLocation !== this.bucketName) {
      this.lazyCopyToLocalBucket(url.pathname, data).catch(err => {
        this.logger.warn(`Lazy copy failed for ${identifier.path}: ${err.message}`);
      });
    }

    // Return data as stream
    const { Readable } = require('node:stream');
    const readable = Readable.from(data);
    return guardStream(readable);
  }

  /**
   * Fetch data from a specific bucket.
   */
  private async fetchFromBucket(bucket: string, path: string): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Try to fetch data from fallback buckets (other regions).
   * Returns the data and source bucket name, or null if not found.
   */
  private async fetchFromFallbackBuckets(path: string): Promise<{ data: Buffer; bucket: string } | null> {
    // Try each region bucket except the current one
    for (const [region, bucket] of Object.entries(this.regionBuckets)) {
      if (bucket === this.bucketName) {
        continue; // Skip local bucket
      }

      try {
        this.logger.debug(`Trying fallback bucket: ${bucket} (region: ${region})`);
        const data = await this.fetchFromBucket(bucket, path);
        return { data, bucket };
      } catch {
        // Not found in this bucket, try next
        continue;
      }
    }

    return null;
  }

  /**
   * Write data to local cache.
   */
  private async writeToCache(cacheFilePath: string, data: Buffer, path: string): Promise<void> {
    try {
      const cacheDir = dirname(cacheFilePath);
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      const writeStream = createWriteStream(cacheFilePath);
      await new Promise<void>((resolve, reject) => {
        writeStream.write(data, (err) => {
          if (err) reject(err);
          else {
            writeStream.end();
            resolve();
          }
        });
      });

      this.addToCacheTracking(cacheFilePath, data.length);
    } catch (error) {
      this.logger.warn(`Failed to cache ${path}: ${error}`);
    }
  }

  /**
   * Lazily copy data to local bucket for future reads.
   * This runs in the background and doesn't block the read.
   */
  private async lazyCopyToLocalBucket(path: string, data: Buffer): Promise<void> {
    const { Readable } = require('node:stream');
    const stream = Readable.from(data);
    
    await this.client.putObject(
      this.bucketName,
      path,
      stream,
      data.length,
    );
    
    this.logger.debug(`Lazy copied to local bucket: ${path}`);
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const url = new URL(identifier.path);
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    const isDirectory = identifier.path.endsWith('/');
    const objectName = isDirectory ? `${url.pathname}/.container` : url.pathname;
    
    let stats: BucketItemStat;
    try {
      stats = await this.client.statObject(this.bucketName, objectName);
    } catch (error) {
      throw new NotFoundHttpError();
    }
    
    if (!isContainerIdentifier(identifier) && !isDirectory) {
      return this.getFileMetadata(link, stats);
    }
    if (isContainerIdentifier(identifier) && isDirectory) {
      return this.getDirectoryMetadata(link, stats);
    }
    throw new NotFoundHttpError();
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const url = new URL(identifier.path);
    const objects = this.client.listObjectsV2(this.bucketName, url.pathname);
    for await (const object of objects) {
      const metadata = await this.getMetadata(object);
      yield metadata;
    }
  }

  /**
   * Write document: COS first (durability), then cache.
   */
  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata): Promise<void> {
    const url = new URL(identifier.path);
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    const itemMetadata = this.encodeMetadata(link, metadata);

    // Collect data for both COS and cache
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Write to COS first (ensure durability)
    try {
      const { Readable } = require('node:stream');
      const cosStream = Readable.from(buffer);
      await this.client.putObject(
        this.bucketName,
        url.pathname,
        cosStream,
        buffer.length,
        itemMetadata || undefined,
      );
    } catch (error) {
      this.logger.error(`Error writing to COS: ${identifier.path} ${error}`);
      throw error;
    }

    // Write to local cache
    const cacheFilePath = this.getCacheFilePath(identifier);
    try {
      const cacheDir = dirname(cacheFilePath);
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      // Remove old cache entry if exists
      if (this.isCached(cacheFilePath)) {
        this.removeFromCacheTracking(cacheFilePath);
      }

      const writeStream = createWriteStream(cacheFilePath);
      await new Promise<void>((resolve, reject) => {
        writeStream.write(buffer, (err) => {
          if (err) reject(err);
          else {
            writeStream.end();
            resolve();
          }
        });
      });

      this.addToCacheTracking(cacheFilePath, buffer.length);
    } catch (error) {
      this.logger.warn(`Failed to write cache ${identifier.path}: ${error}`);
      // Cache failure is non-fatal
    }

    // Replicate to sync targets (for active migrations)
    const syncTargets = this.getActiveSyncTargets(url.pathname);
    for (const targetBucket of syncTargets) {
      try {
        const { Readable } = require('node:stream');
        const syncStream = Readable.from(buffer);
        await this.client.putObject(
          targetBucket,
          url.pathname,
          syncStream,
          buffer.length,
          itemMetadata || undefined,
        );
        this.logger.debug(`Synced to ${targetBucket}: ${url.pathname}`);
      } catch (error) {
        this.logger.warn(`Failed to sync ${url.pathname} to ${targetBucket}: ${error}`);
        // Sync failure is non-fatal, migration will catch up
      }
    }
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const url = new URL(identifier.path);
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    
    await this.client.putObject(
      this.bucketName,
      `${url.pathname}/.container`,
      Buffer.from(''),
      0,
      this.encodeMetadata(link, metadata) || undefined,
    );
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    throw new Error('TieredMinioDataAccessor does not support writing metadata for a resource.');
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const url = new URL(identifier.path);

    // Delete from COS
    await this.client.removeObject(this.bucketName, url.pathname);

    // Delete from cache
    const cacheFilePath = this.getCacheFilePath(identifier);
    if (this.isCached(cacheFilePath)) {
      try {
        unlinkSync(cacheFilePath);
        this.removeFromCacheTracking(cacheFilePath);
      } catch (error) {
        this.logger.warn(`Failed to delete cache ${identifier.path}: ${error}`);
      }
    }

    // Sync delete to migration targets
    const syncTargets = this.getActiveSyncTargets(url.pathname);
    for (const targetBucket of syncTargets) {
      try {
        await this.client.removeObject(targetBucket, url.pathname);
        this.logger.debug(`Synced delete to ${targetBucket}: ${url.pathname}`);
      } catch (error) {
        this.logger.warn(`Failed to sync delete ${url.pathname} to ${targetBucket}: ${error}`);
      }
    }
  }

  // ============== Metadata Helpers ==============

  private async getFileMetadata(link: ResourceLink, stats: BucketItemStat): Promise<RepresentationMetadata> {
    const metadata = await this.getBaseMetadata(link, stats, false);
    if (typeof metadata.contentType === 'undefined') {
      metadata.set(CONTENT_TYPE_TERM, link.contentType);
    }
    return metadata;
  }

  private async getDirectoryMetadata(link: ResourceLink, stats: BucketItemStat): Promise<RepresentationMetadata> {
    return this.getBaseMetadata(link, stats, true);
  }

  private async getBaseMetadata(link: ResourceLink, stats: BucketItemStat, isContainer: boolean): Promise<RepresentationMetadata> {
    const metadata = this.decodeMetadata(link, stats.metaData);
    addResourceMetadata(metadata, isContainer);
    this.addPosixMetadata(metadata, stats, isContainer);
    return metadata;
  }

  private addPosixMetadata(metadata: RepresentationMetadata, stats: BucketItemStat, isDirectory: boolean): void {
    updateModifiedDate(metadata, stats.lastModified);
    metadata.add(
      POSIX.terms.mtime,
      toLiteral(Math.floor(stats.lastModified.getTime() / 1000), XSD.terms.integer),
      SOLID_META.terms.ResponseMetadata,
    );
    if (!isDirectory) {
      metadata.add(
        POSIX.terms.size,
        toLiteral(stats.size, XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    }
  }

  protected encodeMetadata(link: ResourceLink, metadata: RepresentationMetadata): object | null {
    metadata.remove(RDF.terms.type, LDP.terms.Resource);
    metadata.remove(RDF.terms.type, LDP.terms.Container);
    metadata.remove(RDF.terms.type, LDP.terms.BasicContainer);
    metadata.removeAll(DC.terms.modified);
    
    if (isContainerPath(link.filePath) || typeof metadata.contentType !== 'undefined') {
      metadata.removeAll(CONTENT_TYPE_TERM);
    }
    
    const contentTypeObject = metadata.contentTypeObject;
    if (contentTypeObject === undefined || Object.keys(contentTypeObject.parameters).length === 0) {
      return null;
    }
    return contentTypeObject.parameters;
  }

  protected decodeMetadata(link: ResourceLink, metadata: MetadataRecord): RepresentationMetadata {
    return new RepresentationMetadata(link.identifier, metadata);
  }

  // ============== Cache Stats (for monitoring) ==============

  public getCacheStats(): { entries: number; size: number; maxSize: number } {
    return {
      entries: this.cacheEntries.size,
      size: this.currentCacheSize,
      maxSize: this.cacheMaxSize,
    };
  }

  // ============== MigratableDataAccessor Implementation ==============

  /**
   * Check if migration is supported.
   * Migration requires region configuration and region-to-bucket mapping.
   */
  public supportsMigration(): boolean {
    return this.region !== undefined && Object.keys(this.regionBuckets).length > 0;
  }

  /**
   * Migrate all objects under the given prefix to a target region's bucket.
   * Uses Minio server-side copy for efficiency (data doesn't pass through this node).
   */
  public async migrateToRegion(
    prefix: string,
    targetRegion: string,
    onProgress?: (progress: MigrationProgress) => void,
  ): Promise<void> {
    if (!this.supportsMigration()) {
      throw new Error('Migration not supported: region configuration missing');
    }

    const targetBucket = this.regionBuckets[targetRegion];
    if (!targetBucket) {
      throw new Error(`Unknown target region: ${targetRegion}. Available regions: ${Object.keys(this.regionBuckets).join(', ')}`);
    }

    if (targetBucket === this.bucketName) {
      this.logger.info(`Source and target bucket are the same (${this.bucketName}), skipping migration`);
      onProgress?.({ copied: 0, total: 0, bytesTransferred: 0 });
      return;
    }

    this.logger.info(`Starting migration: prefix=${prefix}, source=${this.bucketName}, target=${targetBucket}`);

    // Normalize prefix (remove leading slash for Minio)
    const objectPrefix = prefix.startsWith('/') ? prefix.slice(1) : prefix;

    // 1. List all objects to migrate
    const objects: Array<{ name: string; size: number }> = [];
    const stream = this.client.listObjectsV2(this.bucketName, objectPrefix, true);
    
    for await (const obj of stream) {
      if (obj.name) {
        objects.push({ name: obj.name, size: obj.size ?? 0 });
      }
    }

    this.logger.info(`Found ${objects.length} objects to migrate`);

    if (objects.length === 0) {
      onProgress?.({ copied: 0, total: 0, bytesTransferred: 0 });
      return;
    }

    // 2. Copy each object using server-side copy
    let copied = 0;
    let bytesTransferred = 0;

    for (const obj of objects) {
      try {
        // Minio copyObject uses server-side copy when source and target are on same cluster
        const copySource = `/${this.bucketName}/${obj.name}`;
        await this.client.copyObject(targetBucket, obj.name, copySource, new CopyConditions());
        
        copied++;
        bytesTransferred += obj.size;
        
        onProgress?.({
          copied,
          total: objects.length,
          bytesTransferred,
        });

        this.logger.debug(`Copied: ${obj.name} (${copied}/${objects.length})`);
      } catch (error) {
        this.logger.error(`Failed to copy object ${obj.name}: ${(error as Error).message}`);
        throw error;
      }
    }

    this.logger.info(`Migration completed: ${copied} objects, ${this.formatBytes(bytesTransferred)}`);
  }

  /**
   * Set up real-time sync during migration.
   * 
   * Note: Full implementation would use Minio Bucket Notifications to replicate
   * new writes to the target bucket. For now, we track active syncs and replicate
   * writes in writeDocument().
   */
  public async setupRealtimeSync(prefix: string, targetRegion: string): Promise<void> {
    if (!this.supportsMigration()) {
      throw new Error('Migration not supported: region configuration missing');
    }

    const targetBucket = this.regionBuckets[targetRegion];
    if (!targetBucket) {
      throw new Error(`Unknown target region: ${targetRegion}`);
    }

    const syncKey = `${prefix}:${targetRegion}`;
    this.activeSyncs.set(syncKey, { prefix, targetBucket });
    
    this.logger.info(`Real-time sync enabled: prefix=${prefix}, target=${targetBucket}`);
  }

  /**
   * Stop real-time sync after migration completes.
   */
  public async stopRealtimeSync(prefix: string, targetRegion: string): Promise<void> {
    const syncKey = `${prefix}:${targetRegion}`;
    this.activeSyncs.delete(syncKey);
    
    this.logger.info(`Real-time sync disabled: prefix=${prefix}, targetRegion=${targetRegion}`);
  }

  /**
   * Check if a write should be replicated to sync targets.
   */
  private getActiveSyncTargets(path: string): string[] {
    const targets: string[] = [];
    
    for (const [, sync] of this.activeSyncs) {
      if (path.startsWith(sync.prefix)) {
        targets.push(sync.targetBucket);
      }
    }
    
    return targets;
  }
}

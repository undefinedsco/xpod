import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, BucketItemStat } from 'minio';
import type { DataAccessor } from '@solid/community-server';
import {
  RepresentationMetadata,
  getLoggerFor,
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
}

/**
 * TieredMinioDataAccessor extends MinioDataAccessor with a local cache layer.
 * 
 * Read: Check local cache first, if miss then fetch from COS and cache locally.
 * Write: Write to COS first (ensure durability), then cache locally.
 * 
 * Uses LRU eviction when cache exceeds maxSize.
 */
export class TieredMinioDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  protected readonly resourceMapper: FileIdentifierMapper;
  private readonly client: Client;
  private readonly bucketName: string;
  private readonly cachePath: string;
  private readonly cacheMaxSize: number;
  
  // LRU tracking: Map<cacheFilePath, lastAccessTime>
  private readonly cacheEntries: Map<string, CacheEntry> = new Map();
  private currentCacheSize = 0;

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
   * Get data with cache-first strategy.
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const cacheFilePath = this.getCacheFilePath(identifier);

    // Check local cache first
    if (this.isCached(cacheFilePath)) {
      this.logger.debug(`Cache hit: ${identifier.path}`);
      this.touchCache(cacheFilePath);
      const stream = createReadStream(cacheFilePath);
      return guardStream(stream);
    }

    // Cache miss: fetch from COS
    this.logger.debug(`Cache miss: ${identifier.path}`);
    const url = new URL(identifier.path);
    const cosStream = await this.client.getObject(this.bucketName, url.pathname);

    // Write to cache while returning data
    try {
      // Ensure parent directory exists
      const cacheDir = dirname(cacheFilePath);
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      // For simplicity, we fetch the entire file and cache it
      // In production, consider streaming with PassThrough
      const chunks: Buffer[] = [];
      for await (const chunk of cosStream) {
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);

      // Write to cache
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

      // Track cache entry
      this.addToCacheTracking(cacheFilePath, data.length);

      // Return data as stream
      const { Readable } = require('node:stream');
      const readable = Readable.from(data);
      return guardStream(readable);
    } catch (error) {
      this.logger.warn(`Failed to cache ${identifier.path}: ${error}`);
      // If caching fails, still try to return data from COS
      const url = new URL(identifier.path);
      const stream = await this.client.getObject(this.bucketName, url.pathname);
      return guardStream(stream);
    }
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
    
    this.logger.info(`Write document: ${identifier.path}`);

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
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const url = new URL(identifier.path);
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    
    this.logger.info(`Write container: ${identifier.path}`);
    
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
    this.logger.info(`Delete resource: ${identifier.path}`);

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
}

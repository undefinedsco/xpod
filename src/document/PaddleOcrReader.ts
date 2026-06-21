import { getLoggerFor } from 'global-logger-factory';
import type { DocumentReader, ReadDocument, ReadOptions } from './DocumentReader';
import { countPagesInRange } from './ReaderPolicy';

export interface PaddleOcrClientReadInput {
  fileUrl?: string;
  filePath?: string;
  token: string;
  model: string;
  pageRange?: string;
  expectedUse?: string;
  timeout?: number;
}

export interface PaddleOcrClientReadResult {
  markdown?: string;
  content?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  pages?: unknown[];
}

export interface PaddleOcrClientLike {
  readDocument(input: PaddleOcrClientReadInput): Promise<PaddleOcrClientReadResult>;
}

export interface PaddleOcrReaderOptions {
  token: string;
  model: string;
  client: PaddleOcrClientLike;
  defaultTimeout?: number;
}

export interface PaddleOcrReadOptions extends ReadOptions {
  pageRange?: string;
  expectedUse?: string;
}

export class PaddleOcrReader implements DocumentReader {
  protected readonly logger = getLoggerFor(this);

  private readonly token: string;
  private readonly model: string;
  private readonly client: PaddleOcrClientLike;
  private readonly defaultTimeout: number;

  public constructor(options: PaddleOcrReaderOptions) {
    this.token = options.token;
    this.model = options.model;
    this.client = options.client;
    this.defaultTimeout = options.defaultTimeout ?? 60_000;
  }

  public async read(url: string, options?: PaddleOcrReadOptions): Promise<ReadDocument> {
    const response = await this.client.readDocument({
      fileUrl: url,
      token: this.token,
      model: this.model,
      pageRange: options?.pageRange,
      expectedUse: options?.expectedUse,
      timeout: options?.timeout ?? this.defaultTimeout,
    });

    const markdown = response.markdown ?? response.content ?? response.text ?? '';
    const pageCount = options?.pageRange
      ? countPagesInRange(options.pageRange)
      : Array.isArray(response.pages) ? response.pages.length : undefined;

    return {
      markdown,
      rawUrl: url,
      metadata: {
        url,
        contentType: 'text/markdown',
        wordCount: markdown.trim() ? markdown.trim().split(/\s+/u).length : 0,
        ...(response.metadata ?? {}),
        readerProvider: 'paddleocr',
        readerModel: this.model,
        pageRange: options?.pageRange,
        pageCount,
      } as ReadDocument['metadata'] & Record<string, unknown>,
    };
  }

  public supports(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
    } catch {
      return false;
    }
  }
}

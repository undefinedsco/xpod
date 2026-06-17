import { getLoggerFor } from 'global-logger-factory';
import type { DocumentParser, ParsedDocument, ParseOptions } from './DocumentParser';
import { countPagesInRange } from './ParserPolicy';

export interface PaddleOCRClientParseInput {
  fileUrl?: string;
  filePath?: string;
  token: string;
  model: string;
  pageRange?: string;
  expectedUse?: string;
  timeout?: number;
}

export interface PaddleOCRClientParseResult {
  markdown?: string;
  content?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  pages?: unknown[];
}

export interface PaddleOCRClientLike {
  parseDocument(input: PaddleOCRClientParseInput): Promise<PaddleOCRClientParseResult>;
}

export interface PaddleOCRDocumentParserOptions {
  token: string;
  model: string;
  client: PaddleOCRClientLike;
  defaultTimeout?: number;
}

export interface PaddleOCRParseOptions extends ParseOptions {
  pageRange?: string;
  expectedUse?: string;
}

export class PaddleOCRDocumentParser implements DocumentParser {
  protected readonly logger = getLoggerFor(this);

  private readonly token: string;
  private readonly model: string;
  private readonly client: PaddleOCRClientLike;
  private readonly defaultTimeout: number;

  public constructor(options: PaddleOCRDocumentParserOptions) {
    this.token = options.token;
    this.model = options.model;
    this.client = options.client;
    this.defaultTimeout = options.defaultTimeout ?? 60_000;
  }

  public async parse(url: string, options?: PaddleOCRParseOptions): Promise<ParsedDocument> {
    const response = await this.client.parseDocument({
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
        parserProvider: 'paddleocr',
        parserModel: this.model,
        pageRange: options?.pageRange,
        pageCount,
      } as ParsedDocument['metadata'] & Record<string, unknown>,
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

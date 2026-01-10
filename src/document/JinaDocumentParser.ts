/**
 * JinaDocumentParser - 基于 JINA Reader API 的文档解析器
 *
 * 使用 JINA Reader API (https://r.jina.ai/) 将各种格式的文档转换为 Markdown
 * 支持：PDF, Office 文档, HTML, 图片等
 *
 * @see https://jina.ai/reader/
 */

import { getLoggerFor } from 'global-logger-factory';
import type { DocumentParser, ParsedDocument, ParseOptions } from './DocumentParser';

export interface JinaDocumentParserOptions {
  /** JINA API Key */
  apiKey: string;
  /** 自定义 API 端点（默认 https://r.jina.ai） */
  baseUrl?: string;
  /** 默认超时时间（毫秒） */
  defaultTimeout?: number;
}

/**
 * JINA Reader API 文档解析器
 */
export class JinaDocumentParser implements DocumentParser {
  protected readonly logger = getLoggerFor(this);

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeout: number;

  public constructor(options: JinaDocumentParserOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://r.jina.ai';
    this.defaultTimeout = options.defaultTimeout ?? 30000;
  }

  /**
   * 解析文档为 Markdown
   */
  public async parse(url: string, options?: ParseOptions): Promise<ParsedDocument> {
    const timeout = options?.timeout ?? this.defaultTimeout;

    this.logger.debug(`Parsing document: ${url}`);

    try {
      // 构建 JINA Reader URL
      const readerUrl = `${this.baseUrl}/${encodeURIComponent(url)}`;

      // 创建 AbortController 用于超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'text/markdown',
        'X-Return-Format': 'markdown',
      };

      // 如果需要包含图片描述
      if (options?.includeImages) {
        headers['X-With-Images-Summary'] = 'true';
      }

      // 如果需要包含链接
      if (options?.includeLinks !== false) {
        headers['X-With-Links-Summary'] = 'true';
      }

      const response = await fetch(readerUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`JINA parse failed: ${response.status} ${errorText}`);
      }

      const markdown = await response.text();

      // 提取元数据（从 Markdown 头部）
      const metadata = this.extractMetadata(markdown, url);

      this.logger.info(`Parsed document: ${url}, ${markdown.length} chars`);

      return {
        markdown,
        metadata,
        rawUrl: url,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Document parsing timed out after ${timeout}ms: ${url}`);
      }
      this.logger.error(`Failed to parse document ${url}: ${error}`);
      throw error;
    }
  }

  /**
   * 检查是否支持该 URL
   * JINA Reader 支持大多数 URL
   */
  public supports(url: string): boolean {
    try {
      const parsed = new URL(url);
      // 支持 http 和 https
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * 从 Markdown 内容中提取元数据
   */
  private extractMetadata(
    markdown: string,
    url: string,
  ): ParsedDocument['metadata'] {
    const metadata: ParsedDocument['metadata'] = {
      url,
    };

    // 尝试从 YAML front matter 提取
    const frontMatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
    if (frontMatterMatch) {
      const frontMatter = frontMatterMatch[1];

      // 提取 title
      const titleMatch = frontMatter.match(/^title:\s*(.+)$/m);
      if (titleMatch) {
        metadata.title = titleMatch[1].replace(/^["']|["']$/g, '');
      }

      // 提取 description
      const descMatch = frontMatter.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        metadata.description = descMatch[1].replace(/^["']|["']$/g, '');
      }
    }

    // 如果没有从 front matter 获取 title，尝试从第一个 H1 获取
    if (!metadata.title) {
      const h1Match = markdown.match(/^#\s+(.+)$/m);
      if (h1Match) {
        metadata.title = h1Match[1];
      }
    }

    // 计算字数（简单估算）
    const textContent = markdown
      .replace(/```[\s\S]*?```/g, '') // 移除代码块
      .replace(/[#*_`\[\]()]/g, '') // 移除 Markdown 标记
      .trim();
    metadata.wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return metadata;
  }
}

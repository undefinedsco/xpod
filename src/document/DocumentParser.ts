/**
 * DocumentParser - 文档解析接口
 *
 * 将各种格式的文档（PDF, Office, HTML 等）转换为 Markdown
 */

/**
 * 解析后的文档
 */
export interface ParsedDocument {
  /** Markdown 格式的内容 */
  markdown: string;

  /** 文档元数据 */
  metadata: {
    /** 文档标题 */
    title?: string;
    /** 文档描述 */
    description?: string;
    /** 原始 URL */
    url: string;
    /** 内容类型 */
    contentType?: string;
    /** 字数统计 */
    wordCount?: number;
  };

  /** 原始 URL */
  rawUrl: string;
}

/**
 * 文档解析器接口
 */
export interface DocumentParser {
  /**
   * 解析文档为 Markdown
   * @param url 文档 URL
   * @param options 解析选项
   * @returns 解析后的文档
   */
  parse(url: string, options?: ParseOptions): Promise<ParsedDocument>;

  /**
   * 检查是否支持该 URL
   * @param url 文档 URL
   * @returns 是否支持
   */
  supports(url: string): boolean;
}

/**
 * 解析选项
 */
export interface ParseOptions {
  /** 访问令牌（用于需要认证的资源） */
  accessToken?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否包含图片描述 */
  includeImages?: boolean;
  /** 是否包含链接 */
  includeLinks?: boolean;
}

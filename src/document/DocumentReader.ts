/**
 * DocumentReader - 文档读取接口
 *
 * 将各种格式的文档（PDF, Office, HTML 等）转换为 Markdown
 */

/**
 * 读取后的文档
 */
export interface ReadDocument {
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
    /** reader provider，例如 paddleocr */
    readerProvider?: string;
    /** reader model，例如 pp-ocrv6 */
    readerModel?: string;
    /** 已读取页段 */
    pageRange?: string;
    /** 已读取页数 */
    pageCount?: number;
  };

  /** 原始 URL */
  rawUrl: string;
}

/**
 * 文档读取器接口
 */
export interface DocumentReader {
  /**
   * 读取文档为 Markdown
   * @param url 文档 URL
   * @param options 读取选项
   * @returns 读取后的文档
   */
  read(url: string, options?: ReadOptions): Promise<ReadDocument>;

  /**
   * 检查是否支持该 URL
   * @param url 文档 URL
   * @returns 是否支持
   */
  supports(url: string): boolean;
}

/**
 * 读取选项
 */
export interface ReadOptions {
  /** 访问令牌（用于需要认证的资源） */
  accessToken?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否包含图片描述 */
  includeImages?: boolean;
  /** 是否包含链接 */
  includeLinks?: boolean;
  /** 页码范围，例如 1-20 或 1,3,5-8 */
  pageRange?: string;
  /** Agent/系统读取目的，用于 provider adapter 记录与调度 */
  expectedUse?: string;
}

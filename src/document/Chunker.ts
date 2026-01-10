/**
 * Chunker - 文档分块接口
 *
 * 将 Markdown 文档按标题层级分块，保留结构信息
 */

/**
 * 文本块
 */
export interface TextChunk {
  /** 块 ID */
  id: string;

  /** 标题层级 (1-6)，0 表示文档开头无标题部分 */
  level: number;

  /** 标题文本 */
  heading: string;

  /** 块内容（包含标题和正文） */
  content: string;

  /** 标题路径 (如 ["Introduction", "Getting Started"]) */
  path: string[];

  /** 在原文中的起始偏移量 */
  startOffset: number;

  /** 在原文中的结束偏移量 */
  endOffset: number;

  /** 父块 ID */
  parentId?: string;

  /** 子块 */
  children: TextChunk[];
}

/**
 * 分块器接口
 */
export interface Chunker {
  /**
   * 将 Markdown 分块为树形结构
   * @param markdown Markdown 内容
   * @returns 根级块数组（树形结构）
   */
  chunk(markdown: string): TextChunk[];

  /**
   * 将树形结构扁平化
   * @param chunks 树形结构的块
   * @returns 扁平化的块数组
   */
  flatten(chunks: TextChunk[]): TextChunk[];
}

/**
 * 块元数据（用于存储到 .meta 文件）
 */
export interface ChunkMetadata {
  /** 块 ID */
  id: string;
  /** 标题层级 */
  level: number;
  /** 标题文本 */
  heading: string;
  /** 起始偏移量 */
  startOffset: number;
  /** 结束偏移量 */
  endOffset: number;
  /** 父块 ID */
  parentId?: string;
  /** 向量 ID（存储后填充） */
  vectorId?: number;
}

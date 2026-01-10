/**
 * HeadingChunker - 按标题层级分块
 *
 * 将 Markdown 文档按标题层级分块，构建树形结构
 * 每个块记录 startOffset 和 endOffset
 */

import { randomBytes } from 'crypto';
import type { Chunker, TextChunk } from './Chunker';

/**
 * 按标题层级分块的实现
 */
export class HeadingChunker implements Chunker {
  /**
   * 将 Markdown 分块为树形结构
   */
  public chunk(markdown: string): TextChunk[] {
    const lines = markdown.split('\n');
    const rootChunks: TextChunk[] = [];
    const stack: TextChunk[] = []; // 用于构建树形结构

    let currentOffset = 0;
    let currentChunk: TextChunk | null = null;
    let contentBuffer = '';
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLength = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for \n except last line

      // 检查代码块边界
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        // 代码块边界添加到当前块内容
        if (currentChunk) {
          contentBuffer += line + '\n';
        }
        currentOffset += lineLength;
        continue;
      }

      // 在代码块内，不解析标题
      if (inCodeBlock) {
        if (currentChunk) {
          contentBuffer += line + '\n';
        }
        currentOffset += lineLength;
        continue;
      }

      // 检查是否是标题行
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // 发现新标题，先保存之前的块内容
        if (currentChunk) {
          currentChunk.content = contentBuffer.trim();
          currentChunk.endOffset = currentOffset;
        }

        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();

        // 创建新块
        const newChunk: TextChunk = {
          id: this.generateChunkId(),
          level,
          heading,
          content: '',
          path: [heading], // 初始路径包含自己
          startOffset: currentOffset,
          endOffset: currentOffset + lineLength, // 临时值，后面会更新
          children: [],
        };

        // 构建树形结构
        // 找到合适的父节点
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }

        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          newChunk.parentId = parent.id;
          // path 包含父级的 path 加上当前标题
          newChunk.path = [...parent.path, heading];
          parent.children.push(newChunk);
        } else {
          newChunk.path = [heading];
          rootChunks.push(newChunk);
        }

        stack.push(newChunk);
        currentChunk = newChunk;
        contentBuffer = line + '\n';
      } else {
        // 非标题行，添加到当前块
        if (currentChunk) {
          contentBuffer += line + '\n';
        } else {
          // 文档开头没有标题的部分
          // 创建一个 level 0 的块
          if (line.trim().length > 0 && rootChunks.length === 0) {
            const introChunk: TextChunk = {
              id: this.generateChunkId(),
              level: 0,
              heading: '',
              content: '',
              path: [],
              startOffset: 0,
              endOffset: 0,
              children: [],
            };
            rootChunks.push(introChunk);
            currentChunk = introChunk;
            contentBuffer = line + '\n';
          } else if (currentChunk === null && rootChunks.length > 0) {
            // 继续添加到第一个块
            currentChunk = rootChunks[0];
            contentBuffer = currentChunk.content + line + '\n';
          }
        }
      }

      currentOffset += lineLength;
    }

    // 保存最后一个块的内容
    if (currentChunk) {
      currentChunk.content = contentBuffer.trim();
      currentChunk.endOffset = currentOffset;
    }

    // 更新所有块的 endOffset（递归）
    this.updateEndOffsets(rootChunks, markdown.length);

    return rootChunks;
  }

  /**
   * 将树形结构扁平化
   */
  public flatten(chunks: TextChunk[]): TextChunk[] {
    const result: TextChunk[] = [];

    const walk = (chunk: TextChunk): void => {
      result.push(chunk);
      for (const child of chunk.children) {
        walk(child);
      }
    };

    for (const chunk of chunks) {
      walk(chunk);
    }

    return result;
  }

  /**
   * 更新块的 endOffset
   * 每个块的 endOffset 应该是下一个同级或更高级块的 startOffset - 1
   * 或者文档末尾
   */
  private updateEndOffsets(chunks: TextChunk[], docLength: number): void {
    const flat = this.flatten(chunks);

    for (let i = 0; i < flat.length; i++) {
      const chunk = flat[i];
      const nextSiblingOrHigher = this.findNextSiblingOrHigher(flat, i, chunk.level);

      if (nextSiblingOrHigher) {
        chunk.endOffset = nextSiblingOrHigher.startOffset;
      } else {
        chunk.endOffset = docLength;
      }
    }
  }

  /**
   * 找到下一个同级或更高级的块
   */
  private findNextSiblingOrHigher(
    flat: TextChunk[],
    startIndex: number,
    level: number,
  ): TextChunk | null {
    for (let i = startIndex + 1; i < flat.length; i++) {
      if (flat[i].level <= level && flat[i].level > 0) {
        return flat[i];
      }
    }
    return null;
  }

  /**
   * 生成块 ID
   */
  private generateChunkId(): string {
    return `chunk-${randomBytes(6).toString('hex')}`;
  }
}

import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const READER_CHUNK_POLICY_VERSION = 'markdown-mdast-v1' as const;
export const MARKDOWN_RETRIEVAL_POINT_MAX_BYTES = 8192;

export interface MarkdownRetrievalPointProjectionInput {
  sourceKey: string;
  sourceUri: string;
  representationHash: string;
  markdown: string;
}

export interface MarkdownRetrievalPoint {
  sourceKey: string;
  sourceUri: string;
  representationHash: string;
  chunkPolicyVersion: typeof READER_CHUNK_POLICY_VERSION;
  chunkKey: string;
  retrievalPointKey: string;
  retrievalKind: 'file-chunk';
  ordinal: number;
  subdivisionOrdinal: number;
  structuralPath: string;
  sectionPath: string;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  startByte: number;
  endByte: number;
}

interface MdastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface MdastNode {
  type: string;
  value?: string;
  alt?: string;
  children?: MdastNode[];
  depth?: number;
  position?: MdastPosition;
}

interface LeafProjection {
  structuralPath: string;
  text: string;
  sectionPath: string;
  heading?: string;
  level: number;
  path: string[];
  startOffset: number;
  endOffset: number;
  startByte: number;
  endByte: number;
  exactSourceText: boolean;
}

export class MarkdownRetrievalPointProjector {
  public project(input: MarkdownRetrievalPointProjectionInput): MarkdownRetrievalPoint[] {
    const tree = fromMarkdown(input.markdown) as MdastNode;
    const leaves = this.collectLeaves(tree, input.markdown);
    const points: MarkdownRetrievalPoint[] = [];

    for (const leaf of leaves) {
      const parts = splitUtf8Budget(leaf.text, MARKDOWN_RETRIEVAL_POINT_MAX_BYTES);
      for (const part of parts) {
        const retrievalPointKey = stableRetrievalPointKey({
          sourceKey: input.sourceKey,
          representationHash: input.representationHash,
          structuralPath: leaf.structuralPath,
          subdivisionOrdinal: part.subdivisionOrdinal,
          text: part.text,
        });
        points.push({
          sourceKey: input.sourceKey,
          sourceUri: input.sourceUri,
          representationHash: input.representationHash,
          chunkPolicyVersion: READER_CHUNK_POLICY_VERSION,
          chunkKey: retrievalPointKey,
          retrievalPointKey,
          retrievalKind: 'file-chunk',
          ordinal: points.length,
          subdivisionOrdinal: part.subdivisionOrdinal,
          structuralPath: leaf.structuralPath,
          sectionPath: leaf.sectionPath,
          level: leaf.level,
          heading: leaf.heading,
          path: leaf.path,
          content: part.text,
          startOffset: leaf.exactSourceText ? leaf.startOffset + part.startCharOffset : leaf.startOffset,
          endOffset: leaf.exactSourceText ? leaf.startOffset + part.endCharOffset : leaf.endOffset,
          startByte: leaf.exactSourceText ? leaf.startByte + part.startByteOffset : leaf.startByte,
          endByte: leaf.exactSourceText ? leaf.startByte + part.endByteOffset : leaf.endByte,
        });
      }
    }

    return points;
  }

  private collectLeaves(root: MdastNode, markdown: string): LeafProjection[] {
    const leaves: LeafProjection[] = [];
    const headingStack: { level: number; text: string }[] = [];
    const visitChildren = (children: MdastNode[] | undefined): void => {
      let structuralOrdinal = 0;
      for (const child of children ?? []) {
        if (child.type === 'heading') {
          const level = child.depth ?? 0;
          const text = textContent(child).trim();
          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop();
          }
          if (text) {
            headingStack.push({ level, text });
          }
          structuralOrdinal = 0;
          continue;
        }

        if (isLeafNode(child)) {
          const text = leafText(child).trim();
          if (text) {
            const path = headingStack.map((heading) => heading.text);
            const range = nodeRange(child, markdown);
            leaves.push({
              structuralPath: [
                path.join('/') || '(root)',
                `${child.type}:${structuralOrdinal}`,
                `leaf:${leaves.length}`,
              ].join('/'),
              text,
              sectionPath: path.join(' / '),
              heading: path[path.length - 1],
              level: headingStack[headingStack.length - 1]?.level ?? 0,
              path,
              ...range,
              exactSourceText: markdown.slice(range.startOffset, range.endOffset) === text,
            });
            structuralOrdinal += 1;
          }
          continue;
        }

        visitChildren(child.children);
      }
    };

    visitChildren(root.children);
    return leaves;
  }
}

function stableRetrievalPointKey(input: {
  sourceKey: string;
  representationHash: string;
  structuralPath: string;
  subdivisionOrdinal: number;
  text: string;
}): string {
  return createHash('sha256')
    .update([
      input.sourceKey,
      input.representationHash,
      READER_CHUNK_POLICY_VERSION,
      input.structuralPath,
      String(input.subdivisionOrdinal),
      input.text,
    ].join('\u0000'))
    .digest('hex');
}

function isLeafNode(node: MdastNode): boolean {
  return [
    'paragraph',
    'list',
    'blockquote',
    'code',
    'html',
  ].includes(node.type);
}

function leafText(node: MdastNode): string {
  if (node.type === 'code' || node.type === 'html') {
    return node.value ?? '';
  }
  if (node.type === 'list') {
    return (node.children ?? []).map((child) => textContent(child).trim()).filter(Boolean).join('\n');
  }
  return textContent(node);
}

function textContent(node: MdastNode): string {
  if (node.type === 'break') {
    return '\n';
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    return node.alt ?? '';
  }
  if (typeof node.value === 'string') {
    return node.value;
  }
  if (!node.children || node.children.length === 0) {
    return '';
  }
  return node.children.map((child) => textContent(child)).join(childTextSeparator(node.type));
}

function childTextSeparator(type: string): string {
  return ['root', 'list', 'listItem', 'blockquote'].includes(type) ? '\n' : '';
}

function nodeRange(node: MdastNode, markdown: string): {
  startOffset: number;
  endOffset: number;
  startByte: number;
  endByte: number;
} {
  const startOffset = Math.max(0, node.position?.start?.offset ?? 0);
  const endOffset = Math.max(startOffset, node.position?.end?.offset ?? startOffset);
  return {
    startOffset,
    endOffset,
    startByte: Buffer.byteLength(markdown.slice(0, startOffset), 'utf8'),
    endByte: Buffer.byteLength(markdown.slice(0, endOffset), 'utf8'),
  };
}

function splitUtf8Budget(text: string, maxBytes: number): {
  text: string;
  subdivisionOrdinal: number;
  startCharOffset: number;
  endCharOffset: number;
  startByteOffset: number;
  endByteOffset: number;
}[] {
  const parts: {
    text: string;
    subdivisionOrdinal: number;
    startCharOffset: number;
    endCharOffset: number;
    startByteOffset: number;
    endByteOffset: number;
  }[] = [];
  let current = '';
  let currentBytes = 0;
  let currentStartChar = 0;
  let currentStartByte = 0;
  let charOffset = 0;
  let byteOffset = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + charBytes > maxBytes) {
      parts.push({
        text: current,
        subdivisionOrdinal: parts.length,
        startCharOffset: currentStartChar,
        endCharOffset: charOffset,
        startByteOffset: currentStartByte,
        endByteOffset: byteOffset,
      });
      current = '';
      currentBytes = 0;
      currentStartChar = charOffset;
      currentStartByte = byteOffset;
    }
    current += char;
    currentBytes += charBytes;
    charOffset += char.length;
    byteOffset += charBytes;
  }

  if (current) {
    parts.push({
      text: current,
      subdivisionOrdinal: parts.length,
      startCharOffset: currentStartChar,
      endCharOffset: charOffset,
      startByteOffset: currentStartByte,
      endByteOffset: byteOffset,
    });
  }

  return parts;
}

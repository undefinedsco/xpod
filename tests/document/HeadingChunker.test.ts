/**
 * HeadingChunker 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HeadingChunker } from '../../src/document/HeadingChunker';
import type { TextChunk } from '../../src/document/Chunker';

describe('HeadingChunker', () => {
  let chunker: HeadingChunker;

  beforeEach(() => {
    chunker = new HeadingChunker();
  });

  describe('chunk()', () => {
    it('should return empty array for empty markdown', () => {
      const chunks = chunker.chunk('');
      expect(chunks).toEqual([]);
    });

    it('should create a single root chunk for text without headings', () => {
      const markdown = 'This is some plain text without any headings.';
      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(1);
      expect(chunks[0].level).toBe(0);
      expect(chunks[0].heading).toBe('');
      expect(chunks[0].content).toContain('This is some plain text');
    });

    it('should split by h1 headings', () => {
      const markdown = `# Introduction

This is the introduction.

# Getting Started

This is getting started content.`;

      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(2);
      expect(chunks[0].heading).toBe('Introduction');
      expect(chunks[0].level).toBe(1);
      expect(chunks[1].heading).toBe('Getting Started');
      expect(chunks[1].level).toBe(1);
    });

    it('should create nested structure for h1 and h2', () => {
      const markdown = `# Chapter 1

Chapter 1 introduction.

## Section 1.1

Section 1.1 content.

## Section 1.2

Section 1.2 content.

# Chapter 2

Chapter 2 content.`;

      const chunks = chunker.chunk(markdown);

      // Should have 2 top-level chunks (h1)
      expect(chunks.length).toBe(2);
      expect(chunks[0].heading).toBe('Chapter 1');
      expect(chunks[0].children.length).toBe(2);
      expect(chunks[0].children[0].heading).toBe('Section 1.1');
      expect(chunks[0].children[1].heading).toBe('Section 1.2');
      expect(chunks[1].heading).toBe('Chapter 2');
    });

    it('should track startOffset and endOffset correctly', () => {
      const markdown = `# First

Content.

# Second

More content.`;

      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(2);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBeLessThan(markdown.length);
      expect(chunks[1].startOffset).toBeGreaterThan(0);
      expect(chunks[1].endOffset).toBe(markdown.length);

      // Chunks should be contiguous
      expect(chunks[1].startOffset).toBe(chunks[0].endOffset);
    });

    it('should generate unique IDs for each chunk', () => {
      const markdown = `# A
## B
## C
# D`;

      const chunks = chunker.chunk(markdown);
      const flattened = chunker.flatten(chunks);

      const ids = new Set(flattened.map(c => c.id));
      expect(ids.size).toBe(flattened.length);
    });

    it('should build correct path for nested headings', () => {
      const markdown = `# Parent
## Child
### Grandchild`;

      const chunks = chunker.chunk(markdown);

      // path 包含从根到当前的所有标题
      expect(chunks[0].path).toEqual(['Parent']);
      expect(chunks[0].children[0].path).toEqual(['Parent', 'Child']);
      expect(chunks[0].children[0].children[0].path).toEqual(['Parent', 'Child', 'Grandchild']);
    });

    it('should set parentId for child chunks', () => {
      const markdown = `# Parent
## Child`;

      const chunks = chunker.chunk(markdown);

      expect(chunks[0].parentId).toBeUndefined();
      expect(chunks[0].children[0].parentId).toBe(chunks[0].id);
    });

    it('should handle multiple levels of nesting', () => {
      const markdown = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;

      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(1);
      expect(chunks[0].level).toBe(1);

      let current = chunks[0];
      for (let level = 2; level <= 6; level++) {
        expect(current.children.length).toBe(1);
        current = current.children[0];
        expect(current.level).toBe(level);
      }
    });

    it('should handle skipped heading levels', () => {
      // h1 直接跳到 h3
      const markdown = `# H1
### H3`;

      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(1);
      expect(chunks[0].level).toBe(1);
      // h3 应该作为 h1 的子级（即使跳过了 h2）
      expect(chunks[0].children.length).toBe(1);
      expect(chunks[0].children[0].level).toBe(3);
    });
  });

  describe('flatten()', () => {
    it('should flatten nested chunks', () => {
      const markdown = `# Parent
## Child 1
### Grandchild
## Child 2`;

      const chunks = chunker.chunk(markdown);
      const flattened = chunker.flatten(chunks);

      expect(flattened.length).toBe(4);
      expect(flattened.map(c => c.heading)).toEqual([
        'Parent',
        'Child 1',
        'Grandchild',
        'Child 2',
      ]);
    });

    it('should preserve depth-first order', () => {
      const markdown = `# A
## A1
## A2
# B
## B1`;

      const chunks = chunker.chunk(markdown);
      const flattened = chunker.flatten(chunks);

      expect(flattened.map(c => c.heading)).toEqual([
        'A', 'A1', 'A2', 'B', 'B1',
      ]);
    });
  });

  describe('edge cases', () => {
    it('should handle markdown with only headings', () => {
      const markdown = `# One
# Two
# Three`;

      const chunks = chunker.chunk(markdown);

      expect(chunks.length).toBe(3);
      chunks.forEach(c => {
        expect(c.content).toBeDefined();
      });
    });

    it('should handle headings with special characters', () => {
      const markdown = `# Hello "World"
## It's *markdown*
### Code: \`foo\``;

      const chunks = chunker.chunk(markdown);

      expect(chunks[0].heading).toBe('Hello "World"');
      expect(chunks[0].children[0].heading).toBe("It's *markdown*");
      expect(chunks[0].children[0].children[0].heading).toBe('Code: `foo`');
    });

    it('should handle content before first heading', () => {
      const markdown = `Preamble text.

# First Heading

Content.`;

      const chunks = chunker.chunk(markdown);

      // Preamble should be a chunk with level 0
      expect(chunks[0].level).toBe(0);
      expect(chunks[0].content).toContain('Preamble');
      expect(chunks[1].heading).toBe('First Heading');
    });

    it('should handle code blocks with # symbols', () => {
      const markdown = `# Real Heading

Some text.

\`\`\`bash
# This is a comment, not a heading
echo "hello"
\`\`\`

More text.`;

      const chunks = chunker.chunk(markdown);

      // Should only have 1 heading chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].heading).toBe('Real Heading');
      expect(chunks[0].content).toContain('# This is a comment');
    });
  });
});

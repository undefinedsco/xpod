/**
 * JinaDocumentParser 单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JinaDocumentParser } from '../../src/document/JinaDocumentParser';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('JinaDocumentParser', () => {
  let parser: JinaDocumentParser;

  beforeEach(() => {
    parser = new JinaDocumentParser({ apiKey: 'test-api-key' });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('parse()', () => {
    it('should parse URL and return markdown', async () => {
      const mockMarkdown = '# Test Document\n\nThis is test content.';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => mockMarkdown,
      });

      const result = await parser.parse('https://example.com/doc.html');

      expect(result.markdown).toBe(mockMarkdown);
      expect(result.rawUrl).toBe('https://example.com/doc.html');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('r.jina.ai'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        }),
      );
    });

    it('should encode URL correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '# Content',
      });

      await parser.parse('https://example.com/path?query=value&foo=bar');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('r.jina.ai');
      expect(calledUrl).toContain(encodeURIComponent('https://example.com/path?query=value&foo=bar'));
    });

    it('should throw error when request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(parser.parse('https://example.com/doc.html'))
        .rejects.toThrow('JINA parse failed');
    });

    it('should extract metadata from markdown', async () => {
      const markdown = `Title: My Document
URL Source: https://example.com/doc.html

# My Document

Content here.`;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => markdown,
      });

      const result = await parser.parse('https://example.com/doc.html');

      expect(result.metadata?.title).toBe('My Document');
    });

    it('should use custom base URL if provided', async () => {
      parser = new JinaDocumentParser({
        apiKey: 'test-key',
        baseUrl: 'https://custom.jina.ai/reader',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '# Content',
      });

      await parser.parse('https://example.com/doc.html');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('custom.jina.ai');
    });
  });

  describe('supports()', () => {
    it('should support http URLs', () => {
      expect(parser.supports('http://example.com/page.html')).toBe(true);
    });

    it('should support https URLs', () => {
      expect(parser.supports('https://example.com/page.html')).toBe(true);
    });

    it('should not support file URLs', () => {
      expect(parser.supports('file:///path/to/file.txt')).toBe(false);
    });

    it('should not support relative paths', () => {
      expect(parser.supports('/path/to/file.txt')).toBe(false);
    });

    it('should support various document types', () => {
      expect(parser.supports('https://example.com/doc.pdf')).toBe(true);
      expect(parser.supports('https://example.com/doc.html')).toBe(true);
      expect(parser.supports('https://example.com/page')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(parser.parse('https://example.com/doc.html'))
        .rejects.toThrow('Network error');
    });

    it('should handle rate limiting', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });

      await expect(parser.parse('https://example.com/doc.html'))
        .rejects.toThrow('JINA parse failed');
    });

    it('should handle empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

      const result = await parser.parse('https://example.com/doc.html');
      expect(result.markdown).toBe('');
    });
  });
});

/**
 * JinaReader 单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JinaReader } from '../../src/document/JinaReader';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('JinaReader', () => {
  let reader: JinaReader;

  beforeEach(() => {
    reader = new JinaReader({ apiKey: 'test-api-key' });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('read()', () => {
    it('should read URL and return markdown', async () => {
      const mockMarkdown = '# Test Document\n\nThis is test content.';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => mockMarkdown,
      });

      const result = await reader.read('https://example.com/doc.html');

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

      await reader.read('https://example.com/path?query=value&foo=bar');

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

      await expect(reader.read('https://example.com/doc.html'))
        .rejects.toThrow('JINA read failed');
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

      const result = await reader.read('https://example.com/doc.html');

      expect(result.metadata?.title).toBe('My Document');
    });

    it('should use custom base URL if provided', async () => {
      reader = new JinaReader({
        apiKey: 'test-key',
        baseUrl: 'https://custom.jina.ai/reader',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '# Content',
      });

      await reader.read('https://example.com/doc.html');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('custom.jina.ai');
    });
  });

  describe('supports()', () => {
    it('should support http URLs', () => {
      expect(reader.supports('http://example.com/page.html')).toBe(true);
    });

    it('should support https URLs', () => {
      expect(reader.supports('https://example.com/page.html')).toBe(true);
    });

    it('should not support file URLs', () => {
      expect(reader.supports('file:///path/to/file.txt')).toBe(false);
    });

    it('should not support relative paths', () => {
      expect(reader.supports('/path/to/file.txt')).toBe(false);
    });

    it('should support various document types', () => {
      expect(reader.supports('https://example.com/doc.pdf')).toBe(true);
      expect(reader.supports('https://example.com/doc.html')).toBe(true);
      expect(reader.supports('https://example.com/page')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(reader.read('https://example.com/doc.html'))
        .rejects.toThrow('Network error');
    });

    it('should handle rate limiting', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });

      await expect(reader.read('https://example.com/doc.html'))
        .rejects.toThrow('JINA read failed');
    });

    it('should handle empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

      const result = await reader.read('https://example.com/doc.html');
      expect(result.markdown).toBe('');
    });
  });
});

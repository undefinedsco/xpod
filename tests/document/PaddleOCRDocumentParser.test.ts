import { describe, expect, it, vi } from 'vitest';
import { PaddleOCRDocumentParser } from '../../src/document/PaddleOCRDocumentParser';

describe('PaddleOCRDocumentParser', () => {
  it('delegates document parsing to an injected PaddleOCR client without bundling the SDK', async () => {
    const parseDocument = vi.fn().mockResolvedValue({
      markdown: '# Parsed\n\ncontent',
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
    });
    const parser = new PaddleOCRDocumentParser({
      token: 'paddle-token',
      model: 'pp-ocrv6',
      client: { parseDocument },
    });

    const result = await parser.parse('https://example.com/report.pdf', {
      pageRange: '1-2',
      expectedUse: 'structure-probe',
    });

    expect(parseDocument).toHaveBeenCalledWith(expect.objectContaining({
      fileUrl: 'https://example.com/report.pdf',
      model: 'pp-ocrv6',
      pageRange: '1-2',
    }));
    expect(result.markdown).toBe('# Parsed\n\ncontent');
    expect(result.metadata.parserProvider).toBe('paddleocr');
    expect(result.metadata.pageRange).toBe('1-2');
    expect(result.metadata.pageCount).toBe(2);
  });
});

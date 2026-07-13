import { describe, expect, it, vi } from 'vitest';
import { PaddleOcrReader } from '../../src/document/PaddleOcrReader';

describe('PaddleOcrReader', () => {
  it('delegates document reading to an injected PaddleOCR client without bundling the SDK', async () => {
    const readDocument = vi.fn().mockResolvedValue({
      markdown: '# Read\n\ncontent',
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
    });
    const reader = new PaddleOcrReader({
      token: 'paddle-token',
      model: 'pp-ocrv6',
      client: { readDocument },
    });

    const result = await reader.read('https://example.com/report.pdf', {
      pageRange: '1-2',
      expectedUse: 'structure-probe',
    });

    expect(readDocument).toHaveBeenCalledWith(expect.objectContaining({
      fileUrl: 'https://example.com/report.pdf',
      model: 'pp-ocrv6',
      pageRange: '1-2',
    }));
    expect(result.markdown).toBe('# Read\n\ncontent');
    expect(result.metadata.readerProvider).toBe('paddleocr');
    expect(result.metadata.pageRange).toBe('1-2');
    expect(result.metadata.pageCount).toBe(2);
  });
});

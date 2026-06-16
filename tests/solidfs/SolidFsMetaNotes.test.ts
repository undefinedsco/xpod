import { describe, expect, it } from 'vitest';
import { buildFileMetadataNote, buildParserCoverageNote } from '../../src/solidfs';

describe('SolidFS .meta notes', () => {
  it('builds file metadata note triples without exposing storage secrets', () => {
    const ttl = buildFileMetadataNote({
      subject: '#file',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Remote PDF object, hydrate before reading full bytes.',
      mediaType: 'application/pdf',
      byteSize: 123456789,
      contentHash: 'sha256:abc',
      materializationClass: 'placeholder-r2',
    });

    expect(ttl).toContain('<#file> a udfs:Note');
    expect(ttl).toContain('sioc:about <./report.pdf>');
    expect(ttl).toContain('udfs:materializationClass "placeholder-r2"');
    expect(ttl).not.toContain('signed');
    expect(ttl).not.toContain('bucket');
    expect(ttl).not.toContain('cachePath');
  });

  it('builds parser coverage note with partial page coverage', () => {
    const ttl = buildParserCoverageNote({
      subject: '#parser-pdf-v1',
      about: './report.pdf',
      parserKind: 'pdf',
      parserVersion: 'pdf-v1',
      coverageUnit: 'page',
      coveredRange: '1-12',
      parsedUnits: 12,
      totalUnits: 240,
      status: 'partial',
    });

    expect(ttl).toContain('udfs:noteKind "parser-coverage"');
    expect(ttl).toContain('udfs:coveredRange "1-12"');
    expect(ttl).toContain('udfs:parsedUnits 12');
    expect(ttl).toContain('udfs:totalUnits 240');
  });
});

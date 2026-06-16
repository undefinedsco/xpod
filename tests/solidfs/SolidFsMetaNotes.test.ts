import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { buildFileMetadataNote, buildParserCoverageNote } from '../../src/solidfs';

function parseTurtle(ttl: string): void {
  new Parser().parse(ttl);
}

describe('SolidFS .meta notes', () => {
  it('builds parseable file metadata note triples without exposing storage secrets', () => {
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

    parseTurtle(ttl);
    expect(ttl).toContain('<#file> a udfs:Note');
    expect(ttl).toContain('sioc:about <./report.pdf>');
    expect(ttl).toContain('udfs:materializationClass "placeholder-r2"');
    expect(ttl).not.toContain('signed');
    expect(ttl).not.toContain('bucket');
    expect(ttl).not.toContain('cachePath');
  });

  it('builds parseable parser coverage note with partial page coverage', () => {
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

    parseTurtle(ttl);
    expect(ttl).toContain('udfs:noteKind "parser-coverage"');
    expect(ttl).toContain('udfs:coveredRange "1-12"');
    expect(ttl).toContain('udfs:parsedUnits 12');
    expect(ttl).toContain('udfs:totalUnits 240');
  });

  it('percent-encodes spaces in IRI terms and remains parseable', () => {
    const ttl = buildFileMetadataNote({
      subject: '#file metadata',
      about: './reports/final report.pdf',
      title: 'File metadata',
      description: 'Path contains spaces.',
      materializationClass: 'byline-local',
    });

    parseTurtle(ttl);
    expect(ttl).toContain('<#file%20metadata> a udfs:Note');
    expect(ttl).toContain('sioc:about <./reports/final%20report.pdf>');
  });

  it('rejects IRI terms containing close-angle injection characters', () => {
    expect(() => buildFileMetadataNote({
      subject: '#file> ; udfs:noteKind "injected"',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Unsafe subject.',
      materializationClass: 'placeholder-r2',
    })).toThrow();

    expect(() => buildFileMetadataNote({
      subject: '<#file> ; udfs:noteKind "injected">',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Unsafe wrapped subject.',
      materializationClass: 'placeholder-r2',
    })).toThrow();
  });

  it('rejects malformed blank node terms', () => {
    expect(() => buildFileMetadataNote({
      subject: '_:bad node',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Unsafe blank node.',
      materializationClass: 'placeholder-r2',
    })).toThrow();
  });

  it.each([
    ['byteSize', Number.NaN],
    ['byteSize', Number.POSITIVE_INFINITY],
    ['byteSize', -1],
    ['byteSize', 1.5],
  ])('rejects invalid file metadata numeric field %s=%s', (_field, byteSize) => {
    expect(() => buildFileMetadataNote({
      subject: '#file',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Invalid byte size.',
      byteSize,
      materializationClass: 'placeholder-r2',
    })).toThrow(RangeError);
  });

  it.each([
    ['parsedUnits', Number.NaN],
    ['parsedUnits', Number.POSITIVE_INFINITY],
    ['parsedUnits', -1],
    ['parsedUnits', 1.5],
    ['totalUnits', Number.NaN],
    ['totalUnits', Number.POSITIVE_INFINITY],
    ['totalUnits', -1],
    ['totalUnits', 1.5],
  ])('rejects invalid parser coverage numeric field %s=%s', (field, value) => {
    expect(() => buildParserCoverageNote({
      subject: '#parser-pdf-v1',
      about: './report.pdf',
      parserKind: 'pdf',
      parserVersion: 'pdf-v1',
      coverageUnit: 'page',
      coveredRange: '1-12',
      parsedUnits: field === 'parsedUnits' ? value : 12,
      totalUnits: field === 'totalUnits' ? value : 240,
      status: 'partial',
    })).toThrow(RangeError);
  });
});

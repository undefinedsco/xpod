import { UDFS, FILE_METADATA_NOTE_KIND, READER_COVERAGE_NOTE_KIND } from '@undefineds.co/models';
import { FileMetadataNoteVocab, ReaderCoverageNoteVocab } from '@undefineds.co/models/vocab';
import { buildFileMetadataNote as publicHelper } from '@undefineds.co/xpod-afs/workcopy/SolidFsMetaNotes';
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { buildFileMetadataNote, buildReaderCoverageNote } from '../../src/solidfs';

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

  it('builds parseable reader coverage note with partial page coverage', () => {
    const ttl = buildReaderCoverageNote({
      subject: '#reader-pdf-v1',
      about: './report.pdf',
      readerKind: 'pdf',
      readerVersion: 'pdf-v1',
      coverageUnit: 'page',
      coveredRange: '1-12',
      readUnits: 12,
      totalUnits: 240,
      status: 'partial',
    });

    parseTurtle(ttl);
    expect(ttl).toContain('udfs:noteKind "reader-coverage"');
    expect(ttl).toContain('udfs:coveredRange "1-12"');
    expect(ttl).toContain('udfs:readUnits 12');
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

  it('preserves already-encoded IRI terms without double-encoding percent escapes', () => {
    const ttl = buildFileMetadataNote({
      subject: '<https://pod.example/files/final%20report.pdf#meta>',
      about: 'https://pod.example/files/final%20report.pdf',
      title: 'File metadata',
      description: 'IRI already contains percent-encoded spaces.',
      materializationClass: 'placeholder-r2',
    });

    parseTurtle(ttl);
    expect(ttl).toContain('<https://pod.example/files/final%20report.pdf#meta> a udfs:Note');
    expect(ttl).toContain('sioc:about <https://pod.example/files/final%20report.pdf>');
    expect(ttl).not.toContain('%2520');
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
    ['readUnits', Number.NaN],
    ['readUnits', Number.POSITIVE_INFINITY],
    ['readUnits', -1],
    ['readUnits', 1.5],
    ['totalUnits', Number.NaN],
    ['totalUnits', Number.POSITIVE_INFINITY],
    ['totalUnits', -1],
    ['totalUnits', 1.5],
  ])('rejects invalid reader coverage numeric field %s=%s', (field, value) => {
    expect(() => buildReaderCoverageNote({
      subject: '#reader-pdf-v1',
      about: './report.pdf',
      readerKind: 'pdf',
      readerVersion: 'pdf-v1',
      coverageUnit: 'page',
      coveredRange: '1-12',
      readUnits: field === 'readUnits' ? value : 12,
      totalUnits: field === 'totalUnits' ? value : 240,
      status: 'partial',
    })).toThrow(RangeError);
  });
});

it('keeps the root compatibility export identical to the public AFS helper', () => { expect(buildFileMetadataNote).toBe(publicHelper); });


it('uses the shared canonical vocabulary and typed integers for exact note subjects', () => {
  const subject = 'https://pod.example/notes/file.ttl#metadata';
  const about = 'https://pod.example/files/report.pdf';
  const file = new Parser().parse(buildFileMetadataNote({ subject, about, title: 'File', description: 'Metadata', byteSize: 24, materializationClass: 'hydrated-r2' }));
  const readerSubject = 'https://pod.example/notes/file.ttl#coverage';
  const reader = new Parser().parse(buildReaderCoverageNote({ subject: readerSubject, about, readerKind: 'pdf', readerVersion: 'v1', coverageUnit: 'page', coveredRange: '1-2', readUnits: 2, totalUnits: 3, status: 'partial' }));
  for (const [quads, expectedSubject, vocab, kind] of [[file, subject, FileMetadataNoteVocab, FILE_METADATA_NOTE_KIND], [reader, readerSubject, ReaderCoverageNoteVocab, READER_COVERAGE_NOTE_KIND]] as const) {
    expect(quads.every(quad => quad.subject.value === expectedSubject)).toBe(true);
    expect(quads.find(quad => quad.predicate.value === vocab.about)?.object.value).toBe(about);
    expect(quads.find(quad => quad.predicate.value === vocab.noteKind)?.object.value).toBe(kind);
    expect(quads.find(quad => quad.predicate.value === vocab.type)?.object.value).toBe(vocab.noteType);
    expect(quads.some(quad => quad.predicate.value.startsWith('https://vocab.undefineds.co/udfs#'))).toBe(false);
  }
  expect(reader.find(quad => quad.predicate.value === ReaderCoverageNoteVocab.status)?.object.value).toBe('partial');
  expect(file.find(quad => quad.predicate.value === FileMetadataNoteVocab.materializationClass)?.object.value).toBe('hydrated-r2');
  for (const [quads, predicate, value] of [[file, UDFS.byteSize, '24'], [reader, UDFS.readUnits, '2'], [reader, UDFS.totalUnits, '3']] as const) {
    const object = quads.find(quad => quad.predicate.value === predicate)?.object;
    expect(object?.value).toBe(value);
    expect(object?.termType).toBe('Literal');
    if (object?.termType === 'Literal') expect(object.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
  }
});

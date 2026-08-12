import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MarkdownRetrievalPointProjector,
  READER_CHUNK_POLICY_VERSION,
} from '../../src/document/MarkdownRetrievalPointProjector';

describe('MarkdownRetrievalPointProjector', () => {
  const markdown = [
    '# H1',
    '',
    'Intro paragraph marker.',
    '',
    '## H2',
    '',
    'Nested paragraph marker.',
    '',
    '- list marker one',
    '- list marker two',
    '',
    '> quoted marker',
    '',
    '| Column | Value |',
    '| ------ | ----- |',
    '| table-shaped | marker |',
    '',
    '```ts',
    'const codeMarker = "present";',
    '```',
    '',
    '### Empty',
    '',
    '## Next',
    '',
    'Next section marker.',
  ].join('\n');

  it('projects markdown structural leaves into deterministic retrieval points', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const input = {
      sourceKey: 'urn:xpod:source:1',
      sourceUri: 'https://pod.example/a.pdf',
      representationHash: 'sha256:markdown-v1',
      markdown,
    };

    const first = projector.project(input);
    const second = projector.project(input);

    expect(second).toEqual(first);
    expect(first.every((point) => point.chunkKey === point.retrievalPointKey)).toBe(true);
    expect(first.every((point) => point.sourceKey === 'urn:xpod:source:1')).toBe(true);
    expect(first.every((point) => point.sourceUri === 'https://pod.example/a.pdf')).toBe(true);
    expect(first.every((point) => point.chunkPolicyVersion === READER_CHUNK_POLICY_VERSION)).toBe(true);
    expect(first.map((point) => point.sectionPath)).toContain('H1 / H2');
    expect(first.map((point) => point.content)).toEqual(expect.arrayContaining([
      'Intro paragraph marker.',
      'Nested paragraph marker.',
      'list marker one\nlist marker two',
      'quoted marker',
      '| Column | Value |\n| ------ | ----- |\n| table-shaped | marker |',
      'const codeMarker = "present";',
      'Next section marker.',
    ]));
    expect(first.some((point) => point.sectionPath === 'H1 / Empty')).toBe(false);
    expect(first.map((point) => point.ordinal)).toEqual(first.map((_, index) => index));
  });

  it('keys identity from source key, content hash, policy, structural path, subdivision, and text', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const base = {
      sourceKey: 'urn:xpod:source:stable',
      sourceUri: 'https://pod.example/docs/old.pdf',
      representationHash: 'sha256:markdown-v1',
      markdown: '# Stable\n\nmove-safe marker',
    };

    const [original] = projector.project(base);
    const [moved] = projector.project({
      ...base,
      sourceUri: 'https://pod.example/archive/new.pdf',
    });
    const [changedHash] = projector.project({
      ...base,
      representationHash: 'sha256:markdown-v2',
    });
    const [changedText] = projector.project({
      ...base,
      markdown: '# Stable\n\nmove-safe changed marker',
    });

    expect(moved.retrievalPointKey).toBe(original.retrievalPointKey);
    expect(moved.sourceUri).toBe('https://pod.example/archive/new.pdf');
    expect(changedHash.retrievalPointKey).not.toBe(original.retrievalPointKey);
    expect(changedText.retrievalPointKey).not.toBe(original.retrievalPointKey);
    expect(original.retrievalPointKey).toBe(createHash('sha256')
      .update([
        base.sourceKey,
        base.representationHash,
        READER_CHUNK_POLICY_VERSION,
        original.structuralPath,
        String(original.subdivisionOrdinal),
        original.content,
      ].join('\u0000'))
      .digest('hex'));
  });

  it('keeps keys unique for repeated same-name sections with identical text', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const points = projector.project({
      sourceKey: 'urn:xpod:source:repeated',
      sourceUri: 'https://pod.example/repeated.pdf',
      representationHash: 'sha256:repeated',
      markdown: [
        '# A',
        '## X',
        'same',
        '# A',
        '## X',
        'same',
      ].join('\n\n'),
    });

    expect(points).toHaveLength(2);
    expect(points.map((point) => point.sectionPath)).toEqual(['A / X', 'A / X']);
    expect(new Set(points.map((point) => point.retrievalPointKey)).size).toBe(2);
  });

  it('uses raw structural node ranges unless leaf text exactly matches the source slice', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const markdown = [
      '# Ranges',
      '',
      '**plain**',
      '',
      '- item one',
      '- item two',
      '',
      '> quoted text',
      '',
      '```ts',
      'const code = "range";',
      '```',
    ].join('\n');

    const points = projector.project({
      sourceKey: 'urn:xpod:source:ranges',
      sourceUri: 'https://pod.example/ranges.pdf',
      representationHash: 'sha256:ranges',
      markdown,
    });
    const byContent = new Map(points.map((point) => [point.content, point]));

    for (const [raw, content] of [
      ['**plain**', 'plain'],
      ['- item one\n- item two', 'item one\nitem two'],
      ['> quoted text', 'quoted text'],
      ['```ts\nconst code = "range";\n```', 'const code = "range";'],
    ] as const) {
      const point = byContent.get(content);
      expect(point).toBeDefined();
      const start = markdown.indexOf(raw);
      const end = start + raw.length;
      expect(point).toMatchObject({
        startOffset: start,
        endOffset: end,
        startByte: Buffer.byteLength(markdown.slice(0, start), 'utf8'),
        endByte: Buffer.byteLength(markdown.slice(0, end), 'utf8'),
      });
    }
  });

  it('projects image alt text as leaf content', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const points = projector.project({
      sourceKey: 'urn:xpod:source:image-alt',
      sourceUri: 'https://pod.example/image-alt.pdf',
      representationHash: 'sha256:image-alt',
      markdown: '# Figures\n\n![Architecture diagram](./diagram.png)',
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      sectionPath: 'Figures',
      content: 'Architecture diagram',
    });
  });

  it('preserves hard breaks and nested list block boundaries', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const points = projector.project({
      sourceKey: 'urn:xpod:source:block-boundaries',
      sourceUri: 'https://pod.example/block-boundaries.pdf',
      representationHash: 'sha256:block-boundaries',
      markdown: [
        '# Boundaries',
        '',
        'a\\',
        'b',
        '',
        '- parent',
        '  - child',
        '',
        '> quote parent',
        '>',
        '> quote child',
        '',
        'Inline **strong** [link](https://example.test) text.',
      ].join('\n'),
    });

    expect(points.map((point) => point.content)).toEqual([
      'a\nb',
      'parent\nchild',
      'quote parent\nquote child',
      'Inline strong link text.',
    ]);
  });

  it('splits oversized leaves on valid UTF-8 boundaries deterministically', () => {
    const projector = new MarkdownRetrievalPointProjector();
    const oversized = `${'a'.repeat(9000)}中文🙂${'b'.repeat(9000)}`;
    const markdown = `# Oversized\n\n${oversized}`;
    const points = projector.project({
      sourceKey: 'urn:xpod:source:oversized',
      sourceUri: 'https://pod.example/oversized.pdf',
      representationHash: 'sha256:oversized',
      markdown,
    });
    const textStart = markdown.indexOf(oversized);

    expect(points.length).toBeGreaterThan(1);
    expect(points.map((point) => point.subdivisionOrdinal)).toEqual(points.map((_, index) => index));
    expect(points.map((point) => point.content).join('')).toBe(oversized);
    for (const point of points) {
      expect(Buffer.byteLength(point.content, 'utf8')).toBeLessThanOrEqual(8192);
      expect(point.content).not.toContain('\uFFFD');
      expect(point.startByte).toBeLessThan(point.endByte);
      const priorText = points
        .slice(0, point.subdivisionOrdinal)
        .map((part) => part.content)
        .join('');
      expect(point.startOffset).toBe(textStart + priorText.length);
      expect(point.endOffset).toBe(point.startOffset + point.content.length);
      expect(point.startByte).toBe(Buffer.byteLength(markdown.slice(0, point.startOffset), 'utf8'));
      expect(point.endByte).toBe(Buffer.byteLength(markdown.slice(0, point.endOffset), 'utf8'));
    }
  });
});

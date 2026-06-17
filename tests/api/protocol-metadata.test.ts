import { describe, expect, it } from 'vitest';
import { getProtocolMetadata, withProtocolMetadata } from '../../src/api/protocol-metadata';

describe('protocol metadata helpers', () => {
  it('reads object-shaped protocol metadata', () => {
    expect(getProtocolMetadata({
      protocols: {
        matrix: {
          roomId: '!room:example.com',
        },
      },
    }, 'matrix')).toEqual({
      roomId: '!room:example.com',
    });
  });

  it('reads and merges RDF-hydrated array-shaped protocol metadata', () => {
    expect(getProtocolMetadata({
      protocols: [
        {
          matrix: {
            roomId: '!room:example.com',
            visibility: 'private',
          },
        },
        {
          matrix: {
            roomVersion: '11',
          },
        },
        {
          chatkit: {
            threadId: 'thread-1',
          },
        },
      ],
    }, 'matrix')).toEqual({
      roomId: '!room:example.com',
      visibility: 'private',
      roomVersion: '11',
    });
  });

  it('writes protocol metadata in canonical object shape', () => {
    expect(withProtocolMetadata({ protocol: 'matrix' }, 'matrix', {
      roomId: '!room:example.com',
    })).toEqual({
      protocol: 'matrix',
      protocols: {
        matrix: {
          roomId: '!room:example.com',
        },
      },
    });
  });
});

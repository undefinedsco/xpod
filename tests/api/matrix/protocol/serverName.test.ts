import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { isMatrixServerName, splitServerName, webIdServerName, matrixUserIdFor } from '../../../../src/api/matrix/protocol/serverName';

describe('server name grammar', () => {
  it('accepts hostnames, IP literals and ports', () => {
    for (const name of [ 'example.com', 'a.b.c.example', 'localhost', 'EXAMPLE.com', '[::1]', 'example.com:8448', '[2001:db8::1]:443' ]) {
      expect(isMatrixServerName(name), name).toBe(true);
    }
  });

  it('refuses names that could steer a request elsewhere', () => {
    for (const name of [ '', 'example.com/path', 'user@example.com', 'example.com?x=1', 'example.com#f', 'exa mple.com', '-bad.example', 'example.com:0', 'example.com:99999', 'example.com:abc', 'a..b' ]) {
      expect(isMatrixServerName(name), name).toBe(false);
    }
  });

  it('splits server names into host and port', () => {
    expect(splitServerName('example.com')).toEqual({ host: 'example.com' });
    expect(splitServerName('example.com:8448')).toEqual({ host: 'example.com', port: 8448 });
    expect(splitServerName('[::1]')).toEqual({ host: '::1' });
    expect(splitServerName('[::1]:8448')).toEqual({ host: '::1', port: 8448 });
  });

  it('derives a server name from a WebID host, and nothing from a useless one', () => {
    expect(webIdServerName('https://alice.example/profile/card#me')).toBe('alice.example');
    expect(webIdServerName('https://alice.example:8448/profile/card#me')).toBe('alice.example:8448');
    // Not a URL, or a URL without a host: nothing to sign as.
    expect(webIdServerName('not a url')).toBeUndefined();
    expect(webIdServerName('mailto:alice@example.com')).toBeUndefined();
    expect(webIdServerName('')).toBeUndefined();
  });
});

describe('the MXID an identity has under a server name', () => {
  it('derives it from the identity itself, so nothing has to be recorded or migrated', () => {
    const expected = `@u_${createHash('sha256').update('https://alice.example/card#me').digest('hex')}:alice.example`;
    expect(matrixUserIdFor('https://alice.example/card#me', 'alice.example')).toBe(expected);
    // The same rule serves an agent's own URI: an agent is a room member with its own identity, so
    // participants and agents must not end up with two spellings of the same derivation.
    const agent = matrixUserIdFor('https://pod.example/alice/.data/agents/scribe.ttl#this', 'alice.example');
    expect(agent.startsWith('@u_')).toBe(true);
    expect(agent.endsWith(':alice.example')).toBe(true);
    expect(agent).toBe(matrixUserIdFor('https://pod.example/alice/.data/agents/scribe.ttl#this', 'alice.example'));
    // Different identity, different MXID; different server, different MXID.
    expect(agent).not.toBe(matrixUserIdFor('https://pod.example/alice/.data/agents/other.ttl#this', 'alice.example'));
    expect(agent).not.toBe(matrixUserIdFor('https://pod.example/alice/.data/agents/scribe.ttl#this', 'bob.example'));
  });
});

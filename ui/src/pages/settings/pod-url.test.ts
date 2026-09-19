import { describe, expect, it } from 'vitest';
import { reachablePodUrl } from './pod-url';

describe('reachablePodUrl', () => {
  it('keeps the Pod path but resolves it against the authority serving the app', () => {
    // The desktop shell runs on loopback while the runtime reports the node's
    // canonical public origin, which has no working route in the renderer.
    expect(reachablePodUrl(
      'https://7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co/glocal/',
      'http://127.0.0.1:3000',
    )).toBe('http://127.0.0.1:3000/glocal/');
  });

  it('leaves the address untouched when the app already is the Pod authority', () => {
    expect(reachablePodUrl(
      'https://pod.example/glocal/',
      'https://pod.example',
    )).toBe('https://pod.example/glocal/');
  });

  it('reports nothing to open instead of guessing', () => {
    expect(reachablePodUrl(undefined, 'http://127.0.0.1:3000')).toBeUndefined();
    expect(reachablePodUrl('', 'http://127.0.0.1:3000')).toBeUndefined();
    expect(reachablePodUrl('not a url', 'http://127.0.0.1:3000')).toBeUndefined();
  });
});

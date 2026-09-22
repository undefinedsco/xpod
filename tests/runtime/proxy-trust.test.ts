import { describe, expect, it } from 'vitest';
import type http from 'node:http';
import { forwardedFromOutside } from '../../src/runtime/Proxy';

/**
 * The Gateway is the single outward entry, so a tunnelled request arrives on the same port a
 * local one does. The forwarded chain is what separates them: a local dev proxy forwards this
 * machine's address, a provider edge appends the address it saw.
 */
function request(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  return { headers } as http.IncomingMessage;
}

describe('gateway trust for tunnelled traffic', () => {
  it('keeps a request with no forwarder local', () => {
    expect(forwardedFromOutside(request({}))).toBe(false);
  });

  it('keeps a request forwarded by this machine local', () => {
    expect(forwardedFromOutside(request({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(forwardedFromOutside(request({ 'x-forwarded-for': '::1' }))).toBe(false);
  });

  it('treats a request whose last forwarder is remote as remote', () => {
    expect(forwardedFromOutside(request({ 'x-forwarded-for': '203.0.113.7' }))).toBe(true);
  });

  it('cannot be made local by a client that sends its own loopback forwarded-for', () => {
    // The provider edge appends the address it saw after whatever the client sent.
    expect(forwardedFromOutside(request({ 'x-forwarded-for': '127.0.0.1, 203.0.113.7' }))).toBe(true);
  });

  it('treats an unreadable forwarder as remote rather than trusted', () => {
    expect(forwardedFromOutside(request({ 'x-forwarded-for': 'unknown' }))).toBe(true);
  });

  it('reads the whole address-bearing family, not only x-forwarded-for', () => {
    expect(forwardedFromOutside(request({ 'x-real-ip': '203.0.113.7' }))).toBe(true);
    expect(forwardedFromOutside(request({ forwarded: 'for=203.0.113.7;proto=https' }))).toBe(true);
    expect(forwardedFromOutside(request({ forwarded: 'for="[::1]"' }))).toBe(false);
    expect(forwardedFromOutside(request({ 'x-real-ip': '127.0.0.1' }))).toBe(false);
  });

  it('does not treat host/proto forwarding as address evidence', () => {
    // A local dev proxy sets these for local browsers too, so they would lock the
    // operator out of their own admin surface.
    expect(forwardedFromOutside(request({
      'x-forwarded-host': 'pod.example',
      'x-forwarded-proto': 'https',
    }))).toBe(false);
  });
});

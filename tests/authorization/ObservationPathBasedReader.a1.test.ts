import { describe, expect, it } from 'vitest';
import type { PermissionReader } from '@solid/community-server';
import { observationDispatchContext, ObservationPathBasedReader, type ObservationDispatchAudit } from '../../src/authorization/ObservationPathBasedReader';

const baseUrl = 'http://localhost/';
const defaultReader = { name: 'default' } as unknown as PermissionReader;
const internalReader = { name: 'internal' } as unknown as PermissionReader;

function dispatch(reader: ObservationPathBasedReader, path: string): PermissionReader | undefined {
  return (reader as unknown as { findReader(p: string): PermissionReader | undefined }).findReader(path);
}

function audit(): ObservationDispatchAudit {
  return { covered: new Set<string>(), targetCovered: new Set<string>(), phase: 'requester', stickyFailure: false };
}

describe('A1 observation PathBasedReader dispatch audit', () => {
  it('keeps ordinary behavior outside the observation context', () => {
    const reader = new ObservationPathBasedReader(baseUrl, {}, defaultReader);
    expect(dispatch(reader, 'http://localhost/room/doc')).toBe(defaultReader);
    expect(dispatch(reader, 'http://elsewhere/room/doc')).toBe(defaultReader);
  });

  it('records actual default-route coverage inside the observation context', () => {
    const reader = new ObservationPathBasedReader(baseUrl, {}, defaultReader);
    const state = audit();
    const path = 'http://localhost/room/doc';
    const resolved = observationDispatchContext.run(state, () => dispatch(reader, path));
    expect(resolved).toBe(defaultReader);
    expect(state.covered.has(path)).toBe(true);
    expect(state.stickyFailure).toBe(false);
  });

  it('keeps requester and target coverage distinct so one phase cannot certify the other', () => {
    const reader = new ObservationPathBasedReader(baseUrl, {}, defaultReader);
    const state = audit();
    const path = 'http://localhost/room/doc';
    observationDispatchContext.run(state, () => dispatch(reader, path));
    expect(state.covered.has(path)).toBe(true);
    expect(state.targetCovered.has(path)).toBe(false);
    state.phase = 'target';
    observationDispatchContext.run(state, () => dispatch(reader, path));
    expect(state.covered.has(path)).toBe(true);
    expect(state.targetCovered.has(path)).toBe(true);
  });

  it('retains sticky unsupported failure across a fresh call-specific coverage reset', () => {
    const state = audit();
    const path = 'http://localhost/room/doc';
    observationDispatchContext.run(state, () => dispatch(new ObservationPathBasedReader(baseUrl, {}, defaultReader), path));
    expect(state.covered.has(path)).toBe(true);
    // A fresh call clears only per-call coverage; a route mismatch still sticks so a later fallback
    // cannot re-qualify the call.
    state.covered.clear();
    state.targetCovered.clear();
    const mismatch = new ObservationPathBasedReader(baseUrl, { '^/room/doc': internalReader }, defaultReader);
    expect(() => observationDispatchContext.run(state, () => dispatch(mismatch, path))).toThrow();
    expect(state.covered.has(path)).toBe(false);
    expect(state.stickyFailure).toBe(true);
  });

  it('rejects and sticks when the actual route is not the bound default reader', () => {
    const reader = new ObservationPathBasedReader(baseUrl, { '^/room/internal/': internalReader }, defaultReader);
    const state = audit();
    expect(() => observationDispatchContext.run(state, () => dispatch(reader, 'http://localhost/room/internal/x')))
      .toThrow();
    expect(state.stickyFailure).toBe(true);
    expect(state.covered.size).toBe(0);
  });

  it('rejects a missing default route inside the observation context', () => {
    const reader = new ObservationPathBasedReader(baseUrl, {});
    const state = audit();
    expect(() => observationDispatchContext.run(state, () => dispatch(reader, 'http://localhost/room/doc'))).toThrow();
    expect(state.stickyFailure).toBe(true);
  });
});

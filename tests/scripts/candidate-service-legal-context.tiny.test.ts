/** No mocks: forged capability/closure/budget objects must never qualify. */
import { test, expect } from 'bun:test';
import { observeCandidateServiceLegal, candidateServiceLegalView } from '../../scripts/lib/independent-admission/candidate-service-legal';

test('legal adapter refuses fake capabilities, escaped budget and forged result objects', async () => {
  const live = { check() {}, remainingMs: () => 120000 };
  await expect(observeCandidateServiceLegal({ originals: {}, source: {}, runtimeMembers: {}, sourceClosure: {}, sdk: {}, budget: live })).rejects.toThrow(/issued/);
  await expect(observeCandidateServiceLegal({ originals: {}, source: {}, runtimeMembers: {}, sourceClosure: {}, sdk: {}, budget: { check() {}, remainingMs: () => 0 } })).rejects.toThrow('budget');
  let spentCalls = 0;
  const spent = { check() { spentCalls++; throw Error('parent deadline'); }, remainingMs: () => 1 };
  await expect(observeCandidateServiceLegal({ originals: {}, source: {}, runtimeMembers: {}, sourceClosure: {}, sdk: {}, budget: spent })).rejects.toThrow('parent deadline');
  expect(spentCalls).toBe(1);
  const fake = { status: 'verified', facts: { legalQualified: true } };
  expect(candidateServiceLegalView(fake, { originals: {}, source: {}, runtimeMembers: {}, sourceClosure: {}, sdk: {}, budget: live })).toBeUndefined();
  expect(candidateServiceLegalView({ ...fake }, { originals: {}, source: {}, runtimeMembers: {}, sourceClosure: {}, sdk: {}, budget: live })).toBeUndefined();
});

import { describe, expect, it } from 'vitest';
import { GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker, SingleRootIdentifierStrategy,
  SuffixAuxiliaryIdentifierStrategy } from '@solid/community-server';
import type {
  Authorizer,
  AuxiliaryIdentifierStrategy,
  CredentialsExtractor,
  IdentifierStrategy,
  PermissionReader,
  ResourceStore,
} from '@solid/community-server';
import { AgentReadObservation, type AgentReadObservationActual } from '../../src/authorization/AgentReadObservation';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import type { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import type { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';

const identifierStrategy = new SingleRootIdentifierStrategy('http://localhost/') as IdentifierStrategy;
const auxiliaryStrategy = new SuffixAuxiliaryIdentifierStrategy('.acr') as AuxiliaryIdentifierStrategy;
const locks = new HierarchicalReadWriteLocker(
  new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()), identifierStrategy);
const authorityStore = new LockingResourceStore({} as ResourceStore, locks, auxiliaryStrategy);
const permissionReader = { canHandle: async() => undefined } as unknown as PermissionReader;
const authorizer = {} as Authorizer;
const credentialsExtractor = {} as CredentialsExtractor;
const accessor = {} as MixDataAccessor;
const podLookup = {} as PodLookupRepository;

function capability(): AgentReadObservation {
  return new AgentReadObservation(permissionReader, authorizer, credentialsExtractor, accessor,
    authorityStore, locks, identifierStrategy, auxiliaryStrategy, auxiliaryStrategy);
}

function actual(overrides: Partial<AgentReadObservationActual> = {}): AgentReadObservationActual {
  return {
    permissionReader,
    authorizer,
    credentialsExtractor,
    accessor,
    authorityStore,
    locks,
    identifierStrategy,
    authStrategy: auxiliaryStrategy,
    auxiliaryStrategy,
    podLookup,
    ...overrides,
  };
}

describe('A1 AgentReadObservation identity qualification', () => {
  it('accepts the actual assembly identities with the shared authority locker', () => {
    expect(() => capability().qualify(actual())).not.toThrow();
  });

  it('refuses a mismatched reader', () => {
    expect(() => capability().qualify(actual({ permissionReader: {} as PermissionReader }))).toThrow();
  });

  it('refuses a mismatched quad accessor', () => {
    expect(() => capability().qualify(actual({ accessor: {} as MixDataAccessor }))).toThrow();
  });

  it('refuses a mismatched authorizer or credentials extractor', () => {
    expect(() => capability().qualify(actual({ authorizer: {} as Authorizer }))).toThrow();
    expect(() => capability().qualify(actual({ credentialsExtractor: {} as CredentialsExtractor }))).toThrow();
  });

  it('refuses a second locker and a mismatched authority store', () => {
    const other = new HierarchicalReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()), identifierStrategy);
    expect(() => capability().qualify(actual({ locks: other }))).toThrow();
    expect(() => capability().qualify(actual({ authorityStore: new LockingResourceStore({} as ResourceStore, other, auxiliaryStrategy) }))).toThrow();
  });

  it('refuses absent registered-Pod lookup', () => {
    expect(() => capability().qualify(actual({ podLookup: undefined }))).toThrow();
  });
});

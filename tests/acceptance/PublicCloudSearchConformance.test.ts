import { describe, expect, it } from 'vitest';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import {
  runPublicSearchFusionAcceptance,
  type NativeSearchConformanceReport,
} from '../../src/acceptance/QleverSearchConformance';

const expectedReport: NativeSearchConformanceReport = {
  textOnlyBeforeVector: [{ retrieval: 'alpha late vector canonical card' }],
  fusedBeforeVector: [],
  fusedAfterVector: [{
    retrieval: 'alpha late vector canonical card',
    source: 'https://pod.example/alice/projects/native/old-card.md',
  }],
  fusedAfterVectorExact: [{
    retrieval: 'alpha late vector canonical card',
    source: 'https://pod.example/alice/projects/native/old-card.md',
  }],
  fusedDuringMove: [{
    retrieval: 'alpha late vector canonical card',
    source: 'https://pod.example/alice/projects/native/moved-card.md',
  }],
  fusedDuringMoveExact: [{
    retrieval: 'alpha late vector canonical card',
    source: 'https://pod.example/alice/projects/native/moved-card.md',
  }],
  fusedAfterMove: [{
    retrieval: 'alpha late vector canonical card',
    source: 'https://pod.example/alice/projects/native/moved-card.md',
  }],
  oldSourceAfterMove: [],
  deniedSource: [],
};

describe('Public Cloud search conformance', () => {
  it('runs the full FTS/VEC fusion lifecycle through direct RdfEngine queries', async () => {
    const engine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });

    await expect(runPublicSearchFusionAcceptance(engine)).resolves.toEqual(expectedReport);
  });
});

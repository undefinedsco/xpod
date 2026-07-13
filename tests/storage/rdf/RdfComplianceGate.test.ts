import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sparqlCorrectionForCapability } from '../../../src/storage/rdf';

interface ComplianceGateManifest {
  version: number;
  gateCommand: string;
  policy: {
    serverOwnedPodFallback: string;
    unsupportedStatus: string;
    geoSparql: string;
  };
  w3cTargetSubset: string[];
  deviations: Array<{
    capability: string;
    status: string;
    reason: string;
    primaryAction: string;
  }>;
}

function readManifest(): ComplianceGateManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'docs/rdf-sparql-compliance-gate.json'), 'utf8')) as ComplianceGateManifest;
}

describe('RDF SPARQL compliance gate manifest', () => {
  it('keeps the W3C target subset gate wired to the package test command', () => {
    const manifest = readManifest();
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };

    expect(manifest.version).toBe(1);
    expect(manifest.gateCommand).toBe('bun run test:w3c');
    expect(packageJson.scripts?.['test:w3c']).toBe('vitest --run tests/storage/w3c-sparql-full.test.ts');
    expect(manifest.policy).toMatchObject({
      serverOwnedPodFallback: 'disabled-by-default',
      unsupportedStatus: 'explicit-error-with-correction',
      geoSparql: 'deferred-until-product-need',
    });
    expect(manifest.w3cTargetSubset).toEqual(expect.arrayContaining([
      'select-bgp',
      'values-undef',
      'fixed-length-property-path',
      'delete-insert-where-local-graphs',
    ]));
  });

  it('declares deviations with stable correction actions and keeps GeoSPARQL deferred', () => {
    const manifest = readManifest();
    const capabilities = manifest.deviations.map((entry) => entry.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);

    for (const deviation of manifest.deviations) {
      expect(deviation.reason).toEqual(expect.any(String));
      expect(deviation.reason.length).toBeGreaterThan(16);
      const correction = sparqlCorrectionForCapability(deviation.capability);
      expect(correction.primaryAction).toBe(deviation.primaryAction);
      expect(correction.availableActions).toContain(deviation.primaryAction);
    }

    expect(manifest.deviations.find((entry) => entry.capability === 'sparql.geosparql')).toMatchObject({
      status: 'deferred-product-need',
      primaryAction: 'route_external_executor',
    });
  });
});

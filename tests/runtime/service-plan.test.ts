import { describe, expect, it } from 'vitest';
import { applyRuntimePlan, deriveRuntimePlan, type RuntimeModuleDescription } from '../../src/runtime/service-plan';
import type { ServiceConfig } from '../../src/supervisor/types';

function moduleDescription(id: 'css' | 'api'): RuntimeModuleDescription {
  return { id, process: { name: id, command: '/installed/runtime', args: [`/installed/${id}/entry.mjs`], cwd: `/installed/${id}` },
    target: { url: `http://127.0.0.1:${id === 'css' ? 4101 : 4102}` } };
}

describe('host-derived runtime plan', () => {
  for (const ids of [[], ['css'], ['css', 'api'], ['api']] as const) {
    it(`registers and routes only admitted ${ids.join('+') || 'no'} modules`, () => {
      const plan = deriveRuntimePlan({ modules: ids.map(moduleDescription), baseUrl: 'https://pod.example/',
        ...(ids.length === 1 && ids[0] === 'api' ? { externalOidcIssuer: 'https://identity.example/' } : {}) });
      const registered: ServiceConfig[] = [];
      let targets: unknown;
      applyRuntimePlan(plan, { register: config => registered.push(config), setTargets: value => { targets = value; } });
      expect(registered.map(config => config.name)).toEqual([...ids]);
      expect(registered.map(config => config.args[0])).toEqual(ids.map(id => `/installed/${id}/entry.mjs`));
      expect(Object.keys(targets as object)).toEqual([...ids]);
      expect(Object.isFrozen(plan.modules)).toBe(true);
    });
  }

  for (const issuer of [undefined, '', 'not-a-url', 'file:///identity', 'https://user:secret@identity.example/', 'https://pod.example/idp/', 'https://identity.example/?secret=1']) {
    it(`refuses API-only without independent issuer authority (${issuer === undefined ? 'absent' : 'invalid'})`, () => {
      expect(() => deriveRuntimePlan({ modules: [moduleDescription('api')], baseUrl: 'https://pod.example/', externalOidcIssuer: issuer }))
        .toThrow('API-only runtime requires an independent OIDC issuer');
    });
  }

  it('preserves CSS-only local identity without requiring an external issuer', () => {
    const plan = deriveRuntimePlan({ modules: [moduleDescription('css')], baseUrl: 'http://localhost:3000/' });
    expect(plan.targets.api).toBeUndefined();
    expect(plan.targets.css?.url).toBe('http://127.0.0.1:4101');
  });

  it('rejects duplicate or mismatched admitted capability before host registration', () => {
    const css = moduleDescription('css');
    expect(() => deriveRuntimePlan({ modules: [css, css], baseUrl: 'https://pod.example/' })).toThrow('Duplicate runtime capability');
    expect(() => deriveRuntimePlan({ modules: [{ ...css, process: { ...css.process, name: 'api' } }], baseUrl: 'https://pod.example/' }))
      .toThrow('Runtime process capability mismatch');
  });

  it('snapshots supplied process and endpoint values without changing the module description', () => {
    const args = ['/installed/css/entry.mjs'];
    const css = { ...moduleDescription('css'), process: { name: 'css', command: '/installed/runtime', args } };
    const plan = deriveRuntimePlan({ modules: [css], baseUrl: 'https://pod.example/' });
    args[0] = '/unrelated/entry.mjs';
    css.target.url = 'http://127.0.0.1:9999';
    expect(plan.modules[0]?.process.args[0]).toBe('/installed/css/entry.mjs');
    expect(plan.targets.css?.url).toBe('http://127.0.0.1:4101');
  });
});

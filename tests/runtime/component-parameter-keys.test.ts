import { describe, expect, it } from 'vitest';
import { normalizeComponentParameterKeys } from '../../src/runtime/component-parameter-keys';

const context = {
  Factory: {
    '@id': 'example:Factory',
    '@context': {
      config: { '@id': 'example:Factory_config', '@type': '@json' },
      children: { '@id': 'example:Factory_children', '@container': '@list' },
    },
  },
};

describe('component parameter normalization', () => {
  it('preserves JSON literal typing and leaves its contents opaque', () => {
    const config = { extraParams: ['provisionCode'], nested: { '@type': 'Factory', children: ['literal'] } };
    const document = { '@type': 'Factory', config };
    normalizeComponentParameterKeys(document, context);
    expect(document).toEqual({
      '@type': 'Factory', 'Factory:_config': { '@type': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON', '@value': JSON.stringify(config) },
    });
    expect(config.nested).toEqual({ '@type': 'Factory', children: ['literal'] });
    normalizeComponentParameterKeys(document, context);
    expect(document).toEqual({
      '@type': 'Factory', 'Factory:_config': { '@type': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON', '@value': JSON.stringify(config) },
    });
  });

  it.each(['@json', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON'])('does not double-wrap existing %s literals', (type) => {
    const config = { extraParams: ['provisionCode'] };
    const document = { '@type': 'Factory', config: { '@type': type, '@value': type === '@json' ? config : JSON.stringify(config) } };
    normalizeComponentParameterKeys(document, context);
    expect(document).toEqual({ '@type': 'Factory', 'Factory:_config': {
      '@type': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON', '@value': JSON.stringify(config),
    } });
  });

  it('retains existing list normalization for ordinary component parameters', () => {
    const document = { '@type': 'Factory', children: ['child'] };
    normalizeComponentParameterKeys(document, context);
    expect(document).toEqual({ '@type': 'Factory', 'Factory:_children': { '@list': ['child'] } });
  });
});

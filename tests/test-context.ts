import { ActionContext } from '@comunica/core';

const CONTEXT_KEY_QUERY_SOURCES = '@comunica/bus-query-operation:querySources';

const context = { foo: 'bar' };
const ac = new ActionContext({
  ...context,
  [CONTEXT_KEY_QUERY_SOURCES]: [{ source: 'test-source' }],
});

console.log('Has key:', ac.getRaw(CONTEXT_KEY_QUERY_SOURCES));
console.log('Keys:', [...(ac as any).map.keys()]);

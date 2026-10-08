import '../../../src/runtime/configure-drizzle-solid';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { runResource, taskResource } from '@undefineds.co/models';
import { describe, expect, it, vi } from 'vitest';
import { createXpodTasksClient } from './tasks';

const podUrl = 'https://pod.test/';
const runId = 'task/default/2026/10/04/runs.ttl#run-one';
function setup() {
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ tasks: [{ id: 'index.ttl#one', instruction: 'Work', status: 'active' }], runs: [] }), { headers: { 'content-type': 'application/json' } }));
  const database = drizzle({ info: { webId: `${podUrl}profile/card#me`, isLoggedIn: true }, fetch: async () => { throw new Error('Unexpected RDF request'); } },
    { podUrl, schema: { run: runResource, task: taskResource }, autoConnect: false });
  return { transport, database, client: createXpodTasksClient({ fetch: transport, baseUrl: 'https://gateway.test', database }) };
}
describe('host task HTTP resource binding', () => {
  it.each(['resumeRun', 'selection', 'steps', 'stop'] as const)('sends the relative Run id for %s using actual ORM resolution', async method => {
    const { client, database, transport } = setup();
    const iri = database.resolveResourceIri(runResource, runId);
    if (method === 'resumeRun') await client.resumeRun(iri, 'https://pod.test/approval#one');
    else await client[method](iri);
    expect(new URL(String(transport.mock.calls[0][0])).searchParams.get('id')).toBe(runId);
    if (method === 'resumeRun') expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({ approval: 'https://pod.test/approval#one' });
  });
  it('keeps raw Run ids and rejects another Pod before HTTP access', async () => {
    const { client, transport } = setup();
    await client.selection(runId);
    expect(new URL(String(transport.mock.calls[0][0])).searchParams.get('id')).toBe(runId);
    transport.mockClear();
    await expect(client.stop(`https://other.test/.data/${runId}`)).rejects.toThrow('不属于当前 Pod');
    expect(transport).not.toHaveBeenCalled();
  });
  it('projects a canonical Task IRI for shell notification selection', async () => {
    const { client, database } = setup();
    const result = await client.list();
    expect(result.tasks[0].id).toBe('index.ttl#one');
    expect(result.tasks[0].iri).toBe(database.resolveResourceIri(taskResource, 'index.ttl#one'));
  });
});

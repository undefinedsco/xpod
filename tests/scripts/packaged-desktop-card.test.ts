import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { verifyPublicCloudCard } from '../../scripts/accept-packaged-desktop-permissions';

it('uses the installed RDF API for relative/prefixed exact WebID storage and rejects another subject or missing binding', async () => {
  let body = '';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'text/turtle' }); response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing card protocol fixture address');
  const base = `http://127.0.0.1:${address.port}/`;
  const webId = `${base}profile/card#me`;
  const pods = [`${base}storage/a/`, 'https://local.example/independent-b/'];
  try {
    body = '@prefix pim: <http://www.w3.org/ns/pim/space#>. <#me> pim:storage <../storage/a/>, <https://local.example/independent-b/>.';
    expect(body.includes(webId)).toBe(false);
    await expect(verifyPublicCloudCard(webId, pods)).resolves.toBeUndefined();
    body = `@prefix person: <${base}profile/card#>. @prefix pim: <http://www.w3.org/ns/pim/space#>. person:me pim:storage <${pods[0]}>, <${pods[1]}>.`;
    await expect(verifyPublicCloudCard(webId, pods)).resolves.toBeUndefined();
    body = body.replace('person:me', 'person:other');
    await expect(verifyPublicCloudCard(webId, pods)).rejects.toThrow('exact WebID');
    body = `<${webId}> <http://www.w3.org/ns/pim/space#storage> <${pods[0]}>.`;
    await expect(verifyPublicCloudCard(webId, pods)).rejects.toThrow('storage binding');
    expect(requests.every(request => request === '/profile/card')).toBe(true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

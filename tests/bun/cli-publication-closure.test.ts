import { expect, test } from 'bun:test';
import { assertCliPublicationClosure } from '../../scripts/prepare-cli-publication';

const file = (path: string, content = Buffer.from('export {};')) => ({ path: 'package/' + path, type: 'file', content });
const manifest = () => ({ name: '@undefineds.co/xpod-cli', dependencies: { '@undefineds.co/xpod-client': '1.2.3' }, exports: { '.': './dist/index.mjs' } });
test('checks original public members without trusting producer status', () => {
  assertCliPublicationClosure({ ...manifest(), status: 'passed' }, [file('dist/index.mjs')]);
  expect(() => assertCliPublicationClosure({ ...manifest(), status: 'passed' }, [])).toThrow('public entry');
});
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`rejects unplanned runtime ${field}`, () => {
    const m: any = manifest(); m[field] = { ...m[field], '@solid/community-server': '7.0.0' };
    expect(() => assertCliPublicationClosure(m, [file('dist/index.mjs')])).toThrow('runtime dependency');
  });
}
for (const protocol of ['workspace:*', 'file:./service', 'link:../service']) {
  test(`rejects local edge ${protocol}`, () => {
    const m = manifest(); m.dependencies['@undefineds.co/xpod-client'] = protocol;
    expect(() => assertCliPublicationClosure(m, [file('dist/index.mjs')])).toThrow('not publishable');
  });
}
for (const magic of ['7f454c46', '4d5a0000', 'cffaedfe', 'cafebabe']) {
  test(`rejects disguised binary ${magic}`, () => {
    expect(() => assertCliPublicationClosure(manifest(), [file('dist/index.mjs'), file('dist/innocent.txt', Buffer.from(magic, 'hex'))])).toThrow('native');
  });
}
for (const name of ['dist/addon.node', 'node_modules/service/index.js']) {
  test(`rejects runtime payload ${name}`, () => {
    expect(() => assertCliPublicationClosure(manifest(), [file('dist/index.mjs'), file(name)])).toThrow('runtime payload');
  });
}
test('client cannot add its CLI build-time dependency as a runtime edge', () => {
  expect(() => assertCliPublicationClosure({ name: '@undefineds.co/xpod-client', dependencies: { '@undefineds.co/xpod-cli': '1.2.3' } }, [])).toThrow('runtime dependency');
});
test('original source evidence is preserved while installer hooks and bundled dependencies fail', () => {
  assertCliPublicationClosure(manifest(), [file('dist/index.mjs'), file('dist/producer-materials/source/package.json', Buffer.from('{"dependencies":{"server":"workspace:*"}}'))]);
  for (const extra of [{ scripts: { postinstall: 'download-service' } }, { bundledDependencies: ['service'] }]) {
    expect(() => assertCliPublicationClosure({ ...manifest(), ...extra }, [file('dist/index.mjs')])).toThrow('Unexpected publication');
  }
});

test('accepts conventional relative bin/main while exports remain package-relative', () => {
  assertCliPublicationClosure({ ...manifest(), bin: { xpod: 'dist/index.mjs' }, main: 'dist/index.mjs' }, [file('dist/index.mjs')]);
  expect(() => assertCliPublicationClosure({ ...manifest(), exports: 'dist/index.mjs' }, [file('dist/index.mjs')])).toThrow('public entry');
});
test('only the optional authentication peer is part of the CLI/client contract', () => {
  const peer = { '@inrupt/solid-client-authn-node': '^3.1.1' };
  for (const name of ['@undefineds.co/xpod-cli', '@undefineds.co/xpod-client']) {
    assertCliPublicationClosure({ name, peerDependencies: peer, peerDependenciesMeta: { '@inrupt/solid-client-authn-node': { optional: true } } }, []);
    expect(() => assertCliPublicationClosure({ name, peerDependencies: peer }, [])).toThrow('runtime dependency');
  }
});
test('authentication peer cannot substitute an alias, Git or URL package identity', () => {
  for (const name of ['@undefineds.co/xpod-cli', '@undefineds.co/xpod-client']) {
    for (const version of ['npm:@solid/community-server@7.0.0', 'git+https://example.org/server.git', 'https://example.org/server.tgz', '*', '^4.0.0']) {
      expect(() => assertCliPublicationClosure({ name, peerDependencies: { '@inrupt/solid-client-authn-node': version }, peerDependenciesMeta: { '@inrupt/solid-client-authn-node': { optional: true } } }, [])).toThrow('runtime dependency');
    }
  }
});
test('typesVersions paths must exist; browser and wildcard entries are explicitly unsupported', () => {
  const entries = [file('dist/index.mjs'), file('dist/types/index.d.ts')];
  assertCliPublicationClosure({ ...manifest(), typesVersions: { '*': { client: ['dist/types/index.d.ts'] } } }, entries);
  expect(() => assertCliPublicationClosure({ ...manifest(), typesVersions: { '*': { client: ['missing.d.ts'] } } }, entries)).toThrow('public entry');
  expect(() => assertCliPublicationClosure({ ...manifest(), browser: {} }, entries)).toThrow('Browser');
  expect(() => assertCliPublicationClosure({ ...manifest(), exports: { './*': './dist/*.mjs' } }, entries)).toThrow('public entry');
});

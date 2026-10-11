import { describe, expect, test } from 'bun:test';
import { cssPublicationOptions, verifyCssReleaseMaterials } from '../scripts/publication';

describe('CSS shared publication adapter', () => {
  test('preview is explicit private staging default with package version', () => {
    expect(cssPublicationOptions([], '0.1.0-preview.1')).toEqual({ publication: { mode: 'preview', version: '0.1.0-preview.1' }, materialsRoot: undefined });
  });
  test('release requires version and independent material authority', () => {
    expect(() => cssPublicationOptions(['--publication', 'release'], '0.1.0-preview.1')).toThrow();
    expect(() => cssPublicationOptions(['--publication', 'release', '--version', '1.0.0'], '0.1.0-preview.1')).toThrow();
    const options = cssPublicationOptions(['--publication', 'release', '--version', '1.0.0', '--materials-root', '.test-data/missing-css-materials'], '0.1.0-preview.1');
    expect(options.publication).toEqual({ mode: 'release', version: '1.0.0' });
    expect(() => verifyCssReleaseMaterials('.test-data/missing-css-product', options)).toThrow();
  });
  test('rejects malformed mode/version, duplicate flags and preview external materials', () => {
    for (const args of [['--publication', 'other'], ['--version', 'garbage'], ['--version', '1.0.0', '--version', '2.0.0'], ['--materials-root', 'somewhere']]) {
      expect(() => cssPublicationOptions(args, '0.1.0-preview.1')).toThrow();
    }
  });
});

import {describe, expect, test} from 'bun:test';
import {observeMacNativeRanges, verifyMacLoaderClosure} from '../../scripts/lib/independent-admission/macos-native-range';

function image() {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(0x0100000c, 4);
  data.writeUInt32LE(2, 12); data.writeUInt32LE(1, 16); data.writeUInt32LE(24, 20);
  data.writeUInt32LE(0x32, 32); data.writeUInt32LE(24, 36); data.writeUInt32LE(1, 40);
  data.writeUInt32LE(0x0f0000, 44); data.writeUInt32LE(0x0f0200, 48);
  return data;
}
describe('bounded Mac native observations', () => {
  test('33 MiB member never requires a whole binary Buffer', () => {
    const data = image(); let largest = 0;
    const result = observeMacNativeRanges({sizeBytes: 33 * 1024 ** 2, readRange(offset, length) {
      largest = Math.max(largest, length); return data.subarray(offset, offset + length);
    }}, 'darwin-arm64');
    expect(result.minimumOS).toBe(0x0f0000); expect(largest <= 65536).toBe(true);
    expect(result.scope).toBe('macho-load-command-observations-only');
  });
  test('collects dylib and rpath bytes through bounded ranges', () => {
    const prefix = image(); const commands = [];
    for (const [kind, name, minimum] of [[0xc, '@rpath/libtest.dylib', 24], [0x8000001c, '@loader_path/../lib', 12]] as const) {
      const size = Math.ceil((minimum + Buffer.byteLength(name) + 1) / 8) * 8;
      const command = Buffer.alloc(size); command.writeUInt32LE(kind); command.writeUInt32LE(size, 4);
      command.writeUInt32LE(minimum, 8); command.write(name, minimum); commands.push(command);
    }
    const data = Buffer.concat([prefix, ...commands]);
    data.writeUInt32LE(3, 16); data.writeUInt32LE(data.length - 32, 20);
    const input = {sizeBytes: data.length, readRange: (o: number, n: number) => data.subarray(o, o + n)};
    const result = observeMacNativeRanges(input, 'darwin-arm64');
    expect(result.dependencies).toEqual([{command: 0xc, path: '@rpath/libtest.dylib'}]);
    expect(result.rpaths).toEqual(['@loader_path/../lib']);
    data.writeUInt32LE(0xffffffff, 64);
    expect(() => observeMacNativeRanges(input, 'darwin-arm64')).toThrow();
  });
  test('wrong target rejected' , () => {
    const data = image(); expect(() => observeMacNativeRanges({sizeBytes: data.length,
      readRange: (o, n) => data.subarray(o, o + n)}, 'darwin-x64')).toThrow();
  });
  test('command overrun, short read, wrong platform rejected', () => {
    for (const change of [(b: Buffer) => b.writeUInt32LE(32, 36),
      (b: Buffer) => b.writeUInt32LE(2, 40), (b: Buffer) => b.writeUInt32LE(4097, 16)]) {
      const data = image(); change(data);
      expect(() => observeMacNativeRanges({sizeBytes: data.length,
        readRange: (o, n) => data.subarray(o, o + n)}, 'darwin-arm64')).toThrow();
    }
    expect(() => observeMacNativeRanges({sizeBytes: 100, readRange: () => Buffer.alloc(0)}, 'darwin-arm64')).toThrow();
  });
});


describe('Mac loader bundle policy', () => {
  const base = () => observeMacNativeRanges({sizeBytes: image().length,
    readRange: (o, n) => image().subarray(o, o + n)}, 'darwin-arm64');
  const check = (members: Map<string, ReturnType<typeof base>>) => verifyMacLoaderClosure({
    executable: 'bin/helper', minimumOS: 0x0f0000, sdk: 0x0f0200, members});
  test('resolves actual bundle dependency, accepts only system absolute paths', () => {
    const main = {...base(), rpaths: ['@loader_path/../lib'], dependencies: [
      {command: 0xc, path: '@rpath/liba.dylib'}, {command: 0xc, path: '/usr/lib/libSystem.B.dylib'}]};
    expect(check(new Map([['bin/helper', main], ['lib/liba.dylib', base()]] )).members).toBe(2);
    for (const name of ['/opt/homebrew/lib/liba.dylib', '/usr/lib/../private/liba', '@rpath/missing', '@loader_path/../../escape']) {
      expect(() => check(new Map([['bin/helper', {...base(), dependencies: [{command: 0xc, path: name}]}]]))).toThrow();
    }
  });
  test('rejects unbound inventory and higher-minOS dependency', () => {
    expect(() => check(new Map([['bin/helper', base()], ['lib/unreferenced', base()]]))).toThrow();
    expect(() => check(new Map([['bin/helper', {...base(), dependencies: [{command: 0xc, path: '@loader_path/../lib/new'}]}],
      ['lib/new', {...base(), minimumOS: 0x100000}]]))).toThrow();
  });
});

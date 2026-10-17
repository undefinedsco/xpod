/** Mechanical Mach-O observations from centrally owned immutable ranges.
 * The caller owns whole-file hashing/custody; this module issues no capability. */
export interface MacNativeRanges {
  readonly sizeBytes: number;
  readRange(offset: number, length: number): Buffer;
}

export function observeMacNativeRanges(input: MacNativeRanges, target: string) {
  const fail = (): never => { throw new Error('Invalid bounded macOS native material'); };
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 32
    || !['darwin-arm64', 'darwin-x64'].includes(target)) fail();
  const read = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || length > 65536 || offset + length > input.sizeBytes) fail();
    const bytes = input.readRange(offset, length);
    if (!Buffer.isBuffer(bytes) || bytes.length !== length) fail();
    return bytes;
  };
  const header = read(0, 32);
  // Producers build native thin 64-bit little-endian images. Universal and
  // other encodings need their own explicit policy rather than a fallback.
  if (header.toString('hex', 0, 4) !== 'cffaedfe') fail();
  const cpu = header.readUInt32LE(4);
  if (cpu !== (target === 'darwin-arm64' ? 0x0100000c : 0x01000007)
    || ![2, 6].includes(header.readUInt32LE(12))) fail();
  const count = header.readUInt32LE(16), size = header.readUInt32LE(20);
  if (!count || count > 4096 || size > 1024 * 1024 || size > input.sizeBytes - 32) fail();
  let cursor = 32, stringBytes = 0;
  const dependencies: {command: number; path: string}[] = [], rpaths: string[] = [];
  const versions: {command: number; minimumOS: number; sdk: number; platform: number}[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > 32 + size) fail();
    const command = read(cursor, 8), kind = command.readUInt32LE(0), length = command.readUInt32LE(4);
    if (length < 8 || length % 8 || cursor + length > 32 + size) fail();
    if (kind === 0x32) {
      if (length < 24) fail();
      const body = read(cursor, 24), tools = body.readUInt32LE(20);
      if (tools > 4096 || length !== 24 + tools * 8) fail();
      versions.push({command: kind, platform: body.readUInt32LE(8), minimumOS: body.readUInt32LE(12), sdk: body.readUInt32LE(16)});
    } else if (kind === 0x24) {
      if (length !== 16) fail();
      const body = read(cursor, 16);
      versions.push({command: kind, platform: 1, minimumOS: body.readUInt32LE(8), sdk: body.readUInt32LE(12)});
    }
    const baseKind = kind & 0x7fffffff;
    if ([0xc, 0xd, 0x18, 0x1f, 0x20, 0x23, 0x1c].includes(baseKind)) {
      const minimum = baseKind === 0x1c ? 12 : 24;
      if (length < minimum) fail();
      const prefix = read(cursor, minimum), start = prefix.readUInt32LE(8);
      if (start < minimum || start >= length || length - start > 65536) fail();
      stringBytes += length - start;
      if (stringBytes > 262144) fail();
      const bytes = read(cursor + start, length - start), end = bytes.indexOf(0);
      if (end <= 0) fail();
      const name = bytes.subarray(0, end).toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(bytes.subarray(0, end)) || /[\x00-\x1f\x7f]/u.test(name)) fail();
      if (baseKind === 0x1c) rpaths.push(name);
      else dependencies.push({command: kind, path: name});
    }
    cursor += length;
  }
  if (cursor !== 32 + size || versions.length !== 1 || versions[0].platform !== 1
    || !versions[0].minimumOS || versions[0].sdk < versions[0].minimumOS) fail();
  return {status: 'mechanical-macho-observation' as const, target, sizeBytes: input.sizeBytes,
    minimumOS: versions[0].minimumOS, sdk: versions[0].sdk, dependencies, rpaths,
    scope: 'macho-load-command-observations-only' as const};
}

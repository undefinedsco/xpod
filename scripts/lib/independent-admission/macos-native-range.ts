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

/** Check the complete supplied bundle graph. Inventory/custody and official
 * native execution remain central responsibilities, never inferred here. */
export function verifyMacLoaderClosure(input: {
  readonly executable: string;
  readonly minimumOS: number;
  readonly sdk: number;
  readonly members: ReadonlyMap<string, ReturnType<typeof observeMacNativeRanges>>;
}) {
  const fail = (): never => { throw new Error('Invalid macOS bundled loader closure'); };
  const clean = (name: string) => name.length > 0 && !name.startsWith('/')
    && !name.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/u.test(part));
  if (!clean(input.executable) || input.members.size < 1 || input.members.size > 1024
    || !Number.isSafeInteger(input.minimumOS) || !Number.isSafeInteger(input.sdk)
    || input.minimumOS <= 0 || input.sdk < input.minimumOS) fail();
  const executable = input.members.get(input.executable);
  if (!executable || executable.minimumOS !== input.minimumOS || executable.sdk !== input.sdk) fail();
  const normalize = (value: string): string | undefined => {
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return undefined; parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/');
  };
  const directory = (member: string) => member.split('/').slice(0, -1).join('/');
  const expand = (name: string, member: string): string | undefined => {
    if (name.startsWith('@loader_path/')) return normalize(directory(member) + '/' + name.slice(13));
    if (name.startsWith('@executable_path/')) return normalize(directory(input.executable) + '/' + name.slice(17));
    return undefined;
  };
  const system = (name: string) => (name.startsWith('/usr/lib/') || name.startsWith('/System/Library/'))
    && !name.split('/').some(part => part === '.' || part === '..') && !/[\\\x00-\x1f\x7f]/u.test(name);
  const reached = new Set<string>();
  const visit = (member: string, inheritedRpaths: readonly string[]): void => {
    if (reached.has(member)) return;
    reached.add(member);
    const observation = input.members.get(member);
    if (!observation || observation.target !== executable!.target || observation.minimumOS > input.minimumOS) fail();
    const localRpaths = observation!.rpaths.map(name => {
      const resolved = expand(name, member);
      if (!resolved || !clean(resolved)) return fail();
      return resolved;
    });
    const search = [...localRpaths, ...inheritedRpaths];
    for (const dependency of observation!.dependencies) {
      if ((dependency.command & 0x7fffffff) === 0xd) continue; // LC_ID_DYLIB describes this image.
      const name = dependency.path;
      if (system(name)) continue;
      const direct = expand(name, member);
      const candidates = direct ? [direct] : name.startsWith('@rpath/')
        ? search.map(base => normalize(base + '/' + name.slice(7))).filter((value): value is string => value !== undefined) : [];
      const resolved = candidates.find(candidate => clean(candidate) && input.members.has(candidate));
      if (!resolved) fail();
      visit(resolved!, search);
    }
  };
  for (const name of input.members.keys()) if (!clean(name)) fail();
  visit(input.executable, []);
  if (reached.size !== input.members.size) fail();
  return {status: 'mechanical-loader-closure-verified' as const, members: reached.size,
    scope: 'supplied-inventory-only' as const};
}

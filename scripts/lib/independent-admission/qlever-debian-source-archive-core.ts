import {createHash} from 'node:crypto';
import path from 'node:path';
type SourceOriginalReference = Readonly<{path: string; bytes: number; sha256: string}>;
export type ArchiveCoordinate = Readonly<{name: string; version: string; dsc: SourceOriginalReference; archives: readonly SourceOriginalReference[]}>;
function need(value: unknown, reason: string): asserts value {if (!value) throw Error('Debian source archive mechanics: ' + reason);}
/** Shared byte/set mechanics only. The genuine wrapper supplies its current
 * reader, existing DSC parser, actual ownership coordinates and remaining budget.
 * This function issues no capability and makes no official authority claim. */
export function inspectDebianSourceArchiveCore(input: {
 packages: readonly any[];
 allowedCoordinates: readonly Readonly<{name: string; version: string}>[];
 reader: Readonly<{members: readonly SourceOriginalReference[]; readOriginalRange(path: string, offset: number, length: number): Buffer}>;
 reference(value: unknown): SourceOriginalReference;
 small(value: SourceOriginalReference): Buffer;
 parseDsc(bytes: Buffer): {name: string; version: string; files: readonly {name: string; bytes: number; sha256: string}[]};
 maximumFileBytes: number; maximumTotalBytes: number; check(): void;
}) {
 const {packages, reader, reference, small, parseDsc, maximumFileBytes, maximumTotalBytes, check} = input;
 need(Array.isArray(packages) && packages.length > 0 && packages.length <= 4096, 'bounded package collection');
 need(Number.isSafeInteger(maximumFileBytes) && maximumFileBytes >= 0 && Number.isSafeInteger(maximumTotalBytes) && maximumTotalBytes >= 0, 'remaining byte bounds');
 const identities = new Set(input.allowedCoordinates.map(row => row.name + '\0' + row.version));
  const seen = new Set<string>(), archiveCoordinates: ArchiveCoordinate[] = []; let sourceBytes = 0;
    const originalReference=(value:any):SourceOriginalReference=>{const ref=reference(value);return Object.freeze({path:ref.path,bytes:ref.bytes,sha256:ref.sha256});};
    for (const item of packages) {
      check();
      const coordinate = item.name + '\0' + item.version;
      need(!seen.has(coordinate) && identities.has(coordinate), 'exact Debian source identity absent or repeated in actual dpkg ledger'); seen.add(coordinate);
      const dscRef = reference(item.dsc), dsc = parseDsc(small(dscRef));
      need(dsc.name === item.name && dsc.version === item.version && path.posix.basename(dscRef.path) === item.name + '_' + item.version.replace(/^[0-9]+:/u, '') + '.dsc', 'actual dsc source/version differs');
      const parent = path.posix.dirname(dscRef.path);
      need(/^inner\/debian-source\/package-[0-9]{4}$/u.test(parent) && Array.isArray(item.files) && item.files.length === dsc.files.length, 'Debian original group/reference set differs');
      const expected = new Map<string, any>(dsc.files.map((row: any) => [row.name, row]));
      const names = new Set<string>([dscRef.path]),archives:SourceOriginalReference[]=[]; sourceBytes += dscRef.bytes;
      for (const value of item.files) {
        const ref = reference(value), relative = ref.path.slice(parent.length + 1), declared = expected.get(relative);
        need(ref.path.startsWith(parent + '/') && !names.has(ref.path) && declared && ref.bytes === declared.bytes && ref.sha256 === declared.sha256, 'all orig/debian archive bytes must match dsc SHA256 universe'); names.add(ref.path);
        need(ref.bytes <= maximumFileBytes, 'Debian source member exceeds fixed original bound');
        sourceBytes += ref.bytes;
        need(sourceBytes <= maximumTotalBytes, 'SDK context/input/Debian domains exceed shared source budget');
        const digest = createHash('sha256');
        for (let offset = 0; offset < ref.bytes; offset += 65536) {
          check(); const length = Math.min(65536, ref.bytes - offset), bytes = reader.readOriginalRange(ref.path, offset, length);
          need(bytes.length === length, 'Debian source original truncated'); digest.update(bytes);
        }
        need(digest.digest('hex') === declared.sha256, 'actual complete Debian source original hash differs');archives.push(originalReference(ref));
      }
      const actual = reader.members.filter(row => row.path.startsWith(parent + '/'));
      need(actual.length === names.size && actual.every(row => names.has(row.path)), 'unregistered extra Debian source original member');archiveCoordinates.push(Object.freeze({name:dsc.name,version:dsc.version,dsc:originalReference(dscRef),archives:Object.freeze(archives)}));
      need(sourceBytes <= maximumTotalBytes, 'SDK context/input/Debian domains exceed shared source budget');
    }
  check();
  return Object.freeze({coordinates: Object.freeze(archiveCoordinates), sourceBytes});
}

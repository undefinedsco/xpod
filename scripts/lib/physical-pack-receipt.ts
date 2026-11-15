/** Strict normal pack stdout decoder, shared by physical module evidence readers. */
export function parsePhysicalPackReceipt(data: Buffer, fail: (message: string) => never): any {
  if (data.length > 64 * 1024) fail('pack receipt exceeds small producer output bound');
  const lines = data.toString('utf8').trim().split(/\r?\n/u);
  if (lines.length === 2 && lines[0].startsWith('$ bun scripts/pack.ts ')) lines.shift();
  if (lines.length !== 1) fail('ambiguous pack producer output');
  const result = JSON.parse(lines[0]);
  if (typeof result.archive !== 'string' || !result.archive || !/^[a-f0-9]{64}$/u.test(result.sha256)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(result.integrity) || !Number.isSafeInteger(result.members) || result.members < 1) fail('pack producer result required');
  return result;
}

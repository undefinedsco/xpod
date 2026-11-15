import {test,expect} from 'bun:test';
import * as BunTest from 'bun:test';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import limits from '../../scripts/lib/module-artifact-limits.json';
/** The collector issues a capability; the budget only consumes the issued VIEW. This
 * mock reproduces exactly that seam so the physical ledger arithmetic is exercised
 * without claiming a genuine source-custody proof from a fixture. */
let nativeFixture: unknown;
// Same documented seam other focused tests use: Bun's runtime module mock.
const mock = Reflect.get(BunTest, 'mock') as {module:(name:string,factory:()=>unknown)=>void};
mock.module(path.join(import.meta.dir, '../../scripts/lib/independent-admission/native-original-collector'),
  () => ({
    nativeOriginalsView: (value: unknown) => value === undefined ? undefined : nativeFixture,
    assertCollectedNativeOriginalCustody: () => {},
  }));
// Spread the REAL module and override one predicate: replacing it wholesale would make
// every other export undefined for any later file loaded in the same process.
const realGithubOrigin = await import('../../scripts/lib/independent-admission/github-origin');
mock.module(path.join(import.meta.dir, '../../scripts/lib/independent-admission/github-origin'),
  () => ({...realGithubOrigin, isCandidateServiceImageGitHubOrigin: () => true}));
const {createCandidateServiceQualificationBudget} =
  await import('../../scripts/lib/independent-admission/candidate-service-qualification-budget');
test('all receiver axes consume the same logical read counter without replenishment',()=>{
 const shared=createCandidateServiceQualificationBudget(),source=shared,legal=shared,abi=shared;
 source.chargeReadBytes(limits.sourceMaterialBytes-64);legal.chargeReadBytes(32);expect(abi.remainingReadBytes()).toBe(32);abi.chargeReadBytes(32);expect(source.remainingReadBytes()).toBe(0);
 expect(()=>legal.chargeReadBytes(1)).toThrow('shared logical read bound exceeded');expect(()=>source.check()).toThrow('shared logical read bound exceeded');expect(shared.remainingMs()).toBe(0);
});
test('material reservation and logical IO are distinct bounded resources',()=>{
 const shared=createCandidateServiceQualificationBudget();shared.reserveBytes(limits.sourceMaterialBytes);expect(shared.remainingReadBytes()).toBe(limits.sourceMaterialBytes);shared.chargeReadBytes(64);expect(shared.remainingReadBytes()).toBe(limits.sourceMaterialBytes-64);
 expect(()=>shared.reserveBytes(1)).toThrow('shared material reservation bound exceeded');expect(()=>shared.chargeReadBytes(0)).toThrow('shared material reservation bound exceeded');
});
test('invalid byte charges cannot decrease or replenish shared counters',()=>{
 for(const bytes of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){
  const shared=createCandidateServiceQualificationBudget();expect(()=>shared.chargeReadBytes(bytes)).toThrow();expect(()=>shared.check()).toThrow();
 }
});

test('physical reservations require a genuine retained original universe',()=>{
 expect(()=>createCandidateServiceQualificationBudget({})).toThrow('genuine service original universe required');
 const shared=createCandidateServiceQualificationBudget();
 expect(()=>shared.reserveOriginalMaximum(0)).toThrow('genuine service original universe required');
 expect(()=>shared.check()).toThrow('genuine service original universe required');
});

/** AUTHENTIC RC394 PHYSICAL LEDGER (measured, not assumed).
 *
 * Source artifact: `service-originals.zip`, artifact 13619366292,
 * 221,723,547 bytes, sha256 16a6fb62...f926779.
 * Its `service-image-materials.json` lists 813 retained originals plus the master
 * itself (422,394 bytes) = 814 members totalling exactly 264,524,634 bytes, which
 * also equals the sum of the zip's 814 uncompressed member sizes.
 *
 * The payload below is that exact member-size list (gzip+base64, ~1.7 KB), so the
 * ledger is the real one rather than a rounded stand-in. It is a SIZE ledger only:
 * no body bytes are embedded and nothing is extracted at test time.
 */
const RC394_LEDGER_B64 = (
    'H4sIAOB88GoC/32XPZIcNwyF77JxBwRAEqCu4nLgQIEDJ5Yju3x3fwC7Z8Y9uypV7TRBED8PDyD1z8cfv/346/ufH9+6qq1+fPz4' +
    '/e/vPz6+/aLW5tH4N8chvWt9hyxlpV4rfdnw8b6yeBrwUd8cslOpxHMLQ6W8jIfda8N9vq3GS2DLLrsaL+7MznijsZJ42L02vMvb' +
    'StdLYPO0K22G1NfQ9CLjoWTnRp9rPldDRxpo42VlS56mxxWyaPTA5Jiu/FjHShscdAX7U45kB5T2SFGcUJsPTGfUp1ZwBKWCgCpK' +
    'GEpicvTI5WoclLUO7TGPwF7aXDoEx4PaiFAxS3i1BYmgC2jY7vwZfnQhgwB4mQDQ12R/HRwfQ45ljmV3GQlXVxRkeme/Ax5x+gCg' +
    '2ckhsXABXImxJCFoa8ph+FyHz1ToopRltYxWlcpDGCHRFdPtsOFLSaFJw76u5fktdoyQfn7CI9BwVxIr8WqusY4gJ8gnHpY4DpAx' +
    '4p3rgOsqCdFshQXJkvGEXJ2FZyYTbEYf3SgigZDPoJQk3yz6ylMLOIBrkrJmmwAp3iyMuIRcxwgFBQpAjUkIwlEak0SVIgBJd5Uk' +
    'eS4gDiYUf0GZqIgnLCZYU1Hq4tMdbFpShwOUSrO+ePZGWTlP2IElQ3mNJAXGoKJSf8Moxrw71hyb1ATfnvoODxVcSQiMV6Mr58S3' +
    'Y/dY5IBuWpotD8+V9DG4d0wIRLSTUlIdmRX/4R0EM9xI9jjtktNBCzJ9HvD0U24n5K/ol8+cFwTF94iDdoUBoM5eOob+s6BfHb5H' +
    'FI8TqmXJR07UtlPTGHlSab1ZxdEmzsZM3WQ3CEDiiQthg6YpHhiDjuqS7EoKiiRLT9QgD6nArF7N2TOb7B7ak1R32emiuecMUQgN' +
    'QNhjUTGTaUnfbJjFIuvYc2yuOp3dn22bdXQKNZT2juvHx7Bks2SLZt9PjKOtHZw8+U9quKX5ioaweJluNE0bk2m1Te8TOf7md038' +
    '7PGR7UrTgUzEtJJR4BzbpFIm2zXCJtnAsFVgMAH0lLaU5jWRXTJfhTnHpBhcMrkU1aHam+I51l8VGefW+k2R5mp3RUbFiLubyWiv' +
    'C+Q1SIZ3kvL/mhIZ0V0zA7pHSfF63GQMGZt3PWs7yMFwuzJsD88PPaV09wSNVO7YYm70e4KG8TfPeXG37TkekHWP/rXe2pOjFSG/' +
    'UntNbrY3PY/o8XNzGTLD3uQOfyzrvd3RWvv2/1T2igxsviJ8ItNC9Z6x2MP1l7JiXfbDfKOicx3dqTjtDZwX2ZOJVNTubua4+V6F' +
    'T89bZvdfjtWVoI6mPE0qpO7JzHpv0ddjzNhSralwxAxbNbFp/7ylazMHIuzpLR9JsfTqUy7gHHXlTnznbHkbtVj7DXO+qVCaBcIe' +
    'DZkhOlFE3wHUsyPscarlvJcaFrLfVjnH4myDvn/7KbpU8kgNiJ5zaaveVOapQkOIlYi5H/qiEnnRlBVePWVFwDdMnioUMuoJKOcP' +
    'jo4c40+NYK17NOxg8/mhL/mQ/ekmL/u2Mcu79qHhue67T2N9Hggj17IUPClbDZ181YT5Q0WYumE1KtYJ36d+rPzItsFlvs9cNnhr' +
    '1APYvJ2BjFNyBeJXvk2mbhU7RZfKOGMNrZOn2c9g5Tm0dqjjDO0KNUGU4rn0rwPJT5c9QD+vb9Z1RZySfDm9RJqkqR7kfyn6czLS' +
    'gRv3xnt03yuXCkblHDpzZ8MzgzLVLXA+qX/99z/sCO0BVw0AAA=='
).replace(/\s/gu, '');
interface Rc394Ledger { master: number; sizes: readonly number[] }
const rc394Ledger: Rc394Ledger = JSON.parse(
  gunzipSync(Buffer.from(RC394_LEDGER_B64, 'base64')).toString('utf8')) as Rc394Ledger;

test('the authentic RC394 ledger still totals the reported physical bytes', () => {
  // Guards the fixture itself: if this drifts the assertions below would be meaningless.
  expect(rc394Ledger.sizes).toHaveLength(813);
  expect(rc394Ledger.master).toBe(422394);
  expect(rc394Ledger.master + rc394Ledger.sizes.reduce((a, b) => a + b, 0)).toBe(264524634);
});

test('the real 814-member universe fits the shared physical ledger and settles exactly', () => {
  // Rows are the measured members; only `bytes` participates in the physical ledger and
  // the custody guard is the module's own mocked issuance, never a production claim.
  const members = [{path: 'service-image-materials.json', bytes: rc394Ledger.master},
    ...rc394Ledger.sizes.map((bytes, i) => ({path: `member-${i}.original`, bytes}))];
  nativeFixture = {members};
  const budget = createCandidateServiceQualificationBudget({});
  // Before the fix this threw "retained original universe exceeds existing bound".
  expect(budget.remainingOriginalBytes()).toBe(limits.packedBytes - 264524634);
  expect(budget.remainingOriginalBytes()).toBeGreaterThan(0);
  // Reserve a realistic positive body, then settle to the actual bytes.
  const maximum = 8 * 1024 ** 2;
  const token = budget.reserveOriginalMaximum(maximum);
  expect(budget.remainingOriginalBytes()).toBe(limits.packedBytes - 264524634 - maximum);
  budget.settleOriginalReservation(token, 1024 ** 2, true);
  expect(budget.remainingOriginalBytes()).toBe(limits.packedBytes - 264524634 - 1024 ** 2);
  // Logical reads are a SEPARATE resource and keep their own 8 GiB ceiling.
  expect(budget.remainingReadBytes()).toBe(limits.sourceMaterialBytes);
});

test('a universe larger than the producer packed bound is still refused', () => {
  // The metric changed; the guard did not. Just past the total bound must fail closed.
  nativeFixture = {members: [{path: 'master', bytes: limits.packedBytes + 1}]};
  expect(() => createCandidateServiceQualificationBudget({}))
    .toThrow('retained original universe exceeds existing bound');
  // ...and a legal universe cannot reserve past its own remaining balance.
  nativeFixture = {members: [{path: 'master', bytes: limits.packedBytes - 16}]};
  const budget = createCandidateServiceQualificationBudget({});
  expect(budget.remainingOriginalBytes()).toBe(16);
  expect(() => budget.reserveOriginalMaximum(17))
    .toThrow('existing shared retained original bound exceeded');
});

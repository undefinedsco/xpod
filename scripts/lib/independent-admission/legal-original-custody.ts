import { registryLegalOriginalView, assertRegistryLegalOriginalCustody } from './legal-registry-originals';
import { bunHelperOriginalView, assertBunHelperOriginalCustody } from './legal-bun-helpers';
/** Cache hits still require the original issuer's current custody. A JSON
 * object, copied view or caller callback can neither register nor satisfy it. */
export function assertLegalOriginalCustody(capability: unknown): void {
  if (registryLegalOriginalView(capability)) { assertRegistryLegalOriginalCustody(capability); return; }
  if (bunHelperOriginalView(capability)) { assertBunHelperOriginalCustody(capability); return; }
  throw Error('Legal original custody: unknown private capability');
}

import type { ComponentsManager } from 'componentsjs';
import { DataFactory } from 'rdf-data-factory';

const BASE_HTTP_HANDLER = 'urn:solid-server:default:BaseHttpHandler';

/** The CSS LDP handler IRI that terminates the configured HTTP pipeline. */
export const LDP_HANDLER = 'urn:solid-server:default:LdpHandler';

interface RawConfigResource {
  value?: unknown;
  list?: RawConfigResource[];
  properties?: Record<string, RawConfigResource[]>;
}

/**
 * Derive the configured HTTP entrypoint pipeline from the composed Components.js
 * config. The entrypoint is a PodMutationLockingHttpHandler whose `mutationSource`
 * waterfall owns the ordered handlers, so the pipeline is found by walking the raw
 * config for the list that contains the LDP handler instead of depending on the
 * old raw-argument layout.
 */
export function configuredHttpHandlerIds<Instance>(manager: ComponentsManager<Instance>): string[] {
  const resource = manager.configRegistry.getInstantiatedResource(
    new DataFactory().namedNode(BASE_HTTP_HANDLER),
  );
  if (!resource) throw new Error('Base HTTP handler config was not instantiated');
  const pool = manager.configConstructorPool as typeof manager.configConstructorPool & {
    getRawConfig(value: typeof resource): RawConfigResource;
  };
  const raw = pool.getRawConfig(resource);

  const seen = new Set<RawConfigResource>();
  const lists: RawConfigResource[][] = [];
  const visit = (node: RawConfigResource | undefined): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.list)) {
      lists.push(node.list);
      for (const entry of node.list) visit(entry);
    }
    for (const values of Object.values(node.properties ?? {})) {
      if (Array.isArray(values)) for (const value of values) visit(value);
    }
    if (node.value && typeof node.value === 'object') visit(node.value as RawConfigResource);
  };
  visit(raw);

  const pipeline = lists.find((entries) => entries.some((entry) => entry.value === LDP_HANDLER));
  if (!pipeline) throw new Error('Configured HTTP pipeline containing the LDP handler was not found');
  return pipeline
    .map((entry) => entry.value)
    .filter((value): value is string => typeof value === 'string');
}

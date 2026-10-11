/**
 * Root entry of the shared core.
 *
 * The client protocol is what most consumers want, and it is the same surface
 * `@undefineds.co/ai-connections/client` publishes. The catalog and the
 * client-configuration adapters stay on their own subpaths because they are
 * larger and only some consumers need them.
 */
export * from './ai-connections-client'

/**
 * Reading the event ids a PDU names as its parents or authorisers.
 *
 * Both fields are lists of event ids, and the specification allows each entry to be either
 * a bare id or a `[id, {sha256}]` pair (the form Synapse used to send). Every reader of
 * those lists needs the same answer, so the parsing lives here rather than in each caller.
 */
export function eventReferenceIds(event: unknown, field: 'prev_events' | 'auth_events'): string[] {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
  const list = (event as Record<string, unknown>)[field];
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') ids.push(entry);
    else if (Array.isArray(entry) && typeof entry[0] === 'string') ids.push(entry[0]);
  }
  return ids;
}

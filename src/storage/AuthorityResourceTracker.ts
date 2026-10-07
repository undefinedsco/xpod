/**
 * Authority-resource mutation tracker.
 *
 * R15 protects a scoped conditional write from a local ACL/ACR mutation that lands between
 * authorization and commit. The tracker records, per *authority resource* (the exact ACL/ACR or
 * data resource a decision depends on), a monotonic generation and the number of mutations
 * currently in flight. A caller snapshots the resources a decision depended on, then — inside the
 * unified lock plan, before any mutation — compares each resource's generation and active state.
 *
 * It is deliberately not a whole-instance revision: an unrelated queued write must not invalidate an
 * ACL decision. Only a mutation of a resource that was actually read for the decision changes that
 * resource's generation.
 */
export interface AuthorityResourceSnapshot {
  /** Number of actual mutations of this resource that have started. */
  generation: number;
  /** Whether a mutation of this resource is currently in flight. */
  active: boolean;
}

export class AuthorityResourceTracker {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, number>();

  /** The current generation of one authority resource (0 when never mutated). */
  public generation(resourceUri: string): number {
    return this.generations.get(resourceUri) ?? 0;
  }

  /** A point-in-time view of one authority resource. */
  public snapshot(resourceUri: string): AuthorityResourceSnapshot {
    return { generation: this.generation(resourceUri), active: (this.active.get(resourceUri) ?? 0) > 0 };
  }

  /**
   * Whether a resource's snapshot is unchanged and no mutation of it is currently in flight.
   *
   * The captured snapshot must itself have been taken while the resource was quiescent: if a mutation
   * was already active at the moment of capture, its outcome is not reflected in the captured
   * generation, so the snapshot must never be treated as fresh even after that mutation settles with
   * the same generation.
   */
  public isFresh(resourceUri: string, captured: AuthorityResourceSnapshot): boolean {
    if (captured.active) {
      return false;
    }
    const current = this.snapshot(resourceUri);
    return current.generation === captured.generation && current.active === false;
  }

  /** Register the start of an actual mutation and return the new generation. */
  public beginMutation(resourceUri: string): number {
    const generation = this.generation(resourceUri) + 1;
    this.generations.set(resourceUri, generation);
    this.active.set(resourceUri, (this.active.get(resourceUri) ?? 0) + 1);
    return generation;
  }

  /** Register that a mutation started by {@link beginMutation} has settled (success or failure). */
  public endMutation(resourceUri: string): void {
    const current = this.active.get(resourceUri) ?? 0;
    if (current <= 1) {
      this.active.delete(resourceUri);
    } else {
      this.active.set(resourceUri, current - 1);
    }
  }

  /** Run `callback` as one mutation of `resourceUri`, invalidating every snapshot of it first. */
  public async runMutation<T>(resourceUri: string, callback: () => Promise<T>): Promise<T> {
    this.beginMutation(resourceUri);
    try {
      return await callback();
    } finally {
      this.endMutation(resourceUri);
    }
  }
}

/** The tracker shared by one canonical CSS process. */
export const authorityResourceTracker = new AuthorityResourceTracker();

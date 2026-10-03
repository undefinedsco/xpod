export interface DesktopApprovalDecision { approvalId: string; decision: 'approved' | 'rejected' }
interface ApprovalRecipient {
  send(channel: string, input: DesktopApprovalDecision): void
}

/** Native choices wait for both listeners; navigation reloads invalidate readiness. */
export class DesktopApprovalDelivery<T extends ApprovalRecipient> {
  private readonly states = new WeakMap<T, { navigation: boolean; approval: boolean; generation: number; pending: Map<string, { decision: DesktopApprovalDecision; generation: number }> }>()
  private state(target: T) {
    let state = this.states.get(target)
    if (!state) { state = { navigation: false, approval: false, generation: 0, pending: new Map() }; this.states.set(target, state) }
    return state
  }
  generation(target: T): number { return this.state(target).generation }
  enqueue(target: T, decision: DesktopApprovalDecision, generation: number): void {
    const state = this.state(target)
    if (state.generation !== generation) return
    state.pending.set(decision.approvalId, { decision, generation })
    this.flush(target)
  }
  ready(target: T, listener: 'navigation' | 'approval', ready: boolean): void {
    this.state(target)[listener] = ready
    this.flush(target)
  }
  reload(target: T): void {
    const state = this.state(target)
    state.navigation = false; state.approval = false
  }
  clear(target: T): void {
    const state = this.state(target)
    state.generation += 1
    state.pending.clear()
  }
  private flush(target: T): void {
    const state = this.state(target)
    if (!state.navigation || !state.approval) return
    for (const [id, { decision, generation }] of state.pending) {
      if (generation !== state.generation) { state.pending.delete(id); continue }
      target.send('xpod:approval-decision', decision)
      state.pending.delete(id)
    }
  }
}

import { describe, expect, test } from 'bun:test';
import { DesktopApprovalDelivery, type DesktopApprovalDecision } from '../src/approval-delivery';
describe('native approval delivery', () => {
  test('waits for navigation and approval registration, delivering exactly once', () => {
    const sent: DesktopApprovalDecision[] = [];
    const target = { send: (_channel: string, input: DesktopApprovalDecision) => sent.push(input) };
    const delivery = new DesktopApprovalDelivery<typeof target>();
    const input: DesktopApprovalDecision = { approvalId: 'https://pod.example/approval#1', decision: 'approved' };
    delivery.enqueue(target, input, delivery.generation(target));
    delivery.ready(target, 'navigation', true); expect(sent).toEqual([]);
    delivery.ready(target, 'approval', true); expect(sent).toEqual([input]);
    delivery.ready(target, 'approval', true); expect(sent).toHaveLength(1);
  });
  test('reload requires fresh listeners and identity changes discard pending choices', () => {
    const sent: DesktopApprovalDecision[] = [];
    const target = { send: (_channel: string, input: DesktopApprovalDecision) => sent.push(input) };
    const delivery = new DesktopApprovalDelivery<typeof target>();
    delivery.ready(target, 'navigation', true); delivery.ready(target, 'approval', true);
    delivery.reload(target);
    delivery.enqueue(target, { approvalId: 'one', decision: 'rejected' }, delivery.generation(target));
    delivery.ready(target, 'approval', true); expect(sent).toHaveLength(0);
    delivery.clear(target); delivery.ready(target, 'navigation', true); expect(sent).toHaveLength(0);
  });
  test('an identity switch invalidates a decision while navigation is awaiting completion', async () => {
    const sent: DesktopApprovalDecision[] = [];
    const target = { send: (_channel: string, input: DesktopApprovalDecision) => sent.push(input) };
    const delivery = new DesktopApprovalDelivery<typeof target>();
    const generation = delivery.generation(target);
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => { finishNavigation = resolve; });
    const action = navigation.then(() => delivery.enqueue(target, { approvalId: 'old-identity', decision: 'approved' }, generation));
    delivery.clear(target); // A -> B while main awaits navigation.
    delivery.clear(target); // B -> A must not resurrect the old A callback either.
    delivery.ready(target, 'navigation', true); delivery.ready(target, 'approval', true);
    finishNavigation(); await action;
    expect(sent).toEqual([]);
    delivery.enqueue(target, { approvalId: 'current-identity', decision: 'rejected' }, delivery.generation(target));
    expect(sent).toEqual([{ approvalId: 'current-identity', decision: 'rejected' }]);
  });

});

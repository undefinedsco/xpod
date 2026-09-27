import { describe, expect, it } from 'vitest';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

const AGENT = 'https://agent.example/a';
const WORKSPACE = 'https://pod.example/workspace/';

/**
 * An authorization decision must not outlive the fact it was made from.
 *
 * The acceptance gate for bounded sync and permission updates says a later request must not reuse an
 * earlier allow/deny decision after an ordinary state write. This pins that on the Matrix path's
 * agent grant, which is the decision that authorises *execution*: revoke it and the very next call
 * has to see the revocation, not a remembered answer.
 */
describe('an agent grant is read, not remembered', () => {
  async function roomWithGrants() {
    const harness = matrixHarness();
    const room = await harness.store.createRoom({}, harness.context);
    const grant = {
      agent: AGENT,
      executor: harness.context.webId,
      workspace: WORKSPACE,
      allowedActors: [ harness.context.webId ],
      handoffTo: [],
    };
    return { harness, room, grant };
  }

  it('sees a revocation on the next call, and a re-grant after that', async () => {
    const { harness, room, grant } = await roomWithGrants();

    await harness.store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant ] }, harness.context);
    await expect(harness.store.authorize(room.roomId, AGENT, harness.context)).resolves.toMatchObject({ thread: expect.any(String) });

    // The write that revokes it is the only thing that changed; the next call must act on it.
    await harness.store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [] }, harness.context);
    await expect(harness.store.authorize(room.roomId, AGENT, harness.context)).rejects.toThrow(/No execution grant/u);

    // And the reverse direction, so this is about reading the current state rather than about one
    // order of writes.
    await harness.store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant ] }, harness.context);
    await expect(harness.store.authorize(room.roomId, AGENT, harness.context)).resolves.toMatchObject({ thread: expect.any(String) });
  });

  it('does not grant execution that the current state gives to somebody else', async () => {
    const { harness, room, grant } = await roomWithGrants();
    // `authorize` is about the *executor*: a grant naming another executor is not ours to use, and
    // `allowedActors` (who may trigger the agent) is enforced where routing is decided.
    await harness.store.setState(room.roomId, 'co.undefineds.agents', '', {
      agents: [ { ...grant, executor: 'https://another-executor.example/agent' } ],
    }, harness.context);
    await expect(harness.store.authorize(room.roomId, AGENT, harness.context)).rejects.toThrow(/No execution grant/u);

    // And an agent that the current state does not name at all is not authorised either.
    await harness.store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant ] }, harness.context);
    await expect(harness.store.authorize(room.roomId, 'https://agent.example/other', harness.context))
      .rejects.toThrow(/No execution grant/u);
  });
});

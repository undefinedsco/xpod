import { InternalServerError, PromptFactory } from '@solid/community-server';
import { interactionPolicy } from 'oidc-provider';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from './RememberedClientGrantStore';

/** Runs after the existing account and WebID checks, before any consent checks. */
export class RememberedClientPromptFactory extends PromptFactory {
  public constructor(
    private readonly source: PromptFactory,
    private readonly store: RememberedClientGrantStore,
  ) {
    super();
  }

  public async handle(policy: interactionPolicy.DefaultPolicy): Promise<void> {
    await this.source.handleSafe(policy);
    const consent = policy.get('consent');
    const native = consent?.checks.get('native_client_prompt');
    const consentIndex = policy.findIndex((prompt) => prompt.name === 'consent');
    const loginIndex = policy.findIndex((prompt) => prompt.name === 'login');
    if (!consent || !native || loginIndex < 0 || loginIndex >= consentIndex) {
      throw new InternalServerError('Missing ordered default login and consent policies.');
    }
    const remembered = new WeakSet<object>();
    policy.add(new interactionPolicy.Prompt(
      { name: 'restore_remembered_client', requestable: false },
      new interactionPolicy.Check('restore_remembered_client', 'Restore previously remembered consent.', async (ctx) => {
        const { oidc } = ctx;
        const accountId = oidc.session?.accountId;
        const clientId = oidc.client?.clientId;
        if (!accountId || clientId !== XPOD_DESKTOP_CLIENT_ID || oidc.result?.consent) {
          return false;
        }
        const grant = await this.store.find(oidc.provider, accountId, clientId);
        if (grant) {
          oidc.session!.ensureClientContainer(clientId);
          oidc.session!.grantIdFor(clientId, grant.jti);
          oidc.entity('Grant', grant);
          remembered.add(ctx);
        }
        return false;
      }),
    ), consentIndex);
    const originalCheck = native.check;
    native.check = async (ctx): Promise<boolean> => remembered.has(ctx) ? false : originalCheck(ctx);
  }
}

import {
  FoundHttpError,
  JsonInteractionHandler,
  type JsonInteractionHandlerInput,
  type JsonRepresentation,
  type ProviderFactory,
} from '@solid/community-server';
import { boolean, object } from 'yup';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from './RememberedClientGrantStore';

const rememberSchema = object({ remember: boolean().default(false) });

/** Records successful CSS consent without replacing its grant or interaction handling. */
export class RememberedConsentHandler extends JsonInteractionHandler {
  public constructor(
    private readonly providerFactory: ProviderFactory,
    private readonly source: JsonInteractionHandler,
    private readonly store: RememberedClientGrantStore,
  ) {
    super();
  }

  public override async canHandle(input: JsonInteractionHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const interaction = input.oidcInteraction;
    const previousResult = interaction?.result;
    try {
      return await this.source.handleSafe(input);
    } catch (error) {
      if (!FoundHttpError.isInstance(error) || !interaction?.result?.consent ||
        interaction.result === previousResult) {
        throw error;
      }
      const accountId = interaction.session?.accountId;
      const clientId = interaction.params.client_id;
      const grantId = interaction.result.consent.grantId ?? interaction.grantId;
      if (accountId && clientId === XPOD_DESKTOP_CLIENT_ID && grantId) {
        const provider = await this.providerFactory.getProvider();
        const grant = await provider.Grant.find(grantId);
        if (grant?.accountId === accountId && grant.clientId === clientId) {
          const { remember } = await rememberSchema.validate(input.json);
          if (remember) {
            await this.store.remember(grant);
          } else {
            await this.store.forget(accountId, clientId);
          }
        }
      }
      throw error;
    }
  }
}

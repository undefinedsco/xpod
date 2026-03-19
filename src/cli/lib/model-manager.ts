/**
 * Get available AI models based on configured providers.
 *
 * Queries the user's Pod for configured AI providers and returns
 * the list of available models from each provider.
 */

import { drizzle } from '@undefineds.co/drizzle-solid';
import { ApiKeyCredential, OAuthCredential } from '../../credential/schema/tables';
import { Provider } from '../../ai/schema/provider';
import { Model } from '../../ai/schema/model';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';
import type { Session } from '@inrupt/solid-client-authn-node';
import { getModels } from '@mariozechner/pi-ai';

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Get all available models from configured providers.
 *
 * Returns models from:
 * 1. Providers with active API key credentials
 * 2. Providers with active OAuth credentials
 * 3. Platform default models (from xpod API)
 */
export async function getAvailableModels(session: Session, xpodUrl: string): Promise<AvailableModel[]> {
  const models: AvailableModel[] = [];

  try {
    const db: any = drizzle({
      fetch: session.fetch,
      info: session.info,
    } as any);

    // 1. Get all active credentials
    const allApiKeyCredentials = await db.select().from(ApiKeyCredential) as any[];
    const apiKeyCredentials = allApiKeyCredentials.filter((c: any) =>
      c.service === ServiceType.AI && c.status === CredentialStatus.ACTIVE,
    );

    const allOAuthCredentials = await db.select().from(OAuthCredential) as any[];
    const oauthCredentials = allOAuthCredentials.filter((c: any) =>
      c.service === ServiceType.AI && c.status === CredentialStatus.ACTIVE,
    );

    const allCredentials = [...apiKeyCredentials, ...oauthCredentials];

    // 2. Get all providers
    const allProviders = await db.select().from(Provider) as any[];
    const providerByUri = new Map(allProviders.map(p => [p['@id'], p]));

    // 3. Collect provider IDs from credentials
    const configuredProviderIds = new Set<string>();
    for (const cred of allCredentials) {
      if (!cred.provider) continue;
      const provider = providerByUri.get(cred.provider);
      if (provider && provider.id) {
        configuredProviderIds.add(provider.id as string);
      }
    }

    // 4. Get models from each configured provider
    for (const providerId of configuredProviderIds) {
      try {
        // Only get models for known providers
        const knownProviders = ['openai', 'anthropic', 'openrouter', 'ollama', 'google', 'codebuddy'];
        if (!knownProviders.includes(providerId)) {
          console.warn(`Skipping unknown provider: ${providerId}`);
          continue;
        }

        const providerModels = getModels(providerId as any);
        for (const model of providerModels) {
          models.push({
            id: model.id,
            name: model.name || model.id,
            provider: providerId,
            providerName: model.provider || providerId,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          });
        }
      } catch (error) {
        console.warn(`Failed to get models for provider ${providerId}:`, error);
      }
    }

    // 4.5. Get custom models from Pod
    try {
      const allModels = await db.select().from(Model) as any[];
      for (const model of allModels) {
        // Avoid duplicates
        if (!models.some(m => m.id === model.id)) {
          const provider = providerByUri.get(model.isProvidedBy);
          models.push({
            id: model.id,
            name: model.displayName || model.id,
            provider: provider?.id as string || 'custom',
            providerName: provider?.displayName as string || 'Custom',
            contextWindow: model.contextLength,
            maxTokens: model.maxOutputTokens,
          });
        }
      }
    } catch (error) {
      console.warn('Failed to get custom models:', error);
    }

    // 5. Always include platform default models (from xpod API)
    try {
      const baseUrl = xpodUrl.endsWith('/') ? xpodUrl : `${xpodUrl}/`;
      const modelsUrl = `${baseUrl}v1/models`;

      const response = await session.fetch(modelsUrl, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json() as { object: string; data: any[] };
        for (const model of data.data) {
          // Avoid duplicates
          if (!models.some(m => m.id === model.id)) {
            models.push({
              id: model.id,
              name: model.name || model.id,
              provider: model.provider || 'platform',
              providerName: model.owned_by || 'Platform Default',
              contextWindow: model.context_window,
              maxTokens: model.max_tokens,
            });
          }
        }
      } else {
        console.warn(`Failed to fetch platform models: ${response.status}`);
      }
    } catch (error) {
      console.warn('Failed to get platform default models:', error);
    }
  } catch (error) {
    console.error('Failed to get available models:', error);
    // Return empty array on error
  }

  return models;
}

/**
 * Get a specific model by ID.
 */
export async function getModelById(session: Session, xpodUrl: string, modelId: string): Promise<AvailableModel | null> {
  const models = await getAvailableModels(session, xpodUrl);
  return models.find(m => m.id === modelId) || null;
}

/**
 * List available models (for CLI display).
 */
export async function listAvailableModels(session: Session, xpodUrl: string): Promise<void> {
  const models = await getAvailableModels(session, xpodUrl);

  console.log('\n📋 Available Models:\n');

  // Group by provider
  const byProvider = new Map<string, AvailableModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider) || [];
    list.push(model);
    byProvider.set(model.provider, list);
  }

  for (const [, providerModels] of byProvider) {
    console.log(`\n${providerModels[0].providerName}:`);
    for (const model of providerModels) {
      const ctx = model.contextWindow ? ` (${model.contextWindow} tokens)` : '';
      console.log(`  ${model.id}${ctx}`);
    }
  }

  console.log('');
}

/**
 * Add a custom model to the user's Pod.
 */
export async function addCustomModel(session: Session, xpodUrl: string, modelId: string): Promise<void> {
  try {
    const db: any = drizzle({
      fetch: session.fetch,
      info: session.info,
    } as any);

    // Check if model already exists
    const allModels = await db.select().from(Model) as any[];
    if (allModels.some(m => m.id === modelId)) {
      console.log(`✓ Model ${modelId} already exists`);
      return;
    }

    // Prompt for provider
    const { promptText } = await import('./prompt.js');
    console.log('\n📝 Add custom model\n');

    const displayName = await promptText(`Display name (default: ${modelId}): `);
    const providerInput = await promptText('Provider ID (e.g., openai, anthropic, custom): ');
    const providerId = providerInput || 'custom';

    // Get or create provider
    const allProviders = await db.select().from(Provider) as any[];
    let provider = allProviders.find(p => p.id === providerId);

    if (!provider) {
      console.log(`\n⚠️  Provider ${providerId} not found. Creating new provider...`);
      const providerName = await promptText(`Provider display name (default: ${providerId}): `);
      const baseUrl = await promptText('Base URL (optional): ');

      await db.insert(Provider).values({
        id: providerId,
        displayName: providerName || providerId,
        baseUrl: baseUrl || undefined,
      });

      // Reload provider
      const updatedProviders = await db.select().from(Provider) as any[];
      provider = updatedProviders.find(p => p.id === providerId);
    }

    if (!provider) {
      throw new Error('Failed to create provider');
    }

    // Create model
    const podUrl = xpodUrl.endsWith('/') ? xpodUrl : `${xpodUrl}/`;
    const providerUri = `${podUrl}settings/ai/providers.ttl#${providerId}`;

    await db.insert(Model).values({
      id: modelId,
      displayName: displayName || modelId,
      isProvidedBy: providerUri,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    console.log(`\n✅ Model ${modelId} added successfully!`);
    console.log(`   Provider: ${provider.displayName || providerId}`);
    console.log(`   Display name: ${displayName || modelId}\n`);
  } catch (error) {
    console.error('Failed to add custom model:', error);
    throw error;
  }
}

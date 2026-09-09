import type { GatewayEvent } from '../types';
import { GatewayProtocolError } from '../errors';
import { AnthropicRuntimeAdapter } from './AnthropicRuntimeAdapter';
import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapter,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { ProviderDescriptor } from './ProviderRegistry';
import type { ProviderHttpTransport } from '../../service/provider-http-transport';

export class CustomRuntimeAdapter implements ProviderRuntimeAdapter {
  public readonly provider = 'custom';
  private readonly openai: ProviderRuntimeAdapter;
  private readonly anthropic: ProviderRuntimeAdapter;

  public constructor(input: { transport: ProviderHttpTransport; descriptor: ProviderDescriptor }) {
    this.openai = new OpenAiCompatibleRuntimeAdapter({
      transport: input.transport,
      provider: 'custom',
      descriptor: input.descriptor,
      defaultBaseUrl: input.descriptor.defaultBaseUrl,
      safeBaseUrls: input.descriptor.safeBaseUrls,
      allowCredentialBaseUrl: true,
      supportsImages: input.descriptor.capabilities.imageInput,
      supportsDeveloperMessages: true,
      allowToolChoiceRequired: true,
    });
    this.anthropic = new AnthropicRuntimeAdapter({
      transport: input.transport,
      provider: 'custom',
      defaultBaseUrl: input.descriptor.defaultBaseUrl,
      safeBaseUrls: input.descriptor.safeBaseUrls,
      allowCredentialBaseUrl: true,
    });
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const compatibility = input.credential?.compatibility ?? 'openai';
    if (compatibility === 'anthropic') {
      yield* this.anthropic.execute(input);
      return;
    }
    if (compatibility !== 'auto') {
      yield* this.openai.execute(input);
      return;
    }
    let emitted = false;
    try {
      for await (const event of this.openai.execute(input)) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (emitted) throw error;
      let anthropicEmitted = false;
      try {
        for await (const event of this.anthropic.execute(input)) {
          anthropicEmitted = true;
          yield event;
        }
      } catch (anthropicError) {
        if (anthropicEmitted) throw anthropicError;
        throw new GatewayProtocolError('custom_protocol_detection_failed:openai_and_anthropic', {
          code: 'provider_error',
          status: 502,
          details: {
            probes: {
              openai: sanitizeProbeFailure(error),
              anthropic: sanitizeProbeFailure(anthropicError),
            },
          },
        });
      }
    }
  }
}

function sanitizeProbeFailure(error: unknown): {
  code: GatewayProtocolError['code'];
  status: number;
  providerStatusCode: number;
  classification: string;
} {
  const gatewayError = error instanceof GatewayProtocolError ? error : undefined;
  const status = safeHttpStatus(gatewayError?.status ?? (error as { status?: unknown })?.status);
  const providerStatusCode = safeHttpStatus(gatewayError?.details?.providerStatusCode, status);
  const classification = safeClassification(gatewayError?.details?.classification)
    ?? classifyProbeStatus(providerStatusCode);
  return {
    code: gatewayError?.code ?? 'provider_error',
    status,
    providerStatusCode,
    classification,
  };
}

function safeHttpStatus(value: unknown, fallback = 502): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : fallback;
}

function safeClassification(value: unknown): string | undefined {
  return typeof value === 'string' && [
    'authentication',
    'authorization',
    'quota_exhausted',
    'rate_limited',
    'upstream_unavailable',
    'provider_error',
  ].includes(value)
    ? value
    : undefined;
}

function classifyProbeStatus(status: number): string {
  if (status === 401) return 'authentication';
  if (status === 402) return 'quota_exhausted';
  if (status === 403) return 'authorization';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'provider_error';
}

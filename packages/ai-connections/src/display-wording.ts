import type {
  AiConnectionsProvider,
  AiProviderAuthorizationMethod,
} from './contract/ai-connections-client'

/**
 * The wording this applet shows, in one place.
 *
 * The shared core carries what a provider *is* and how to talk to it - ids,
 * auth modes, connect modes, endpoints - and deliberately carries no user-facing
 * wording. A connect entry's wording is a property of the entry's id, so it
 * belongs here, where it is rendered, rather than in the catalog, in the
 * payload the server sends, and in this applet's own fallback derivation, which
 * is where the same button used to be named three different ways.
 *
 * An id this table does not know keeps whatever wording its payload declared:
 * a provider the user configured themselves can still name its own entry, and an
 * entry that names nothing stays unrendered, which is how "the offering did not
 * ask for this button" has always been expressed.
 *
 * The table lists only the ids the shared core stopped naming - the four connect
 * actions plus the browser authorization-code entry. A declared wording always
 * wins (see `authorizationMethodLabel`); this is the fallback that keeps a
 * payload naming nothing renderable under the action's own name.
 */
const AUTHORIZATION_METHOD_LABEL_BY_ID: Record<string, string> = {
  'api-key': '添加 API Key',
  'browser-login': '浏览器登录',
  'browser-oauth': '浏览器登录',
  'device-code': '设备码登录',
  'local-session-import': '已有登录态',
  'local-service': '本地服务',
}

/**
 * Wording for one connect entry.
 *
 * A payload that declares its own wording keeps it: the entry's own name is the
 * more specific statement, and it is how a provider the user configured names
 * its entry, and how one offering renames a shared action for its context. The
 * table only fills the gap the shared core deliberately leaves - it names the
 * action by `id` and no longer writes the button.
 */
export function authorizationMethodLabel(method: AiProviderAuthorizationMethod): string | undefined {
  return method.label ?? AUTHORIZATION_METHOD_LABEL_BY_ID[method.id]
}

/** Fills in the wording of every entry that has one. */
export function withAuthorizationMethodLabels(
  methods: readonly AiProviderAuthorizationMethod[],
): AiProviderAuthorizationMethod[] {
  return methods.map((method) => {
    const label = authorizationMethodLabel(method)
    return label === method.label ? method : { ...method, label }
  })
}

/**
 * The name this applet shows for a provider. English for the providers whose
 * product name is English, Chinese where the product is known by its Chinese
 * name - a display decision, so it lives with the display layer instead of
 * travelling in every payload.
 */
export function providerDisplayName(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'kimi':
      return 'Kimi';
    case 'bailian':
      return '百炼';
    case 'deepseek':
      return 'DeepSeek';
    case 'zhipu':
      return '智谱 AI';
    case 'ollama':
      return 'Ollama';
    case 'custom':
      return 'Custom';
  }
}

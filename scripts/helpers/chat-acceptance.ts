/** Shared acceptance rules, with no service startup or credential access. */
export const CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS = 512;
export type ChatAcceptanceProtocol = 'chatCompletions' | 'responses' | 'anthropic';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(part => typeof object(part)?.text !== 'string')) return undefined;
  return value.map(part => object(part)!.text).join('');
}
function stopped(reason: unknown): boolean { return reason === 'stop' || reason === 'end_turn'; }

export function chatCompletionBodyMatches(body: unknown, marker: string): boolean {
  const value = object(body);
  const choices = value?.choices;
  if (value?.error || !Array.isArray(choices) || choices.length !== 1) return false;
  const choice = object(choices[0]);
  return choice?.finish_reason === 'stop' && contentText(object(choice.message)?.content)?.trim() === marker;
}

/** Reasoning, HTTP success and a partial marker cannot establish an answer.
 * Check each protocol's assistant text and terminal event independently.
 */
export function streamedChatBodyMatches(text: string, protocol: ChatAcceptanceProtocol, marker: string): boolean {
  let answer = '';
  let completed = false;
  let successfulStop = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    let event: ObjectValue | undefined;
    try { event = object(JSON.parse(payload)); } catch { return false; }
    if (!event || event.error || event.type === 'error' || event.type === 'response.failed') return false;
    let delta: unknown;
    let terminal = false;
    if (protocol === 'chatCompletions') {
      if (Array.isArray(event.choices) && event.choices.length > 1) return false;
      const choice = object(Array.isArray(event.choices) ? event.choices[0] : undefined);
      delta = object(choice?.delta)?.content;
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        terminal = true;
        successfulStop = choice.finish_reason === 'stop';
      }
    } else if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta') delta = event.delta;
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        terminal = true;
        const response = object(event.response);
        successfulStop = event.type === 'response.completed' && response?.status === 'completed'
          && !response.incomplete_details && (response.finish_reason === undefined || stopped(response.finish_reason));
      }
    } else {
      const part = object(event.delta);
      if (event.type === 'content_block_delta' && part?.type === 'text_delta') delta = part.text;
      if (event.type === 'message_delta' && part?.stop_reason !== undefined) successfulStop = stopped(part.stop_reason);
      if (event.type === 'message_stop') {
        terminal = true;
        if (event.stop_reason !== undefined) successfulStop = stopped(event.stop_reason);
      }
    }
    if (typeof delta === 'string') {
      if (completed) return false;
      answer += delta;
    }
    if (terminal) {
      if (completed || !successfulStop) return false;
      completed = true;
    }
  }
  return completed && answer.trim() === marker;
}

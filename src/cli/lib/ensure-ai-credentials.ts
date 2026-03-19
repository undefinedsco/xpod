/**
 * Ensure AI credentials helper
 *
 * 在 agent 启动前检查是否有 AI credentials，如果没有则提示用户登录。
 */

import type { Session } from '@inrupt/solid-client-authn-node';
import { loadPodAiConfig } from './pod-ai-config';
import { promptText } from './prompt';

/**
 * 确保用户有 AI credentials，如果没有则提示
 *
 * @param session - Solid session
 * @returns true if credentials exist, false if user skipped setup
 */
export async function ensureAiCredentials(session: Session): Promise<boolean> {
  // 检查是否已有 AI credentials
  const existingConfig = await loadPodAiConfig(session);
  if (existingConfig) {
    return true; // 已有配置，直接返回
  }

  // 没有配置，提示用户
  console.log('\n💡 No AI credentials found in your Pod.');
  console.log('The agent will use the platform default provider.');
  console.log('');
  console.log('To use your own AI provider, you can:');
  console.log('  • Run: xpod login codebuddy');
  console.log('  • Run: xpod config set --provider openai --api-key YOUR_KEY');
  console.log('');

  const choice = await promptText('Continue with default provider? (Y/n): ');

  if (choice.toLowerCase() === 'n') {
    console.log('\nPlease configure an AI provider first:');
    console.log('  xpod login codebuddy');
    console.log('  xpod config set --provider openai --api-key YOUR_KEY\n');
    return false;
  }

  return true; // 用户选择继续使用默认 provider
}

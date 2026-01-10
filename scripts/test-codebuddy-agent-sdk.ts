/**
 * 测试 CodeBuddy Agent SDK 是否可以正常工作
 *
 * 运行: npx ts-node scripts/test-codebuddy-agent-sdk.ts
 */

import { query } from '@tencent-ai/agent-sdk';

async function main() {
  console.log('Testing CodeBuddy Agent SDK...\n');

  const abortController = new AbortController();

  // 60秒超时
  const timeout = setTimeout(() => {
    console.log('\n⏰ Timeout - aborting...');
    abortController.abort();
  }, 60000);

  try {
    // 简单测试
    const q = query({
      prompt: '请直接回答：1+1=?',
      options: {
        abortController,
        // 禁用工具
        disallowedTools: ['Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch'],
        maxTurns: 1,
      },
    });

    // 收集消息
    for await (const message of q) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log('Assistant:', block.text);
            }
          }
        } else {
          console.log('Assistant:', content);
        }
      } else if (message.type === 'result') {
        console.log('\n✅ Result subtype:', message.subtype);
        console.log('Turns:', message.num_turns);
        console.log('Cost:', message.total_cost_usd, 'USD');
      } else if (message.type === 'system') {
        console.log('[system] initialized');
      }
    }

    clearTimeout(timeout);
    console.log('\n✅ CodeBuddy Agent SDK test passed!');
  } catch (error) {
    clearTimeout(timeout);
    if ((error as Error).name === 'AbortError') {
      console.log('\n⏰ Test aborted due to timeout');
    } else {
      console.error('❌ Error:', error);
    }
    process.exit(1);
  }
}

main();

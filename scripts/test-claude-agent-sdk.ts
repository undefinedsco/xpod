/**
 * 测试 Claude Agent SDK 是否可以正常工作
 *
 * 运行: npx ts-node scripts/test-claude-agent-sdk.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Testing Claude Agent SDK...\n');

  const abortController = new AbortController();
  
  // 60秒超时
  const timeout = setTimeout(() => {
    console.log('\n⏰ Timeout - aborting...');
    abortController.abort();
  }, 60000);

  try {
    // 简单测试：让 Claude 回答一个问题
    const q = query({
      prompt: '2',  // 超简单的 prompt
      options: {
        abortController,
        // 禁用所有工具
        disallowedTools: ['Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch'],
        // 限制轮数
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
        if (message.subtype === 'success') {
          console.log('\n✅ Success! Result:', message.result?.slice(0, 200));
        } else {
          console.log('\n⚠️ Ended with:', message.subtype);
        }
        console.log('Turns:', message.num_turns);
        console.log('Cost:', message.total_cost_usd, 'USD');
      } else if (message.type === 'system') {
        console.log('[system] initialized, tools:', (message as any).tools?.length ?? 0);
      }
    }

    clearTimeout(timeout);
    console.log('\n✅ Claude Agent SDK test passed!');
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

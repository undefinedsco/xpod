/**
 * Real CLI smoke test for agent config passthrough.
 * Run directly: bun scripts/test-acp-agent-config.ts
 */
import { AcpAgentRuntime } from '../src/api/chatkit/runtime/AcpAgentRuntime';
import type { ResolvedAgentConfig } from '../src/agents/config/types';

const runners = ['codebuddy', 'claude', 'codex'] as const;

const agentConfig: ResolvedAgentConfig = {
  id: 'smoke-test',
  displayName: 'Smoke Test Agent',
  description: 'Validates agent config passthrough',
  systemPrompt: 'You are a concise assistant. Reply with a single word when possible.',
  executorType: 'claude',
  apiKey: process.env.DEFAULT_API_KEY?.trim() || '',
  baseUrl: process.env.DEFAULT_API_BASE?.trim(),
  model: process.env.DEFAULT_MODEL?.trim(),
  maxTurns: 5,
  allowedTools: [],
  mcpServers: {},
  skillsContent: undefined,
  enabled: true,
};

async function testRunner(runner: typeof runners[number]): Promise<void> {
  const rt = new AcpAgentRuntime();
  const threadId = `smoke-${runner}-${Date.now()}`;

  console.log(`\n=== Testing ${runner} with agentConfig ===`);

  try {
    let text = '';
    let sawAuth = false;
    for await (const ev of rt.run({
      threadId,
      prompt: 'Reply with exactly: OK',
      config: {
        workspace: `file://localhost${process.cwd()}`,
        idleMs: 30_000,
        runner: { type: runner, protocol: 'acp' },
        agentConfig,
      },
    })) {
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'auth_required') {
        sawAuth = true;
        console.log(`  [!] auth_required: ${ev.url}`);
      }
      if (ev.type === 'error') {
        console.log(`  [✗] runtime error: ${ev.message}`);
      }
    }

    if (sawAuth && !text.trim()) {
      console.log(`  [~] Skipped: auth required`);
    } else if (text.trim()) {
      console.log(`  [✓] Got response: "${text.trim().slice(0, 80)}"`);
    } else {
      console.log(`  [?] No text output`);
    }
  } catch (e: any) {
    console.log(`  [✗] run FAILED: ${e.message}`);
  }

  // Also test without agentConfig (regression)
  const threadId2 = `smoke-${runner}-noconfig-${Date.now()}`;
  try {
    let text2 = '';
    for await (const ev of rt.run({
      threadId: threadId2,
      prompt: 'Reply with exactly: OK',
      config: {
        workspace: `file://localhost${process.cwd()}`,
        idleMs: 30_000,
        runner: { type: runner, protocol: 'acp' },
      },
    })) {
      if (ev.type === 'text') text2 += ev.text;
      if (ev.type === 'auth_required') {
        console.log(`  [~] auth_required (no agentConfig)`);
        break;
      }
    }
    if (text2.trim()) {
      console.log(`  [✓] Regression OK: "${text2.trim().slice(0, 80)}"`);
    }
  } catch (e: any) {
    console.log(`  [✗] Regression FAILED: ${e.message}`);
  }
}

async function main() {
  if (!agentConfig.apiKey) {
    console.error('DEFAULT_API_KEY not set, aborting.');
    process.exit(1);
  }
  console.log(`API base: ${agentConfig.baseUrl || '(default)'}`);
  console.log(`Model: ${agentConfig.model || '(default)'}`);

  for (const runner of runners) {
    await testRunner(runner);
  }
  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

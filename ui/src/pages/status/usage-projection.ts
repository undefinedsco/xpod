export function projectAiUsage(input: { usage: { tokensUsed: number; computeSeconds: number }; limits: { tokenLimitMonthly: number | null; computeLimitSeconds: number | null } }): Array<[string, string]> {
  return [
    ['Tokens', input.usage.tokensUsed.toLocaleString('en-US')],
    ['Monthly token limit', input.limits.tokenLimitMonthly == null ? 'Unlimited' : input.limits.tokenLimitMonthly.toLocaleString('en-US')],
    ['Compute', `${input.usage.computeSeconds.toLocaleString('en-US')} s`],
    ['Compute limit', input.limits.computeLimitSeconds == null ? 'Unlimited' : `${input.limits.computeLimitSeconds.toLocaleString('en-US')} s`],
  ];
}

export function projectIndexStorage(input: { factsBytes: number; derivedBytes: number; totalBytes: number }): Array<[string, string]> {
  return [['Authority data', formatBytes(input.factsBytes)], ['Derived indexes', formatBytes(input.derivedBytes)], ['Combined', formatBytes(input.totalBytes)]];
}

function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }

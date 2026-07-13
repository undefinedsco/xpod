import { describe, expect, it } from 'vitest';
import { buildWorkspaceSemanticsPrompt, buildWorkspaceSummaryPrompt } from '../../src/solidfs';

describe('workspace prompt helpers', () => {
  it('explains placeholders and explicit hydration', () => {
    const prompt = buildWorkspaceSemanticsPrompt();
    expect(prompt).toContain('Xpod SolidFS materialized workspace');
    expect(prompt).toContain('Do not assume placeholder bytes are the real content');
    expect(prompt).toContain('Hydration has cost');
    expect(prompt).toContain('Search/vector/index artifacts are internal');
  });

  it('renders dynamic workspace summary', () => {
    const prompt = buildWorkspaceSummaryPrompt({
      root: '/workspace/demo',
      authority: 'cloud-object-store',
      files: 100,
      bylineLocalFiles: 90,
      remotePlaceholders: 10,
      hydratedRemoteObjects: 2,
      freeLocalCacheBytes: 1024,
      maxHydrateBytesWithoutConfirmation: 2048,
      tools: ['stat', 'read_meta', 'hydrate'],
    });

    expect(prompt).toContain('Root: "/workspace/demo"');
    expect(prompt).toContain('Remote placeholders: 10');
    expect(prompt).toContain('"hydrate"');
  });

  it('quotes dynamic root and tools so newlines cannot inject prompt lines', () => {
    const prompt = buildWorkspaceSummaryPrompt({
      root: '/workspace/demo\nInjected: yes',
      authority: 'local-filesystem',
      files: 3,
      bylineLocalFiles: 2,
      remotePlaceholders: 1,
      hydratedRemoteObjects: 0,
      tools: ['stat\n- injected', 'hydrate'],
    });

    expect(prompt).toContain('Root: "/workspace/demo\\nInjected: yes"');
    expect(prompt).toContain('Available tools: "stat\\n- injected", "hydrate"');
    expect(prompt.split('\n')).not.toContain('Injected: yes');
    expect(prompt.split('\n')).not.toContain('- injected');
  });

  it('escapes Unicode logical line separators as visible prompt text', () => {
    const prompt = buildWorkspaceSummaryPrompt({
      root: '/workspace/demo\u2028Injected: yes\u2029Paragraph: yes\u0085Next: yes',
      authority: 'local-filesystem',
      files: 3,
      bylineLocalFiles: 2,
      remotePlaceholders: 1,
      hydratedRemoteObjects: 0,
      tools: ['stat\u2028- injected', 'hydrate\u2029paragraph', 'meta\u0085next'],
    });

    expect(prompt).toContain('Root: "/workspace/demo\\u2028Injected: yes\\u2029Paragraph: yes\\u0085Next: yes"');
    expect(prompt).toContain('Available tools: "stat\\u2028- injected", "hydrate\\u2029paragraph", "meta\\u0085next"');
    expect(prompt).not.toContain('\u2028Injected: yes');
    expect(prompt).not.toContain('\u2029Paragraph: yes');
    expect(prompt).not.toContain('\u0085Next: yes');
    expect(prompt).not.toContain('\u2028- injected');
    expect(prompt).not.toContain('\u2029paragraph');
    expect(prompt).not.toContain('\u0085next');
  });
});

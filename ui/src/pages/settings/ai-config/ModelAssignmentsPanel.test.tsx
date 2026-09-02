import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { ModelAssignmentRow } from './ModelAssignmentsPanel';

const baseProps = {
  label: 'Embedding',
  name: 'embeddingModel' as const,
  description: 'Creates vectors for semantic search.',
  testing: false,
  onChange: vi.fn(),
  onTest: vi.fn(),
};

describe('ModelAssignmentRow', () => {
  test('shows the default state once and aligns the select with a same-height test button', () => {
    const html = renderToStaticMarkup(
      <ModelAssignmentRow {...baseProps} models={[]} />,
    );

    expect(html.match(/System default/gu)).toHaveLength(1);
    expect(html).toContain('sm:grid-cols-[minmax(0,1fr)_4.5rem]');
    expect(html).toContain('h-10 w-full self-start');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('Creates vectors for semantic search.');
  });

  test('reserves the shared status row for an explicit model or probe result', () => {
    const html = renderToStaticMarkup(
      <ModelAssignmentRow
        {...baseProps}
        value="/settings/providers/openai.ttl#embedding-small"
        testResult="ready"
        models={[{
          id: 'embedding-small',
          displayName: 'Embedding Small',
          owner: 'openai',
          ref: '/settings/providers/openai.ttl#embedding-small',
          capabilities: ['embedding'],
        }]}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Connected · credential ready · openai · Probe succeeded');
    expect(html).toContain('sm:col-span-2');
  });
});

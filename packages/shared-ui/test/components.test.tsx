import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Input,
  cn,
} from '../src'

describe('@undefineds.co/shared-ui', () => {
  it('exports the controls required by standalone applets', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardTitle>AI Connection</CardTitle>
        <CardContent>
          <Input aria-label="API Key" />
          <Button variant="outline">Connect</Button>
          <Badge>Ready</Badge>
        </CardContent>
      </Card>,
    )

    expect(html).toContain('AI Connection')
    expect(html).toContain('aria-label="API Key"')
    expect(html).toContain('Connect')
    expect(html).toContain('Ready')
  })

  it('merges utility classes consistently across hosts', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4')
  })
})

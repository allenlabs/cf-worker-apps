import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeMemoryNotice } from './NativeMemoryNotice'

describe('native memory disclosure', () => {
  it('distinguishes automatic capture, recall preference and indexing', () => {
    const html = renderToStaticMarkup(<NativeMemoryNotice enabled />)
    expect(html).toContain('complete saved text conversations')
    expect(html).toContain('recall only, not transcript capture')
    expect(html).toContain('still be indexing')
  })
  it('does not advertise automatic capture in unconfigured deployments', () => {
    expect(renderToStaticMarkup(<NativeMemoryNotice enabled={false} />)).toBe('')
  })
})

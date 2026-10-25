// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotProfile } from '@gadgets/workshop-shared/api'
import { BotPicker, BotSnapshotBadge, botSelectionFromProfiles, botIdFromSearch } from './BotPicker'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const profile: BotProfile = { id: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Research partner',
  description: 'Use primary sources.', instructions: 'Cite.', icon: 'search', starterPrompts: [], memory: 'off', archived: false,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' }
describe('bot selection', () => {
  let root: Root | undefined
  afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })
  it('fails visibly for a selected unavailable or archived bot instead of returning the standard agent', () => {
    expect(() => botSelectionFromProfiles(profile.id, [], 'error')).toThrow(/load/i)
    expect(() => botSelectionFromProfiles(profile.id, [], 'loading')).toThrow(/load/i)
    expect(() => botSelectionFromProfiles(profile.id, [], 'ready')).toThrow(/unavailable/i)
    expect(() => botSelectionFromProfiles(profile.id, [{ ...profile, archived: true }], 'ready')).toThrow(/unavailable/i)
    expect(botSelectionFromProfiles(undefined, [], 'error')).toBeUndefined()
    expect(botSelectionFromProfiles(profile.id, [profile], 'ready')).toEqual({ id: profile.id, revision: 3 })
  })
  it('rejects malformed route identities and preserves a complete UUID', () => {
    expect(botIdFromSearch(profile.id)).toBe(profile.id)
    expect(botIdFromSearch(undefined)).toBeUndefined()
    expect(() => botIdFromSearch('someone/else')).toThrow(/bot/i)
  })
  it('keeps a failed selection explicit until the user chooses Standard assistant', async () => {
    const retry = vi.fn()
    function Fixture() {
      const [id, setId] = useState<string | undefined>(profile.id)
      return <BotPicker profiles={[]} status="error" selectedId={id} onChange={setId} onRetry={retry} />
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Fixture />))
    expect(document.body.textContent).toContain('Could not load bots')
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Choose bot"]')!
    expect(select.value).toBe(profile.id)
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(select.value).toBe('')
  })
  it('labels an existing chat with its saved name and revision independently of the current catalog', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<BotSnapshotBadge bot={{ id: profile.id, revision: 2, name: 'Original research role', icon: 'search', instructions: 'Old instructions.', memory: 'off' }} />))
    expect(document.body.textContent).toContain('Original research role')
    expect(document.body.textContent).toContain('v2')
  })
})

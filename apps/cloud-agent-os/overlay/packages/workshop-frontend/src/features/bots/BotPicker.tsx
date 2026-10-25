import { Button } from '@cloudflare/kumo'
import type { BotProfile, BotSelection } from '@gadgets/workshop-shared/api'
import type { BotCatalogStatus } from './botProfiles'
import { BotIcon } from './BotIcon'

export function botIdFromSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid bot selection. Choose a bot from your library.')
  return value
}

/** A manually selected Standard assistant stays Standard even if a main bot exists. */
export function preferredBotId(explicit: string | undefined, mainBotId: string | null | undefined, overridden: boolean): string | undefined {
  return explicit ?? (overridden ? undefined : mainBotId ?? undefined)
}

export function botSelectionFromProfiles(id: string | undefined, profiles: BotProfile[], status: BotCatalogStatus): BotSelection | undefined {
  if (!id) return undefined
  if (status !== 'ready') throw new Error('Load your selected bot before starting a chat. Retry or explicitly choose Standard assistant.')
  const profile = profiles.find(item => item.id === id && !item.archived)
  if (!profile) throw new Error('This bot is unavailable or archived. Choose another bot before starting a chat.')
  return { id: profile.id, revision: profile.revision }
}

export function BotPicker({ profiles, status, selectedId, mainBotId, onChange, onRetry, compact = false }: {
  profiles: BotProfile[]; status: BotCatalogStatus; selectedId?: string; mainBotId?: string | null
  onChange: (id: string | undefined) => void; onRetry: () => void; compact?: boolean
}) {
  const active = profiles.filter(profile => !profile.archived)
  const selected = active.find(profile => profile.id === selectedId)
  return <section aria-label="Bot selection" className={`rounded-xl border border-kumo-line bg-kumo-base ${compact ? 'm-3 p-3' : 'p-4'}`}>
    <div className="flex flex-wrap items-center gap-3">
      <BotIcon icon={selected?.icon ?? 'spark'} small={compact} />
      <div className="min-w-0 flex-1"><label htmlFor={compact ? 'workspace-bot-picker' : 'home-bot-picker'} className="mb-1 block text-xs font-medium text-kumo-subtle">Chat with</label>
        <select id={compact ? 'workspace-bot-picker' : 'home-bot-picker'} aria-label="Choose bot" value={selectedId ?? ''} onChange={event => onChange(event.target.value || undefined)}
          className="w-full min-w-0 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-brand/20">
          <option value="">Standard assistant</option>
          {selectedId && !selected && <option value={selectedId}>{status === 'loading' ? 'Selected bot · loading…' : 'Selected bot · unavailable'}</option>}
          {active.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{mainBotId === profile.id ? ' · Main' : ''}</option>)}
        </select></div>
      <a href="/bots" className="text-xs font-medium text-kumo-subtle underline underline-offset-4 hover:text-kumo-default">Manage bots</a>
    </div>
    {status === 'loading' && <p role="status" className="mt-2 text-xs text-kumo-subtle">Loading bots…</p>}
    {status === 'error' && <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-kumo-danger"><span>Could not load bots.{selectedId ? ' Your selected bot is still selected; retry before sending.' : ''}</span><Button type="button" size="sm" onClick={onRetry}>Retry bots</Button></div>}
    {status === 'ready' && selectedId && !selected && <p role="alert" className="mt-3 text-xs text-kumo-danger">This bot is unavailable or archived. Select another bot to start a chat.</p>}
    {selected && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-kumo-subtle">{selected.description || selected.name}<span className="mt-1 block text-xs">Personal · v{selected.revision} · {selected.memory === 'connected' ? 'Connected memory preferred' : 'Automatic recall off'}</span></p>}
  </section>
}

export function BotSnapshotBadge({ bot }: { bot: Pick<BotProfile, 'id' | 'revision' | 'name' | 'icon' | 'instructions' | 'memory'> }) {
  return <details className="mx-3 mb-2 rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-kumo-default"><BotIcon icon={bot.icon} small /><span className="min-w-0 break-words font-medium">{bot.name}</span><span className="ml-auto shrink-0 text-xs text-kumo-subtle">v{bot.revision}</span></summary>
    <p className="mt-2 text-xs text-kumo-subtle">Saved for this chat. Profile edits apply to new chats.</p>
    <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words leading-6">{bot.instructions}</p>
    <p className="mt-3 text-xs text-kumo-subtle">{bot.memory === 'connected'
      ? 'Prefers memory tools you have connected and authorized.'
      : 'Automatic recall is off. Connected memory may be used when explicitly requested.'}</p>
  </details>
}

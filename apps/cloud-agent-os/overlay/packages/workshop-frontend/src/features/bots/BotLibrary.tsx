import { useMemo, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowRight, Archive, ArrowCounterClockwise, Copy, MagnifyingGlass, PencilSimple, Plus, Sparkle } from '@phosphor-icons/react'
import type { BotProfile, BotProfileInput } from '@gadgets/workshop-shared/api'
import { BotEditor } from './BotEditor'
import { BotIcon } from './BotIcon'
import { botProfileInput, useBotProfiles, type BotProfilesApi } from './botProfiles'

type Editor = { initial: BotProfileInput; expectedRevision: number; duplicate?: boolean }

export function BotLibrary({ api, onUseBot }: { api: BotProfilesApi; onUseBot: (id: string) => void }) {
  const catalog = useBotProfiles(api)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actionLock = useRef(false)
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return catalog.profiles.filter(profile => profile.archived === archived && (!search || `${profile.name}\n${profile.description}`.toLocaleLowerCase().includes(search)))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [catalog.profiles, query, archived])
  const disabled = busy || editor !== null || catalog.status !== 'ready'
  const create = () => {
    setNotice(null); setError(null)
    setEditor({ expectedRevision: 0, initial: { id: crypto.randomUUID(), name: '', description: '', instructions: '', icon: 'spark', starterPrompts: [], memory: 'off', archived: false } })
  }
  const changeArchive = async (profile: BotProfile) => {
    if (actionLock.current) return
    actionLock.current = true; setBusy(true); setError(null); setNotice(null)
    try {
      const saved = await api.saveBotProfile({ ...botProfileInput(profile), archived: !profile.archived }, profile.revision)
      catalog.upsert(saved)
      setNotice(saved.archived ? `${saved.name} archived. Existing chats keep their saved profile.` : `${saved.name} restored and ready for new chats.`)
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'The change could not be confirmed.'} Reload your bots before retrying.`)
    } finally { actionLock.current = false; setBusy(false) }
  }
  return <div className="mx-auto w-full max-w-7xl px-4 py-8 text-kumo-default sm:px-8 sm:py-12">
    <header className="mb-8 flex flex-wrap items-start justify-between gap-5"><div className="max-w-xl">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-kumo-subtle">Your personal workspace</p>
      <h1 className="text-3xl font-semibold tracking-tight">Bots</h1><p className="mt-3 text-sm leading-6 text-kumo-subtle">Give recurring work a familiar partner. Save a role, a working style, and a few ways to start.</p>
    </div><Button variant="primary" disabled={disabled} onClick={create}><Plus size={16} />New bot</Button></header>
    {notice && <p role="status" className="mb-5 rounded-xl border border-kumo-line bg-kumo-base p-4 text-sm">{notice}</p>}
    {error && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-kumo-danger/25 p-4 text-sm"><p className="flex-1">{error}</p><Button disabled={busy || !!editor} onClick={() => { setError(null); void catalog.refresh() }}>Reload bots</Button></div>}
    <div className={editor ? 'grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_minmax(380px,480px)]' : ''}>
      <section aria-label="Bot library" className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="inline-flex rounded-lg border border-kumo-line bg-kumo-base p-1">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)} className={`rounded-md px-3 py-1.5 text-sm ${!archived ? 'bg-kumo-fill font-medium' : 'text-kumo-subtle hover:text-kumo-default'}`}>Active</button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)} className={`rounded-md px-3 py-1.5 text-sm ${archived ? 'bg-kumo-fill font-medium' : 'text-kumo-subtle hover:text-kumo-default'}`}>Archived</button></div>
          <label className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 sm:max-w-xs"><MagnifyingGlass size={16} className="shrink-0 text-kumo-subtle" />
            <input type="search" name="search" aria-label="Search bots" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your bots" className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-kumo-subtle" /></label></div>
        {catalog.status === 'loading' && <div role="status" className="rounded-xl border border-kumo-line bg-kumo-base p-8 text-sm text-kumo-subtle">Loading your bots…</div>}
        {catalog.status === 'error' && <div role="alert" className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-6"><h2 className="font-medium">Could not load your bots</h2><p className="text-sm text-kumo-subtle">Your saved profiles have not been changed. Reconnect and try again.</p><Button onClick={() => void catalog.refresh()} aria-label="Retry loading bots">Retry</Button></div>}
        {catalog.status === 'ready' && visible.length === 0 && <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-kumo-line bg-kumo-base/60 px-6 py-10 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-kumo-fill"><Sparkle size={25} className="text-kumo-subtle" /></span>
          <h2 className="text-lg font-semibold">{query.trim() ? 'No matching bots' : archived ? 'No archived bots' : 'Create your first bot'}</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-kumo-subtle">{query.trim() ? 'Try another name or description.' : archived ? 'Archived profiles stay available here and can be restored.' : 'A research partner, a careful editor, or a coding companion. Give it one clear job.'}</p>
        </div>}
        {catalog.status === 'ready' && visible.length > 0 && <div className={`grid gap-4 ${editor ? 'md:grid-cols-2 xl:grid-cols-1' : 'md:grid-cols-2 2xl:grid-cols-3'}`}>
          {visible.map(profile => <article key={profile.id} aria-label={profile.name} className="flex min-w-0 flex-col rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm transition-shadow hover:shadow-md">
            <div className="flex items-start gap-3"><BotIcon icon={profile.icon} /><div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold leading-6">{profile.name}</h2><p className="mt-0.5 text-xs text-kumo-subtle">Personal · v{profile.revision}{profile.archived ? ' · Archived' : ''}</p></div></div>
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-kumo-subtle">{profile.description || 'A saved role for your next conversation.'}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-kumo-subtle"><span className="rounded-md bg-kumo-fill px-2 py-1">{profile.memory === 'connected' ? 'Connected memory' : 'Automatic recall off'}</span><span className="rounded-md bg-kumo-fill px-2 py-1">{profile.starterPrompts.length} starter {profile.starterPrompts.length === 1 ? 'prompt' : 'prompts'}</span></div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
              {profile.archived ? <Button disabled={disabled} aria-label={`Restore ${profile.name}`} onClick={() => void changeArchive(profile)}><ArrowCounterClockwise size={14} />Restore</Button>
                : <Button variant="primary" disabled={disabled} aria-label={`Use ${profile.name}`} onClick={() => onUseBot(profile.id)}>Use bot<ArrowRight size={14} /></Button>}
              <Button disabled={disabled} aria-label={`Edit ${profile.name}`} onClick={() => setEditor({ initial: botProfileInput(profile), expectedRevision: profile.revision })}><PencilSimple size={14} />Edit</Button>
              <Button disabled={disabled} aria-label={`Duplicate ${profile.name}`} onClick={() => setEditor({ initial: { ...botProfileInput(profile), id: crypto.randomUUID(), name: `${profile.name} copy`, archived: false }, expectedRevision: 0, duplicate: true })}><Copy size={14} />Duplicate</Button>
              {!profile.archived && <Button disabled={disabled} aria-label={`Archive ${profile.name}`} onClick={() => void changeArchive(profile)}><Archive size={14} />Archive</Button>}
            </div>
          </article>)}
        </div>}
        <p className="text-xs leading-5 text-kumo-subtle">Profiles are personal. Each new chat keeps the selected version; editing or archiving a bot leaves existing chats intact.</p>
      </section>
      {editor && <BotEditor key={editor.initial.id} {...editor} api={api} onCancel={() => setEditor(null)} onSaved={profile => { catalog.upsert(profile); setEditor(null); setArchived(profile.archived); setQuery(''); setNotice(`${profile.name} saved. Ready for a new chat.`) }} />}
    </div>
  </div>
}

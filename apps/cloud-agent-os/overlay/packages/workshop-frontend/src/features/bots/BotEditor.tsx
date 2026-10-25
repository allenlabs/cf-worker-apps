import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo'
import { Plus, X } from '@phosphor-icons/react'
import type { BotProfile, BotProfileInput } from '@gadgets/workshop-shared/api'
import type { BotProfilesApi } from './botProfiles'
import { BOT_ICONS, BotIcon } from './BotIcon'

const CONTROL = 'w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none transition-shadow focus:border-kumo-brand focus:ring-2 focus:ring-kumo-brand/15 disabled:opacity-60'
const LABEL = 'block text-sm font-medium text-kumo-default'
const limits = { name: 80, description: 320, instructions: 16000, starter: 2000 }

function validate(input: BotProfileInput): string[] {
  const errors: string[] = []
  if (!input.name.trim()) errors.push('Give your bot a name.')
  if (!input.instructions.trim()) errors.push('Describe the job and instructions for this bot.')
  for (const key of ['name', 'description', 'instructions'] as const) {
    if (input[key].length > limits[key]) errors.push(`${key === 'name' ? 'Name' : key === 'description' ? 'Description' : 'Instructions'} must be ${limits[key].toLocaleString('en-US')} characters or fewer. Your full text is still here.`)
  }
  if (input.starterPrompts.length > 6) errors.push('Use up to six starter prompts.')
  input.starterPrompts.forEach((prompt, index) => {
    if (!prompt.trim()) errors.push(`Write starter prompt ${index + 1}, or remove it.`)
    if (prompt.length > limits.starter) errors.push(`Starter prompt ${index + 1} must be 2,000 characters or fewer. Your full text is still here.`)
  })
  return errors
}

function Count({ value, limit }: { value: string; limit: number }) {
  return <span className={`text-xs tabular-nums ${value.length > limit ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
    {value.length.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}
  </span>
}

export function BotEditor({ initial, expectedRevision, api, onSaved, onCancel, duplicate = false }: {
  initial: BotProfileInput; expectedRevision: number; api: BotProfilesApi
  onSaved: (profile: BotProfile) => void; onCancel: () => void; duplicate?: boolean
}) {
  const [draft, setDraft] = useState(() => ({ ...initial, starterPrompts: [...initial.starterPrompts] }))
  const [revision, setRevision] = useState(expectedRevision)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<BotProfile | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const edit = <K extends keyof BotProfileInput>(key: K, value: BotProfileInput[K]) => setDraft(current => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    const nextErrors = validate(draft)
    setErrors(nextErrors); setNotice(null)
    if (nextErrors.length) return
    lock.current = true; setBusy(true)
    try {
      const saved = await api.saveBotProfile(draft, revision)
      if (alive.current) onSaved(saved)
    } catch (error) {
      if (!alive.current) return
      const message = error instanceof Error ? error.message : 'The change could not be confirmed.'
      setErrors([`${message} Your draft is unchanged.`])
      setConflict(/revision|conflict|changed|exists/i.test(message))
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const review = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      const profiles = await api.listBotProfiles()
      if (!alive.current) return
      const current = profiles.find(item => item.id === draft.id)
      if (current) setLatest(current)
      else setErrors(['This bot is no longer available. Your draft is unchanged; copy it before leaving this editor.'])
    } catch { if (alive.current) setErrors(['Could not load the latest version. Your draft is unchanged. Try again when connected.']) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="min-w-0 rounded-2xl border border-kumo-line bg-kumo-base shadow-sm" aria-label="Bot editor">
    <div className="flex items-start gap-3 border-b border-kumo-line p-5">
      <BotIcon icon={draft.icon} />
      <div className="min-w-0"><h2 className="text-lg font-semibold text-kumo-default">{duplicate ? 'Duplicate bot' : expectedRevision ? 'Edit bot' : 'Create a bot'}</h2>
        <p className="mt-1 text-sm text-kumo-subtle">A clear role, ready for your next conversation.</p></div>
    </div>
    <form aria-label="Bot profile" onSubmit={submit} noValidate className="space-y-5 p-5">
      {errors.length > 0 && <div role="alert" className="space-y-1 rounded-lg border border-kumo-danger/25 bg-kumo-danger/5 p-3 text-sm text-kumo-danger">
        {errors.map(error => <p key={error}>{error}</p>)}</div>}
      {notice && <p role="status" className="rounded-lg bg-kumo-fill p-3 text-sm text-kumo-subtle">{notice}</p>}
      {conflict && <Button type="button" disabled={busy} onClick={() => void review()}>Review latest version</Button>}
      {latest && <div aria-label="Latest saved profile" className="space-y-3 rounded-lg border border-kumo-line p-3 text-sm">
        <p className="font-medium">Saved version {latest.revision}: {latest.name}</p>
        <p className="whitespace-pre-wrap break-words">{latest.description}</p>
        <details open><summary className="cursor-pointer text-kumo-subtle">Saved instructions</summary><p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{latest.instructions}</p></details>
        <p className="text-xs text-kumo-subtle">{BOT_ICONS[latest.icon].label} icon · {latest.memory === 'connected' ? 'Connected memory' : 'Automatic recall off'} · {latest.archived ? 'Archived' : 'Active'}</p>
        {latest.starterPrompts.length > 0 && <details open><summary className="cursor-pointer text-kumo-subtle">Saved starter prompts</summary>
          <ul className="mt-2 list-disc space-y-2 pl-4">{latest.starterPrompts.map((prompt, index) => <li key={index} className="whitespace-pre-wrap break-words">{prompt}</li>)}</ul></details>}
        <p className="text-kumo-subtle">Continue only if you want your draft to replace this version. Existing chats keep their saved profile.</p>
        <Button type="button" disabled={busy} onClick={() => { setRevision(latest.revision); setLatest(null); setConflict(false); setErrors([]); setNotice('Latest revision selected. Review your draft, then save when ready.') }}>Keep my draft with this revision</Button>
      </div>}
      <fieldset disabled={busy} className="space-y-5">
        <div><div className="mb-1.5 flex items-center justify-between gap-3"><label className={LABEL} htmlFor="bot-name">Name</label><Count value={draft.name} limit={limits.name} /></div>
          <input id="bot-name" name="name" value={draft.name} onChange={event => edit('name', event.target.value)} placeholder="Research partner" autoComplete="off" className={CONTROL} autoFocus /></div>
        <div><label className={`${LABEL} mb-2`}>Icon</label><div className="flex flex-wrap gap-2">
          {(Object.keys(BOT_ICONS) as BotProfile['icon'][]).map(icon => <button type="button" key={icon} aria-label={`${BOT_ICONS[icon].label} icon`} aria-pressed={draft.icon === icon}
            onClick={() => edit('icon', icon)} className={`rounded-xl p-1 outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand ${draft.icon === icon ? 'ring-2 ring-kumo-brand' : 'ring-1 ring-kumo-line hover:bg-kumo-tint'}`}><BotIcon icon={icon} /></button>)}</div></div>
        <div><div className="mb-1.5 flex items-center justify-between gap-3"><label className={LABEL} htmlFor="bot-description">Description</label><Count value={draft.description} limit={limits.description} /></div>
          <textarea id="bot-description" name="description" value={draft.description} onChange={event => edit('description', event.target.value)} placeholder="A short description for your bot library." rows={2} className={`${CONTROL} resize-y`} /></div>
        <div><div className="mb-1.5 flex items-center justify-between gap-3"><label className={LABEL} htmlFor="bot-instructions">Job and instructions</label><Count value={draft.instructions} limit={limits.instructions} /></div>
          <textarea id="bot-instructions" name="instructions" value={draft.instructions} onChange={event => edit('instructions', event.target.value)} placeholder="Describe the job, working style, expected output, and boundaries." rows={8} className={`${CONTROL} resize-y leading-6`} />
          <p className="mt-1.5 text-xs leading-5 text-kumo-subtle">Saved in full. Instructions guide the bot; existing access controls and approvals still apply.</p>
          <p className="mt-1.5 text-xs leading-5 text-kumo-subtle">Instructions saved with a chat are visible to that workspace’s collaborators.</p></div>
        <section aria-label="Starter prompts" className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className={LABEL}>Starter prompts</h3><span className="text-xs text-kumo-subtle">{draft.starterPrompts.length} / 6</span></div>
          <p className="text-xs text-kumo-subtle">Optional starting points for a new chat.</p>
          {draft.starterPrompts.map((prompt, index) => <div key={index} className="space-y-1.5"><div className="flex items-center justify-between gap-2">
            <label htmlFor={`bot-starter-${index}`} className="text-xs text-kumo-subtle">Prompt {index + 1}</label><Count value={prompt} limit={limits.starter} /></div>
            <div className="flex items-start gap-2"><textarea id={`bot-starter-${index}`} name={`starter-${index}`} value={prompt} rows={2} className={`${CONTROL} resize-y`}
              onChange={event => edit('starterPrompts', draft.starterPrompts.map((item, at) => at === index ? event.target.value : item))} />
              <Button type="button" aria-label={`Remove starter prompt ${index + 1}`} onClick={() => edit('starterPrompts', draft.starterPrompts.filter((_, at) => at !== index))}><X size={14} /></Button></div></div>)}
          <Button type="button" disabled={draft.starterPrompts.length >= 6} onClick={() => edit('starterPrompts', [...draft.starterPrompts, ''])}><Plus size={14} />Add starter prompt</Button>
        </section>
        <fieldset className="space-y-3 rounded-xl border border-kumo-line p-3"><legend className="px-1 text-sm font-medium">Memory</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="radio" name="memory" value="off" checked={draft.memory === 'off'} onChange={() => edit('memory', 'off')} className="mt-1 accent-[var(--color-kumo-brand)]" />
            <span><span className="font-medium">Automatic recall off</span><span className="mt-0.5 block text-xs leading-5 text-kumo-subtle">Do not use connected memory automatically. The bot can use it when you explicitly ask; this setting does not disconnect tools.</span></span></label>
          <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="radio" aria-label="Use connected memory" name="memory" value="connected" checked={draft.memory === 'connected'} onChange={() => edit('memory', 'connected')} className="mt-1 accent-[var(--color-kumo-brand)]" />
            <span><span className="font-medium">Use connected memory</span><span className="mt-0.5 block text-xs leading-5 text-kumo-subtle">Ask the bot to use the memory tools you have connected and authorized. This is not a separate memory store and does not automatically ingest conversations.</span></span></label>
          <p className="text-xs leading-5 text-kumo-subtle">Manage models in <a href="/providers" className="underline underline-offset-2">Providers</a> and authorized tools in <a href="/gatekeepers" className="underline underline-offset-2">Connections</a>.</p>
        </fieldset>
      </fieldset>
      <div className="space-y-3 border-t border-kumo-line pt-4"><p className="text-xs leading-5 text-kumo-subtle">Changes apply to new chats. Existing chats keep the profile version they started with.</p>
        <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save bot'}</Button><Button type="button" disabled={busy} onClick={onCancel}>Cancel</Button></div></div>
    </form>
  </section>
}

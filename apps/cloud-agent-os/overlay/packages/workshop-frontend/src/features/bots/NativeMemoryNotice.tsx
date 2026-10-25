export const NATIVE_MEMORY_ENABLED = import.meta.env.VITE_NATIVE_AGENT_MEMORY === 'true'

export function NativeMemoryNotice({ enabled = NATIVE_MEMORY_ENABLED }: { enabled?: boolean }) {
  if (!enabled) return null
  return <div role="note" className="space-y-2 rounded-lg bg-kumo-fill p-3 text-xs leading-5 text-kumo-subtle">
    <p className="font-medium text-kumo-default">Automatic Cloudflare Agent Memory</p>
    <p>This private deployment automatically sends complete saved text conversations to a separate profile for each bot. Profiles are created on first use. Names can change without losing memory.</p>
    <p>The controls below affect recall only, not transcript capture. Original conversations stay in this workspace. Binary attachments remain here; their metadata and text attachments can be ingested.</p>
    <p>Ask for memory sync status to inspect pending records or retries. An accepted upload may still be indexing.</p>
  </div>
}

import type { MemoryPage, MemorySnapshot, MemorySourceRef, NativeMemorySource } from './native-memory';

type CanonicalRecord = { sequence: number; type: string; timestamp: Date; author: { type: string };
  toolCalls?: Array<{ archivedOutput?: { id: string }; sourceArtifactId?: string }>;
  attachments?: Array<{ id: string; mimeType: string }> };
export interface MemorySourceHost {
  assertAccess(chatId: number, principal: string): void;
  record(chatId: number, sequence: number): CanonicalRecord | undefined;
  history(chatId: number, sequence: number, principal: string): Promise<{ sequence: number | null;
    page: { artifactId: string; cursor: string } | null }>;
  readText(chatId: number, artifactId: string, cursor: string | undefined, principal: string): Promise<MemoryPage>;
  archive(chatId: number, text: string): Promise<{ id: string; startCursor: string }>;
  attachment(chatId: number, id: string): Promise<Uint8Array>;
  isTextAttachment(mimeType: string): boolean;
}

/** Reuse original-history and archive authorization, not the model's compacted projection. */
export function createMemorySource(host: MemorySourceHost): NativeMemorySource {
  return {
    async load(chatId, sequence, principal) {
      host.assertAccess(chatId,principal);
      const record = host.record(chatId,sequence);
      if (!record) return null;
      const original = await host.history(chatId,sequence,principal);
      if (original.sequence !== sequence || !original.page) throw new Error('Canonical memory history changed');
      const sources: MemorySourceRef[] = [{ id: original.page.artifactId, startCursor: original.page.cursor, label: 'chat-record' }];
      const seen = new Set(sources.map(source=>source.id));
      // Raw records contain artifact references. Also ingest their acquired text, never just previews.
      for (const tool of record.toolCalls ?? []) {
        for (const id of [tool.archivedOutput?.id, tool.sourceArtifactId]) {
          if (id && !seen.has(id)) { seen.add(id); sources.push({id,label:'tool-result'}); }
        }
      }
      for (const attachment of record.attachments ?? []) {
        if (!host.isTextAttachment(attachment.mimeType)) continue;
        const bytes = await host.attachment(chatId,attachment.id);
        const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        const ref = await host.archive(chatId,text);
        if (!seen.has(ref.id)) { seen.add(ref.id); sources.push({...ref,label:`text-attachment:${attachment.id}`}); }
      }
      host.assertAccess(chatId,principal);
      return { sequence, role: record.author.type==='agent' ? 'assistant' : 'user',
        timestamp: record.timestamp.toISOString(), sources } satisfies MemorySnapshot;
    },
    async page(chatId,source,cursor,principal) {
      host.assertAccess(chatId,principal);
      return host.readText(chatId,source.id,cursor,principal);
    },
    async authorize(chatId,snapshot,principal) {
      host.assertAccess(chatId,principal);
      for (const source of snapshot.sources) await host.readText(chatId,source.id,source.startCursor,principal);
      host.assertAccess(chatId,principal);
    },
  };
}

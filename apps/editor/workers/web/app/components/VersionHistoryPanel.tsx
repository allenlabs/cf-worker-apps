// Right-hand page version-history panel (Phase 5). Lists captured snapshots
// newest-first (time + author), previews a selected version's HTML, and can
// restore it. Restore writes snapshot_html back (after snapshotting the
// current state) then full-page reloads so every view re-reads the page.
//
// NOTE: restore sets the DB snapshot_html only. The live Yjs collab doc is a
// separate store and is NOT rewound in v1 — a reload re-seeds the editor from
// the restored snapshot.

import { useEffect, useState } from 'react';
import {
  versionGet as versionGetFn,
  versionRestore as versionRestoreFn,
  versionsList as versionsListFn,
  type VersionMeta,
} from '~/server/docs';

interface VersionHistoryPanelProps {
  pageId: string;
  onClose: () => void;
}

export function VersionHistoryPanel({ pageId, onClose }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void versionsListFn({ data: { pageId } })
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  async function handleSelect(id: string) {
    setSelectedId(id);
    setPreviewHtml('');
    try {
      const { snapshotHtml } = await versionGetFn({ data: { id } });
      setPreviewHtml(snapshotHtml);
    } catch {
      /* ignore */
    }
  }

  async function handleRestore() {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await versionRestoreFn({ data: { id: selectedId } });
      // Full-page reload so the editor + every view re-reads the restored page.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <aside className="w-96 shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <span className="text-sm font-semibold text-gray-900">Version history</span>
        <button
          className="text-gray-400 hover:text-gray-700 text-sm"
          onClick={onClose}
          aria-label="Close history"
        >
          ✕
        </button>
      </div>

      <div className="border-b border-gray-200 max-h-56 overflow-y-auto">
        {loading ? (
          <p className="text-xs text-gray-400 px-4 py-3">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-xs text-gray-400 px-4 py-3">No saved versions yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  className={`w-full text-left px-4 py-2 hover:bg-gray-50 ${
                    selectedId === v.id ? 'bg-gray-100' : ''
                  }`}
                  onClick={() => void handleSelect(v.id)}
                >
                  <div className="text-xs text-gray-800">
                    {new Date(v.createdAt).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-gray-500">{v.authorName || 'Unknown'}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {selectedId ? (
          <>
            <button
              className="mb-3 w-full btn-primary text-sm disabled:opacity-50"
              onClick={() => void handleRestore()}
              disabled={busy}
            >
              {busy ? 'Restoring…' : 'Restore this version'}
            </button>
            <div
              className="prose prose-sm max-w-none text-gray-700"
              // Preview only — sanitised content comes from our own editor.
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </>
        ) : (
          <p className="text-xs text-gray-400">Select a version to preview it.</p>
        )}
      </div>
    </aside>
  );
}

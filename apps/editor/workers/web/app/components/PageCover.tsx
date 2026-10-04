// Page cover banner (Phase 11). When no cover is set, shows an "Add cover"
// affordance on hover; when set, renders the image as a fixed-height banner with
// Change / Remove controls. Uploading reuses the existing uploadFile → R2 flow
// (passed in by the route to avoid duplicating the base64 plumbing).

import { useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';

interface PageCoverProps {
  cover: string | null;
  /** Read-only viewers can't add/change/remove. */
  editable: boolean;
  /** Upload a chosen file → public URL (route wires the base64→R2 flow). */
  uploadFile: (file: File) => Promise<string>;
  /** Persist the new cover (URL or null to clear). */
  onChange: (cover: string | null) => void;
}

export function PageCover({ cover, editable, uploadFile, onChange }: PageCoverProps) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  function pickFile() {
    inputRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadFile(file);
      onChange(url);
    } catch {
      /* upload failed — leave the cover untouched */
    } finally {
      setBusy(false);
    }
  }

  // Hidden file input shared by Add + Change.
  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => void handleFile(e)}
      aria-label={t('cover.add')}
    />
  );

  if (!cover) {
    if (!editable) return null;
    return (
      <div className="group/cover relative h-8 mb-1">
        {hiddenInput}
        <button
          className="opacity-0 group-hover/cover:opacity-100 transition text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 px-2 py-1"
          onClick={pickFile}
          disabled={busy}
          data-testid="cover-add"
        >
          {busy ? t('cover.uploading') : `🖼 ${t('cover.add')}`}
        </button>
      </div>
    );
  }

  return (
    <div className="group/cover relative -mx-8 mb-4" data-testid="cover-banner">
      {hiddenInput}
      <img
        src={cover}
        alt=""
        className="w-full h-44 object-cover"
        draggable={false}
      />
      {editable ? (
        <div className="absolute right-3 bottom-3 opacity-0 group-hover/cover:opacity-100 transition flex gap-1">
          <button
            className="text-xs px-2 py-1 bg-white/90 border border-gray-200 dark:border-gray-700 rounded hover:bg-white shadow-sm"
            onClick={pickFile}
            disabled={busy}
            data-testid="cover-change"
          >
            {busy ? t('cover.uploading') : t('cover.change')}
          </button>
          <button
            className="text-xs px-2 py-1 bg-white/90 border border-gray-200 dark:border-gray-700 rounded hover:bg-white shadow-sm"
            onClick={() => onChange(null)}
            data-testid="cover-remove"
          >
            {t('cover.remove')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

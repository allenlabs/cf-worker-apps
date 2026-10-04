import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: {
      /** Insert a video player for a media URL. */
      setVideo: (attrs: { src: string }) => ReturnType;
    };
    audio: {
      /** Insert an audio player for a media URL. */
      setAudio: (attrs: { src: string }) => ReturnType;
    };
    file: {
      /** Insert a download card for a file URL. */
      setFile: (attrs: { src: string; name?: string; size?: number }) => ReturnType;
    };
  }
}

/** Human-readable file size. Pure → unit-tested. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || v % 1 === 0 ? 0 : 1)} ${units[i]}`;
}

/** Best-effort filename from a URL (last path segment), falling back to "File". */
export function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const seg = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return seg || 'File';
  } catch {
    const seg = url.split('/').filter(Boolean).pop() ?? '';
    return seg || 'File';
  }
}

/**
 * Video — an atom block rendering an HTML5 `<video controls>` for `{ src }`.
 * Serialises to `<div data-type="video" data-src="…">`.
 */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-src') ?? el.querySelector('video')?.getAttribute('src') ?? '',
        renderHTML: (attrs) => ({ 'data-src': attrs.src as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="video"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const src = (HTMLAttributes['data-src'] as string) || '';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'video',
        'data-testid': 'video',
        class: 'ae-video',
      }),
      ['video', { controls: 'true', class: 'ae-video-el', src, preload: 'metadata' }],
    ];
  },

  addCommands() {
    return {
      setVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

/**
 * Audio — an atom block rendering an HTML5 `<audio controls>` for `{ src }`.
 * Serialises to `<div data-type="audio" data-src="…">`.
 */
export const Audio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-src') ?? el.querySelector('audio')?.getAttribute('src') ?? '',
        renderHTML: (attrs) => ({ 'data-src': attrs.src as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="audio"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const src = (HTMLAttributes['data-src'] as string) || '';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'audio',
        'data-testid': 'audio',
        class: 'ae-audio',
      }),
      ['audio', { controls: 'true', class: 'ae-audio-el', src, preload: 'metadata' }],
    ];
  },

  addCommands() {
    return {
      setAudio:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

/**
 * File — an atom block rendering a download card (icon + filename + size +
 * download link) for `{ src, name, size? }`. Serialises to
 * `<a data-type="file" data-src="…">`.
 */
export const FileBlock = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-src') ?? el.getAttribute('href') ?? '',
        renderHTML: (attrs) => ({ 'data-src': attrs.src as string }),
      },
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-name') ?? '',
        renderHTML: (attrs) => ({ 'data-name': attrs.name as string }),
      },
      size: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-size');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs) =>
          attrs.size != null ? { 'data-size': String(attrs.size as number) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-type="file"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const src = (HTMLAttributes['data-src'] as string) || '';
    const name = (HTMLAttributes['data-name'] as string) || fileNameFromUrl(src);
    const size = formatFileSize(
      HTMLAttributes['data-size'] != null ? Number(HTMLAttributes['data-size']) : null,
    );
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'file',
        'data-testid': 'file',
        class: 'ae-file',
        href: src,
        download: '',
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
      ['span', { class: 'ae-file-icon', contenteditable: 'false' }, '📎'],
      ['span', { class: 'ae-file-name' }, name],
      ...(size ? [['span', { class: 'ae-file-size', contenteditable: 'false' }, size] as const] : []),
    ];
  },

  addCommands() {
    return {
      setFile:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: attrs.src,
              name: attrs.name ?? fileNameFromUrl(attrs.src),
              size: attrs.size ?? null,
            },
          }),
    };
  },
});

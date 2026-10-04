import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { normalizeEmbed, isAutoEmbedUrl } from '../lib/embed';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: {
      /** Insert an embed iframe for a URL (normalized to a provider source). */
      setEmbed: (attrs: { url: string }) => ReturnType;
    };
  }
}

/** Build the iframe attrs for an embed URL. Sandbox generic embeds tightly. */
function iframeAttrsFor(url: string): {
  src: string;
  provider: string;
} {
  const norm = normalizeEmbed(url);
  if (!norm) return { src: url, provider: 'generic' };
  return { src: norm.embedUrl, provider: norm.provider };
}

/**
 * Embed — an atom block that renders a responsive 16:9 iframe for a URL.
 * YouTube/Vimeo/Figma/Google-Maps URLs are normalized to their embed form
 * (see {@link normalizeEmbed}); anything else is embedded as a sandboxed
 * iframe of the raw URL. Stores `{ url, provider }`; serialises to
 * `<div data-type="embed" data-url="…">` for HTML round-trip. A paste handler
 * turns a bare YouTube/Vimeo/Figma URL pasted on its own into an embed.
 */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-url') ?? '',
        renderHTML: (attrs) => ({ 'data-url': attrs.url as string }),
      },
      provider: {
        default: 'generic',
        parseHTML: (el) => el.getAttribute('data-provider') ?? 'generic',
        renderHTML: (attrs) => ({ 'data-provider': attrs.provider as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embed"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const url = (HTMLAttributes['data-url'] as string) || '';
    const { src, provider } = iframeAttrsFor(url);
    // Generic embeds get a tight sandbox; trusted media providers need scripts
    // + same-origin for their players, so sandbox is omitted for those.
    const iframe: Record<string, string> = {
      class: 'ae-embed-iframe',
      src,
      loading: 'lazy',
      allowfullscreen: 'true',
      referrerpolicy: 'no-referrer',
    };
    if (provider === 'generic') {
      iframe.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';
    }
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'embed',
        'data-testid': 'embed',
        'data-provider': provider,
        class: 'ae-embed',
      }),
      ['div', { class: 'ae-embed-frame', contenteditable: 'false' }, ['iframe', iframe]],
    ];
  },

  addCommands() {
    return {
      setEmbed:
        (attrs) =>
        ({ commands }) => {
          const { provider } = iframeAttrsFor(attrs.url);
          return commands.insertContent({
            type: this.name,
            attrs: { url: attrs.url, provider },
          });
        },
    };
  },

  // Paste a bare YouTube/Vimeo/Figma URL on its own → insert an embed instead of
  // a plain text link. Generic URLs fall through to the default paste (so
  // ordinary links still paste as links).
  addProseMirrorPlugins() {
    const type = this.editor.schema.nodes[this.name];
    return [
      new Plugin({
        key: new PluginKey('embedPasteHandler'),
        props: {
          handlePaste: (view, event) => {
            if (!type || !view.editable) return false;
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!isAutoEmbedUrl(text)) return false;
            const { provider } = iframeAttrsFor(text.trim());
            const node = type.create({ url: text.trim(), provider });
            const tr = view.state.tr.replaceSelectionWith(node);
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

import Mention from '@tiptap/extension-mention';
import { ReactRenderer } from '@tiptap/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from 'react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { MentionItem, MentionSource } from '../lib/types';

interface ListProps {
  items: MentionItem[];
  command: (item: { id: string; label: string }) => void;
}
interface Handle {
  onKeyDown: (x: { event: KeyboardEvent }) => boolean;
}

const MentionList = forwardRef(function MentionList(
  { items, command }: ListProps,
  ref: Ref<Handle>,
) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setSelected((i) => (i + items.length - 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelected((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'Enter') {
        const it = items[selected];
        if (it) command({ id: it.id, label: it.label });
        return true;
      }
      return false;
    },
  }));
  if (items.length === 0) {
    return <div className="ae-mention-menu ae-slash-empty">No people</div>;
  }
  return (
    <div className="ae-mention-menu" role="listbox">
      {items.map((it, idx) => (
        <button
          key={it.id}
          type="button"
          role="option"
          aria-selected={idx === selected}
          data-testid={`mention-item-${it.id}`}
          className={`ae-slash-item${idx === selected ? ' ae-slash-active' : ''}`}
          onMouseEnter={() => setSelected(idx)}
          onClick={() => command({ id: it.id, label: it.label })}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
});

/** A live, mutable holder for the current mention source (a React ref works). */
export interface MentionSourceRef {
  current: MentionSource | null | undefined;
}

/**
 * Build a configured @-Mention extension backed by a caller-supplied source.
 *
 * The source may be passed directly, or as a ref-like `{ current }` holder. The
 * holder form lets the host keep an inline (per-render) source function in a
 * ref so its identity never forces the editor to rebuild — the extension always
 * reads the latest source without being re-created. See {@link CollaborativeEditor}.
 */
export function makeMention(source: MentionSource | MentionSourceRef) {
  const resolve = (): MentionSource | null | undefined =>
    typeof source === 'function' ? source : source.current;
  return Mention.configure({
    HTMLAttributes: { class: 'ae-mention' },
    suggestion: {
      char: '@',
      items: async ({ query }) => {
        const src = resolve();
        if (!src) return [];
        const res = await src(query);
        return res.slice(0, 8);
      },
      render: () => {
        let component: ReactRenderer<Handle> | null = null;
        let popup: TippyInstance | null = null;
        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props: { items: props.items, command: props.command },
              editor: props.editor,
            });
            if (!props.clientRect) return;
            popup = tippy(document.body, {
              getReferenceClientRect: props.clientRect as () => DOMRect,
              appendTo: () => document.body,
              content: component.element,
              showOnCreate: true,
              interactive: true,
              trigger: 'manual',
              placement: 'bottom-start',
            });
          },
          onUpdate: (props) => {
            component?.updateProps({ items: props.items, command: props.command });
            if (props.clientRect && popup) {
              popup.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
            }
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              popup?.hide();
              return true;
            }
            return component?.ref?.onKeyDown(props) ?? false;
          },
          onExit: () => {
            popup?.destroy();
            component?.destroy();
          },
        };
      },
    },
  });
}

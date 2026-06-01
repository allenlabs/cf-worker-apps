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

/** Build a configured @-Mention extension backed by a caller-supplied source. */
export function makeMention(source: MentionSource) {
  return Mention.configure({
    HTMLAttributes: { class: 'ae-mention' },
    suggestion: {
      char: '@',
      items: async ({ query }) => {
        const res = await source(query);
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

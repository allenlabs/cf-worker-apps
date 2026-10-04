import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from 'react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import type { SlashItem } from '../lib/types';
import { DEFAULT_SLASH_ITEMS, filterSlashItems } from '../lib/slash-items';

interface ListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}
export interface SlashListHandle {
  onKeyDown: (x: { event: KeyboardEvent }) => boolean;
}

const SlashList = forwardRef(function SlashList(
  { items, command }: ListProps,
  ref: Ref<SlashListHandle>,
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
        if (it) command(it);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return <div className="ae-slash-menu ae-slash-empty">No results</div>;
  }
  return (
    <div className="ae-slash-menu" role="listbox">
      {items.map((it, idx) => (
        <button
          key={it.title}
          type="button"
          role="option"
          aria-selected={idx === selected}
          data-testid={`slash-item-${it.title.toLowerCase().replace(/\s+/g, '-')}`}
          className={`ae-slash-item${idx === selected ? ' ae-slash-active' : ''}`}
          onMouseEnter={() => setSelected(idx)}
          onClick={() => command(it)}
        >
          {it.icon ? <span className="ae-slash-icon" aria-hidden="true">{it.icon}</span> : null}
          <span className="ae-slash-text">
            <span className="ae-slash-title">{it.title}</span>
            {it.hint ? <span className="ae-slash-hint">{it.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
});

/**
 * "/" slash menu extension. Filters {@link DEFAULT_SLASH_ITEMS} (or a custom
 * list) as you type and runs the chosen block command. Rendered with tippy +
 * a React list so keyboard nav (↑/↓/Enter) works.
 */
export const SlashCommand = Extension.create<{ items: SlashItem[] }>({
  name: 'slashCommand',
  addOptions() {
    return { items: DEFAULT_SLASH_ITEMS };
  },
  addProseMirrorPlugins() {
    const all = this.options.items;
    const suggestion: Omit<SuggestionOptions, 'editor'> = {
      char: '/',
      startOfLine: false,
      items: ({ query }) => filterSlashItems(all, query),
      command: ({ editor, range, props }) => {
        (props as SlashItem).command({ editor, range });
      },
      render: () => {
        let component: ReactRenderer<SlashListHandle> | null = null;
        let popup: TippyInstance | null = null;
        return {
          onStart: (props) => {
            component = new ReactRenderer(SlashList, {
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
    };
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

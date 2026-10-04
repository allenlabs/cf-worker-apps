import { Node, mergeAttributes, ReactNodeViewRenderer } from '@tiptap/react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import {
  parseActions,
  describeAction,
  isClientAction,
  type ButtonAction,
  type BlockTemplate,
} from '../lib/actions';

/**
 * Wiring the host supplies so a Button BLOCK can execute its actions. Client
 * actions (insert_blocks, open_page, show_confirm) are handled inside the
 * NodeView; data actions (add_page_to_db, edit_pages) are delegated to the host
 * via `runDataAction` (which calls a server fn). All optional — a Button with no
 * wiring still renders + serialises, it just can't run data actions.
 */
export interface ButtonOptions {
  /** Navigate to a page (full-page nav in the host). */
  onOpenPage?: (pageId: string) => void;
  /** Execute a server-side data action (add_page_to_db / edit_pages). */
  runDataAction?: (action: ButtonAction) => Promise<void>;
  /** Whether the editor is editable (gates the ⚙ Configure affordance). */
  editable: boolean;
  /** Localized labels. Keyed e.g. 'button.configure', 'action.<kind>'. */
  t?: (key: string) => string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    button: {
      /** Insert a button block. */
      setButton: (attrs?: { label?: string; icon?: string; actions?: ButtonAction[] }) => ReturnType;
    };
  }
}

function parseActionsAttr(raw: string | null): ButtonAction[] {
  if (!raw) return [];
  try {
    return parseActions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Build the TipTap doc nodes for an `insert_blocks` action — a small templated
 * set (paragraph / heading / todo). Pure so it's unit-testable; the NodeView
 * inserts the result below the button.
 */
export function blockTemplateToNodes(blocks: BlockTemplate[]): Record<string, unknown>[] {
  return blocks.map((b) => {
    if (b.type === 'heading') {
      return {
        type: 'heading',
        attrs: { level: b.level ?? 2 },
        content: b.text ? [{ type: 'text', text: b.text }] : [],
      };
    }
    if (b.type === 'todo') {
      return {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: b.text ? [{ type: 'text', text: b.text }] : [] }],
          },
        ],
      };
    }
    return {
      type: 'paragraph',
      content: b.text ? [{ type: 'text', text: b.text }] : [],
    };
  });
}

/**
 * Run a button's actions in order. Client actions are handled here; data actions
 * delegate to `runDataAction`. A `show_confirm` that the user cancels aborts the
 * remaining actions (Notion semantic). Returns when the chain finishes/aborts.
 */
export async function runButtonActions(
  actions: ButtonAction[],
  ctx: {
    insertBelow: (nodes: Record<string, unknown>[]) => void;
    openPage?: (pageId: string) => void;
    confirm?: (message: string) => boolean;
    runDataAction?: (action: ButtonAction) => Promise<void>;
  },
): Promise<void> {
  for (const action of actions) {
    if (action.kind === 'show_confirm') {
      const ok = ctx.confirm ? ctx.confirm(action.message) : true;
      if (!ok) return;
      continue;
    }
    if (action.kind === 'insert_blocks') {
      ctx.insertBelow(blockTemplateToNodes(action.blocks ?? []));
      continue;
    }
    if (action.kind === 'open_page') {
      ctx.openPage?.(action.pageId);
      continue;
    }
    // Data action — delegate to the host (server fn).
    if (ctx.runDataAction) await ctx.runDataAction(action);
  }
}

function ButtonView(props: NodeViewProps) {
  const options = props.extension.options as ButtonOptions;
  const t = options.t;
  const label = (props.node.attrs.label as string) || (t ? t('button.defaultLabel') : 'Button');
  const icon = (props.node.attrs.icon as string) || '';
  const actions = parseActionsAttr(props.node.attrs.actions as string | null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const tr = (key: string, fallback: string) => {
    const v = t?.(key);
    return v && v !== key ? v : fallback;
  };

  async function handleClick() {
    if (options.editable || running) return; // edit mode → no run (avoid surprises)
    setRunning(true);
    try {
      await runButtonActions(actions, {
        insertBelow: (nodes) => {
          const pos = props.getPos();
          if (typeof pos !== 'number') return;
          const after = pos + props.node.nodeSize;
          props.editor.chain().focus().insertContentAt(after, nodes).run();
        },
        openPage: options.onOpenPage,
        confirm: (message) =>
          typeof window !== 'undefined' ? window.confirm(message) : true,
        runDataAction: options.runDataAction,
      });
    } finally {
      setRunning(false);
    }
  }

  function setActions(next: ButtonAction[]) {
    props.updateAttributes({ actions: JSON.stringify(next) });
  }

  return (
    <NodeViewWrapper
      className="ae-button-block"
      data-type="button"
      data-testid="button-block"
      contentEditable={false}
    >
      <button
        type="button"
        className="ae-button"
        data-testid="button-run"
        onClick={handleClick}
        disabled={running}
      >
        {icon ? <span className="ae-button-icon">{icon}</span> : null}
        <span className="ae-button-label">{label}</span>
      </button>
      {options.editable ? (
        <button
          type="button"
          className="ae-button-configure"
          data-testid="button-configure"
          onClick={() => setOpen((o) => !o)}
          title={tr('button.configure', 'Configure')}
        >
          ⚙
        </button>
      ) : null}
      {options.editable && open ? (
        <div className="ae-button-config" data-testid="button-config">
          <label className="ae-button-config-row">
            <span>{tr('button.icon', 'Icon')}</span>
            <input
              type="text"
              value={icon}
              maxLength={4}
              onChange={(e) => props.updateAttributes({ icon: e.target.value })}
            />
          </label>
          <label className="ae-button-config-row">
            <span>{tr('button.label', 'Label')}</span>
            <input
              type="text"
              value={label}
              onChange={(e) => props.updateAttributes({ label: e.target.value })}
            />
          </label>
          <div className="ae-button-actions">
            {actions.map((a, i) => (
              <div key={i} className="ae-button-action" data-testid="button-action">
                <span>{describeAction(a, t)}</span>
                <span className="ae-button-action-ctrls">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => {
                      const next = actions.slice();
                      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                      setActions(next);
                    }}
                    title="↑"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === actions.length - 1}
                    onClick={() => {
                      const next = actions.slice();
                      [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
                      setActions(next);
                    }}
                    title="↓"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setActions(actions.filter((_, j) => j !== i))}
                    title="×"
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="ae-button-add">
            <button
              type="button"
              data-testid="button-add-insert"
              onClick={() =>
                setActions([
                  ...actions,
                  { kind: 'insert_blocks', blocks: [{ type: 'paragraph', text: '' }] },
                ])
              }
            >
              + {tr('action.insert_blocks', 'Insert blocks')}
            </button>
            <button
              type="button"
              data-testid="button-add-confirm"
              onClick={() =>
                setActions([...actions, { kind: 'show_confirm', message: tr('button.confirmDefault', 'Are you sure?') }])
              }
            >
              + {tr('action.show_confirm', 'Show confirm')}
            </button>
          </div>
        </div>
      ) : null}
      {/* Mark whether the action list contains client-only actions so a host
          without `runDataAction` still works for those. */}
      <span hidden data-has-client-action={actions.some(isClientAction) ? '1' : '0'} />
    </NodeViewWrapper>
  );
}

/**
 * Button — an atom block that runs a list of actions when clicked. Actions are
 * stored as a JSON string on the `actions` attr (so the node round-trips through
 * the page's HTML snapshot + Yjs). The NodeView runs client actions directly and
 * delegates data actions to the host. In edit mode a ⚙ affordance opens a config
 * popover (label/icon + add/remove/reorder actions).
 */
export const Button = Node.create<ButtonOptions>({
  name: 'button',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { editable: true, onOpenPage: undefined, runDataAction: undefined, t: undefined };
  },

  addAttributes() {
    return {
      label: {
        default: 'Button',
        parseHTML: (el) => el.getAttribute('data-label') ?? 'Button',
        renderHTML: (attrs) => ({ 'data-label': attrs.label as string }),
      },
      icon: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-icon') ?? '',
        renderHTML: (attrs) => ({ 'data-icon': attrs.icon as string }),
      },
      actions: {
        // Stored as a JSON string so it survives the HTML snapshot round-trip.
        default: '[]',
        parseHTML: (el) => el.getAttribute('data-actions') ?? '[]',
        renderHTML: (attrs) => ({ 'data-actions': attrs.actions as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="button"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'button',
        'data-testid': 'button-block',
        class: 'ae-button-block',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },

  addCommands() {
    return {
      setButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              label: attrs?.label ?? 'Button',
              icon: attrs?.icon ?? '',
              actions: JSON.stringify(attrs?.actions ?? []),
            },
          }),
    };
  },
});

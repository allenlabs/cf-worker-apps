import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import GlobalDragHandle from 'tiptap-extension-global-drag-handle';
import {
  BG_COLORS,
  DEFAULT_BLOCK_LABELS,
  TEXT_COLORS,
  TURN_INTO_TARGETS,
  type ColorChoice,
  type TurnIntoId,
  colorBlock,
  deleteBlock,
  duplicateBlock,
  insertParagraphBelow,
  topLevelBlockAt,
  turnBlockInto,
} from '../lib/block-actions';

/** A translator: key → string. Defaults to the English fallback table. */
export type BlockMenuT = (key: string) => string;

const fallbackT: BlockMenuT = (key) => DEFAULT_BLOCK_LABELS[key] ?? key;

interface BlockMenuProps {
  editor: Editor;
  /** Document position of the block the handle is hovering. */
  pos: number;
  /** Anchor rect for positioning the popup (the handle button's rect). */
  anchor: DOMRect;
  t: BlockMenuT;
  onClose: () => void;
}

type Submenu = 'root' | 'turn' | 'color';

/**
 * The block action menu — opened by clicking the ⋮⋮ drag handle. Renders a
 * floating popup positioned next to the handle with Turn into / Duplicate /
 * Delete / Color. Submenus render inline (root → turn/color) to keep the popup
 * single-rooted and easy to dismiss on outside-click / Escape.
 */
function BlockMenu({ editor, pos, anchor, t, onClose }: BlockMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<Submenu>('root');

  // Dismiss on outside click + Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.round(anchor.bottom + 4),
    left: Math.round(anchor.left),
    zIndex: 50,
  };

  function run(fn: () => void) {
    fn();
    onClose();
  }

  return (
    <div ref={ref} className="ae-block-menu" style={style} role="menu" data-testid="block-menu">
      {view === 'root' ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="ae-block-menu-item"
            data-testid="block-menu-turn"
            onClick={() => setView('turn')}
          >
            <span className="ae-block-menu-glyph">↻</span>
            <span className="ae-block-menu-label">{t('block.turnInto')}</span>
            <span className="ae-block-menu-chevron">›</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ae-block-menu-item"
            data-testid="block-menu-duplicate"
            onClick={() => run(() => duplicateBlock(editor, pos))}
          >
            <span className="ae-block-menu-glyph">⧉</span>
            <span className="ae-block-menu-label">{t('block.duplicate')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ae-block-menu-item"
            data-testid="block-menu-color"
            onClick={() => setView('color')}
          >
            <span className="ae-block-menu-glyph">🎨</span>
            <span className="ae-block-menu-label">{t('block.color')}</span>
            <span className="ae-block-menu-chevron">›</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ae-block-menu-item ae-block-menu-danger"
            data-testid="block-menu-delete"
            onClick={() => run(() => deleteBlock(editor, pos))}
          >
            <span className="ae-block-menu-glyph">🗑</span>
            <span className="ae-block-menu-label">{t('block.delete')}</span>
          </button>
        </>
      ) : null}

      {view === 'turn' ? (
        <>
          <button
            type="button"
            className="ae-block-menu-back"
            data-testid="block-menu-back"
            onClick={() => setView('root')}
          >
            ‹ {t('block.turnInto')}
          </button>
          {TURN_INTO_TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              className="ae-block-menu-item"
              data-testid={`block-menu-turn-${target.id}`}
              onClick={() => run(() => turnBlockInto(editor, pos, target.id as TurnIntoId))}
            >
              <span className="ae-block-menu-glyph">{target.icon}</span>
              <span className="ae-block-menu-label">{t(target.labelKey)}</span>
            </button>
          ))}
        </>
      ) : null}

      {view === 'color' ? (
        <>
          <button
            type="button"
            className="ae-block-menu-back"
            data-testid="block-menu-back"
            onClick={() => setView('root')}
          >
            ‹ {t('block.color')}
          </button>
          {TEXT_COLORS.map((choice: ColorChoice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitem"
              className="ae-block-menu-item"
              data-testid={`block-menu-color-${choice.id}`}
              onClick={() => run(() => colorBlock(editor, pos, choice))}
            >
              <span
                className="ae-block-menu-swatch"
                style={{ color: choice.textColor ?? '#111827' }}
              >
                A
              </span>
              <span className="ae-block-menu-label">{t(choice.labelKey)}</span>
            </button>
          ))}
          {BG_COLORS.map((choice: ColorChoice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitem"
              className="ae-block-menu-item"
              data-testid={`block-menu-color-${choice.id}`}
              onClick={() => run(() => colorBlock(editor, pos, choice))}
            >
              <span
                className="ae-block-menu-swatch ae-block-menu-swatch-bg"
                style={{ background: choice.bgColor ?? 'transparent' }}
              />
              <span className="ae-block-menu-label">{t(choice.labelKey)}</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * Resolve the document position of the block whose drag-handle is at viewport
 * point (x, y). The global-drag-handle places its ⋮⋮ to the LEFT of the block,
 * so we probe a point a little to the right of the handle (into the content).
 */
function blockPosAtHandle(editor: Editor, handleRect: DOMRect): number | null {
  const probeX = handleRect.right + 8;
  const probeY = handleRect.top + handleRect.height / 2;
  const found = editor.view.posAtCoords({ left: probeX, top: probeY });
  if (!found) return null;
  const block = topLevelBlockAt(editor, found.pos);
  return block ? block.pos : null;
}

interface BlockMenuController {
  destroy: () => void;
}

/**
 * Mount the React block menu against the DOM handle elements created by
 * GlobalDragHandle. We add a click listener on the handle and a "＋" affordance
 * next to it; clicking the handle opens the menu, clicking "＋" inserts an empty
 * paragraph below and opens the slash menu (by typing "/").
 *
 * Client-only: callers guard on `typeof window`. The whole controller is torn
 * down when the editor is destroyed.
 */
function mountBlockMenu(editor: Editor, t: BlockMenuT): BlockMenuController {
  const container = document.createElement('div');
  container.className = 'ae-block-menu-portal';
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  // The "＋" add-block affordance — a sibling button we inject next to the
  // handle on hover. GlobalDragHandle owns the ⋮⋮ element with class
  // "drag-handle"; we attach our own click behaviour to it.
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'ae-add-block';
  plus.setAttribute('aria-label', 'Add block below');
  plus.textContent = '＋';
  plus.style.display = 'none';
  document.body.appendChild(plus);

  let open = false;
  let lastHandle: HTMLElement | null = null;

  function close() {
    open = false;
    root.render(null);
  }

  function openAt(handle: HTMLElement) {
    if (!editor.isEditable) return;
    const rect = handle.getBoundingClientRect();
    const pos = blockPosAtHandle(editor, rect);
    if (pos == null) return;
    open = true;
    root.render(
      <BlockMenu editor={editor} pos={pos} anchor={rect} t={t} onClose={close} />,
    );
  }

  // Position + show the "＋" next to whichever drag-handle is currently visible.
  function positionPlus(handle: HTMLElement) {
    lastHandle = handle;
    const rect = handle.getBoundingClientRect();
    plus.style.display = 'flex';
    plus.style.position = 'fixed';
    plus.style.top = `${Math.round(rect.top)}px`;
    plus.style.left = `${Math.round(rect.left - 20)}px`;
  }

  // Delegate: when the pointer enters a .drag-handle, remember it + place "＋".
  function onMouseOver(e: MouseEvent) {
    if (!editor.isEditable) return;
    const target = e.target as HTMLElement | null;
    const handle = target?.closest?.('.drag-handle') as HTMLElement | null;
    if (handle) positionPlus(handle);
  }

  // Click on the ⋮⋮ handle → open the block menu.
  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const handle = target?.closest?.('.drag-handle') as HTMLElement | null;
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      if (open) close();
      else openAt(handle);
    }
  }

  plus.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!lastHandle || !editor.isEditable) return;
    const rect = lastHandle.getBoundingClientRect();
    const pos = blockPosAtHandle(editor, rect);
    if (pos == null) return;
    insertParagraphBelow(editor, pos);
    // Open the slash menu by inserting "/" at the caret.
    editor.chain().focus().insertContent('/').run();
  });

  // Hide "＋" when leaving the editor surface entirely.
  function onMouseLeave() {
    plus.style.display = 'none';
  }

  const dom = editor.view.dom as HTMLElement;
  document.addEventListener('mouseover', onMouseOver, true);
  dom.addEventListener('click', onClick, true);
  document.addEventListener('click', onClick, true);
  dom.addEventListener('mouseleave', onMouseLeave);

  return {
    destroy: () => {
      document.removeEventListener('mouseover', onMouseOver, true);
      dom.removeEventListener('click', onClick, true);
      document.removeEventListener('click', onClick, true);
      dom.removeEventListener('mouseleave', onMouseLeave);
      root.unmount();
      container.remove();
      plus.remove();
    },
  };
}

/**
 * DragHandle — bundles the MIT `tiptap-extension-global-drag-handle` (⋮⋮ handle
 * + drag-to-reorder) with our React block action menu. Add it to the extension
 * list; pass a translator via `t` for localized menu labels.
 *
 * Read-only safe: the menu + "＋" never act when `editor.isEditable` is false,
 * and the handle is suppressed via CSS in read-only mode.
 */
export const DragHandle = Extension.create<{ t: BlockMenuT }>({
  name: 'aeDragHandle',

  addOptions() {
    return { t: fallbackT };
  },

  addExtensions() {
    return [
      GlobalDragHandle.configure({
        dragHandleWidth: 20,
        scrollTreshold: 100,
      }),
    ];
  },

  onCreate() {
    if (typeof window === 'undefined') return;
    const ctrl = mountBlockMenu(this.editor, this.options.t);
    // Stash on the storage so onDestroy can tear it down.
    (this.storage as { ctrl?: BlockMenuController }).ctrl = ctrl;
  },

  onDestroy() {
    (this.storage as { ctrl?: BlockMenuController }).ctrl?.destroy();
  },
});

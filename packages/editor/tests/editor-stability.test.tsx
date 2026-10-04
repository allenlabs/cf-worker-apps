// @vitest-environment jsdom
//
// Regression guard for the "/" slash menu rendering empty in production.
//
// Root cause: the host route passes fresh inline prop identities (mention,
// breadcrumb, onUpdate, …) on every re-render. In collab mode the route
// re-renders constantly (awareness ticks, local state). The old code put those
// identities in the `extensions` useMemo dep array, so the editor was torn down
// and rebuilt on every re-render. Rebuilding destroys EditorContent's
// `contentComponent`, so any open slash/mention ReactRenderer popup loses its
// React Portal target → an empty `.react-renderer` with zero errors. The same
// rebuild also collapsed the caret (the reported fast-typing reversal).
//
// The fix makes the editor depend only on STRUCTURAL flags + stable primitives;
// every live callback/object is read through a ref. These tests fail before the
// fix (editor recreated; popup empty) and pass after.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CollaborativeEditor } from '../src/CollaborativeEditor';
import { SlashCommand } from '../src/extensions/slash';

afterEach(() => {
  // jsdom can throw a benign NotFoundError tearing down ProseMirror/tippy DOM
  // nodes that were moved out of React's tree — not a product concern.
  try {
    cleanup();
  } catch {
    /* ignore jsdom teardown noise */
  }
});

async function waitForProseMirror(): Promise<HTMLElement> {
  let pm: HTMLElement | null = null;
  await act(async () => {
    for (let i = 0; i < 60; i++) {
      pm = document.querySelector('.ProseMirror');
      if (pm) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  if (!pm) throw new Error('ProseMirror never mounted');
  return pm;
}

describe('editor stability under parent re-render', () => {
  it('does not recreate the editor when unrelated inline props change', async () => {
    const seen = new Set<unknown>();
    let bump: (() => void) | null = null;

    function Harness() {
      const [, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return (
        <CollaborativeEditor
          value=""
          placeholder="type /"
          // Fresh identities every render — exactly like the host route.
          mention={async () => []}
          breadcrumb={{ items: [] }}
          onUpdate={() => {}}
          onOpenPage={() => {}}
        />
      );
    }

    await act(async () => {
      render(<Harness />);
    });
    seen.add(await waitForProseMirror());

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        bump!();
        await new Promise((r) => setTimeout(r, 10));
      });
      seen.add(document.querySelector('.ProseMirror'));
    }

    // A stable editor → exactly one ProseMirror element identity throughout.
    expect(seen.size, 'editor must not be recreated on parent re-render').toBe(1);
  });
});

describe('editor stability when the askAI hook identity changes', () => {
  it('does not recreate the editor when a fresh askAI identity is handed in', async () => {
    const seen = new Set<unknown>();
    let bump: (() => void) | null = null;

    function Harness() {
      const [, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return (
        <CollaborativeEditor
          value=""
          placeholder="type /"
          // A fresh askAI closure every render — the host route does this. The
          // editor must read it through a ref (hasAskAI is the only structural
          // dep), so this must NOT tear down + rebuild the editor.
          askAI={async () => 'ai output'}
        />
      );
    }

    await act(async () => {
      render(<Harness />);
    });
    seen.add(await waitForProseMirror());

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        bump!();
        await new Promise((r) => setTimeout(r, 10));
      });
      seen.add(document.querySelector('.ProseMirror'));
    }

    expect(seen.size, 'editor must not be recreated when askAI identity changes').toBe(1);
  });
});

describe('slash menu renders into its ReactRenderer portal', () => {
  it('shows .ae-slash-menu + slash-item-heading-1 when "/" is typed', async () => {
    const hold: { editor: Editor | null } = { editor: null };
    function Harness() {
      const editor = useEditor({
        extensions: [StarterKit, SlashCommand],
        content: '<p></p>',
        immediatelyRender: false,
      });
      hold.editor = editor;
      return editor ? <EditorContent editor={editor} /> : null;
    }
    await act(async () => {
      render(<Harness />);
    });
    await act(async () => {
      for (let i = 0; i < 60 && !hold.editor?.isInitialized; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    expect(hold.editor?.isInitialized).toBe(true);

    await act(async () => {
      hold.editor!.commands.focus();
      hold.editor!.commands.insertContent('/');
      await new Promise((r) => setTimeout(r, 50));
    });

    const renderer = document.querySelector('.react-renderer');
    expect(renderer, '.react-renderer mounted').not.toBeNull();
    // The bug was a mounted-but-empty .react-renderer; assert it has content.
    expect(document.querySelector('.ae-slash-menu'), '.ae-slash-menu rendered').not.toBeNull();
    expect(
      document.querySelector('[data-testid="slash-item-heading-1"]'),
      'slash-item-heading-1 rendered',
    ).not.toBeNull();
  });
});

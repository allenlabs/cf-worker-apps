import { Extension, InputRule } from '@tiptap/core';

/**
 * Match a to-do markdown prefix at the start of a line:
 *   "[] ", "[ ] ", "[x] ", "[X] "
 * The trailing space triggers the rule (mirrors StarterKit's list rules).
 */
export const TODO_INPUT_REGEX = /^\s*\[([ xX]?)\]\s$/;

/**
 * Markdown input rules StarterKit doesn't provide. Currently: a to-do (task)
 * item from `[] `/`[ ] `/`[x] ` at the start of a line. StarterKit already
 * covers bold/italic/strike/code/headings/lists/quote/code-block/divider, so we
 * only add what's missing.
 *
 * Implemented as a command-driven InputRule (rather than wrappingInputRule):
 * a task list is `taskList > taskItem > paragraph`, so we delete the typed
 * prefix then run `toggleTaskList` and set the checked state from the match.
 * Requires TaskList + TaskItem to be registered (they are, in the editor).
 */
export const MarkdownRules = Extension.create({
  name: 'aeMarkdownRules',

  addInputRules() {
    const taskList = this.editor.schema.nodes.taskList;
    const taskItem = this.editor.schema.nodes.taskItem;
    if (!taskList || !taskItem) return [];
    return [
      new InputRule({
        find: TODO_INPUT_REGEX,
        handler: ({ range, match, chain, state }) => {
          // Only fire inside an empty-ish paragraph (a normal block start), so
          // we don't hijack "[x]" typed mid-content.
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          const checked = /[xX]/.test(match[1] ?? '');
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes('taskItem', { checked })
            .run();
        },
      }),
    ];
  },
});

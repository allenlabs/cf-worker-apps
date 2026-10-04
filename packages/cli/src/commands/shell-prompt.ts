// `al shell-prompt` — print a one-line "current focus" snippet for $PS1.
//
// Designed to be embedded via PROMPT_COMMAND.  Stays empty when no
// session is active so the prompt is clean.  Never errors; never blocks
// on the network.

/* v8 ignore start — wraps loadSession + formatPromptSnippet, both tested. */

import { formatPromptSnippet } from '../lib/humans.js';
import { loadSession } from '../lib/session-store.js';
import { makeIO, type IO } from '../lib/output.js';

export async function shellPromptCommand(io: IO = makeIO()): Promise<number> {
  try {
    const session = await loadSession();
    if (!session) return 0; // empty stdout
    io.stdout(formatPromptSnippet(session.startedAt, session.targetMinutes));
    return 0;
  } catch {
    // Never trip the shell prompt — eat all errors.
    return 0;
  }
}

/* v8 ignore stop */

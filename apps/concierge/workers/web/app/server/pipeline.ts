// The "compose a nudge → insert → deliver" pipeline.  Shared between the
// cron worker (which iterates all enabled users) and the API worker's
// /v1/event endpoint (which receives a single cross-app trigger).
//
// Pure functions; deps injected.  Tests stub `fetchFn`, `now`, etc.

import type { DB } from '~/db/client';
import {
  bumpLastNudgeImpl,
  buildStateSummaryImpl,
  composeNudgeImpl,
  gateNudge,
  getPreferencesImpl,
  insertNudgeImpl,
  pickTopic,
  renderStateSummary,
  type Channel,
  type NudgeRow,
  type LlmEnv,
} from './concierge';
import {
  deliverPushImpl,
  type DeliverPushEnv,
} from './delivery';

export type ProcessResultStatus =
  | 'sent'
  | 'skipped-gate'
  | 'skipped-llm';

export interface ProcessNudgeResult {
  status: ProcessResultStatus;
  nudge?: NudgeRow;
  reason?: 'disabled' | 'quiet-hours' | 'cadence' | 'no-question';
  pushed?: boolean;
}

export interface ProcessNudgeEnv extends LlmEnv, DeliverPushEnv {
  /** Optional override for the URL embedded in the push payload — defaults
   *  to https://today.allenlabs.org/ which is where the user reads nudges. */
  PUBLIC_NUDGE_URL?: string;
}

export interface ProcessNudgeOptions {
  /** Force topic + skip the LLM topic-picking heuristic (event-driven case). */
  trigger?: string;
  /** Channels to attempt.  Defaults to ['push', 'today']. */
  channels?: Channel[];
  /** Pinned clock for tests. */
  now?: Date;
  /** Injectable fetch (LLM + push delivery). */
  fetchFn?: typeof fetch;
}

export async function processNudgeForUserImpl(
  env: ProcessNudgeEnv,
  db: DB,
  userId: number,
  opts: ProcessNudgeOptions = {},
): Promise<ProcessNudgeResult> {
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const channels: Channel[] = opts.channels ?? ['push', 'today'];

  const prefs = await getPreferencesImpl(db, userId);
  const gate = gateNudge(prefs, now);
  if (!gate.ok) {
    return { status: 'skipped-gate', reason: gate.reason };
  }

  const state = await buildStateSummaryImpl(db, userId);
  const stateText = renderStateSummary(state, now);
  const composed = await composeNudgeImpl(
    env,
    { stateSummary: stateText, trigger: opts.trigger },
    fetchFn,
  );
  if (!composed.question) {
    return { status: 'skipped-llm', reason: 'no-question' };
  }

  const topic = opts.trigger ? 'event' : pickTopic(state, now);
  const nudge = await insertNudgeImpl(
    db,
    {
      userId,
      topic,
      question: composed.question,
      contextSummary: stateText,
      model: composed.model,
      channels,
    },
    now,
  );

  let pushed = false;
  if (channels.includes('push')) {
    const url = env.PUBLIC_NUDGE_URL ?? 'https://today.allenlabs.org/';
    const result = await deliverPushImpl(
      env,
      {
        userId,
        title: 'A nudge from Concierge',
        body: nudge.question,
        url,
        tag: `concierge-${nudge.id}`,
      },
      fetchFn,
    );
    pushed = result.delivered;
  }

  await bumpLastNudgeImpl(db, userId, now);
  return { status: 'sent', nudge, pushed };
}

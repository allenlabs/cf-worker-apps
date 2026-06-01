import { useT } from '@allenlabs/i18n/react';
import { topicLabel, timeAgo } from '~/lib/format';
import type { NudgeRow as NudgeRowType } from '~/server/concierge';

interface NudgeRowProps {
  nudge: NudgeRowType;
  now?: number;
}

/**
 * Pure presentational row for the admin home list.  Exported separately so
 * tests can render it without router context.
 */
export function NudgeRowInner({ nudge, now }: NudgeRowProps) {
  const ago = timeAgo(nudge.sentAt, now);
  const state = nudge.dismissedAt
    ? 'dismissed'
    : nudge.repliedAt
      ? 'replied'
      : nudge.openedAt
        ? 'opened'
        : 'unopened';
  return (
    <div
      className="block p-3 text-slate-100"
      data-testid={`nudge-${nudge.id}`}
      data-state={state}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-slate-100">
          {nudge.question}
        </span>
        <span className="text-xs text-slate-500 shrink-0">{ago}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
        <span className="text-conci-300">{topicLabel(nudge.topic)}</span>
        <span>· {state}</span>
        {nudge.channels.length > 0 ? (
          <span>· via {nudge.channels.join(', ')}</span>
        ) : null}
        {nudge.repliedAt && nudge.replyText ? (
          <span className="text-slate-300">· "{nudge.replyText}"</span>
        ) : null}
      </div>
    </div>
  );
}

export function NudgeRow({ nudge, now }: NudgeRowProps) {
  return (
    <li className="card hover:bg-slate-800/40 transition-colors">
      <NudgeRowInner nudge={nudge} now={now} />
    </li>
  );
}

export function EmptyNudges() {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="empty-nudges">
      <p className="mb-2 text-slate-200">{t('concierge.emptyTitle')}</p>
      <p className="text-xs">
        {t('concierge.emptyBody', { flag: 'enabled = true' })}
      </p>
    </div>
  );
}

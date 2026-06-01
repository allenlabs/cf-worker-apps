import type { ReminderRow as ReminderData } from '~/server/nudge';
import { timeUntil } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

interface ReminderRowProps {
  reminder: ReminderData;
  now?: number;
  onSnooze?: (id: number, minutes: number) => void;
  onDismiss?: (id: number) => void;
}

export function ReminderRowCard({ reminder, now, onSnooze, onDismiss }: ReminderRowProps) {
  const { t } = useT();
  const when = timeUntil(reminder.fireAt, now);
  return (
    <li
      className="card p-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
      data-testid={`reminder-${reminder.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-100 break-words" data-testid={`reminder-text-${reminder.id}`}>
          {reminder.text}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          <span data-testid={`reminder-when-${reminder.id}`}>{when}</span>
          {reminder.recurrence ? (
            <span className="ml-2 text-nudge-300" data-testid={`reminder-recur-${reminder.id}`}>
              {reminder.recurrence}
            </span>
          ) : null}
          {reminder.tags.map((t) => (
            <span key={t} className="ml-2 text-slate-400" data-testid={`reminder-tag-${reminder.id}-${t}`}>
              #{t}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 text-xs">
        <button
          type="button"
          onClick={() => onSnooze?.(reminder.id, 30)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
          data-testid={`snooze-${reminder.id}`}
        >
          {t('nudge.snooze30m')}
        </button>
        <button
          type="button"
          onClick={() => onDismiss?.(reminder.id)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
          data-testid={`dismiss-${reminder.id}`}
        >
          {t('nudge.dismiss')}
        </button>
      </div>
    </li>
  );
}

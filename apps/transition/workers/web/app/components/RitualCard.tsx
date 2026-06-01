import type { RitualRow } from '~/server/transition';
import { useT } from '@allenlabs/i18n/react';
import { relativeAgo, targetLabel } from '~/lib/format';

interface RitualCardProps {
  ritual: RitualRow;
}

const TARGET_KEY: Record<string, string> = {
  context: 'transition.target.toContext',
  inbox: 'transition.target.toInbox',
  journal: 'transition.target.toJournal',
};

export function RitualCard({ ritual }: RitualCardProps) {
  const { t } = useT();
  const target = ritual.target;
  const targetText = !target
    ? t('transition.target.keptHere')
    : TARGET_KEY[target]
      ? t(TARGET_KEY[target]!)
      : targetLabel(target);
  return (
    <li className="card p-3 space-y-2" data-testid={`ritual-${ritual.id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-transition-400" data-testid={`target-${ritual.id}`}>
          {targetText}
        </span>
        <span className="text-xs text-slate-500">{relativeAgo(ritual.createdAt)}</span>
      </div>
      <div>
        <div className="text-xs text-slate-500">{t('transition.card.leavingAt')}</div>
        <p className="text-sm text-slate-100 whitespace-pre-wrap" data-testid={`leaving-${ritual.id}`}>
          {ritual.leavingAt}
        </p>
      </div>
      <div>
        <div className="text-xs text-slate-500">{t('transition.card.nextStep')}</div>
        <p className="text-sm text-slate-100 whitespace-pre-wrap" data-testid={`next-${ritual.id}`}>
          {ritual.nextStep}
        </p>
      </div>
      {ritual.mightForget ? (
        <div>
          <div className="text-xs text-slate-500">{t('transition.card.mightForget')}</div>
          <p className="text-sm text-slate-300 whitespace-pre-wrap" data-testid={`forget-${ritual.id}`}>
            {ritual.mightForget}
          </p>
        </div>
      ) : null}
    </li>
  );
}

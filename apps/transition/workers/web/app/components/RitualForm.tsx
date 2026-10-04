import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { TARGETS, type SaveRitualInput, type Target } from '~/server/transition';

interface RitualFormProps {
  onSubmit: (input: SaveRitualInput) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

const TARGET_OPTION_KEY: Record<string, string> = {
  context: 'transition.form.targetContext',
  inbox: 'transition.form.targetInbox',
  journal: 'transition.form.targetJournal',
};

export function RitualForm({ onSubmit, busy, error }: RitualFormProps) {
  const { t } = useT();
  const [leavingAt, setLeavingAt] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [mightForget, setMightForget] = useState('');
  const [target, setTarget] = useState<Target | ''>('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!leavingAt.trim() || !nextStep.trim()) return;
    void onSubmit({
      leaving_at: leavingAt.trim(),
      next_step: nextStep.trim(),
      might_forget: mightForget.trim() || null,
      target: target || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="ritual-form">
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          {t('transition.form.q1')}
        </label>
        <textarea
          value={leavingAt}
          onChange={(e) => setLeavingAt(e.target.value)}
          rows={2}
          className="w-full rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="leaving-input"
          placeholder={t('transition.form.leavingPlaceholder')}
        />
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          {t('transition.form.q2')}
        </label>
        <textarea
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
          rows={2}
          className="w-full rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="next-input"
          placeholder={t('transition.form.nextPlaceholder')}
        />
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          {t('transition.form.q3')}
        </label>
        <textarea
          value={mightForget}
          onChange={(e) => setMightForget(e.target.value)}
          rows={2}
          className="w-full rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="forget-input"
          placeholder={t('transition.form.forgetPlaceholder')}
        />
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          {t('transition.form.sendCopy')}
        </label>
        <select
          value={target}
          onChange={(e) => setTarget((e.target.value as Target | '') || '')}
          className="rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="target-select"
        >
          <option value="">{t('transition.form.keepHere')}</option>
          {TARGETS.map((opt) => (
            <option key={opt} value={opt}>
              {TARGET_OPTION_KEY[opt] ? t(TARGET_OPTION_KEY[opt]!) : opt}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="text-sm text-red-400" data-testid="form-error">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy || !leavingAt.trim() || !nextStep.trim()}
          className="rounded bg-transition-600 hover:bg-transition-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white"
          data-testid="save-button"
        >
          {busy ? t('state.saving') : t('transition.form.save')}
        </button>
      </div>
    </form>
  );
}

import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import type { CheckinRow } from '~/server/gentle';

export interface CheckinFormValues {
  slept_ok: boolean | null;
  meds: boolean | null;
  ate: boolean | null;
  moved: boolean | null;
  talked: boolean | null;
  note: string;
  date: string;
}

interface CheckinFormProps {
  initial: CheckinRow | null;
  date: string;
  onSubmit: (data: CheckinFormValues) => void;
  busy?: boolean;
  error?: string | null;
}

const TOGGLES: Array<{
  key: keyof Omit<CheckinFormValues, 'note' | 'date'>;
  labelKey: string;
  questionKey: string;
}> = [
  { key: 'slept_ok', labelKey: 'gentle.toggle.slept.label',  questionKey: 'gentle.toggle.slept.question' },
  { key: 'meds',     labelKey: 'gentle.toggle.meds.label',   questionKey: 'gentle.toggle.meds.question' },
  { key: 'ate',      labelKey: 'gentle.toggle.ate.label',    questionKey: 'gentle.toggle.ate.question' },
  { key: 'moved',    labelKey: 'gentle.toggle.moved.label',  questionKey: 'gentle.toggle.moved.question' },
  { key: 'talked',   labelKey: 'gentle.toggle.talked.label', questionKey: 'gentle.toggle.talked.question' },
];

interface ToggleRowProps {
  label: string;
  question: string;
  value: boolean | null;
  testId: string;
  onChange: (v: boolean | null) => void;
}

// Tri-state pill row: yes / no / blank.  No streak break for "blank" —
// gentle's whole purpose is to NOT force a yes/no when the user genuinely
// didn't know.  An explicit "no" still counts as engaging with the
// check-in.
export function ToggleRow({ label, question, value, testId, onChange }: ToggleRowProps) {
  const { t } = useT();
  function pillCls(active: boolean): string {
    return active
      ? 'bg-gentle-600 border-gentle-500 text-white'
      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800';
  }
  return (
    <div className="flex items-center gap-3" data-testid={`row-${testId}`}>
      <span className="w-24 text-sm text-slate-400" title={question}>{label}</span>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onChange(value === true ? null : true)}
          className={`h-8 px-3 rounded text-sm font-medium border ${pillCls(value === true)}`}
          data-testid={`${testId}-yes`}
          aria-pressed={value === true}
          aria-label={t('gentle.toggle.ariaYes', { question })}
        >
          {t('gentle.toggle.yes')}
        </button>
        <button
          type="button"
          onClick={() => onChange(value === false ? null : false)}
          className={`h-8 px-3 rounded text-sm font-medium border ${pillCls(value === false)}`}
          data-testid={`${testId}-no`}
          aria-pressed={value === false}
          aria-label={t('gentle.toggle.ariaNo', { question })}
        >
          {t('gentle.toggle.no')}
        </button>
      </div>
    </div>
  );
}

export function CheckinForm({ initial, date, onSubmit, busy, error }: CheckinFormProps) {
  const { t } = useT();
  const [sleptOk, setSleptOk] = useState<boolean | null>(initial?.sleptOk ?? null);
  const [meds, setMeds] = useState<boolean | null>(initial?.meds ?? null);
  const [ate, setAte] = useState<boolean | null>(initial?.ate ?? null);
  const [moved, setMoved] = useState<boolean | null>(initial?.moved ?? null);
  const [talked, setTalked] = useState<boolean | null>(initial?.talked ?? null);
  const [note, setNote] = useState<string>(initial?.note ?? '');

  const setters: Record<string, (v: boolean | null) => void> = {
    slept_ok: setSleptOk,
    meds: setMeds,
    ate: setAte,
    moved: setMoved,
    talked: setTalked,
  };
  const values: Record<string, boolean | null> = {
    slept_ok: sleptOk,
    meds,
    ate,
    moved,
    talked,
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ slept_ok: sleptOk, meds, ate, moved, talked, note, date });
      }}
      className="space-y-4"
      data-testid="checkin-form"
    >
      <div className="space-y-2">
        {TOGGLES.map((tog) => (
          <ToggleRow
            key={tog.key}
            label={t(tog.labelKey)}
            question={t(tog.questionKey)}
            value={values[tog.key] ?? null}
            testId={tog.key}
            onChange={setters[tog.key]!}
          />
        ))}
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          {t('gentle.noteLabel')}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-gentle-500 focus:outline-none"
          data-testid="note-input"
          placeholder={t('gentle.notePlaceholder')}
        />
      </div>
      {error ? <p className="text-sm text-red-400" data-testid="form-error">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-gentle-600 hover:bg-gentle-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white"
          data-testid="save-button"
        >
          {busy ? t('state.saving') : initial ? t('gentle.update') : t('btn.save')}
        </button>
      </div>
    </form>
  );
}

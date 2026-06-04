// PUBLIC form route (database Forms). Reachable signed-out — it has NO
// beforeLoad auth gate and its path prefix (/form/) is exempted from the __root
// SSO redirect (see PUBLIC_PATH_PREFIXES there). It SSR-fetches the form
// definition via the no-user `publicForm` server fn (which hits editor-api's
// public route, gated by the enabled share token), renders the form, and
// submits via `submitPublicForm`. On success it shows the confirmation message
// + a "submit another response" affordance. NO auth required.

import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  publicForm,
  submitPublicForm,
  type PublicFormDefinition,
  type PublicFormField,
} from '~/server/docs';

export const Route = createFileRoute('/form/$token')({
  // NOTE: intentionally NO beforeLoad — public visitors must reach this.
  loader: async ({ params }) => {
    if (typeof document !== 'undefined') {
      return { form: null as PublicFormDefinition | null, token: params.token };
    }
    try {
      const form = await publicForm({ data: { token: params.token } });
      return { form, token: params.token };
    } catch {
      return { form: null as PublicFormDefinition | null, token: params.token };
    }
  },
  component: FormPage,
});

function FormPage() {
  const { form, token } = Route.useLoaderData();
  const { t } = useT();

  if (!form) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <h1 className="text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
          {t('form.unavailableTitle')}
        </h1>
        <p className="text-gray-500 dark:text-gray-400">{t('form.unavailableBody')}</p>
      </div>
    );
  }

  return <FormBody form={form} token={token} />;
}

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

function FormBody({ form, token }: { form: PublicFormDefinition; token: string }) {
  const { t } = useT();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<SubmitState>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function setAnswer(propId: string, value: unknown) {
    setAnswers((prev) => ({ ...prev, [propId]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setErrors({});
    try {
      const res = await submitPublicForm({ data: { token, answers } });
      if (res.ok) {
        setState('done');
      } else {
        setErrors(res.errors ?? {});
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  function reset() {
    setAnswers({});
    setErrors({});
    setState('idle');
  }

  if (state === 'done') {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3 text-gray-900 dark:text-gray-100">
          {form.title || t('form.defaultTitle')}
        </h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">{form.confirmationMessage}</p>
        <button
          type="button"
          onClick={reset}
          className="text-sm px-4 py-2 rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {t('form.submitAnother')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      {form.title ? (
        <h1 className="text-2xl font-bold mb-2 text-gray-900 dark:text-gray-100">{form.title}</h1>
      ) : null}
      {form.description ? (
        <p className="text-gray-600 dark:text-gray-400 mb-6 whitespace-pre-wrap">
          {form.description}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-5">
        {form.fields.map((field) => (
          <FieldInput
            key={field.propId}
            field={field}
            value={answers[field.propId]}
            error={errors[field.propId]}
            onChange={(v) => setAnswer(field.propId, v)}
          />
        ))}

        {state === 'error' && Object.keys(errors).length === 0 ? (
          <p className="text-sm text-red-600 dark:text-red-400">{t('form.submitFailed')}</p>
        ) : null}

        <button
          type="submit"
          disabled={state === 'submitting'}
          className="w-full sm:w-auto px-5 py-2.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-60"
        >
          {state === 'submitting' ? t('form.submitting') : form.submitText || t('form.submit')}
        </button>
      </form>
    </div>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: PublicFormField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const { t } = useT();
  const labelEl = (
    <label className="block text-sm font-medium mb-1.5 text-gray-800 dark:text-gray-200">
      {field.label}
      {field.required ? <span className="text-red-500 ml-0.5">*</span> : null}
    </label>
  );
  const inputClass =
    'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  let control: React.ReactNode;
  switch (field.type) {
    case 'number':
      control = (
        <input
          type="number"
          className={inputClass}
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
      break;
    case 'date':
      control = (
        <input
          type="date"
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
      break;
    case 'checkbox':
      control = (
        <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
      );
      break;
    case 'select':
    case 'status':
      control = (
        <select
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        >
          <option value="">{t('form.selectPlaceholder')}</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div className="space-y-1.5">
          {field.options.map((o) => (
            <label
              key={o.id}
              className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selected.includes(o.name)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, o.name]
                    : selected.filter((n) => n !== o.name);
                  onChange(next);
                }}
              />
              {o.name}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'text':
      control = (
        <textarea
          className={inputClass}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
      break;
    case 'url':
    case 'email':
    case 'phone':
    default:
      control = (
        <input
          type={field.type === 'url' ? 'url' : field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
      break;
  }

  return (
    <div>
      {field.type === 'checkbox' ? null : labelEl}
      {control}
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t(`form.error.${error}`)}</p>
      ) : null}
    </div>
  );
}

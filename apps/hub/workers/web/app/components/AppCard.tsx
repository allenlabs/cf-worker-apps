import type { AppEntry } from '~/lib/apps-catalog';

export interface AppCardProps {
  app: AppEntry;
}

export function AppCard({ app }: AppCardProps) {
  return (
    <a
      href={app.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded border border-slate-800 bg-slate-900 hover:border-emerald-500 hover:bg-slate-800 transition-colors p-4"
      data-testid={`app-card-${app.slug}`}
      aria-label={app.name}
    >
      <div className="text-slate-100 font-medium">{app.name}</div>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{app.description}</p>
      <div className="mt-3 text-xs text-emerald-400">{app.url}</div>
    </a>
  );
}

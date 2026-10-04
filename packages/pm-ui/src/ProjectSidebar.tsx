import { Link, useLocation } from '@tanstack/react-router';
import { useT } from '@allenlabs/i18n/react';

interface Props {
  identifier: string;
  projectName: string;
  modules: string[];
}

export function ProjectSidebar({ identifier, projectName, modules }: Props) {
  const loc = useLocation();
  const { t } = useT();
  const base = `/projects/${identifier}`;
  const item = (href: string, label: string, show = true) => {
    if (!show) return null;
    const active = loc.pathname === href || loc.pathname.startsWith(href + '/');
    return (
      <Link
        to={href}
        className={`block px-3 py-1.5 text-sm rounded ${active ? 'bg-redmine-100 text-redmine-800' : 'text-gray-700 hover:bg-gray-100'}`}
      >
        {label}
      </Link>
    );
  };
  return (
    <aside className="w-56 shrink-0 space-y-1 pr-2 border-r border-gray-200">
      <div className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wide">
        {projectName}
      </div>
      {item(`${base}`, t('sidebar.overview'))}
      {item(`${base}/activity`, t('sidebar.activity'))}
      {item(`${base}/issues`, t('sidebar.issues'), modules.includes('issue_tracking'))}
      {item(`${base}/board`, t('sidebar.board'), modules.includes('issue_tracking'))}
      {item(`${base}/gantt`, t('sidebar.gantt'), modules.includes('gantt'))}
      {item(`${base}/roadmap`, t('sidebar.roadmap'), modules.includes('roadmap'))}
      {item(`${base}/wiki`, t('sidebar.wiki'), modules.includes('wiki'))}
      {item(`${base}/files`, t('sidebar.files'), modules.includes('files'))}
      {item(`${base}/time`, t('sidebar.time'), modules.includes('time_tracking'))}
      <div className="px-3 py-1.5 mt-3 text-xs text-gray-500 uppercase tracking-wide">
        {t('sidebar.configure')}
      </div>
      {item(`${base}/members`, t('sidebar.members'))}
      {item(`${base}/versions`, t('sidebar.versions'))}
      {item(`${base}/categories`, t('sidebar.categories'))}
      {item(`${base}/labels`, t('sidebar.labels'))}
      {item(`${base}/settings`, t('sidebar.settings'))}
    </aside>
  );
}

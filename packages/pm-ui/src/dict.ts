// i18n strings owned by pm-ui's components (project sidebar nav + toast). The
// consuming app merges this fragment into its dictionary; pm-ui's own tests use
// it directly. Same shape as @allenlabs/i18n's Dict (locale → flat key → text).
import type { Dict } from '@allenlabs/i18n';

export const pmUiStrings: Dict = {
  en: {
    'sidebar.overview': 'Overview',
    'sidebar.activity': 'Activity',
    'sidebar.issues': 'Issues',
    'sidebar.gantt': 'Gantt',
    'sidebar.roadmap': 'Roadmap',
    'sidebar.wiki': 'Wiki',
    'sidebar.files': 'Files',
    'sidebar.time': 'Time',
    'sidebar.configure': 'Configure',
    'sidebar.members': 'Members',
    'sidebar.versions': 'Versions',
    'sidebar.categories': 'Categories',
    'sidebar.labels': 'Labels',
    'sidebar.board': 'Board',
    'sidebar.settings': 'Settings',
    'toast.region': 'Notifications',
    'toast.dismiss': 'Dismiss notification',
  },
  ko: {
    'sidebar.overview': '개요',
    'sidebar.activity': '활동',
    'sidebar.issues': '이슈',
    'sidebar.gantt': '간트',
    'sidebar.roadmap': '로드맵',
    'sidebar.wiki': '위키',
    'sidebar.files': '파일',
    'sidebar.time': '시간 추적',
    'sidebar.configure': '설정',
    'sidebar.members': '멤버',
    'sidebar.versions': '버전',
    'sidebar.categories': '카테고리',
    'sidebar.labels': '라벨',
    'sidebar.board': '보드',
    'sidebar.settings': '설정',
    'toast.region': '알림',
    'toast.dismiss': '알림 닫기',
  },
};

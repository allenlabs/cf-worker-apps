// Editor-specific translation strings, merged with the shared common dict.
// `t` returns the key unchanged when missing in both locales — easy to spot
// during dev. English values are kept exactly equal to the prior literals so
// the en render is byte-identical to pre-i18n.

import { mergeDicts, type Dict } from '@allenlabs/i18n';
import { commonStrings } from '@allenlabs/i18n/dict/common';

const editor: Dict = {
  en: {
    'app.name': 'Editor',

    // Sidebar
    'sidebar.workspace': 'Workspace',
    'sidebar.favorites': 'Favorites',
    'sidebar.sharedWithMe': 'Shared with me',
    'sidebar.private': 'Private',
    'sidebar.noPages': 'No pages yet.',
    'sidebar.searchPlaceholder': 'Search…',
    'sidebar.searchAria': 'Search pages',
    'sidebar.noResults': 'No results.',
    'sidebar.newPage': '＋ New page',
    'sidebar.newDatabase': '⊞ New database',
    'sidebar.newTeamspace': '＋ New teamspace',
    'sidebar.trash': '🗑 Trash',
    'sidebar.collapse': 'Collapse',
    'sidebar.expand': 'Expand',
    'sidebar.addSubPage': 'Add sub-page',
    'sidebar.untitled': 'Untitled',
    'sidebar.newTeamspacePrompt': 'Teamspace name',
    'sidebar.newTeamspaceDefault': 'Teamspace',
    'sidebar.teamspaceMembers': 'Members',
    'sidebar.teamspaceMembersShort': 'Members',
    'sidebar.teamspaceOpen': 'Open to all workspace members. Add members to restrict.',

    // Page header
    'page.share': 'Share',
    'page.comments': 'Comments',
    'page.history': 'History',
    'page.favoriteAdd': 'Add to favorites',
    'page.favoriteRemove': 'Remove from favorites',
    'page.toggleFavorite': 'Toggle favorite',
    'page.toggleComments': 'Toggle comments',
    'page.toggleHistory': 'Toggle version history',
    'page.untitled': 'Untitled',
    'page.loading': 'Loading…',
    'page.loadingEditor': 'Loading editor…',
    'page.addSubPage': '＋ Add sub-page',
    'page.editorPlaceholder': 'Type "/" for commands…',
    'page.readOnly': 'View only — you can read but not edit this page.',

    // Share popover (public + invite)
    'share.toWeb': 'Share to web',
    'share.anyoneCanView': 'Anyone with the link can view this page.',
    'share.copy': 'Copy',
    'share.copied': 'Copied',
    'share.off': 'Off — only workspace members can view.',
    'share.invitePeople': 'Invite people',
    'share.invitePlaceholder': 'Search by name or username…',
    'share.roleView': 'Can view',
    'share.roleEdit': 'Can edit',
    'share.invite': 'Invite',
    'share.inviting': 'Inviting…',
    'share.noUser': 'No matching user.',
    'share.peopleWithAccess': 'People with access',
    'share.remove': 'Remove',
    'share.removeAria': 'Remove access',
    'share.restrict': 'Restrict access',
    'share.restrictOn': 'Only invited people and the owner can find this page.',
    'share.restrictOff': 'Off — all workspace members can find this page.',

    // Index empty state
    'index.settingUp': 'Setting up your workspace…',
    'index.createFirstTitle': 'Create your first page',
    'index.createFirstBody':
      'Pages can be nested infinitely. Start with one and add sub-pages as you go.',
    'index.newPage': 'New page',
    'index.newDatabase': 'New database',
    'index.creating': 'Creating…',

    // Trash
    'trash.title': 'Trash',
    'trash.body':
      'Archived pages. Restore to bring them back, or delete forever to remove permanently.',
    'trash.empty': 'Trash is empty.',
    'trash.restore': 'Restore',
    'trash.deleteForever': 'Delete forever',
    'trash.purgeConfirm':
      'Permanently delete "{title}" and everything inside it? This cannot be undone.',

    // Database views
    'db.viewTable': 'Table',
    'db.viewBoard': 'Board',
    'db.viewList': 'List',
    'db.viewGallery': 'Gallery',
    'db.viewCalendar': 'Calendar',
    'db.viewTimeline': 'Timeline',
    'db.addView': '＋ Add view…',
    'db.addViewAria': 'Add view',
    'db.noViews': 'No views.',
    'db.loadingRows': 'Loading rows…',

    // Comments panel
    'comments.title': 'Comments',
    'comments.close': 'Close comments',
    'comments.loading': 'Loading…',
    'comments.inlineThreads': 'Inline threads',
    'comments.pageComments': 'Page comments',
    'comments.noPageComments': 'No page comments yet.',
    'comments.reopen': 'Reopen',
    'comments.resolve': 'Resolve',
    'comments.delete': 'Delete',
    'comments.resolveThread': 'Resolve thread',
    'comments.someone': 'Someone',
    'comments.addPlaceholder': 'Add a page comment…',
    'comments.commentPlaceholder': 'Comment…',
    'comments.replyPlaceholder': 'Reply…',
    'comments.posting': 'Posting…',
    'comments.comment': 'Comment',
  },
  ko: {
    'app.name': '에디터',

    // Sidebar
    'sidebar.workspace': '워크스페이스',
    'sidebar.favorites': '즐겨찾기',
    'sidebar.sharedWithMe': '나와 공유됨',
    'sidebar.private': '개인',
    'sidebar.noPages': '아직 페이지가 없습니다.',
    'sidebar.searchPlaceholder': '검색…',
    'sidebar.searchAria': '페이지 검색',
    'sidebar.noResults': '결과가 없습니다.',
    'sidebar.newPage': '＋ 새 페이지',
    'sidebar.newDatabase': '⊞ 새 데이터베이스',
    'sidebar.newTeamspace': '＋ 새 팀스페이스',
    'sidebar.trash': '🗑 휴지통',
    'sidebar.collapse': '접기',
    'sidebar.expand': '펼치기',
    'sidebar.addSubPage': '하위 페이지 추가',
    'sidebar.untitled': '제목 없음',
    'sidebar.newTeamspacePrompt': '팀스페이스 이름',
    'sidebar.newTeamspaceDefault': '팀스페이스',
    'sidebar.teamspaceMembers': '멤버',
    'sidebar.teamspaceMembersShort': '멤버',
    'sidebar.teamspaceOpen': '모든 워크스페이스 멤버에게 공개. 멤버를 추가하면 제한됩니다.',

    // Page header
    'page.share': '공유',
    'page.comments': '코멘트',
    'page.history': '기록',
    'page.favoriteAdd': '즐겨찾기에 추가',
    'page.favoriteRemove': '즐겨찾기에서 제거',
    'page.toggleFavorite': '즐겨찾기 전환',
    'page.toggleComments': '코멘트 전환',
    'page.toggleHistory': '버전 기록 전환',
    'page.untitled': '제목 없음',
    'page.loading': '로딩 중…',
    'page.loadingEditor': '에디터 로딩 중…',
    'page.addSubPage': '＋ 하위 페이지 추가',
    'page.editorPlaceholder': '"/"를 입력하여 명령 실행…',
    'page.readOnly': '보기 전용 — 이 페이지는 읽을 수만 있고 편집할 수 없습니다.',

    // Share popover
    'share.toWeb': '웹에 공유',
    'share.anyoneCanView': '링크가 있는 누구나 이 페이지를 볼 수 있습니다.',
    'share.copy': '복사',
    'share.copied': '복사됨',
    'share.off': '꺼짐 — 워크스페이스 멤버만 볼 수 있습니다.',
    'share.invitePeople': '사람 초대',
    'share.invitePlaceholder': '이름 또는 사용자명으로 검색…',
    'share.roleView': '볼 수 있음',
    'share.roleEdit': '편집할 수 있음',
    'share.invite': '초대',
    'share.inviting': '초대 중…',
    'share.noUser': '일치하는 사용자가 없습니다.',
    'share.peopleWithAccess': '액세스 권한이 있는 사람',
    'share.remove': '제거',
    'share.removeAria': '액세스 제거',
    'share.restrict': '액세스 제한',
    'share.restrictOn': '초대된 사람과 소유자만 이 페이지를 찾을 수 있습니다.',
    'share.restrictOff': '꺼짐 — 모든 워크스페이스 멤버가 이 페이지를 찾을 수 있습니다.',

    // Index empty state
    'index.settingUp': '워크스페이스를 설정하는 중…',
    'index.createFirstTitle': '첫 페이지 만들기',
    'index.createFirstBody':
      '페이지는 무한히 중첩할 수 있습니다. 하나로 시작해 하위 페이지를 추가하세요.',
    'index.newPage': '새 페이지',
    'index.newDatabase': '새 데이터베이스',
    'index.creating': '만드는 중…',

    // Trash
    'trash.title': '휴지통',
    'trash.body':
      '보관된 페이지입니다. 복원하여 되돌리거나 영구 삭제하여 완전히 제거하세요.',
    'trash.empty': '휴지통이 비어 있습니다.',
    'trash.restore': '복원',
    'trash.deleteForever': '영구 삭제',
    'trash.purgeConfirm':
      '"{title}"와(과) 그 안의 모든 항목을 영구히 삭제하시겠어요? 되돌릴 수 없습니다.',

    // Database views
    'db.viewTable': '테이블',
    'db.viewBoard': '보드',
    'db.viewList': '목록',
    'db.viewGallery': '갤러리',
    'db.viewCalendar': '캘린더',
    'db.viewTimeline': '타임라인',
    'db.addView': '＋ 뷰 추가…',
    'db.addViewAria': '뷰 추가',
    'db.noViews': '뷰가 없습니다.',
    'db.loadingRows': '행 로딩 중…',

    // Comments panel
    'comments.title': '코멘트',
    'comments.close': '코멘트 닫기',
    'comments.loading': '로딩 중…',
    'comments.inlineThreads': '인라인 스레드',
    'comments.pageComments': '페이지 코멘트',
    'comments.noPageComments': '아직 페이지 코멘트가 없습니다.',
    'comments.reopen': '다시 열기',
    'comments.resolve': '해결',
    'comments.delete': '삭제',
    'comments.resolveThread': '스레드 해결',
    'comments.someone': '누군가',
    'comments.addPlaceholder': '페이지 코멘트 추가…',
    'comments.commentPlaceholder': '코멘트…',
    'comments.replyPlaceholder': '답글…',
    'comments.posting': '게시 중…',
    'comments.comment': '코멘트',
  },
};

export const editorDict: Dict = mergeDicts(commonStrings, editor);

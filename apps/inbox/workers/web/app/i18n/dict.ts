// Inbox-specific strings merged with the shared common dict.
import { mergeDicts, type Dict } from "@allenlabs/i18n";
import { commonStrings } from "@allenlabs/i18n/dict/common";

const app: Dict = {
  en: {
    "app.name": "Inbox",
    "inbox.title": "Inbox",
    "inbox.placeholder": "Type a thought, hit ↵ — that's it.",
    "inbox.capture": "Capture",
    "inbox.zero": "Inbox zero.",
    "inbox.zeroHint": "Working memory: clear.  Go ship the thing.",
    "inbox.snoozed": "Snoozed ({n})",
    "inbox.triageLabel": "Triage list",
    "inbox.keysHint":
      "Keys: j/k move · ↵ open · 1 pin · 2 refile→PM · d drop · s snooze 1d · S snooze 1w · u mark unread",
    "inbox.via": "via {source}",
    "inbox.wakes": "wakes {when}",
    "notif.title": "Notifications",
    "notif.permission": "Permission:",
    "notif.unsupported": "unsupported",
    "notif.unsupportedHint":
      "This browser does not support Web Push.  Try Safari 16.4+ on iOS or any modern desktop browser.",
    "notif.enable": "Enable notifications",
    "notif.disable": "Disable notifications",
    "notif.onCapture": "Notify on new captures",
    "notif.quietHours": "Quiet hours",
    "notif.quietStart": "quiet start",
    "notif.quietEnd": "quiet end",
    "notif.quietHint": "Times are UTC.  Leave blank to disable.",
  },
  ko: {
    "app.name": "수신함",
    "inbox.title": "수신함",
    "inbox.placeholder": "생각을 입력하고 ↵ — 그게 전부에요.",
    "inbox.capture": "담기",
    "inbox.zero": "수신함 비움.",
    "inbox.zeroHint": "작업 기억: 정리됨. 이제 만들러 가세요.",
    "inbox.snoozed": "보류 ({n})",
    "inbox.triageLabel": "분류 목록",
    "inbox.keysHint":
      "단축키: j/k 이동 · ↵ 열기 · 1 고정 · 2 PM으로 보내기 · d 버리기 · s 1일 보류 · S 1주 보류 · u 안읽음 표시",
    "inbox.via": "출처 {source}",
    "inbox.wakes": "{when} 깨어남",
    "notif.title": "알림",
    "notif.permission": "권한:",
    "notif.unsupported": "지원 안 됨",
    "notif.unsupportedHint":
      "이 브라우저는 웹 푸시를 지원하지 않습니다. iOS는 Safari 16.4+ 또는 최신 데스크톱 브라우저를 사용하세요.",
    "notif.enable": "알림 켜기",
    "notif.disable": "알림 끄기",
    "notif.onCapture": "새 캡처 시 알림",
    "notif.quietHours": "방해 금지 시간",
    "notif.quietStart": "시작 시각",
    "notif.quietEnd": "종료 시각",
    "notif.quietHint": "시간은 UTC 기준입니다. 비워 두면 비활성화됩니다.",
  },
};

export const appDict: Dict = mergeDicts(commonStrings, app);

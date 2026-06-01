// Hub-specific strings merged with the shared common dict.
import { mergeDicts, type Dict } from "@allenlabs/i18n";
import { commonStrings } from "@allenlabs/i18n/dict/common";

const hub: Dict = {
  en: {
    "app.name": "Allen Labs",
    "hub.title": "Allen Labs App Shell",
    "hub.subtitle": "One home for all productivity surfaces.",
    "hub.appsCount": "{n} apps available",
    "hub.signedInAs": "Signed in as {name}",
    "hub.guest": "Guest",
    "hub.health": "Health",
    "hub.appList": "App list",
  },
  ko: {
    "app.name": "Allen Labs",
    "hub.title": "Allen Labs 앱 셸",
    "hub.subtitle": "모든 생산성 도구를 한 곳에서.",
    "hub.appsCount": "사용 가능한 앱 {n}개",
    "hub.signedInAs": "{name}님으로 로그인",
    "hub.guest": "게스트",
    "hub.health": "상태",
    "hub.appList": "앱 목록",
  },
};

export const hubDict: Dict = mergeDicts(commonStrings, hub);

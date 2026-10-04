# CF Observe 실제 운영

대시보드는 <https://observe.example.invalid>입니다. 조회 토큰으로 로그인한 뒤
서비스 필터에서 Worker 이름을 고르면 해당 앱의 실행 결과, console 로그와 예외를 볼 수 있습니다.
기본 조회는 수신 시각 기준 최근 1시간이며, 이벤트 상세에는 발생 시각과 수신 시각을 함께 표시합니다.

배포별 연결 대상은 비공개 설정에서 관리합니다.
배포 후 확인할 항목은 [운영 검증 안내](OPERATIONAL_VERIFICATION.md)에 있습니다.

## 로컬 개발

```powershell
cd C:\path\to\cf-worker-apps
npm ci --workspace @cf-worker-apps/cf-observe
npm run -w @cf-worker-apps/cf-observe init:secrets
npm run dev:observe
```

기본 Node.js 최소 버전은22.13입니다. `init:secrets`는 앱의
`workers/web/.dev.vars`를 기존 파일을 덮어쓰지 않고 만듭니다. 로컬 화면에는 이 파일의
VIEWER_TOKEN을 사용합니다. 운영 토큰은 로컬 개발 토큰과 별개입니다.

## Cloudflare Workers 연결

```text
배포된 앱 Worker
 → cf-observe-tail (요청 종료 후 로그·실행 결과)
 → Service Binding OBSERVE
 → cf-observe (소스 인증·필터링·영속 수락)
 → WebSocket + SQLite pending
 → 10초 또는 용량 임계치마다 private R2
```

1. 수신 Worker는 `npm run -w @cf-worker-apps/cf-observe deploy`로 배포합니다.
2. 수신기 `SOURCE_TOKENS` secret에 `workers-tail` 전용 자격증명을 등록합니다.
3. `npm run -w @cf-worker-apps/cf-observe deploy:tail`로 Tail Worker를 배포하고
   그 Worker의 `INGEST_TOKEN` secret에 같은 소스 자격증명을 설정합니다.
4. Cloudflare API 자격증명을 셸의 `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`에 설정하고 연결 계획을 확인합니다.

```powershell
npm run -w @cf-worker-apps/cf-observe tail:connect -- --all-repo
npm run -w @cf-worker-apps/cf-observe tail:connect -- --workers=hub-web,inbox-api --apply
```

`--all-repo --apply`는 저장소의 tracked Wrangler 설정과 실제 계정의 배포 목록이
일치하는 모든 producer를 연결합니다. 기본 동작은 읽기 전용 계획입니다. 기존 Tail
consumer는 보존하며 CF Observe와 수집기 자신은 제외합니다. 성공한 연결과 변경 전
목록은 Git에서 제외된 저장소 루트 `.cf-observe/tail-*.json`에 기록합니다.
일반 앱 배포 뒤에도 연결을 유지하도록 producer의 **최상위** Wrangler 설정에 다음을 둡니다.

```toml
tail_consumers = [{ service = "cf-observe-tail" }]
```

Tail은 producer 호출이 끝나야 전달됩니다. 긴 작업의 진행 상황은
[공통 publisher](../collectors/README.md)를 직접 호출하세요. Native OTel export는
별도 지연 경로이며 지금 자동으로 추가하지 않습니다. 같은 로그에 여러 exporter를
무작정 켜면 중복 보관될 수 있습니다.

## 소스별 자격증명과 상태

`SOURCE_TOKENS`는 Workers Secret에 저장하는 JSON 문자열입니다. 공개 설정 파일에
실제 값을 넣지 마세요. 형식은 다음과 같습니다.

```json
{
  "workers-tail": { "token": "<새로 생성한 32자 이상 난수>", "enabled": true }
}
```

source ID는 안정적으로 유지하고 token만 교체합니다. `enabled:false`면 해당 소스의
새 수집을 차단합니다. 기존 `INGEST_TOKEN`은 `legacy` 소스로 동작합니다. 각 자격증명은
다른 소스·조회 토큰과 달라야 합니다. 최대64개 source와 legacy를 지원합니다.

소스 상태 표는 실제 수락 이후부터 누적한 이벤트·배치·바이트와 마지막 수신 시각을
표시합니다. `workers-tail`은 수집기 하나이며, 앱별 구분은 서비스 필터를 사용합니다.
조용한 Cron이나 방문이 없는 앱을 단순히 장애로 판정하지 않습니다. 인증 실패 등
모든 edge 요청을 집계하는 계정 사용량 화면은 아닙니다.

## 보관과 장애 확인

수집 성공은 DO 임시 영속 버퍼에 수락됐다는 뜻입니다. R2 원본과 시간별 인덱스가 모두
기록된 뒤에만 pending을 정리합니다. 포화는503으로 반환하고, R2 오류가 발생하면
적체와 다음 재시도 시각을 화면에서 확인할 수 있습니다. 24시간 이내 같은 source의
같은 Idempotency-Key와 필터링된 payload는 중복 수락하지 않습니다. 일반 OTLP
SDK가 안정적인 키를 보내지 않으면 재전송 중복이 생길 수 있습니다.

자동 삭제·compaction은 켜지지 않았습니다. R2 segment만 lifecycle로 삭제하면
인덱스가 깨질 수 있으므로 피하세요. 조회하는 시각의 기준은 이벤트 발생 시각이 아닌
**서버 수신 시각**입니다. 보관 점검은 아래처럼 특정 UTC 시간에 대해 실행합니다.

```powershell
$env:OBSERVE_URL = 'https://observe.example.invalid'
$env:OBSERVE_SECRETS_FILE = 'C:\path\to\cf-worker-apps\.cf-observe\production-secrets.json'
npm run -w @cf-worker-apps/cf-observe archive:check -- 2026-09-08T05:00:00Z
```

기본값은 직전 UTC 시간대입니다. 한 번에 인덱스 하나와 최대1,000개 파일 이름만
확인하고 원본을 해제·삭제·복구하지 않습니다. `incomplete`는 목록 한도 초과,
`warning`은 확인할 차이를 뜻합니다. 진행 중 flush가 만드는 임시 차이도 있으므로
이 결과만으로 고아 파일을 삭제하지 마세요. 새 DO namespace를 기존 데이터셋에
연결하거나 DATASET을 재사용해 seq를 초기화하지 마세요.

## 수집 범위와 비용

Tail은 요청 metadata의 허용된 부분과 필터링한 로그·예외만 전송합니다. 원본 headers,
body, CF 객체는 보내지 않습니다. 메시지 길이·로그 개수·전송량 한도와 Tail의 best-effort
전달 한계는 [수집기 계약](../collectors/README.md)에 명시되어 있습니다. 필터는 일반
개인정보 탐지기가 아니며 오래된 보관 자료를 소급 변경하지 않습니다. 새 protobuf는
필터링한 decoded payload만 저장하고 원본 wire는 생략합니다.

Workers/DO/R2 사용료가 발생할 수 있습니다. 현재 화면의 바이트·배치 값은 과금액이
아닙니다. 자동 예산 상한·영구 장애 알림·전체 기간 집계는 구현되지 않았습니다.
보존기간과 예산을 정한 뒤 자동 삭제나 대규모 수집을 확대하세요.

개인 서버는 이번 실행 범위에서 제외했습니다. 기존 OTLP 예시는 제공되지만 영속 큐와
파일 checkpoint를 갖춘 서버 Collector 설치·검증은 별도 작업입니다.

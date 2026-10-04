# CF Observe

**서버를 직접 운영하지 않고, 방금 발생한 작업과 R2에 보관한 telemetry를 함께 확인하는 Cloudflare-native 프로젝트.**

수신·대시보드 Worker, SQLite-backed Durable Object, 비공개 R2 버킷으로 구성하고, 기존 Workers의 로그를 받는 Tail Worker를 함께 배포합니다. 대시보드는 수신 Worker의 Static Assets로 제공합니다. JavaScript ESM이며 런타임 외부 패키지는 없습니다. 개발·배포에 Wrangler를 사용합니다.

> CF Observe collects Cloudflare Workers logs with per-source credentials, filtering before storage, collection health, and archive inspection. See the [operations guide](docs/OPERATIONS.md), [collector guide](collectors/README.md), and [verification checklist](docs/OPERATIONAL_VERIFICATION.md).

## 핵심 동작

```text
애플리케이션 / OpenTelemetry SDK
              │ OTLP/HTTP JSON·Protobuf 또는 일반 JSON
              ▼
     인증된 Ingest Worker
              │
              ▼
   Durable Object · 임시 영속 버퍼
       │                    │
       │ 저장 확인 후        │ 기본 10초 배치
       ▼                    ▼
   WebSocket push      R2 gzip NDJSON + 시간별 인덱스
       │                    │
       └─────────┬──────────┘
                 ▼
      Worker API + 웹 대시보드
       실시간 / 이력 / 원본 검사
```

**화면에 표시되는 시점과 R2에 묶어 쓰는 시점을 분리합니다.** 수집 서버가 받은 이벤트는 DO의 영속 버퍼에 저장한 뒤 Live 연결로 전달합니다. 목록은 200ms, 무거운 그래프는 1초 간격으로 갱신을 합칩니다. R2 쓰기를 10초 기다리는 동안에도 새로고침·조회할 수 있습니다. R2 쓰기 간격을 `1000ms`로 바꾸는 것도 가능합니다.

**약 1초는 수신 후 표시 목표이지 SLA가 아닙니다.** SDK/Collector가 5~60초 동안 모아서 보내면 서버에서 줄일 수 없습니다. 네트워크, 큰 export, 런타임 지연, 재연결도 영향을 줍니다. 실행 중인 span은 완료 전 export되지 않을 수 있으므로 작업 진행은 로그 이벤트로 보내세요. [연동 설정](docs/INTEGRATIONS.md)

## 포함된 기능

| 영역 | 구현 |
|---|---|
| 수집 | OTLP/HTTP JSON·Protobuf: logs, traces, metrics; gzip; 일반 JSON/NDJSON |
| 실시간 | WebSocket push, 200ms 목록·1초 그래프 갱신, 재연결 시 이력 재조회 |
| 원본 | 자격증명 필터를 통과한 decoded JSON 보관; 검사할 수 없는 Protobuf wire는 저장하지 않음 |
| 탐색 | 시간·서비스·종류·Trace ID·원본 속성/본문 검색, 페이지네이션 |
| 상세 | 원본 record 및 resource/scope, 전체 export 요청, JSON 내려받기 |
| 시각화 | 로딩한 이벤트 분포, gauge/sum 원시값 포인트, 선택 trace의 span waterfall |
| 보관 | R2 압축 segment + 시간별 manifest; 임시 버퍼는 R2 기록 후 제거 |
| 장애 | 재시도 가능한 outbox, 안정적인 파일 키, 쓰기 실패 시 버퍼 보존, 포화 시 503 |
| 접근 | 수집/조회 토큰 분리, HttpOnly 세션, Origin 검사, 요청·조회 작업량 제한 |
| 도구 | 단위/통합 테스트, 로컬 데모, 배포 후 smoke, 범위 export, R2 비용 계산기 |

수신기는 필터링과 검증을 통과한 배치를 원자적으로 수락합니다. 자격증명 필터는 일반 개인정보 탐지기가 아니므로 애플리케이션에서도 수집 범위를 정해야 합니다. Tail 수집기는 메모리·전송량을 제한하며 초과 로그 수와 잘린 내용을 명시합니다. 잘못된 입력·과대 배치는 거부하고, 상류 SDK 또는 Tail에서 유실된 데이터를 복원하지는 못합니다. 자동 삭제와 compaction은 비활성 상태입니다.

## 저장소 구성

`apps/cf-observe/`는 `@cf-worker-apps/cf-observe` npm workspace입니다. 의존성은 저장소 루트의 `package-lock.json`으로 고정합니다. 루트에서 `npm ci` 후 `npm run test:observe`, `npm run demo:observe`, `npm run dev:observe`를 사용할 수 있습니다. 기존 정적 대시보드에는 Vite/SSR 빌드가 필요하지 않습니다.

```text
apps/cf-observe/
  src/                  Worker, 수집기, journal, R2 조회
  public/               대시보드
  tests/                Vitest Node + SQLite 테스트 어댑터, workers/ 런타임 검사
  scripts/              demo / smoke / export / cost
  examples/             SDK·Worker·Collector 연동 예시
  docs/                 운영 계약, 비용, 보안, API, 검증
  workers/web/          wrangler.toml, .dev.vars.example
  vitest.config.ts
  package.json
```

원본 패키지의 인수인계 기록은 [REPO_HANDOFF.md](docs/REPO_HANDOFF.md)에 있습니다. 현재 저장소 작업에는 루트 `CLAUDE.md`의 main 직접 반영 규칙을 따릅니다.

## 바로 확인하기: 클라우드 계정 없이

Node.js 22.13 이상이 필요합니다. Node 22에서는 `node:sqlite` 실험적 경고가 표시될 수 있습니다.

```bash
npm ci                  # 저장소 루트에서 실행
cd apps/cf-observe
npm test
npm run check
npm run demo
```

브라우저에서 `http://127.0.0.1:8788`을 열고 다음 **데모 전용** 조회 토큰을 입력합니다.

```text
local-only-demo-viewer-token-0000000000000000
```

데모는 합성 데이터이며 R2/DO 플랫폼 바인딩을 로컬에서 흉내 냅니다. 종료하면 데이터가 사라집니다. 실제 Cloudflare 동작·지연을 검증하는 방법은 아닙니다. 이 서버를 외부에 공개하거나 운영에 사용하지 마세요.

## 실제 배포

Workers Paid와 R2 사용 설정을 전제로 합니다. 프로젝트 디렉터리에서 실행합니다.

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create cf-observe-archive
npm run dry-run
npm run deploy
npm run secret:ingest
npm run secret:viewer
```

`workers/web/wrangler.toml`의 Worker 이름과 버킷 이름을 원하는 이름으로 변경할 수 있습니다. 두 secret에는 각각 **다른 32바이트 이상의 임의 값**을 넣으세요. 첫 deploy 후 secret이 설정되기 전까지 수집/조회 API는 닫힌 상태로 응답합니다. Cloudflare 인증과 계정 선택은 본인 환경에서 확인해야 합니다. 저장소 루트의 lockfile을 사용하세요.

Secret 생성 예시: 다음 명령을 두 번 실행하고, 결과를 각각 `wrangler secret put` 프롬프트에 입력합니다. **출력 값을 공개 저장소나 이슈에 붙이지 마세요.**

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

로컬 Wrangler 개발은 `npm run init:secrets`로 무시되는 `workers/web/.dev.vars`를 만든 뒤 `npm run dev`를 사용합니다. `.dev.vars`는 운영 secret을 자동 설정하지 않습니다. R2 버킷의 public access와 `r2.dev` 공개 주소는 켜지 마세요.

배포 후 URL과 secret을 환경변수로 지정하고 `npm run smoke`를 실행하면 합성 이벤트 **한 건을 실제 저장**하여 즉시 조회, 중복 요청, R2 전환을 검사합니다. 자세한 순서는 [DEPLOYMENT.md](docs/DEPLOYMENT.md)에 있습니다.

## 비용 기본값

```json
{
  "R2_FLUSH_MS": "10000",
  "MAX_PENDING_BYTES": "16777216",
  "MAX_QUERY_SEGMENTS": "12"
}
```

평소에는 `R2_FLUSH_MS=10000`을 유지하세요. **Live는 그대로 빠르고**, R2 작은 파일·쓰기 요청 수는 줄어듭니다. 쓰기 간격은 보장된 상한이 아닙니다. 장애 때는 지연되며, 버퍼를 여러 번 비워야 하는 부하에서는 추가 flush가 생깁니다.

기본 이력 조회는 R2 SQL을 부르지 않습니다. 시간별 인덱스를 `GET`하고, 해당 서비스/종류/시간 후보 파일만 읽습니다. `LIST` 폴링이나 주기적 전체 데이터 재검색을 하지 않습니다. SQL scan 과금은 없지만 **R2 요청·저장과 Worker/DO 사용료는 발생**합니다.

```bash
npm run cost -- --flushSeconds=10 --averageGB=100
npm run cost -- --flushSeconds=1 --averageGB=100
```

R2 무료 허용량은 계정 전체에서 공유하며 비용 계산기는 R2만 추산합니다. [계산 근거와 한계](docs/COST.md)

## 데이터 보존과 한계

**영구 원본은 R2, R2 저장 전 원본은 DO의 임시 영속 저장소에 있습니다.** RAM에만 보관하고 성공 응답을 주지 않습니다. 수집 성공은 임시 영속 수락을 의미하며, R2 저장 완료 여부는 health/API와 화면의 `buffer`/`R2`로 구분합니다.

이 버전은 작은 내부 시스템의 최근 작업·원본 조사에 초점을 둔 탐색기입니다. **ClickStack/Prometheus의 완전한 대체품, 임의 SQL/PromQL 엔진, 인덱스 기반 전문 검색, 알림 엔진은 아닙니다.** 장기간의 방대한 데이터를 여러 번 읽으면 느려지고 Worker 비용도 증가합니다.

UI의 숫자·분포·메트릭은 **현재 로딩한 결과**입니다. 전체 기간의 정확한 집계나 p95로 가장하지 않습니다. 목록은 기본 200건씩, 최대 한 페이지 500건이고 화면은 10,000건을 보관합니다. 이후에는 범위를 나누거나 `scripts/export.mjs`를 사용하세요. 원본의 보관량을 10,000건으로 제한하는 것은 아닙니다.

하나의 dataset에는 하나의 writer DO가 사용됩니다. 이 설계의 최대 처리량은 실측하지 않았습니다. `/api/health`의 backlog, Worker/DO 사용량과 오류를 확인하고, 지속적으로 backlog가 증가한다면 유입 배치를 조정하거나 별도 shard 설계를 해야 합니다. 단순히 DO만 여러 개 만들어 같은 인덱스를 쓰게 하면 안 됩니다.

**Iceberg, Pipelines, R2 SQL 연결은 구현되어 있지 않습니다.** 현재 `.ndjson.gz` 파일은 그 자체로 R2 SQL에서 조회할 수 없습니다. 대규모 분석이 필요해질 때 추가하는 설계는 [R2_SQL_EXTENSION.md](docs/R2_SQL_EXTENSION.md)에 분리해 두었습니다.

## 문서

[배포](docs/DEPLOYMENT.md) · [연동](docs/INTEGRATIONS.md) · [API](docs/API.md) · [신뢰성](docs/RELIABILITY.md) · [비용](docs/COST.md) · [보안](docs/SECURITY.md) · [검증](docs/VERIFICATION.md)

MIT License. OTLP field mappings의 Apache-2.0 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.

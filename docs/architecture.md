# 아키텍처 설계 (그린필드)

기존 Slack 전용 구현에 얽매이지 않고, **멀티테넌트 · 멀티채널 · 플러그인 확장형 AI 에이전트**를
처음부터 설계한 청사진. [OpenClaw](https://docs.openclaw.ai/) ·
[Hermes Agent](https://github.com/nousresearch/hermes-agent)의 "게이트웨이 + 채널 어댑터 +
정규화 스키마" 패턴을 토대로, serverless(Amplify SSR)와 long-running worker 양쪽을 수용하도록 확장한다.

> 이 문서는 **목표 설계**(어떻게)다. 구현해야 할 목표 항목은 [`docs/roadmap.md`](./roadmap.md)를 본다.
> 현재 구현은 이 설계를 향한 **골격**(인터페이스 + 스텁)이며, 진행 상태는 roadmap을 본다.

## 1. 목표

- **채널 무관 코어** — 입력을 어디서 받든(Slack, Web, HTTP API, Telegram, …) 같은 에이전트 코어가 처리한다.
- **플러그인 확장** — 채널·도구·LLM provider·저장소를 정해진 인터페이스를 구현하는 파일 추가만으로 확장한다. 코어 수정 없음.
- **멀티테넌시** — 하나의 배포가 다수 테넌트(워크스페이스/봇/API 키)를 격리해 서빙한다.
- **이식 가능한 실행 모델** — webhook(serverless) 채널과 상시 연결(long-running) 채널을 같은 코어로 굴린다.

## 2. 설계 원칙

1. **코어는 transport를 모른다** — 코어는 정규화된 `InboundMessage`만 받고 `OutboundChunk`만 내보낸다. 채널 native 타입은 어댑터 경계를 넘지 않는다.
2. **어댑터는 thin translation layer** — native API ↔ 공통 내부 표현 변환만 한다. 비즈니스 로직 없음.
3. **횡단 관심사는 코어에 집중** — dedup · ACL · throttle · 라우팅 · 회계는 채널마다 재구현하지 않는다.
4. **능력 기반 도구(capability-based tools)** — 도구는 채널이 제공하는 능력(`Capabilities`)에만 의존하고, 채널을 직접 알지 않는다.
5. **deny-by-default 보안** — allowlist 미설정 시 거부. 시크릿은 채널/테넌트별로 격리.
6. **모든 외부 경계는 명시적 계약(인터페이스)** — 채널·도구·LLM·저장소·자격증명 모두 인터페이스 뒤에 둔다.

## 3. 고수준 구조

```
┌─────────────────────────── Ingress (channel adapters) ───────────────────────────┐
│  Slack(webhook/socket)   Web UI(SSE)   HTTP API(token)   Telegram(webhook)   ...   │
│        │  native 페이로드을 정규화 + 검증 + 테넌트/신원 해석                          │
└────────┼──────────────────────────────────────────────────────────────────────────┘
         ▼  InboundMessage (정규화 envelope)
┌─────────────────────────── Gateway / Core pipeline ────────────────────────────────┐
│  resolve tenant → dedup → ACL → throttle → load context → run agent → persist       │
└────────┼────────────────────────────────────────────────────────────────────────────┘
         ▼  ConversationRequest
┌─────────────────────────── Agent runtime ──────────────────────────────────────────┐
│  LLM(provider plugin) · tool loop(capability-bound tools) · step/usage accounting    │
└────────┼────────────────────────────────────────────────────────────────────────────┘
         ▼  OutboundChunk 스트림
┌─────────────────────────── Egress (Responder per channel) ─────────────────────────┐
│  채널 native 렌더링(청킹·포맷·미디어 업로드) → 사용자에게 회신                        │
└─────────────────────────────────────────────────────────────────────────────────────┘
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ Storage      │  │ Memory       │  │ Credentials  │  │ Observability│
   │ (KV+doc)     │  │ (3-tier)     │  │ (per channel)│  │ (logs/trace) │
   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

## 4. 핵심 도메인 모델 (정규화 스키마)

채널 무관 envelope. 어댑터가 이 형태로 변환한 뒤에야 코어로 들어온다.

```ts
interface InboundMessage {
  channel: string;          // "slack" | "web" | "api" | "telegram" | ...
  tenantId: string;         // 채널 내 테넌트 식별 (워크스페이스/봇/키)
  conversationId: string;   // 스레드/채팅/세션 — 메모리·dedup 스코프
  userId: string;           // 채널 내 사용자 식별
  text: string;             // 봇 멘션 제거 등 정규화된 본문
  attachments: Attachment[];// 이미지/문서 등 (url + mime + 다운로드 핸들)
  mentions: string[];       // 본문에서 추출한 사용자 멘션
  surface: "dm" | "channel" | "thread" | "direct"; // ACL 판단용
  dedupKey: string;         // 채널이 제공하는 멱등 키
  receivedAt: number;
  raw: unknown;             // 디버그용 원본 (코어 로직은 쓰지 않음)
}

interface OutboundChunk {
  text: string;             // mrkdwn/markdown 중립 표현 (어댑터가 방언 변환)
  kind: "delta" | "final";
  media?: MediaRef[];        // 생성/첨부 이미지 등
}
```

`Tenant`·`Identity`는 채널별 의미를 코어로 흘리지 않도록 `tenantId`/`userId` 문자열로만 추상화한다.

## 5. 컴포넌트

### 5.1 채널 레이어 (Channel adapter + plugin protocol)

각 채널은 `ChannelAdapter` 계약을 구현한다. 4가지 책임: 검증 · inbound 정규화 · 접근제어 입력 제공 · outbound 렌더링.

```ts
interface ChannelAdapter {
  readonly id: string;
  // 실행 모델: webhook(요청-응답) | connection(상시 연결) | http(동기 API)
  readonly mode: "webhook" | "connection" | "http";

  // inbound: native 요청을 검증하고 0개 이상의 정규화 메시지로 변환
  ingest(input: RawIngress): Promise<IngestResult>;

  // 이 채널/테넌트의 자격증명 provider
  credentials(tenantId: string): CredentialRef;

  // 회신 채널 — 코어가 OutboundChunk를 흘려보내면 native로 렌더링
  responder(msg: InboundMessage): Responder;

  // 도구가 의존하는 채널 능력 (없으면 해당 도구 미등록)
  capabilities(msg: InboundMessage): Capabilities;
}

interface Responder {
  append(chunk: OutboundChunk): Promise<void>; // 스트리밍 (지원 안 하면 버퍼링)
  finalize(text: string, media?: MediaRef[]): Promise<void>;
  status?(text: string): Promise<void>;        // "생각 중…" 등 (optional)
}
```

**플러그인 등록·discovery**:

- 채널은 `defineChannel({...})`로 어댑터를 정의하고 레지스트리에 등록한다.
- 로딩 우선순위: `src/channels/<name>/`(번들) → `channels/`(로컬 확장) → 외부 패키지(`package.json`의 `agent.channels` 필드, 후순위).
- 코어는 레지스트리만 알고 구체 채널을 직접 import하지 않는다.

**실행 모델 차이 (중요)**:

| mode | 예시 | 토폴로지 | 배포 |
|---|---|---|---|
| `webhook` | Slack(events), Telegram | public URL 필요, 요청당 처리 | serverless(Amplify SSR + `after()`) |
| `http` | 토큰 기반 동기 API | public URL, 즉시 응답 | serverless |
| `connection` | Slack Socket Mode, polling | 상시 연결 필요 | long-running worker |

코어는 동일하지만 ingress 진입점이 다르다 — webhook/http는 Next route handler, connection은 별도 worker 프로세스가 같은 코어를 호출한다.

### 5.2 게이트웨이 / 코어 파이프라인

채널 무관. `InboundMessage` 하나를 받아 처리한다.

```ts
async function runConversation(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
  // 1. tenant 해석 + 설정 로드
  // 2. dedup: reserve(channel:tenant:dedupKey) — 이미 처리/진행 중이면 종료
  // 3. ACL: surface(dm/channel) + user allowlist (테넌트 override > 전역)
  // 4. throttle: 사용자별 동시 요청
  // 5. context: 대화 히스토리 + 메모리 로드
  // 6. agent: LLM + capability-bound 도구 루프
  // 7. egress: adapter.responder()로 스트리밍 회신
  // 8. persist: 히스토리 저장 + markDone
}
```

dedup/throttle/conversation 키는 모두 `{channel}:{tenantId}:…`로 스코프되어 채널 간 충돌이 없다.

### 5.3 에이전트 런타임

- LLM은 `LlmProvider` 플러그인 — `getModel({provider, model})` (openai/bedrock/… 확장).
- 멀티스텝 도구 루프(`stepCountIs(maxSteps)`), 토큰/스텝/툴콜 회계, tool-call로 끝나면 forced-compose.
- 시스템 프롬프트는 계층 조립: 기본 task rules + 채널 렌더링 규칙(어댑터가 제공) + 운영 정책 + 테넌트 persona + 언어 지시.
  - 채널 렌더링 규칙을 어댑터가 주입 → Slack은 mrkdwn, Web은 GitHub markdown, API는 plain 등 채널별로 자동 달라짐.

### 5.4 도구 시스템 (capability-bound)

도구를 두 부류로 나눈다.

- **채널 무관 도구** — `get_current_time`, `search_web`, `search_images`, `fetch_webpage`. 어디서나 동일.
- **능력 의존 도구** — 첨부 읽기, 스레드 히스토리, 프로필 조회, 이미지 업로드. `Capabilities` 인터페이스에 의존.

```ts
interface Capabilities {
  fetchHistory?(limit: number): Promise<HistoryEntry[]>;
  downloadAttachment?(ref: AttachmentRef): Promise<Blob>;
  uploadMedia?(media: MediaRef): Promise<{ url: string }>;
  fetchUserProfile?(userId: string): Promise<Profile>;
}
```

레지스트리는 `capabilities`에 실제 구현이 있는 도구만 에이전트에 노출한다. 예: HTTP API 채널은 `uploadMedia`가 없으면 `generate_image`를 등록하지 않거나, URL만 반환하는 변형으로 등록.

### 5.5 메모리 (3계층)

- **단기(대화)** — `conversationId` 스코프, newest-first 절단, TTL. 매 턴 컨텍스트.
- **장기(유저)** — `mem:{channel}:{tenantId}:{userId}` 스코프 영속 메모리. `remember` / `forget` 도구로 갱신.
- **검색(선택)** — 임베딩 기반 episodic 검색. 채널 전환 시 관련 컨텍스트 복원(Hermes 패턴). 초기엔 미구현, 인터페이스만 예약.

`MemoryStore` 인터페이스 뒤에 두어 KV/DynamoDB/vector 백엔드를 교체 가능.

### 5.6 멀티테넌시 · 자격증명

- `Tenant` = (channel, 워크스페이스/봇/API 키). 메타데이터(ACL override, persona, 신원)는 document store.
- `CredentialProvider` per channel — Slack=서명 시크릿+bot token(SSM), Telegram=bot token, API=발급 토큰 해시. 시크릿은 코드/DB가 아닌 시크릿 매니저(SSM 등)에 격리.
- 캐시 + 네거티브 캐시, 회전 시 즉시 무효화.

### 5.7 저장소 추상화

```ts
interface StorageProvider {
  kv: KvStore;        // dedup, throttle, 캐시 (TTL 지원)
  doc: DocStore;      // 테넌트 메타, 대화 히스토리, 유저 메모리
}
```

기본 구현은 DynamoDB 단일 테이블(PK/SK + GSI + TTL) + Redis/Valkey(KV). 인터페이스 덕분에 테스트는 in-memory, 다른 배포는 다른 백엔드 가능.

### 5.8 관측성

- 구조적 JSON 로깅, 요청 스코프 필드(`requestId`, `channel`, `tenantId`, `conversationId`) 바인딩.
- 표준 lifecycle 로그키(`agent.start`/`agent.done`, `dedup.*`, `acl.*`)는 채널 무관.
- `instrumentation` 훅으로 Sentry/OTel/PostHog 연결.

## 6. 플러그인 프로토콜 요약

확장 대상과 계약:

| 확장 | 인터페이스 | 등록 |
|---|---|---|
| 채널 | `ChannelAdapter` | `defineChannel()` → 레지스트리 / discovery |
| 도구 | `ToolDefinition`(+ 선택적 `requires: Capability[]`) | `defineTool()` → tool 레지스트리 |
| LLM provider | `LlmProvider` | `defineProvider()` |
| 저장소 | `StorageProvider` | 배포 설정으로 선택 |
| 메모리 | `MemoryStore` | 배포 설정으로 선택 |

원칙: **새 채널/도구를 추가할 때 코어 코드를 수정하지 않는다.** 파일 추가 + 레지스트리 등록뿐.

## 7. 보안

- 채널 검증: webhook 서명(Slack HMAC), API 토큰 검증, replay guard.
- deny-by-default allowlist(채널×테넌트), operator 권한 분리.
- 시크릿 격리(시크릿 매니저), 로그/에러 redaction.
- 도구 fetch는 SSRF 가드 + redirect 거부 + 바이트 cap. 토큰은 신뢰 호스트에만 전송.

## 8. 점진적 구축 순서 (그린필드라도 단계적으로)

1. 도메인 모델 + 코어 파이프라인(`runConversation`) — 인메모리 저장소 + 더미 채널로 테스트. 검증: 채널 없이 코어 단위 테스트 통과.
2. `StorageProvider`(DynamoDB) + dedup/throttle/conversation/memory 구현. 검증: 통합 테스트.
3. 첫 채널 어댑터 = Slack(webhook). 검증: 멘션→스트리밍 회신 E2E.
4. 두 번째 채널 = Web UI(SSE) 또는 HTTP API(token). 검증: 첨부·스트리밍 없는 최소 채널이 코어를 그대로 통과 → 인터페이스 일반성 입증.
5. connection 모드 채널 = Telegram 또는 Slack Socket Mode(long-running worker). 검증: worker가 같은 코어 호출.
6. 도구 capability 분리 + 유저 장기 메모리 + (선택) 검색 메모리.
7. 외부 npm 플러그인 discovery는 내부 어댑터 2개 이상 안정화 후.

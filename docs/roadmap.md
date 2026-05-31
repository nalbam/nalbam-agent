# 로드맵 — 구현 목표

## 최종 목표

**멀티테넌트 · 멀티채널 · 플러그인 확장형 AI 에이전트.**

하나의 배포가 다수 테넌트를 격리해 서빙하고, 입력·회신·도구·LLM·저장소를 플러그인으로
교체·추가하며, 채널 무관 코어가 모든 채널을 동일하게 처리한다.

이 문서는 그 목표를 위해 **구현해야 할 것**을 영역별로 명세한다. 설계(어떻게)는
[`docs/architecture.md`](./architecture.md)를 본다.

상태 범례: 🔴 우선 검증 · 🟡 핵심 기능 · 🟠 하드닝 · 🟢 후속 · ⚪ 부가

진행 표기:

- `[x]` 구현되어 있고 테스트/타입체크 기준으로 현재 골격에 반영됨.
- `[~]` 인터페이스 또는 스텁은 있으나 운영 동작이 없음.
- `[ ]` 아직 없음.

## 현재 구현 스냅샷

- `[x]` 정규화 타입, `ChannelAdapter`, `Responder`, `Capabilities`, 채널/도구/provider 레지스트리.
- `[x]` 채널 무관 `runConversation` 파이프라인 골격과 순서 테스트.
- `[x]` OpenAI/Bedrock provider registry, OpenAI-compatible provider(`xai`/`gemini`/`claude`) 및 `getModel` 래퍼.
- `[x]` Better Auth 기반 operator 인증 골격, S3 blob store, DynamoDB 공통 helper, DynamoDB KV 기반 secondary storage.
- `[~]` Slack adapter는 Events API `ingest`(서명 검증 + 정규화), SSM bot token 기반 responder,
  `fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile` capabilities까지 구현됨.
- `[~]` Agent runtime은 AI SDK `streamText`로 응답 생성·delta streaming·step/token accounting까지 구현됨.
  forced-compose, usage persistence, 고급 tool loop hardening은 남아 있다.
- `[~]` `buildPipelineDeps()`는 DynamoDB KV-backed dedup/throttle, deny-by-default ACL, in-memory memory store,
  `AGENT_TENANTS_JSON` 기반 정적 tenant resolver와 `StorageProvider(kv+doc+blob)` factory를 연결한다.
  대화/유저 메모리의 DynamoDB `doc` backend 연결과 운영용 tenant metadata 관리는 남아 있다.
- `[~]` 토큰 기반 HTTP API 채널은 SHA-256 bearer token hash 검증, JSON 정규화, 동기 route 응답까지 구현됨.
- `[ ]` Web UI/Telegram 채널, 일반화된 channel credential provider, 검색 메모리, 웹/문서/이미지/execute/read/edit/agent/todo 도구.

## MVP 수용 기준

첫 운영 가능 버전은 다음 조건을 모두 만족한다.

1. Slack webhook 요청을 원본 바이트 기준으로 검증하고, tenant/user/conversation/surface/dedupKey를 정규화한다.
2. `runConversation`이 KV-backed dedup/throttle, tenant resolver, deny-by-default ACL, memory store를 사용한다.
3. Agent runtime이 실제 LLM provider로 응답을 생성하고, Slack responder가 채널 포맷으로 최종 회신한다.
4. HTTP API 채널을 두 번째 채널로 추가할 때 `src/core` 수정 없이 통과한다.
5. 테넌트 시크릿은 SSM SecureString 등 시크릿 매니저에서 읽고 로그/DB/env에 저장하지 않는다.
6. `pnpm lint`, `pnpm typecheck`, `pnpm test`와 핵심 ingest/responder 단위 테스트가 통과한다.

---

## 1. 채널 레이어 (입력 · 회신)

- [x] 🟡 `InboundMessage` / `OutboundChunk` 정규화 스키마 — 채널 native 타입이 코어 경계를 넘지 않는다.
- [x] 🟡 `ChannelAdapter` 인터페이스 — 검증 · inbound 정규화 · 접근제어 입력 · outbound 렌더링.
- [x] 🟡 `Responder` 인터페이스 — 채널 native 스트리밍/최종 렌더링(청킹 · 포맷 방언 · 미디어 업로드).
- [x] 🟡 webhook · connection · http 세 가지 실행 모델의 타입/route/worker 진입점 골격.
- [~] 🟡 Slack 어댑터 (webhook, Socket Mode).
  - [x] Slack Events API `url_verification`, app mention/message event 정규화.
  - [x] signing secret HMAC 검증 + timestamp replay guard.
  - [x] `chat.postMessage`/`chat.update` 기반 responder와 메시지 길이 청킹.
  - [x] `fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile` capabilities.
  - [ ] Socket Mode 또는 별도 connection-mode adapter/worker.
- [ ] 🟡 Web UI 어댑터 (SSE 스트리밍).
- [~] 🟡 토큰 기반 HTTP API 어댑터 (동기 응답) — env token hash 기반 MVP, S3-backed `uploadMedia` capability. 운영용 토큰 발급/회전 backend 필요.
- [ ] 🟢 Telegram 어댑터 (group mention gating).
- [ ] 🟢 채널 플러그인 등록·discovery — 번들 → 로컬 → 외부 패키지.

## 2. 코어 파이프라인

- [x] 🟡 채널 무관 `runConversation(message, adapter, deps)` 골격 — dedup → tenant → ACL → throttle → context → agent → egress → persist.
- [x] 🟡 dedup · conversation 키를 `{channel}:{tenant}` 스코프로 조립.
- [x] 🟡 throttle 키를 `{channel}:{tenant}:{user}` 스코프로 조정.
- [x] 🟡 2단계 멱등성(in-flight 예약 + 완료 마커) 계약과 TTL-backed KV 구현.
- [ ] 🟡 대화 히스토리 동시 쓰기 충돌 방지(OCC).
- [~] 🟡 멘션 제거 · surface(dm/channel/thread) 판정을 어댑터 정규화 단계에서 수행. 계약은 있으나 실제 채널 구현 필요.
- [ ] 🟠 실패 정책 정리 — responder 실패, memory persist 실패, dedup markDone 실패 시 재시도/보상 동작.

## 3. 에이전트 런타임

- [x] 🟡 `LlmProvider` 플러그인 골격 — OpenAI · Bedrock · OpenAI-compatible(`xai`/`gemini`/`claude`) 및 확장.
- [x] 🟡 Agent runtime — AI SDK `streamText`, responder delta streaming, 토큰/스텝/툴콜 회계.
- [~] 🟡 멀티스텝 도구 루프 — `stepCountIs` 홉 상한은 구현. tool-call로 끝나면 forced-compose는 남음.
- [x] 🟡 채널별 렌더링 규칙을 어댑터가 시스템 프롬프트 입력으로 전달(Slack=mrkdwn, Web=markdown, API=plain).
- [~] 🟡 계층형 시스템 프롬프트 — task · channel · policy(전역) · persona(테넌트) · language.
- [ ] 🟠 usage accounting 저장 — tenant/user/conversation별 tokens, tool calls, latency.

## 4. 도구

제공 도구:

| 도구 | 분류 | 기능 |
|---|---|---|
| `get_current_time` | 채널 무관 | IANA 타임존 기준 현재 시각/요일 |
| `search_web` | 채널 무관 | 웹 검색(provider 추상화) |
| `search_images` | 채널 무관 | 이미지 검색 |
| `fetch_webpage` | 채널 무관 | URL 본문 추출(SSRF 가드) |
| `read_attached_images` | 능력 의존 | 첨부 이미지 → 멀티모달 설명 |
| `read_attached_document` | 능력 의존 | PDF/text 추출 |
| `fetch_user_profile` | 능력 의존 | 유저 프로필·이미지 |
| `fetch_thread_history` | 능력 의존 | 대화 히스토리 조회 |
| `generate_image` | 능력 의존 | 이미지 생성·업로드 |
| `attach_image_from_url` | 능력 의존 | 외부 이미지 첨부 |
| `edit_image` | 능력 의존 | 이미지 편집·업로드 |
| `save_text_artifact` | 능력 의존 | 텍스트 산출물 → 채널 uploadMedia(S3 blob) |
| `execute_task` | 채널 무관 | 샌드박스/워커 기반 명령 실행(권한·감사 필요) |
| `read_file` / `edit_file` | 채널 무관 | 워크스페이스 파일 읽기·수정(권한·범위 제한 필요) |
| `delegate_agent` | 채널 무관 | 하위 에이전트 작업 위임 |
| `todo` | 채널 무관 | 장기 작업 계획·상태 관리 |

- [x] 🟡 능력 의존 도구는 `Capabilities`(`fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile`)에만 의존하고, 채널이 능력을 제공할 때만 등록하는 레지스트리 골격.
- [x] 🟡 채널 무관 도구는 모든 채널이 공유하는 레지스트리 골격.
- [x] 🟡 `get_current_time` 기본 구현.
- [x] 🟡 `save_text_artifact` 구현 — `uploadMedia` capability를 통해 S3/memory blob store에 텍스트 산출물 저장.
- [ ] 🟡 `search_web`, `search_images`, `fetch_webpage` 구현(provider 추상화 + SSRF guard).
- [ ] 🟡 `execute_task`, `read_file`, `edit_file`, `delegate_agent`, `todo` 구현(권한·감사·샌드박스 필수).
- [ ] 🟡 첨부 이미지/문서, thread history, user profile capability-bound 도구 구현.
- [ ] 🟡 이미지 생성·편집을 OpenAI · Bedrock 양쪽에서 지원.
- [x] 🟢 도구 플러그인 등록 — `defineTool({ requires: Capability[] })`.

## 5. 메모리

- [~] 🟡 단기 대화 메모리 — in-memory conversation 스코프 + 문자 예산 절단 구현. TTL/OCC와 운영 backend 필요.
- [~] 🟡 장기 유저 메모리 — `mem:{channel}:{tenant}:{user}` 스코프 `remember`/`forget`/`loadUserMemory`의 in-memory 구현. 영속 backend와 `remember`/`forget`의 도구 노출은 남음.
- [ ] 🟢 검색 메모리 — 임베딩 기반 episodic, 채널 전환 시 관련 컨텍스트 복원.
- [x] 🟡 `MemoryStore` 인터페이스로 백엔드(KV/document/vector) 교체.

## 6. 멀티테넌시 · 자격증명

- [x] 🟡 `Tenant` = (channel, workspace/bot/key) 격리 모델.
- [~] 🟡 `CredentialProvider` per channel 계약 — 시크릿은 시크릿 매니저에 격리, 코드·DB에 두지 않음. Slack용 `ssmSlackCredentialProvider`(SSM SecureString + TTL 캐시)는 구현됨. 일반화된 per-channel 계약 구현은 남음.
- [~] 🟡 채널 무관 테넌트 메타데이터 스키마 — ACL override, persona, 신원. 현재 `AGENT_TENANTS_JSON` 정적 설정.
- [ ] 🟡 자격증명 캐시 + 회전 시 즉시 무효화.
- [ ] 🟠 operator UI에서 tenant/channel credential 상태, ACL, persona 관리.

## 7. 저장소

- [x] 🟡 `StorageProvider`(`kv` + `doc` + `blob`) 추상화 — dedup/throttle/캐시는 KV, 메타·히스토리·메모리는 doc, 첨부·도구 산출물은 blob.
- [x] 🟡 DynamoDB 단일 테이블 `kv` + `doc` store — `kv`는 conditional `setNx`·atomic `ADD`(`incr`/`decr`)·native TTL + lazy `expiresAt`, `doc`은 PK/SK + `begins_with` query. `provider.ts` factory와 Better Auth `secondaryStorage`가 연결. (대화/유저 메모리의 `doc` backend 연결은 §5.)
- [x] 🟡 S3 blob store — 첨부/생성 파일/도구 산출물 저장, presigned URL, tenant-scoped prefix, `StorageProvider.blob` wiring.
- [x] 🟢 in-memory `kv`/`doc`/`blob` 구현 — 단위 테스트 대체용. 런타임 factory는 `kv`·`doc`=DynamoDB, `blob`=`S3_BUCKET_NAME` 설정 시 S3(없으면 in-memory).

## 8. 관측성

- [~] 🟡 요청 스코프 구조 로깅 — `requestId` · `channel` · `tenant` · `conversation` 바인딩. 기본 logger/context는 있음.
- [x] 🟢 채널 무관 lifecycle 로그키 + `channel` 필드 골격.
- [~] 🟢 `instrumentation` 훅 — Sentry / OpenTelemetry / PostHog 연결 지점만 있음.

## 9. 보안 · 하드닝 · 배포

- [ ] 🟡 채널별 검증(서명/토큰) + replay guard.
- [~] 🟡 deny-by-default allowlist(채널 × 테넌트) — agent ACL 구현됨. operator 권한 분리와 설정 UI/backend 필요.
- [~] 🟡 시크릿 격리 + 로그/에러 redaction. env/auth infra는 있음, channel credential provider 필요.
- [ ] 🟡 도구 fetch SSRF 가드 + redirect 거부 + 바이트 cap.
- [~] 🟡 AWS Amplify SSR serverless(webhook/http) 배포 토폴로지 — `amplify.yml` 골격 있음. 비동기 후처리 검증 필요.
- [ ] 🟡 long-running worker(connection) 배포 토폴로지 — ECS/Fargate 또는 별도 worker 기준 정리 필요.
- [ ] 🔴 비동기 후처리(`after()` 등)가 HTTP 응답 이후 끝까지 실행됨을 배포 환경에서 검증. 실패 시 큐/워커 폴백.
- [ ] 🟠 운영 필수 설정 — operator allowlist · throttle KV · CSP enforce · 최소권한 IAM · 백업(PITR).

---

## 구현 순서

1. 정규화 스키마 + 채널 무관 코어 (1 · 2)
2. `StorageProvider` (7)
3. Slack 어댑터 (1)
4. 두 번째 채널: Web UI 또는 HTTP API (1) — 첨부·스트리밍 없는 최소 채널로 인터페이스 일반성 검증
5. 능력 · 자격증명 분리 (4 · 6)
6. 장기 메모리 + Bedrock 이미지 (4 · 5)
7. connection 채널(Telegram) · 검색 메모리 · 관측성 정렬 · 외부 플러그인 discovery

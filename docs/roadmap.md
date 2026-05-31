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
- `[x]` OpenAI/Bedrock provider registry 및 `getModel` 래퍼.
- `[x]` Better Auth 기반 operator 인증 골격, DynamoDB 공통 helper, Redis/Valkey secondary storage 옵션.
- `[~]` Slack adapter는 등록만 되어 있고 `ingest`, responder, credentials, capabilities는 스텁.
- `[~]` Agent runtime은 빈 응답 스텁. 실제 `streamText` tool loop 없음.
- `[~]` dedup/ACL/throttle/tenant/memory는 인터페이스가 있으나 `buildPipelineDeps()`는 permissive/no-op 스텁.
- `[ ]` Web UI/API/Telegram 채널, channel credential provider, DynamoDB-backed agent storage, 장기 메모리, 웹/문서/이미지 도구.

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
  - [ ] Slack Events API `url_verification`, app mention/message event 정규화.
  - [ ] signing secret HMAC 검증 + timestamp replay guard.
  - [ ] `chat.postMessage`/`chat.update` 기반 responder와 메시지 길이 청킹.
  - [ ] `fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile` capabilities.
  - [ ] Socket Mode 또는 별도 connection-mode adapter/worker.
- [ ] 🟡 Web UI 어댑터 (SSE 스트리밍).
- [ ] 🟡 토큰 기반 HTTP API 어댑터 (동기 응답).
- [ ] 🟢 Telegram 어댑터 (group mention gating).
- [ ] 🟢 채널 플러그인 등록·discovery — 번들 → 로컬 → 외부 패키지.

## 2. 코어 파이프라인

- [x] 🟡 채널 무관 `runConversation(message, adapter, deps)` 골격 — dedup → tenant → ACL → throttle → context → agent → egress → persist.
- [x] 🟡 dedup · conversation 키를 `{channel}:{tenant}` 스코프로 조립.
- [~] 🟡 throttle 키를 `{channel}:{tenant}:{user}` 스코프로 조정. 현재 인터페이스는 `userId`만 받음.
- [~] 🟡 2단계 멱등성(in-flight 예약 + 완료 마커) 계약. 실제 TTL-backed 구현 필요.
- [ ] 🟡 대화 히스토리 동시 쓰기 충돌 방지(OCC).
- [~] 🟡 멘션 제거 · surface(dm/channel/thread) 판정을 어댑터 정규화 단계에서 수행. 계약은 있으나 실제 채널 구현 필요.
- [ ] 🟠 실패 정책 정리 — responder 실패, memory persist 실패, dedup markDone 실패 시 재시도/보상 동작.

## 3. 에이전트 런타임

- [x] 🟡 `LlmProvider` 플러그인 골격 — OpenAI · Bedrock 및 확장.
- [~] 🟡 Agent runtime 인터페이스. 현재는 빈 응답 스텁.
- [ ] 🟡 멀티스텝 도구 루프 — 홉 상한, 토큰/스텝 회계, tool-call로 끝나면 forced-compose.
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

- [x] 🟡 능력 의존 도구는 `Capabilities`(`fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile`)에만 의존하고, 채널이 능력을 제공할 때만 등록하는 레지스트리 골격.
- [x] 🟡 채널 무관 도구는 모든 채널이 공유하는 레지스트리 골격.
- [x] 🟡 `get_current_time` 기본 구현.
- [ ] 🟡 `search_web`, `search_images`, `fetch_webpage` 구현(provider 추상화 + SSRF guard).
- [ ] 🟡 첨부 이미지/문서, thread history, user profile capability-bound 도구 구현.
- [ ] 🟡 이미지 생성·편집을 OpenAI · Bedrock 양쪽에서 지원.
- [x] 🟢 도구 플러그인 등록 — `defineTool({ requires: Capability[] })`.

## 5. 메모리

- [~] 🟡 단기 대화 메모리 인터페이스 — conversation 스코프, 토큰 예산 절단, TTL. 실제 구현 필요.
- [~] 🟡 장기 유저 메모리 인터페이스 — `mem:{channel}:{tenant}:{user}`, `remember` / `forget` 도구. 실제 구현 필요.
- [ ] 🟢 검색 메모리 — 임베딩 기반 episodic, 채널 전환 시 관련 컨텍스트 복원.
- [x] 🟡 `MemoryStore` 인터페이스로 백엔드(KV/document/vector) 교체.

## 6. 멀티테넌시 · 자격증명

- [x] 🟡 `Tenant` = (channel, workspace/bot/key) 격리 모델.
- [~] 🟡 `CredentialProvider` per channel 계약 — 시크릿은 시크릿 매니저에 격리, 코드·DB에 두지 않음. 실제 provider 필요.
- [~] 🟡 채널 무관 테넌트 메타데이터 스키마 — ACL override, persona, 신원.
- [ ] 🟡 자격증명 캐시 + 회전 시 즉시 무효화.
- [ ] 🟠 operator UI에서 tenant/channel credential 상태, ACL, persona 관리.

## 7. 저장소

- [x] 🟡 `StorageProvider`(`kv` + `doc`) 추상화 — dedup/throttle/캐시는 KV, 메타·히스토리·메모리는 doc.
- [~] 🟡 DynamoDB(doc) + Redis/Valkey(kv) 구현. 공통 DynamoDB helper와 Better Auth adapter는 있음, agent storage wiring 필요.
- [x] 🟢 in-memory KV 구현(테스트·로컬). in-memory doc/memory 구현은 별도 필요.

## 8. 관측성

- [~] 🟡 요청 스코프 구조 로깅 — `requestId` · `channel` · `tenant` · `conversation` 바인딩. 기본 logger/context는 있음.
- [x] 🟢 채널 무관 lifecycle 로그키 + `channel` 필드 골격.
- [~] 🟢 `instrumentation` 훅 — Sentry / OpenTelemetry / PostHog 연결 지점만 있음.

## 9. 보안 · 하드닝 · 배포

- [ ] 🟡 채널별 검증(서명/토큰) + replay guard.
- [~] 🟡 deny-by-default allowlist(채널 × 테넌트) + operator 권한 분리. operator gate는 있음, agent ACL 구현 필요.
- [~] 🟡 시크릿 격리 + 로그/에러 redaction. env/auth infra는 있음, channel credential provider 필요.
- [ ] 🟡 도구 fetch SSRF 가드 + redirect 거부 + 바이트 cap.
- [ ] 🟡 serverless(webhook) + long-running worker(connection) 양쪽 배포 토폴로지.
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

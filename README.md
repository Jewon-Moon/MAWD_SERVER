# 감정 방패 (가칭)

기능명세: [docs/feature-spec.md](docs/feature-spec.md) · API 문서: [docs/api.md](docs/api.md)

## 구조
```
apps/api            백엔드 (Fastify + TypeScript). 전화 · 채널톡 채팅 · 매장 설정은 실제 구현, 나머지는 목 응답
packages/contracts  API 요청 · 응답 zod 스키마 (프론트는 타입만 import)
apps/web            프론트 (Next.js, 프론트 팀이 생성)
```

## 실행
```bash
cp .env.example .env               # LLM_API_KEY 채우기 (OpenAI 호환 키)
pnpm install
pnpm db:up                          # Postgres 16 (Docker, 포트 54329)
pnpm --filter @mawd/api migrate     # 스키마 + RLS 적용
pnpm --filter @mawd/api seed        # 데모 매장 + 주문 (주문 1234 / 연락처 뒷자리 5678)
pnpm dev                            # http://localhost:8000
```

- API 문서: http://localhost:8000/docs
- OpenAPI: http://localhost:8000/openapi.json (파일로: `pnpm --filter @mawd/api openapi`)
- 데모 페이지: http://localhost:8000/demo (전화 · 채널톡 채팅 탭)
- 테스트 콘솔: http://localhost:8000/console (데모 + 매장 설정 · 규칙 · FAQ · 문구 편집, 시뮬레이터, 음성 연동, 감사 로그)
- 테스트: `pnpm test` (테스트 전용 DB `mawd_test`를 새로 만들어 돌림)
- 채널톡 연결 (해커톤 당일): [docs/channeltalk-dayof.md](docs/channeltalk-dayof.md)

## 프론트 연동
- Base URL `http://localhost:8000/v1`, 요청에 `credentials: 'include'`
- 타입: `@mawd/contracts`를 import하거나, `openapi-typescript`로 `/openapi.json`에서 생성
- 통화 턴(`POST /v1/calls/{id}/turns`)은 SSE 스트림. 이벤트 형식은 contracts의 `CallTurnEvent`

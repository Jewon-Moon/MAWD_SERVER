# 감정 방패 (가칭)

채널톡 위에 얹는 24시간 AI 고객 응대 · 감정 완충 레이어. 이 저장소는 **API 서버**만 담습니다 (기획 문서 · 테스트는 로컬에만).

## 구조
```
apps/api            백엔드 (Fastify + TypeScript, tsx로 바로 실행)
  src/              라우트 · 응대 파이프라인 · 연동(OpenAI · Vapi · Bivia · 채널톡 · FCM)
  drizzle/          SQL 마이그레이션 (RLS 포함)
  templates/        매장 문서 MD 템플릿
  public/           데모(/demo) · 테스트 콘솔(/console)
packages/contracts  API 요청 · 응답 zod 스키마 (프론트는 타입만 import)
```

## 로컬 실행
```bash
cp .env.example .env               # LLM_API_KEY 등 채우기
pnpm install
docker run -d --name mawd-db -p 54329:5432 -e POSTGRES_USER=app_owner -e POSTGRES_PASSWORD=app_owner_dev -e POSTGRES_DB=mawd postgres:16-alpine
pnpm migrate                        # 스키마 + RLS
pnpm seed                           # 데모 매장 + 주문 (주문 1234 / 연락처 뒷자리 5678)
pnpm dev                            # http://localhost:8000
```

## 배포
- **서버 한 대 (docker compose, 추천):** API + Postgres를 같이 띄움. DB 포트는 외부에 열지 않음
  ```bash
  cp .env.example .env    # DB_OWNER_PASSWORD · APP_DB_PASSWORD(openssl rand -hex 24) · LLM_API_KEY · PUBLIC_BASE_URL 등
  docker compose up -d --build
  docker compose logs -f api          # 업데이트: git pull && docker compose up -d --build
  ```
  HTTPS는 앞단(Caddy · Nginx · Cloudflare Tunnel 등)에서. 시작할 때 마이그레이션 → 시드(이미 있으면 건너뜀) → 서버
- **플랫폼 (Railway · Render · Fly.io 등):** `Dockerfile`로 서버만 올리고 DB는 플랫폼의 Postgres
- **Docker 없이:** `pnpm install --prod` 후 `pnpm migrate && pnpm seed && pnpm start`
- **필수 환경변수 (플랫폼 배포 시):** `DATABASE_URL`(앱 역할 app_user), `OWNER_DATABASE_URL`(마이그레이션용 소유자 역할), `APP_DB_PASSWORD`(app_user 비밀번호, DATABASE_URL과 같게), `LLM_API_KEY`, `PORT`, `WEB_ORIGIN`(프론트 주소, CORS), `PUBLIC_BASE_URL`(이 서버의 공개 https 주소, Vapi · 채널톡 · 푸시 링크용)
- **선택:** Vapi · Bivia · 채널톡 · FCM · EXAONE 키. 없으면 해당 기능만 꺼지고 서버는 뜸. 전체 목록은 `.env.example`
- Node 22.9 이상, pnpm 12 (`packageManager` 고정)

## 확인
- API 문서(Swagger): `/docs` · OpenAPI: `/openapi.json`
- 데모: `/demo` · 테스트 콘솔: `/console`
- 상태: `/health`

## 프론트 연동
- Base URL `{서버}/v1`, 요청에 `credentials: 'include'`
- 타입: `@mawd/contracts`를 import하거나 `openapi-typescript`로 `/openapi.json`에서 생성
- 통화 턴(`POST /v1/calls/{id}/turns`)은 SSE 스트림. 이벤트 형식은 contracts의 `CallTurnEvent`

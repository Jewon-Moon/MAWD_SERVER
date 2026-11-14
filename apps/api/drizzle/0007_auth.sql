-- 회원 계정 · 로그인 세션. 매장을 정하기 전에 읽어야 해서 매장 테이블(RLS)이 아닌 전역 테이블 (§5.1 I4: 인증 코드만 접근)
-- 매장 연결은 memberships(tenant_id, user_id), 로그인 후 매장은 tenant_for_user()로
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,         -- 소문자로 저장
  password_hash text NOT NULL,                -- scrypt (salt 포함)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,               -- 세션 토큰의 SHA-256 (원본 토큰은 저장하지 않음)
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);

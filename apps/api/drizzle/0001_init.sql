-- 초기 스키마 + 매장 격리 (docs/feature-spec.md §5, §5.1)
-- app_owner(이 파일을 실행하는 역할) = 테이블 소유자. app_user = 앱 런타임, RLS 적용.

-- shortcut: 개발용 비밀번호를 여기서 지정. 운영에서는 배포 후 ALTER ROLE app_user PASSWORD로 교체
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 현재 트랜잭션의 매장 ID. SET LOCAL이 끝난 뒤 같은 세션에서는 ''가 되므로 NULLIF로 NULL 처리 → 아무 행도 안 보임
CREATE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  webhook_token text NOT NULL UNIQUE,
  channeltalk_channel_id text,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    text NOT NULL,           -- 인증 라이브러리(Better Auth)의 사용자 ID
  role       text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX ON memberships (user_id);

CREATE TABLE secrets (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL,           -- channeltalk | stibee
  ciphertext text NOT NULL,           -- AES-256-GCM, 서버 키로 암호화 (§5.1 I7)
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title           text NOT NULL,
  category        text NOT NULL,
  status          text NOT NULL DEFAULT 'suggested',
  stibee_email_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE inquiries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('chat','call','sns')),
  external_chat_id text,
  customer_name    text,
  customer_email   text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','auto_done','done','manual')),
  route            text CHECK (route IN ('A','B','C')),
  issue_id         uuid,
  ai_muted         boolean NOT NULL DEFAULT false,
  verified_customer_ref text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_chat_id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES issues(tenant_id, id)
);
CREATE INDEX ON inquiries (tenant_id, status, updated_at DESC);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  inquiry_id          uuid NOT NULL,
  external_message_id text,
  sender              text NOT NULL CHECK (sender IN ('customer','ai','owner')),
  text                text NOT NULL,
  latency_ms          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_message_id),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON messages (tenant_id, inquiry_id, created_at);

CREATE TABLE analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  inquiry_id  uuid NOT NULL,
  category    text,
  heat        integer CHECK (heat BETWEEN 0 AND 100),
  abuse_spans jsonb NOT NULL DEFAULT '[]',
  needs_owner boolean,
  confidence  real,
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON analyses (tenant_id, inquiry_id);

CREATE TABLE cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  inquiry_id  uuid NOT NULL,
  summary     jsonb NOT NULL,
  policy_refs jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON cards (tenant_id, inquiry_id);

CREATE TABLE actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inquiry_id  uuid,
  actor       text NOT NULL CHECK (actor IN ('ai','owner','system')),
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON actions (tenant_id, inquiry_id, created_at);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('pdf','text','url','faq')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE doc_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  document_id uuid NOT NULL,
  content     text NOT NULL,
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON doc_chunks USING gin (content gin_trgm_ops);
CREATE INDEX ON doc_chunks (tenant_id);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_no      text NOT NULL,
  customer_name text,
  phone         text,
  email         text,
  items         text,
  amount        numeric,
  ordered_at    timestamptz,
  status        text,
  tracking_no   text,
  eta           date,
  raw           jsonb,
  UNIQUE (tenant_id, order_no)
);
CREATE INDEX ON orders (tenant_id, phone);
CREATE INDEX ON orders (tenant_id, email);

-- RLS: 모든 매장 테이블에 같은 정책 하나 (§5.1 I1)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','secrets','issues','inquiries','messages','analyses','cards','actions','documents','doc_chunks','orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

-- FORCE: 소유자에게도 RLS 적용. tenants · memberships는 아래 SECURITY DEFINER 함수(소유자 권한)가 읽어야 해서 제외.
-- app_user는 소유자가 아니므로 이 두 테이블도 ENABLE만으로 RLS가 걸립니다.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['secrets','issues','inquiries','messages','analyses','cards','actions','documents','doc_chunks','orders'] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 매장을 정하기 전 조회는 이 두 함수만 (§5.1 I4). 매장 ID 하나만 돌려줍니다.
CREATE FUNCTION tenant_for_user(p_user_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT tenant_id FROM memberships WHERE user_id = p_user_id ORDER BY tenant_id LIMIT 1 $$;

CREATE FUNCTION tenant_for_webhook(p_token text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT id FROM tenants WHERE webhook_token = p_token $$;

REVOKE ALL ON FUNCTION tenant_for_user(text), tenant_for_webhook(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_for_user(text), tenant_for_webhook(text), current_tenant() TO app_user;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
REVOKE ALL ON _migrations FROM app_user;
-- 이후 마이그레이션에서 만드는 테이블도 자동으로 app_user 권한 부여. RLS 누락은 격리 테스트가 잡습니다.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

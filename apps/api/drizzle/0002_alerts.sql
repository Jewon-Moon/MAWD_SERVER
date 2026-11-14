-- 사장님 화면 알림 (감정 점수 우선순위) + 푸시 알림(FCM) 기기 토큰. 매장 격리는 0001과 같은 RLS 정책

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inquiry_id  uuid,                    -- 시험 알림은 NULL
  channel     text NOT NULL CHECK (channel IN ('chat', 'call', 'sns')),
  kind        text NOT NULL CHECK (kind IN ('live', 'card')),
  priority    text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal')),
  heat        integer NOT NULL CHECK (heat BETWEEN 0 AND 100),
  title       text NOT NULL,
  message     text NOT NULL,           -- 고객 원문(욕설)은 넣지 않음
  display     text NOT NULL CHECK (display IN ('modal', 'banner', 'toast', 'badge', 'none')),
  sound       boolean NOT NULL,
  pushed      integer NOT NULL DEFAULT 0, -- 푸시를 보낸 기기 수
  acked_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON alerts (tenant_id, created_at DESC);

CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      text,                   -- 인증 붙기 전에는 NULL (매장 단위로 전체 기기에 보냄)
  token        text NOT NULL,          -- FCM 등록 토큰
  platform     text NOT NULL CHECK (platform IN ('web', 'android', 'ios')),
  label        text,                   -- 기기 구분용 (예: "Chrome · macOS")
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, token)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alerts', 'push_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

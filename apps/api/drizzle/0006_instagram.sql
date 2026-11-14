-- 인스타그램 연동 (매장별): 연결한 인스타 비즈니스 계정 + 댓글 처리 기록. 액세스 토큰은 secrets(kind='instagram')에 암호화
CREATE TABLE instagram_accounts (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ig_user_id    text NOT NULL UNIQUE,      -- 웹훅 entry.id로 매장을 찾는 키
  username      text,
  connected_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE instagram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instagram_accounts USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- 웹훅은 매장을 정하기 전에 와서 이 함수로만 찾음 (§5.1 I4와 같은 방식, 매장 ID 하나만 돌려줌)
CREATE FUNCTION tenant_for_instagram(p_ig_user_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT tenant_id FROM instagram_accounts WHERE ig_user_id = p_ig_user_id $$;
REVOKE ALL ON FUNCTION tenant_for_instagram(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_for_instagram(text) TO app_user;

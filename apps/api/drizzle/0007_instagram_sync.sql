-- 인스타그램 댓글 동기화 스케줄러 전용: 연결된 계정이 있는 매장 ID만 돌려줌 (§5.1 I4)
CREATE FUNCTION tenants_with_instagram() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT DISTINCT tenant_id FROM instagram_accounts $$;
REVOKE ALL ON FUNCTION tenants_with_instagram() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenants_with_instagram() TO app_user;

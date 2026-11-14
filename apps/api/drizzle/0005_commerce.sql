-- 외부 커머스 플랫폼 연동 (F13): 판매처별 연결 + 주문의 판매처 구분 + 판매처별 정책 문서
-- 여러 판매처를 같이 쓰면 주문번호가 겹칠 수 있으므로 주문의 유일성은 (매장, 판매처, 주문번호)

CREATE TABLE store_connections (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source         text NOT NULL,          -- naver | coupang | musinsa | ably | baemin | coupangeats | yogiyo | csv
  mode           text NOT NULL CHECK (mode IN ('api', 'demo', 'file')),
  status         text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disabled')),
  sync_cursor    timestamptz,            -- 다음 동기화에서 이 시각 이후 변경분을 가져옴
  last_synced_at timestamptz,
  last_error     text,                   -- 사장님 화면에 보여줄 마지막 실패 사유 (키 · 토큰은 넣지 않음)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source)
);
-- ENABLE만: 동기화 스케줄러가 아래 SECURITY DEFINER 함수(소유자 권한)로 "연결이 있는 매장 ID"를 읽어야 해서 FORCE 제외.
-- app_user는 소유자가 아니므로 RLS가 그대로 걸립니다 (tenants · memberships와 같은 방식)
ALTER TABLE store_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON store_connections USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE orders ADD COLUMN source     text NOT NULL DEFAULT 'csv';
ALTER TABLE orders ADD COLUMN raw_status text;          -- 플랫폼 원래 상태 코드 (status는 공통 상태로 바꾼 값)
ALTER TABLE orders ADD COLUMN synced_at  timestamptz;   -- 플랫폼에서 마지막으로 받아온 시각 (CSV는 업로드 시각)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tenant_id_order_no_key;
ALTER TABLE orders ADD CONSTRAINT orders_tenant_source_order_no_key UNIQUE (tenant_id, source, order_no);
CREATE INDEX ON orders (tenant_id, order_no);

ALTER TABLE documents ADD COLUMN source text;           -- 이 문서가 적용되는 판매처. NULL = 모든 판매처 공통

-- 동기화 스케줄러 전용: 자동 동기화할 연결이 있는 매장 ID만 돌려줌 (§5.1 I4와 같은 방식, 내용은 읽지 않음)
CREATE FUNCTION tenants_with_connections() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT DISTINCT tenant_id FROM store_connections WHERE mode IN ('api', 'demo') AND status <> 'disabled' $$;
REVOKE ALL ON FUNCTION tenants_with_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenants_with_connections() TO app_user;

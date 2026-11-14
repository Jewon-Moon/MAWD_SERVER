-- 매장 문서 (MD): 매장 소개 · 상품 · 서비스 · 운영 정책. 템플릿 모드(fields → MD) 또는 직접 작성 모드(markdown 그대로)
CREATE TABLE context_docs (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('business', 'offerings', 'policies')),
  mode        text NOT NULL CHECK (mode IN ('template', 'custom')),
  fields      jsonb,                 -- 템플릿 모드 입력값
  markdown    text NOT NULL,         -- AI에 들어가는 최종 MD (템플릿 모드는 서버가 생성)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
ALTER TABLE context_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON context_docs USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

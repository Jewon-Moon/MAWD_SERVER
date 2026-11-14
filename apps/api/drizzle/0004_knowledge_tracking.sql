-- 매장별 지식(RAG) 문서 사용 여부 + 주문의 택배사 (실시간 배송 조회용)
ALTER TABLE documents ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE orders ADD COLUMN carrier text;   -- 예: "CJ대한통운" 또는 Delivery Tracker ID "kr.cjlogistics"

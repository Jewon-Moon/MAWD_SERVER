// 데모 데이터: 데모 매장 + 주문 몇 건. 여러 번 실행해도 안전합니다.  pnpm --filter @mawd/api seed
import { createDb } from './db/client.js';
import * as s from './db/schema.js';
import { TENANT_ID } from './mocks/data.js';

const db = createDb();
await db.withTenant(TENANT_ID, async (tx) => {
  await tx.insert(s.tenants).values({ id: TENANT_ID, name: '데모 상점', webhookToken: 'demo-token' }).onConflictDoNothing();
  await tx.insert(s.orders).values([
    { tenantId: TENANT_ID, orderNo: '1234', customerName: '김고객', phone: '010-1111-5678', items: '머그컵 외 1건', amount: '32000', status: '배송중', trackingNo: '5512-3344-7788', carrier: 'CJ대한통운', eta: '2026-11-13' },
    { tenantId: TENANT_ID, orderNo: '2001', customerName: '이고객', phone: '010-2222-9999', items: '텀블러', amount: '18000', status: '출고 준비', eta: '2026-11-15' },
  ]).onConflictDoNothing();
});
await db.close();
console.log('seeded demo tenant', TENANT_ID);

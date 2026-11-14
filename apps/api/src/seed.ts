// 데모 데이터: 데모 매장 + 주문 몇 건 + 데모 계정(초기 세팅 완료 상태). 여러 번 실행해도 안전합니다.  pnpm --filter @mawd/api seed
// 데모 계정: DEMO_EMAIL / DEMO_PASSWORD (기본 demo@mawd.app / mawd-demo-1234). 운영에서는 비밀번호를 꼭 바꿔서 넣으세요
import { createAuth } from './auth.js';
import { createDb } from './db/client.js';
import * as s from './db/schema.js';
import { TENANT_ID } from './mocks/data.js';
import { configOf, loadConfig, saveConfig } from './tenantConfig.js';

const DEMO_EMAIL = process.env.DEMO_EMAIL?.trim() || 'demo@mawd.app';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD?.trim() || 'mawd-demo-1234';

const db = createDb();
await db.withTenant(TENANT_ID, async (tx) => {
  await tx.insert(s.tenants).values({ id: TENANT_ID, name: '데모 상점', webhookToken: 'demo-token' }).onConflictDoNothing();
  await tx.insert(s.orders).values([
    { tenantId: TENANT_ID, orderNo: '1234', customerName: '김고객', phone: '010-1111-5678', items: '머그컵 외 1건', amount: '32000', status: '배송중', trackingNo: '5512-3344-7788', carrier: 'CJ대한통운', eta: '2026-11-13' },
    { tenantId: TENANT_ID, orderNo: '2001', customerName: '이고객', phone: '010-2222-9999', items: '텀블러', amount: '18000', status: '출고 준비', eta: '2026-11-15' },
  ]).onConflictDoNothing();
});
await createAuth({ db }).ensureUser(DEMO_EMAIL, DEMO_PASSWORD, TENANT_ID);
// 데모 매장은 초기 세팅 화면 없이 바로 대시보드로 (이미 바꾼 설정은 유지)
await loadConfig(db, TENANT_ID);
configOf(TENANT_ID).setup = { done: true, template: 'online_shop' };
await saveConfig(db, TENANT_ID);
await db.close();
console.log('seeded demo tenant', TENANT_ID, '/ demo account', DEMO_EMAIL);

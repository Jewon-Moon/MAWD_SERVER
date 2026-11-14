// F12 읽기 전용 주문 도구 + 안전장치 S1~S9 (docs/feature-spec.md F12).
// 원칙: LLM은 무엇을 읽을지 요청만 하고, 읽어도 되는지는 이 코드가 정한다.
import { and, eq } from 'drizzle-orm';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import type { DataAccess } from '@mawd/contracts';
import type { z } from 'zod';

type Db = ReturnType<typeof createDb>;
type DataAccessCfg = z.infer<typeof DataAccess>;
type ExposedField = DataAccessCfg['exposed_fields'][number];

/** 대화(통화)별 본인 확인 상태. 서버만 바꿀 수 있고 LLM은 읽지도 쓰지도 않음 (S3) */
export type VerifyState = { verifiedPhone: string | null; attempts: number; lookups: number; locked: boolean };
export const newVerifyState = (): VerifyState => ({ verifiedPhone: null, attempts: 0, lookups: 0, locked: false });

const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

/** 발화에서 주문번호 · 연락처 뒷 4자리 추출 (예: "주문번호 1234, 뒷자리 5678") */
export function extractCredentials(text: string): { orderNo: string; last4: string } | null {
  // 채팅에서는 연락처를 통째로 쓰는 경우가 많음 ("1234 / 010-1111-5678") → 휴대폰 번호면 끝 4자리, 주문번호는 나머지에서
  const phone = text.match(/01\d[-.\s]?\d{3,4}[-.\s]?(\d{4})(?!\d)/);
  if (phone) {
    const orderNo = text.replace(phone[0], ' ').match(/\d{3,}/)?.[0];
    return orderNo ? { orderNo, last4: phone[1]! } : null;
  }
  const nums = text.match(/\d{3,}/g) ?? [];
  if (nums.length < 2) return null;
  const last4 = nums.find((n, i) => n.length === 4 && i > 0) ?? nums[nums.length - 1]!.slice(-4);
  const orderNo = nums[0]!;
  return last4.length === 4 ? { orderNo, last4 } : null;
}

export function createOrderTools(db: Db, tenantId: string, cfg: DataAccessCfg) {
  async function audit(inquiryId: string | null, payload: Record<string, unknown>) {
    await db.withTenant(tenantId, (tx) => tx.insert(s.actions).values({ tenantId, inquiryId, actor: 'ai', type: 'read_lookup', payload })); // S9
  }

  /** S3 · S6 · S7: 서버가 값을 비교. 실패 사유(주문 없음 / 번호 불일치)는 구분하지 않음 */
  async function verify(state: VerifyState, inquiryId: string | null, orderNo: string, last4: string): Promise<'ok' | 'failed' | 'locked'> {
    if (state.locked || !cfg.enabled || !cfg.verification_methods.includes('order_no_last4')) return 'locked';
    state.attempts++;
    const rows = await db.withTenant(tenantId, (tx) =>
      tx.select({ phone: s.orders.phone }).from(s.orders).where(eq(s.orders.orderNo, orderNo)), { readOnly: true }); // S1 · S2
    const phone = rows[0]?.phone;
    const ok = !!phone && digits(phone).slice(-4) === last4;
    if (ok) state.verifiedPhone = phone!;
    else if (state.attempts >= cfg.max_verify_attempts) state.locked = true;
    await audit(inquiryId, { tool: 'verify_customer', ok, attempts: state.attempts });
    return ok ? 'ok' : state.locked ? 'locked' : 'failed';
  }

  /** S4 · S5 · S7: 확인된 고객의 주문만, 허용 필드만 */
  async function lookup(state: VerifyState, inquiryId: string | null, orderNo?: string) {
    if (!state.verifiedPhone || !cfg.enabled || !cfg.tools.lookup_order) return [];
    if (state.lookups >= cfg.max_lookups_per_inquiry) return [];
    state.lookups++;
    const rows = await db.withTenant(tenantId, (tx) =>
      tx.select().from(s.orders).where(orderNo
        ? and(eq(s.orders.phone, state.verifiedPhone!), eq(s.orders.orderNo, orderNo))
        : eq(s.orders.phone, state.verifiedPhone!)).limit(5), { readOnly: true });
    const pick = (o: typeof rows[number]) => {
      const all: Record<ExposedField, unknown> = { status: o.status, eta: o.eta, items: o.items, amount: o.amount, tracking_no: o.trackingNo };
      return { order_no: o.orderNo, ...Object.fromEntries(cfg.exposed_fields.map((f) => [f, all[f]])) };
    };
    await audit(inquiryId, { tool: 'lookup_order', rows: rows.length, verified: true });
    return rows.map(pick);
  }

  return { verify, lookup };
}

/** S8: 고객에게 나가는 문장에 확인된 고객 본인 것이 아닌 연락처 · 이메일이 있으면 막음 */
export function leaksPii(sentence: string, verifiedPhone: string | null): boolean {
  const phones = sentence.match(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g) ?? [];
  if (phones.some((p) => digits(p) !== digits(verifiedPhone))) return true;
  return /[\w.+-]+@[\w-]+\.[\w.]+/.test(sentence);
}

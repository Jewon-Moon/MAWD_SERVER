// F12 읽기 전용 주문 도구 + 안전장치 S1~S9 (docs/feature-spec.md F12) + F13 다중 판매처 대응.
// 원칙: LLM은 무엇을 읽을지 요청만 하고, 읽어도 되는지는 이 코드가 정한다.
import { and, eq, sql } from 'drizzle-orm';
import type { CommerceSource, DataAccess } from '@mawd/contracts';
import type { z } from 'zod';
import { platformLabel } from '../commerce/types.js';
import type { CommerceService } from '../commerce/service.js';
import type { createDb } from '../db/client.js';
import type { Tracker } from '../integrations/tracker.js';
import * as s from '../db/schema.js';

type Db = ReturnType<typeof createDb>;
type DataAccessCfg = z.infer<typeof DataAccess>;
type ExposedField = DataAccessCfg['exposed_fields'][number];

/** 대화(통화)별 본인 확인 상태. 서버만 바꿀 수 있고 LLM은 읽지도 쓰지도 않음 (S3) */
export type VerifyState = {
  verifiedPhone: string | null;
  verifiedSource: CommerceSource | null; // 다중 판매처 중 주문번호로 확정된 판매처 (여러 곳에서 샀으면 null)
  verifiedOrderNo: string | null;
  attempts: number;
  lookups: number;
  locked: boolean;
};
export const newVerifyState = (): VerifyState => ({
  verifiedPhone: null,
  verifiedSource: null,
  verifiedOrderNo: null,
  attempts: 0,
  lookups: 0,
  locked: false,
});

const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
const ORDER_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]{2,}/g;

/** 발화에서 주문번호 후보 추출 (숫자형 · 무신사/에이블리/배달앱 영문+숫자형 모두) */
export function extractOrderNo(text: string): string | null {
  const stripped = text.replace(/(?:01\d|050\d)[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/g, ' ');
  const tokens = (stripped.match(ORDER_TOKEN) ?? []).filter((t) => /\d/.test(t) && !/^-+$/.test(t));
  if (!tokens.length) return null;
  return tokens.find((t) => !/^\d{4}$/.test(t)) ?? tokens[0]!;
}

/** 발화에서 주문번호 · 연락처 뒷 4자리 추출 (예: "주문번호 1234, 뒷자리 5678", "M202611130001 / 2468") */
export function extractCredentials(text: string): { orderNo: string; last4: string } | null {
  // 채팅에서는 연락처를 통째로 쓰는 경우가 많음 ("1234 / 010-1111-5678") → 휴대폰 번호면 끝 4자리, 주문번호는 나머지에서
  const phone = text.match(/(?:01\d|050\d)[-\s.]?\d{3,4}[-\s.]?(\d{4})(?!\d)/);
  if (phone) {
    const orderNo = extractOrderNo(text.replace(phone[0], ' '));
    return orderNo ? { orderNo, last4: phone[1]! } : null;
  }
  const tokens = (text.match(ORDER_TOKEN) ?? []).filter((t) => /\d/.test(t) && !/^-+$/.test(t));
  if (tokens.length < 2) return null;
  // 한쪽이 영문 포함이거나 4자리가 아닌 긴 주문번호면, 4자리 숫자 토큰을 뒷자리로 본다 (순서 무관)
  const nonFour = tokens.find((t) => !/^\d{4}$/.test(t));
  const fourAtTail = tokens.find((t, i) => /^\d{4}$/.test(t) && (nonFour ? true : i > 0));
  if (nonFour && fourAtTail) return { orderNo: nonFour, last4: fourAtTail };
  const last4 = fourAtTail ?? digits(tokens[tokens.length - 1]).slice(-4);
  const orderNo = tokens[0]!;
  return last4.length === 4 ? { orderNo, last4 } : null;
}

export function createOrderTools(db: Db, tenantId: string, cfg: DataAccessCfg, tracker?: Tracker, commerce?: CommerceService) {
  async function audit(inquiryId: string | null, payload: Record<string, unknown>) {
    await db.withTenant(tenantId, (tx) => tx.insert(s.actions).values({ tenantId, inquiryId, actor: 'ai', type: 'read_lookup', payload })); // S9
  }

  /** S3 · S6 · S7: 서버가 값을 비교. 같은 주문번호가 여러 판매처에 있으면 모두 비교하고 일치한 판매처를 확정 */
  async function verify(state: VerifyState, inquiryId: string | null, orderNo: string, last4: string): Promise<'ok' | 'failed' | 'locked'> {
    if (state.locked || !cfg.enabled || !cfg.verification_methods.includes('order_no_last4')) return 'locked';
    state.attempts++;

    const findCandidates = () => db.withTenant(tenantId, (tx) =>
      tx.select({ source: s.orders.source, orderNo: s.orders.orderNo, phone: s.orders.phone })
        .from(s.orders).where(eq(s.orders.orderNo, orderNo)), { readOnly: true }); // S1 · S2

    let rows = await findCandidates();
    let matches = rows.filter((r) => !!r.phone && digits(r.phone).slice(-4) === last4);

    // 아직 주기적 동기화가 안 돈 방금 들어온 주문이면 연결된 판매처에서 실시간 조회 후 다시 확인
    if (!matches.length && commerce) {
      const fetched = await commerce.lookupOrderLive(tenantId, orderNo);
      if (fetched > 0) {
        rows = await findCandidates();
        matches = rows.filter((r) => !!r.phone && digits(r.phone).slice(-4) === last4);
      }
    }

    const ok = matches.length > 0;
    if (ok) {
      state.verifiedPhone = matches[0]!.phone!;
      state.verifiedOrderNo = orderNo;
      state.verifiedSource = matches.length === 1 ? (matches[0]!.source as CommerceSource) : null;
    } else if (state.attempts >= cfg.max_verify_attempts) {
      state.locked = true;
    }
    await audit(inquiryId, { tool: 'verify_customer', ok, attempts: state.attempts, source: state.verifiedSource });
    return ok ? 'ok' : state.locked ? 'locked' : 'failed';
  }

  /** S4 · S5 · S7: 확인된 고객의 주문만 (모든 연동 판매처 통합 조회), 허용 필드만 */
  async function lookup(state: VerifyState, inquiryId: string | null, orderNo?: string) {
    if (!state.verifiedPhone || !cfg.enabled || !cfg.tools.lookup_order) return [];
    if (state.lookups >= cfg.max_lookups_per_inquiry) return [];
    state.lookups++;

    const phoneDigits = digits(state.verifiedPhone);
    const phoneMatch = sql`regexp_replace(coalesce(${s.orders.phone}, ''), '[^0-9]', '', 'g') = ${phoneDigits}`;
    const queryRows = () => db.withTenant(tenantId, (tx) =>
      tx.select().from(s.orders)
        .where(orderNo ? and(phoneMatch, eq(s.orders.orderNo, orderNo)) : phoneMatch)
        .orderBy(sql`${s.orders.orderedAt} DESC NULLS LAST`, s.orders.orderNo)
        .limit(10), { readOnly: true });

    let rows = await queryRows();
    // 후속 질문에서 DB에 아직 없는 새 주문번호를 물었을 때도 실시간 조회 (본인 연락처일 때만 아래 필터에 걸림)
    if (orderNo && !rows.length && commerce) {
      const fetched = await commerce.lookupOrderLive(tenantId, orderNo);
      if (fetched > 0) rows = await queryRows();
    }

    const multiSource = new Set(rows.map((r) => r.source)).size > 1;
    // 실시간 배송 상태: 매장이 켰고(track_shipment · delivery 노출) 송장 · 택배사가 있는 주문만. 실패하면 주문 데이터 상태로만
    const live = cfg.tools.track_shipment && cfg.exposed_fields.includes('delivery') && tracker?.configured;
    const pick = async (o: typeof rows[number]) => {
      const delivery = live && o.trackingNo && o.carrier ? await tracker!.track(o.carrier, o.trackingNo) : null;
      const all: Record<ExposedField, unknown> = { status: o.status, eta: o.eta, items: o.items, amount: o.amount, tracking_no: o.trackingNo, carrier: o.carrier, delivery };
      const fields = Object.fromEntries(cfg.exposed_fields.map((f) => [f, all[f]]).filter(([, v]) => v != null));
      const tagPlatform = o.source !== 'csv' || multiSource;
      return {
        ...(tagPlatform ? { source: o.source, platform: platformLabel(o.source) } : {}),
        order_no: o.orderNo,
        ...fields,
        ...(tagPlatform && o.syncedAt ? { synced_at: o.syncedAt.toISOString() } : {}),
      };
    };
    const out = await Promise.all(rows.map(pick));
    await audit(inquiryId, { tool: 'lookup_order', rows: rows.length, verified: true, sources: [...new Set(rows.map((r) => r.source))], live_tracking: out.filter((o) => 'delivery' in o).length });
    return out;
  }

  return { verify, lookup };
}

/** S8: 고객에게 나가는 문장에 확인된 고객 본인 것이 아닌 연락처 · 이메일이 있으면 막음 */
export function leaksPii(sentence: string, verifiedPhone: string | null): boolean {
  const phones = sentence.match(/(?:01[016789]|050\d)[-\s.]?\d{3,4}[-\s.]?\d{4}/g) ?? [];
  if (phones.some((p) => digits(p) !== digits(verifiedPhone))) return true;
  return /[\w.+-]+@[\w-]+\.[\w.]+/.test(sentence);
}

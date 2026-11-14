// 네이버 스마트스토어: 네이버 커머스API (https://apicenter.commerce.naver.com). 읽기 전용 (주문 조회만).
// 인증: client_secret_sign = base64(bcrypt(client_id + "_" + timestamp, client_secret)) → OAuth2 client_credentials 토큰 (3시간)
// 엔드포인트 · 필드명은 2026-11 문서 기준. 실제 키로 처음 붙일 때 응답 형식을 한 번 확인하세요 (raw에 원본이 남음)
import bcrypt from 'bcryptjs';
import type { CommerceAdapter, NormalizedOrder } from './types.js';
import { carrierName, mergeLines, normalizePhone } from './types.js';

const BASE = 'https://api.commerce.naver.com/external';
type Creds = { client_id: string; client_secret: string; account_id?: string };

const STATUS: Record<string, string> = {
  PAYMENT_WAITING: '결제 대기', PAYED: '결제 완료', DELIVERING: '배송중', DELIVERED: '배송 완료', PURCHASE_DECIDED: '구매 확정',
  EXCHANGED: '교환 완료', CANCELED: '취소 완료', RETURNED: '반품 완료', CANCELED_BY_NOPAYMENT: '취소 완료',
};
const CLAIM: Record<string, string> = {
  CANCEL_REQUEST: '취소 요청', CANCELING: '취소 요청', RETURN_REQUEST: '반품 요청', COLLECTING: '반품 요청', COLLECT_DONE: '반품 요청',
  EXCHANGE_REQUEST: '교환 요청', EXCHANGE_REDELIVERING: '교환 요청',
};

/** KST ISO (네이버 API는 +09:00 오프셋 형식을 받음) */
export const kstIso = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace('Z', '+09:00');

type Detail = {
  order?: { orderId?: string; ordererName?: string; ordererTel?: string; orderDate?: string; paymentDate?: string };
  productOrder?: { productOrderId?: string; productOrderStatus?: string; claimStatus?: string; placeOrderStatus?: string; productName?: string; quantity?: number; totalPaymentAmount?: number; shippingAddress?: { name?: string; tel1?: string }; expectedDeliveryDate?: string };
  delivery?: { deliveryCompany?: string; trackingNumber?: string; deliveryStatus?: string };
};

export function normalizeNaver(d: Detail): NormalizedOrder {
  const po = d.productOrder ?? {};
  const claim = po.claimStatus ? CLAIM[po.claimStatus] : undefined;
  let status = claim ?? STATUS[po.productOrderStatus ?? ''] ?? po.productOrderStatus ?? '확인 중';
  if (status === '결제 완료' && po.placeOrderStatus === 'OK') status = '상품 준비중'; // 발주 확인됨
  return {
    orderNo: String(d.order?.orderId ?? po.productOrderId ?? ''),
    customerName: d.order?.ordererName ?? po.shippingAddress?.name ?? null,
    phone: normalizePhone(d.order?.ordererTel ?? po.shippingAddress?.tel1),
    email: null,
    items: po.productName ? `${po.productName}${po.quantity && po.quantity > 1 ? ` ${po.quantity}개` : ''}` : null,
    amount: po.totalPaymentAmount ?? null,
    orderedAt: d.order?.orderDate ? new Date(d.order.orderDate) : null,
    status,
    rawStatus: [po.productOrderStatus, po.claimStatus].filter(Boolean).join('/') || null,
    trackingNo: d.delivery?.trackingNumber ?? null,
    carrier: carrierName(d.delivery?.deliveryCompany),
    eta: po.expectedDeliveryDate?.slice(0, 10) ?? null,
    raw: d,
  };
}

export function createNaverAdapter(creds: Creds, fetchFn: typeof fetch = fetch): CommerceAdapter {
  let token: { value: string; exp: number } | null = null;

  async function auth(): Promise<string> {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const timestamp = String(Date.now());
    const sign = Buffer.from(bcrypt.hashSync(`${creds.client_id}_${timestamp}`, creds.client_secret)).toString('base64');
    const body = new URLSearchParams({ client_id: creds.client_id, timestamp, client_secret_sign: sign, grant_type: 'client_credentials', type: creds.account_id ? 'SELLER' : 'SELF' });
    if (creds.account_id) body.set('account_id', creds.account_id);
    const res = await fetchFn(`${BASE}/v1/oauth2/token`, { method: 'POST', body, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`네이버 인증 실패 (${res.status}): 애플리케이션 ID · 시크릿을 확인하세요`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return token.value;
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchFn(`${BASE}${path}`, {
      ...init, signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${await auth()}`, 'content-type': 'application/json', ...init.headers },
    });
    if (res.status === 401) token = null;
    if (!res.ok) throw new Error(`네이버 API 오류 (${res.status} ${path.split('?')[0]})`);
    return (await res.json()) as T;
  }

  async function details(productOrderIds: string[]): Promise<NormalizedOrder[]> {
    const out: NormalizedOrder[] = [];
    for (let i = 0; i < productOrderIds.length; i += 300) { // 한 번에 최대 300건
      const j = await call<{ data?: Detail[] }>('/v1/pay-order/seller/product-orders/query', { method: 'POST', body: JSON.stringify({ productOrderIds: productOrderIds.slice(i, i + 300) }) });
      out.push(...(j.data ?? []).map(normalizeNaver));
    }
    return mergeLines(out.filter((o) => o.orderNo));
  }

  return {
    source: 'naver',
    async test() { await auth(); },
    async fetchChanged(since, until) {
      const ids = new Set<string>();
      // 변경 조회는 한 번에 최대 24시간 범위 → 하루씩 끊어서. 페이지는 moreFrom · moreSequence로 이어감
      for (let from = since; from < until; from = new Date(from.getTime() + 86_400_000)) {
        const to = new Date(Math.min(from.getTime() + 86_400_000, until.getTime()));
        let more: { moreFrom?: string; moreSequence?: string } | undefined;
        do {
          const q = new URLSearchParams({ lastChangedFrom: more?.moreFrom ?? kstIso(from), lastChangedTo: kstIso(to) });
          if (more?.moreSequence) q.set('moreSequence', more.moreSequence);
          const j = await call<{ data?: { lastChangeStatuses?: { productOrderId: string }[]; more?: { moreFrom?: string; moreSequence?: string } } }>(`/v1/pay-order/seller/product-orders/last-changed-statuses?${q}`);
          j.data?.lastChangeStatuses?.forEach((s) => ids.add(s.productOrderId));
          more = j.data?.more?.moreFrom ? j.data.more : undefined;
        } while (more);
      }
      return details([...ids]);
    },
    async fetchOrder(orderNo) {
      const j = await call<{ data?: string[] }>(`/v1/pay-order/seller/orders/${encodeURIComponent(orderNo)}/product-order-ids`).catch(() => ({ data: [] }));
      return j.data?.length ? details(j.data) : [];
    },
    // 주문번호 16자리 (예: 2026111412345678), 상품주문번호도 숫자 16자리
    looksLike: (no) => /^\d{14,20}$/.test(no),
  };
}

// 쿠팡 마켓플레이스: 쿠팡 Open API (https://developers.coupangcorp.com). 읽기 전용 (발주서 조회만).
// 인증: HMAC-SHA256. message = signedDate(yyMMddTHHmmssZ) + method + path + query → Authorization: CEA ...
// 엔드포인트 · 필드명은 2026-11 문서 기준. 실제 키로 처음 붙일 때 응답 형식을 한 번 확인하세요 (raw에 원본이 남음)
import { createHmac } from 'node:crypto';
import type { CommerceAdapter, NormalizedOrder } from './types.js';
import { mergeLines, normalizePhone } from './types.js';

const DEFAULT_HOST = 'https://api-gateway.coupang.com';
type Creds = { vendor_id: string; access_key: string; secret_key: string };

// 발주서 상태: 결제완료 → 상품준비중 → 배송지시 → 배송중 → 배송완료 (업체 직접 배송은 NONE_TRACKING)
const STATUS: Record<string, string> = {
  ACCEPT: '결제 완료', INSTRUCT: '상품 준비중', DEPARTURE: '배송중', DELIVERING: '배송중', FINAL_DELIVERY: '배송 완료', NONE_TRACKING: '배송중',
};
const STATUSES = Object.keys(STATUS);

export function signCoupang(creds: Pick<Creds, 'access_key' | 'secret_key'>, method: string, path: string, query: string, now = new Date()): string {
  const signedDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').slice(2); // yyMMddTHHmmssZ
  const signature = createHmac('sha256', creds.secret_key).update(signedDate + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${creds.access_key}, signed-date=${signedDate}, signature=${signature}`;
}

type Sheet = {
  orderId?: number | string; orderedAt?: string; status?: string; invoiceNumber?: string; deliveryCompanyName?: string; estimatedShippingDate?: string;
  orderer?: { name?: string; email?: string; safeNumber?: string; ordererNumber?: string };
  receiver?: { name?: string; safeNumber?: string; receiverNumber?: string };
  orderItems?: { vendorItemName?: string; shippingCount?: number; orderPrice?: number }[];
};

export function normalizeCoupang(s: Sheet): NormalizedOrder[] {
  const items = s.orderItems?.length ? s.orderItems : [{}];
  // 연락처: 실번호가 있으면 실번호, 없으면 안심번호(050x). 안심번호는 고객이 아는 번호와 달라 뒷자리 확인이 안 될 수 있음
  const phone = normalizePhone(s.orderer?.ordererNumber || s.receiver?.receiverNumber || s.orderer?.safeNumber || s.receiver?.safeNumber);
  return items.map((it) => ({
    orderNo: String(s.orderId ?? ''),
    customerName: s.orderer?.name ?? s.receiver?.name ?? null,
    phone,
    email: s.orderer?.email ?? null,
    items: it.vendorItemName ? `${it.vendorItemName}${it.shippingCount && it.shippingCount > 1 ? ` ${it.shippingCount}개` : ''}` : null,
    amount: it.orderPrice ?? null,
    orderedAt: s.orderedAt ? new Date(s.orderedAt.length === 19 ? `${s.orderedAt}+09:00` : s.orderedAt) : null,
    status: STATUS[s.status ?? ''] ?? s.status ?? '확인 중',
    rawStatus: s.status ?? null,
    trackingNo: s.invoiceNumber || null,
    carrier: s.deliveryCompanyName || null,
    eta: null,
    raw: { ...s, virtual_phone: !!phone && /^050\d/.test(phone.replace(/\D/g, '')) },
  }));
}

const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function createCoupangAdapter(creds: Creds, fetchFn: typeof fetch = fetch, host = process.env.COUPANG_API_BASE?.trim() || DEFAULT_HOST): CommerceAdapter {
  const HOST = host.replace(/\/$/, '');
  const vendorPath = `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(creds.vendor_id)}`;

  async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const res = await fetchFn(`${HOST}${path}${query ? `?${query}` : ''}`, {
      headers: { authorization: signCoupang(creds, 'GET', path, query), 'content-type': 'application/json;charset=UTF-8', 'X-Requested-By': creds.vendor_id },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`쿠팡 인증 실패 (${res.status}): 업체코드 · Access Key · Secret Key를 확인하세요`);
    if (!res.ok) throw new Error(`쿠팡 API 오류 (${res.status})`);
    return (await res.json()) as T;
  }

  async function sheets(from: Date, to: Date, status: string): Promise<Sheet[]> {
    const out: Sheet[] = [];
    let nextToken = '';
    do {
      const p: Record<string, string> = { createdAtFrom: ymd(from), createdAtTo: ymd(to), status, maxPerPage: '50' };
      if (nextToken) p.nextToken = nextToken;
      const j = await call<{ data?: Sheet[]; nextToken?: string }>(`${vendorPath}/ordersheets`, p);
      out.push(...(j.data ?? []));
      nextToken = j.nextToken ?? '';
    } while (nextToken);
    return out;
  }

  return {
    source: 'coupang',
    async test() { await sheets(new Date(Date.now() - 86_400_000), new Date(), 'ACCEPT'); },
    async fetchChanged(since, until) {
      // 발주서 목록은 "주문일" 기준 조회 (최대 31일) + 상태별 → 최근 주문을 상태마다 훑어서 현재 상태로 덮어씀
      const from = new Date(Math.max(since.getTime() - 86_400_000, until.getTime() - 30 * 86_400_000));
      const all: Sheet[] = [];
      for (const st of STATUSES) all.push(...(await sheets(from, until, st)));
      return mergeLines(all.flatMap(normalizeCoupang).filter((o) => o.orderNo));
    },
    async fetchOrder(orderNo) {
      const j = await call<{ data?: Sheet[] | Sheet }>(`${vendorPath}/${encodeURIComponent(orderNo)}/ordersheets`).catch(() => ({ data: [] as Sheet[] }));
      const list = Array.isArray(j.data) ? j.data : j.data ? [j.data] : [];
      return mergeLines(list.flatMap(normalizeCoupang).filter((o) => o.orderNo));
    },
    looksLike: (no) => /^\d{9,16}$/.test(no),
  };
}

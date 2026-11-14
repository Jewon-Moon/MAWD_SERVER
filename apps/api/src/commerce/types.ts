// 판매처 공통 모델 (F13). 플랫폼마다 다른 주문 형식 · 상태 코드를 이 모양으로 바꿔 orders 테이블에 넣습니다.
// AI는 플랫폼 API를 직접 부르지 않고 orders만 읽습니다 (읽기 전용 · 본인 확인 · 범위 고정 안전장치 S1~S9를 그대로 적용).
import type { CommerceSource } from '@mawd/contracts';

/** 공통 주문 상태. 고객에게 그대로 말해도 되는 표현 */
export const ORDER_STATUS = ['결제 대기', '결제 완료', '상품 준비중', '배송중', '배송 완료', '구매 확정', '취소 요청', '취소 완료', '반품 요청', '반품 완료', '교환 요청', '교환 완료'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export type NormalizedOrder = {
  orderNo: string;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  items: string | null;
  amount: number | null;
  orderedAt: Date | null;
  status: string;            // ORDER_STATUS 중 하나 (모르는 값이면 원문)
  rawStatus: string | null;  // 플랫폼 원래 상태 코드
  trackingNo: string | null;
  carrier: string | null;
  eta: string | null;        // YYYY-MM-DD
  raw: unknown;
};

/** 플랫폼 하나의 읽기 전용 어댑터. 쓰기(발주 확인 · 송장 입력 · 환불)는 만들지 않음 (스펙 F12 권한 원칙) */
export interface CommerceAdapter {
  source: CommerceSource;
  /** 연결 확인 (키가 맞는지). 실패하면 사람이 읽을 수 있는 메시지로 throw */
  test(): Promise<void>;
  /** since 이후 바뀐 주문 */
  fetchChanged(since: Date, until: Date): Promise<NormalizedOrder[]>;
  /** 주문번호 하나 실시간 조회 (AI 응대 중 "방금 주문했는데요" 같은 경우). 없으면 [] */
  fetchOrder(orderNo: string): Promise<NormalizedOrder[]>;
  /** 이 플랫폼 주문번호 형식인지 (아니면 실시간 조회를 건너뜀) */
  looksLike(orderNo: string): boolean;
}

export type PlatformDef = {
  source: CommerceSource;
  label: string;
  kind: 'api' | 'partner' | 'file';
  modes: ('api' | 'demo' | 'file')[];
  credentialFields: { key: string; label: string; secret: boolean; required?: boolean }[];
  adminUrl: string | null;
  adminHint: string;          // 요약 카드의 "처리 위치"
  note: string;
};

// 2026-11 기준 조사. partner = 공개 API가 없거나 솔루션사 제휴가 필요 → 지금은 판매자센터에서 내려받은 파일 업로드로
export const PLATFORMS: Record<CommerceSource, PlatformDef> = {
  naver: {
    source: 'naver', label: '네이버 스마트스토어', kind: 'api', modes: ['api', 'demo', 'file'],
    credentialFields: [
      { key: 'client_id', label: '애플리케이션 ID', secret: false, required: true },
      { key: 'client_secret', label: '애플리케이션 시크릿', secret: true, required: true },
      { key: 'account_id', label: '판매자 계정 ID (솔루션 연동일 때만)', secret: false, required: false },
    ],
    adminUrl: 'https://sell.smartstore.naver.com', adminHint: '스마트스토어센터 → 판매관리 / 클레임관리',
    note: '네이버 커머스API센터(apicenter.commerce.naver.com)에서 애플리케이션 등록 후 ID · 시크릿 발급',
  },
  coupang: {
    source: 'coupang', label: '쿠팡', kind: 'api', modes: ['api', 'demo', 'file'],
    credentialFields: [
      { key: 'vendor_id', label: '업체코드 (Vendor ID)', secret: false, required: true },
      { key: 'access_key', label: 'Access Key', secret: false, required: true },
      { key: 'secret_key', label: 'Secret Key', secret: true, required: true },
    ],
    adminUrl: 'https://wing.coupang.com', adminHint: '쿠팡 WING → 주문/배송 관리 · 반품/교환 관리',
    note: '쿠팡 WING → 판매자 정보 → 추가판매정보 → OPEN API 키 발급. 연락처는 안심번호로 올 수 있음',
  },
  musinsa: {
    source: 'musinsa', label: '무신사', kind: 'partner', modes: ['demo', 'file'], credentialFields: [],
    adminUrl: 'https://partner.musinsa.com', adminHint: '무신사 파트너센터 → 주문/클레임 관리',
    note: 'API는 지정 솔루션사(API 대행사)만 연동 가능. 파트너센터에서 주문 엑셀을 내려받아 업로드',
  },
  ably: {
    source: 'ably', label: '에이블리', kind: 'partner', modes: ['demo', 'file'], credentialFields: [],
    adminUrl: 'https://sellers.a-bly.com', adminHint: '에이블리 셀러스 → 주문 관리',
    note: "API 토큰은 '셀러스' 입점 유형만, 주로 통합솔루션 경유. 지금은 주문 엑셀 업로드",
  },
  baemin: {
    source: 'baemin', label: '배달의민족', kind: 'partner', modes: ['demo', 'file'], credentialFields: [],
    adminUrl: 'https://self.baemin.com', adminHint: '배민셀프서비스 · 배민사장님광장',
    note: '공개 API 없음 (POS · 주문중계 파트너 제휴). 지난 주문 내역을 내려받아 업로드',
  },
  coupangeats: {
    source: 'coupangeats', label: '쿠팡이츠', kind: 'partner', modes: ['demo', 'file'], credentialFields: [],
    adminUrl: 'https://store.coupangeats.com', adminHint: '쿠팡이츠 스토어 (사장님 포털)',
    note: '공개 API 없음 (POS 제휴). 주문 내역 파일 업로드',
  },
  yogiyo: {
    source: 'yogiyo', label: '요기요', kind: 'partner', modes: ['demo', 'file'], credentialFields: [],
    adminUrl: 'https://ceo.yogiyo.co.kr', adminHint: '요기요 사장님 사이트',
    note: '공개 API 없음 (POS 제휴 · 별도 승인). 주문 내역 파일 업로드',
  },
  csv: {
    source: 'csv', label: '직접 등록', kind: 'file', modes: ['file'], credentialFields: [],
    adminUrl: null, adminHint: '자체 쇼핑몰 · 직접 판매', note: '판매처를 정하지 않은 CSV · 구글 시트 업로드',
  },
};

export const platformLabel = (source: string) => PLATFORMS[source as CommerceSource]?.label ?? source;

/** 플랫폼마다 다른 전화번호 표기(01011115678, +82-10-1111-5678, 05071234567)를 통일 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('82') && d.length >= 11) d = `0${d.slice(2)}`;
  if (d.length === 11 && /^01\d/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10 && /^01\d/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 12 && d.startsWith('050')) return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length === 11 && d.startsWith('050')) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return raw.trim();
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  const d = phone.replace(/\D/g, '');
  if (d.length < 4) return '***';
  return `${d.slice(0, 3)}-****-${d.slice(-4)}`;
}

// 자유 텍스트 상태(엑셀 · CSV)를 공통 상태로. 순서가 중요 (요청이 완료보다 먼저, '배송 완료'가 '배송중'보다 먼저)
const TEXT_RULES: [RegExp, OrderStatus][] = [
  [/취소\s*(요청|신청|접수)/, '취소 요청'], [/취소/, '취소 완료'],
  [/반품\s*(요청|신청|접수|수거)/, '반품 요청'], [/반품/, '반품 완료'],
  [/교환\s*(요청|신청|접수|수거)/, '교환 요청'], [/교환/, '교환 완료'],
  [/구매\s*확정/, '구매 확정'], [/배송\s*완료|배달\s*완료|도착\s*완료/, '배송 완료'],
  [/배송\s*중|배달\s*중|배송\s*출발|출고\s*완료|발송\s*완료|집하/, '배송중'],
  [/상품\s*준비|출고\s*(준비|대기)|발송\s*(준비|대기)|발주\s*확인|조리/, '상품 준비중'],
  [/입금\s*대기|결제\s*대기|미입금/, '결제 대기'], [/결제\s*완료|신규\s*주문|주문\s*접수|입금\s*완료/, '결제 완료'],
];
export function normalizeStatusText(t: string | null | undefined): string {
  const s = (t ?? '').trim();
  if (!s) return '확인 중';
  if ((ORDER_STATUS as readonly string[]).includes(s)) return s;
  return TEXT_RULES.find(([re]) => re.test(s))?.[1] ?? s;
}

/** 택배사 코드 → 이름 (tracker.ts가 이름으로 택배사 ID를 찾음) */
const CARRIER_CODES: Record<string, string> = {
  CJGLS: 'CJ대한통운', CJ: 'CJ대한통운', HANJIN: '한진택배', LOTTE: '롯데택배', HYUNDAI: '롯데택배', EPOST: '우체국택배',
  KOREAPOST: '우체국택배', LOGEN: '로젠택배', KDEXP: '경동택배', DAESIN: '대신택배', ILYANG: '일양로지스', CVSNET: 'GS편의점택배', CUPOST: 'CU편의점택배',
};
export const carrierName = (code: string | null | undefined) => (code ? CARRIER_CODES[code.toUpperCase()] ?? code : null);

/** 같은 주문번호의 여러 줄(상품별 행)을 주문 하나로 합침 */
export function mergeLines(lines: NormalizedOrder[]): NormalizedOrder[] {
  const by = new Map<string, NormalizedOrder & { _items: string[]; _raw: unknown[] }>();
  for (const l of lines) {
    const cur = by.get(l.orderNo);
    if (!cur) { by.set(l.orderNo, { ...l, _items: l.items ? [l.items] : [], _raw: [l.raw] }); continue; }
    if (l.items) cur._items.push(l.items);
    cur._raw.push(l.raw);
    cur.amount = cur.amount == null && l.amount == null ? null : (cur.amount ?? 0) + (l.amount ?? 0);
    // 상품마다 상태가 다르면 진행이 덜 된 쪽(고객이 물어볼 가능성이 큰 쪽)을 대표로, 클레임은 항상 우선
    const rank = (s: string) => (/요청/.test(s) ? -1 : ORDER_STATUS.indexOf(s as OrderStatus));
    if (rank(l.status) < rank(cur.status)) { cur.status = l.status; cur.rawStatus = l.rawStatus; }
    cur.trackingNo ??= l.trackingNo; cur.carrier ??= l.carrier; cur.eta ??= l.eta;
    cur.customerName ??= l.customerName; cur.phone ??= l.phone; cur.email ??= l.email; cur.orderedAt ??= l.orderedAt;
  }
  return [...by.values()].map(({ _items, _raw, ...o }) => ({
    ...o,
    items: _items.length > 2 ? `${_items[0]} 외 ${_items.length - 1}건` : _items.join(', ') || null,
    raw: _raw.length === 1 ? _raw[0] : { lines: _raw, items: _items },
  }));
}

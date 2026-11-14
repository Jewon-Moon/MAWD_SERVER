// 판매자센터 주문 CSV/엑셀 내보내기 파서 (F13): 무신사 · 에이블리 · 배민 · 쿠팡이츠 · 요기요 · 자체 쇼핑몰 등 공용.
import { carrierName, mergeLines, normalizePhone, normalizeStatusText, type NormalizedOrder } from './types.js';

type Field =
  | 'orderNo'
  | 'customerName'
  | 'phone'
  | 'email'
  | 'items'
  | 'quantity'
  | 'amount'
  | 'orderedAt'
  | 'status'
  | 'trackingNo'
  | 'carrier'
  | 'eta';

const normHeader = (h: string) => h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_()-]/g, '');

const ALIASES: [Field, string[]][] = [
  ['orderNo', ['주문번호', '상품주문번호', '주문코드', '묶음배송번호', 'orderno', 'orderid', 'ordernumber']],
  ['customerName', ['구매자명', '주문자명', '고객명', '수령인명', '수취인명', '수취인이름', '주문자', '수령인', 'customername', 'buyername', 'receivername', 'name']],
  ['phone', ['구매자연락처', '주문자연락처', '구매자휴대폰', '주문자휴대폰', '수취인연락처', '수령인연락처', '안심번호', '연락처', '전화번호', '휴대폰번호', '휴대폰', 'phone', 'tel', 'mobile']],
  ['email', ['이메일', '구매자이메일', 'email']],
  ['items', ['상품명', '주문상품', '주문내역', '메뉴명', '메뉴', '품목', 'items', 'item', 'productname', 'product']],
  ['quantity', ['수량', '주문수량', 'qty', 'quantity']],
  ['amount', ['결제금액', '총결제금액', '주문금액', '최종결제금액', '상품금액', '판매가', '금액', 'amount', 'totalamount', 'price']],
  ['orderedAt', ['주문일시', '주문일', '결제일시', '결제일', 'orderedat', 'orderdate']],
  ['status', ['주문상태', '배송상태', '클레임상태', '처리상태', '상태', 'status']],
  ['trackingNo', ['송장번호', '운송장번호', '등기번호', 'trackingno', 'trackingnumber', 'invoiceno', 'invoicenumber']],
  ['carrier', ['택배사', '배송사', '택배사명', '배송업체', 'carrier', 'deliverycompany']],
  ['eta', ['도착예정일', '배송예정일', '발송기한', 'eta', 'expecteddeliverydate']],
];

const HEADER_MAP = new Map<string, Field>(ALIASES.flatMap(([f, keys]) => keys.map((k) => [k, f])));

/** RFC 4180 호환 CSV 토크나이저 (따옴표 안의 쉼표 · 줄바꿈 허용) */
export function parseCsvRows(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function parseAmount(raw: string | undefined): number | null | 'invalid' {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[,원₩\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return 'invalid';
  return Number(cleaned);
}

function parseDateVal(raw: string | undefined): Date | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const norm = s.replace(/\./g, '-').replace(' ', 'T');
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(norm) ? `${norm}T00:00:00+09:00` : norm);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseEta(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().replace(/\./g, '-');
  const m = s.match(/(\d{4}-\d{1,2}-\d{1,2})/);
  if (!m) return null;
  const [y, mo, da] = m[1]!.split('-');
  return `${y}-${mo!.padStart(2, '0')}-${da!.padStart(2, '0')}`;
}

export function parseOrdersCsv(csv: string): { orders: NormalizedOrder[]; skipped: number; errors: string[] } {
  const table = parseCsvRows(csv);
  if (table.length < 2) return { orders: [], skipped: 0, errors: table.length === 0 ? ['CSV 내용이 비어 있습니다.'] : ['데이터 행이 없습니다.'] };

  const headers = table[0]!;
  const colIndex = new Map<Field, number>();
  headers.forEach((h, i) => {
    const f = HEADER_MAP.get(normHeader(h));
    if (f && !colIndex.has(f)) colIndex.set(f, i);
  });
  if (!colIndex.has('orderNo')) {
    return { orders: [], skipped: table.length - 1, errors: ['헤더에 주문번호 열이 없습니다 (예: 주문번호, order_no).'] };
  }

  const lines: NormalizedOrder[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (let r = 1; r < table.length; r++) {
    const row = table[r]!;
    const lineNo = r + 1;
    const get = (f: Field) => {
      const idx = colIndex.get(f);
      return idx !== undefined ? (row[idx] ?? '').trim() : '';
    };
    const orderNo = get('orderNo');
    if (!orderNo) { skipped++; errors.push(`${lineNo}행: 주문번호 없음`); continue; }

    const amount = parseAmount(get('amount'));
    if (amount === 'invalid') { skipped++; errors.push(`${lineNo}행: 결제금액 형식 오류 (${get('amount')})`); continue; }

    const itemName = get('items');
    const qty = Number(get('quantity'));
    const items = itemName
      ? `${itemName}${Number.isFinite(qty) && qty > 1 && !itemName.includes(String(qty)) ? ` ${qty}개` : ''}`
      : null;

    const rawStatus = get('status') || null;
    const rawObj: Record<string, unknown> = Object.fromEntries(headers.map((h, i) => [h.trim() || `col_${i}`, row[i] ?? '']));
    const phone = normalizePhone(get('phone'));
    if (phone && /^050\d/.test(phone.replace(/\D/g, ''))) rawObj.virtual_phone = true;

    lines.push({
      orderNo,
      customerName: get('customerName') || null,
      phone,
      email: get('email') || null,
      items,
      amount,
      orderedAt: parseDateVal(get('orderedAt')),
      status: normalizeStatusText(rawStatus),
      rawStatus,
      trackingNo: get('trackingNo') || null,
      carrier: carrierName(get('carrier')) ?? (get('carrier') || null),
      eta: parseEta(get('eta')),
      raw: rawObj,
    });
  }

  return { orders: mergeLines(lines), skipped, errors };
}

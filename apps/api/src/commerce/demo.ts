// 데모 모드 어댑터: 키 없이 "여러 판매처를 같이 쓰는 매장"을 시연. 실제 API와 같은 인터페이스라 AI 쪽 코드는 구분하지 않음.
// 시나리오: 김고객(010-1111-5678)은 네이버 · 쿠팡 둘 다에서 구매, 쿠팡 주문 1234는 직접 등록 주문 1234와 번호가 겹침,
// 네이버 2026111499990001은 "방금 들어온 주문"이라 동기화 목록에는 없고 실시간 조회(fetchOrder)로만 찾힘
import type { CommerceSource } from '@mawd/contracts';
import type { CommerceAdapter, NormalizedOrder } from './types.js';

const day = 86_400_000;
const dateOnly = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
const o = (p: Partial<NormalizedOrder> & Pick<NormalizedOrder, 'orderNo' | 'status'>, agoDays: number): NormalizedOrder => ({
  customerName: null, phone: null, email: null, items: null, amount: null, rawStatus: null, trackingNo: null, carrier: null, eta: null, raw: { demo: true },
  orderedAt: new Date(Date.now() - agoDays * day), ...p,
});

export function demoOrders(source: CommerceSource): { listed: NormalizedOrder[]; liveOnly: NormalizedOrder[] } {
  switch (source) {
    case 'naver': return {
      listed: [
        o({ orderNo: '2026111210000001', customerName: '김고객', phone: '010-1111-5678', items: '라탄 바구니 (L)', amount: 27000, status: '배송중', rawStatus: 'DELIVERING', trackingNo: '6080-1122-3344', carrier: 'CJ대한통운', eta: dateOnly(1) }, 2),
        o({ orderNo: '2026111310000002', customerName: '박고객', phone: '010-3333-1212', items: '리넨 앞치마', amount: 19000, status: '상품 준비중', rawStatus: 'PAYED', eta: dateOnly(3) }, 1),
        o({ orderNo: '2026110810000003', customerName: '이고객', phone: '010-2222-9999', items: '원목 트레이', amount: 24000, status: '반품 요청', rawStatus: 'DELIVERED/RETURN_REQUEST' }, 6),
      ],
      liveOnly: [
        o({ orderNo: '2026111499990001', customerName: '김고객', phone: '010-1111-5678', items: '머그컵 세트', amount: 35000, status: '결제 완료', rawStatus: 'PAYED', eta: dateOnly(3) }, 0),
      ],
    };
    case 'coupang': return {
      listed: [
        o({ orderNo: '31000012345', customerName: '김고객', phone: '010-1111-5678', items: '스테인리스 텀블러 2개', amount: 36000, status: '배송 완료', rawStatus: 'FINAL_DELIVERY', trackingNo: '4012-5566-7788', carrier: '한진택배' }, 4),
        o({ orderNo: '1234', customerName: '최고객', phone: '010-4444-7777', items: '접이식 장바구니', amount: 12900, status: '배송중', rawStatus: 'DELIVERING', trackingNo: '4012-9900-1122', carrier: '한진택배', eta: dateOnly(1) }, 2),
      ],
      liveOnly: [],
    };
    case 'musinsa': return { listed: [o({ orderNo: 'M202611130001', customerName: '정고객', phone: '010-5555-2468', items: '오버핏 니트 (M)', amount: 59000, status: '교환 요청', rawStatus: '교환신청' }, 3)], liveOnly: [] };
    case 'ably': return { listed: [o({ orderNo: 'AB1311220', customerName: '한고객', phone: '010-6666-1357', items: '플리츠 스커트', amount: 32000, status: '배송중', trackingNo: '5512-0000-1111', carrier: '롯데택배', eta: dateOnly(1) }, 2)], liveOnly: [] };
    case 'baemin': return { listed: [o({ orderNo: 'B1NT00A1B2', customerName: '배고객', phone: '050-7123-4567', items: '로제 떡볶이 2인분', amount: 21000, status: '배송 완료', raw: { demo: true, virtual_phone: true } }, 0)], liveOnly: [] };
    case 'coupangeats': return { listed: [o({ orderNo: 'CE7A2X9K', customerName: '쿠고객', phone: '050-7999-1234', items: '치즈 김밥 3줄', amount: 13500, status: '배송중', raw: { demo: true, virtual_phone: true } }, 0)], liveOnly: [] };
    case 'yogiyo': return { listed: [o({ orderNo: 'YG10293847', customerName: '요고객', phone: '050-7555-9876', items: '순살 치킨', amount: 22000, status: '상품 준비중', raw: { demo: true, virtual_phone: true } }, 0)], liveOnly: [] };
    default: return { listed: [], liveOnly: [] };
  }
}

export function createDemoAdapter(source: CommerceSource): CommerceAdapter {
  const all = () => { const d = demoOrders(source); return [...d.listed, ...d.liveOnly]; };
  return {
    source,
    async test() {},
    async fetchChanged() { return demoOrders(source).listed; },
    async fetchOrder(orderNo) { return all().filter((x) => x.orderNo === orderNo); },
    looksLike: (no) => no.length >= 4,
  };
}

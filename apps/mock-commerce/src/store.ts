// 더미 커머스 스토어 저장소: 네이버 스마트스토어 · 쿠팡 호환 API 응답과 시연용 주문/문의 관리를 동시에 지원합니다.
export type MockPlatform = 'naver' | 'coupang';

export type MockOrderStatus =
  | '결제 완료'
  | '상품 준비중'
  | '배송중'
  | '배송 완료'
  | '취소 요청'
  | '반품 요청'
  | '교환 요청';

export interface MockOrder {
  id: string;
  platform: MockPlatform;
  orderNo: string;
  productOrderId: string;
  customerName: string;
  phone: string;
  itemName: string;
  quantity: number;
  amount: number;
  status: MockOrderStatus;
  carrier: string | null;
  trackingNo: string | null;
  eta: string | null;
  orderedAt: string;
  updatedAt: string;
}

export interface MockInquiry {
  id: string;
  chatId: string;
  platform: MockPlatform | null;
  orderNo: string | null;
  customerName: string;
  question: string;
  aiReply: string | null;
  aiState: string | null;
  handedOff: boolean;
  createdAt: string;
}

// 네이버 커머스 API는 client_secret 자리에 bcrypt salt 문자열을 요구함 (apps/api/src/commerce/naver.ts)
export const DEMO_CREDS = {
  naver: {
    client_id: 'demo_naver_client',
    client_secret: '$2a$04$N9qo8uLOickgx2ZMRZoMye',
    account_id: 'demo_seller_01',
  },
  coupang: {
    vendor_id: 'A00123456',
    access_key: 'demo_coupang_access',
    secret_key: 'demo_coupang_secret',
  },
} as const;

const CARRIER_TO_NAVER: Record<string, string> = {
  CJ대한통운: 'CJGLS',
  한진택배: 'HANJIN',
  롯데택배: 'LOTTE',
  로젠택배: 'LOGEN',
  우체국택배: 'EPOST',
};

const NAVER_STATUS: Record<MockOrderStatus, { productOrderStatus: string; claimStatus?: string; placeOrderStatus?: string }> = {
  '결제 완료': { productOrderStatus: 'PAYED' },
  '상품 준비중': { productOrderStatus: 'PAYED', placeOrderStatus: 'OK' },
  배송중: { productOrderStatus: 'DELIVERING' },
  '배송 완료': { productOrderStatus: 'DELIVERED' },
  '취소 요청': { productOrderStatus: 'PAYED', claimStatus: 'CANCEL_REQUEST' },
  '반품 요청': { productOrderStatus: 'DELIVERED', claimStatus: 'RETURN_REQUEST' },
  '교환 요청': { productOrderStatus: 'DELIVERED', claimStatus: 'EXCHANGE_REQUEST' },
};

const COUPANG_STATUS: Record<MockOrderStatus, string> = {
  '결제 완료': 'ACCEPT',
  '상품 준비중': 'INSTRUCT',
  배송중: 'DELIVERING',
  '배송 완료': 'FINAL_DELIVERY',
  '취소 요청': 'ACCEPT',
  '반품 요청': 'FINAL_DELIVERY',
  '교환 요청': 'FINAL_DELIVERY',
};

const dayMs = 86_400_000;
const kstYmd = (offsetDays = 0) => new Date(Date.now() + offsetDays * dayMs + 9 * 3600_000).toISOString().slice(0, 10);
const padSeq = (n: number) => String(n).padStart(4, '0');

export function toNaverDetail(o: MockOrder) {
  const st = NAVER_STATUS[o.status] ?? { productOrderStatus: 'PAYED' };
  return {
    order: {
      orderId: o.orderNo,
      ordererName: o.customerName,
      ordererTel: o.phone,
      orderDate: o.orderedAt,
      paymentDate: o.orderedAt,
    },
    productOrder: {
      productOrderId: o.productOrderId,
      productOrderStatus: st.productOrderStatus,
      ...(st.claimStatus ? { claimStatus: st.claimStatus } : {}),
      ...(st.placeOrderStatus ? { placeOrderStatus: st.placeOrderStatus } : {}),
      productName: o.itemName,
      quantity: o.quantity,
      totalPaymentAmount: o.amount,
      shippingAddress: { name: o.customerName, tel1: o.phone },
      ...(o.eta ? { expectedDeliveryDate: `${o.eta}T18:00:00+09:00` } : {}),
    },
    delivery: o.trackingNo
      ? {
          deliveryCompany: (o.carrier && CARRIER_TO_NAVER[o.carrier]) || o.carrier || 'CJGLS',
          trackingNumber: o.trackingNo,
          deliveryStatus: o.status === '배송 완료' ? 'DELIVERED' : 'DELIVERING',
        }
      : undefined,
  };
}

export function toCoupangSheet(o: MockOrder) {
  return {
    orderId: Number(o.orderNo) || o.orderNo,
    orderedAt: o.orderedAt,
    status: COUPANG_STATUS[o.status] ?? 'ACCEPT',
    invoiceNumber: o.trackingNo ?? '',
    deliveryCompanyName: o.carrier ?? '',
    estimatedShippingDate: o.eta ?? undefined,
    orderer: { name: o.customerName, ordererNumber: o.phone },
    receiver: { name: o.customerName, receiverNumber: o.phone },
    orderItems: [{ vendorItemName: o.itemName, shippingCount: o.quantity, orderPrice: o.amount }],
  };
}

export function createMockCommerceStore() {
  let seq = 100;
  const orders = new Map<string, MockOrder>();
  const inquiries: MockInquiry[] = [];

  const nextOrderNo = (platform: MockPlatform) => {
    seq += 1;
    const datePrefix = kstYmd(0).replace(/-/g, '');
    return platform === 'naver' ? `${datePrefix}1000${padSeq(seq)}` : `3100001${padSeq(seq)}`;
  };

  const nextTrackingNo = () => `${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;

  function seed() {
    orders.clear();
    const now = Date.now();
    const initial: Omit<MockOrder, 'id' | 'productOrderId'>[] = [
      {
        platform: 'naver',
        orderNo: `${kstYmd(-2).replace(/-/g, '')}10000001`,
        customerName: '김고객',
        phone: '010-1111-5678',
        itemName: '라탄 바구니 (L)',
        quantity: 1,
        amount: 27000,
        status: '배송중',
        carrier: 'CJ대한통운',
        trackingNo: '6080-1122-3344',
        eta: kstYmd(1),
        orderedAt: new Date(now - 2 * dayMs).toISOString(),
        updatedAt: new Date(now - 3600_000).toISOString(),
      },
      {
        platform: 'naver',
        orderNo: `${kstYmd(-1).replace(/-/g, '')}10000002`,
        customerName: '박고객',
        phone: '010-3333-1212',
        itemName: '리넨 앞치마',
        quantity: 1,
        amount: 19000,
        status: '상품 준비중',
        carrier: null,
        trackingNo: null,
        eta: kstYmd(2),
        orderedAt: new Date(now - dayMs).toISOString(),
        updatedAt: new Date(now - 1800_000).toISOString(),
      },
      {
        platform: 'coupang',
        orderNo: '31000012345',
        customerName: '김고객',
        phone: '010-1111-5678',
        itemName: '스테인리스 텀블러',
        quantity: 2,
        amount: 36000,
        status: '배송 완료',
        carrier: '한진택배',
        trackingNo: '4012-5566-7788',
        eta: kstYmd(0),
        orderedAt: new Date(now - 3 * dayMs).toISOString(),
        updatedAt: new Date(now - 7200_000).toISOString(),
      },
      {
        platform: 'coupang',
        orderNo: '31000012346',
        customerName: '최고객',
        phone: '010-4444-7777',
        itemName: '접이식 장바구니',
        quantity: 1,
        amount: 12900,
        status: '결제 완료',
        carrier: null,
        trackingNo: null,
        eta: kstYmd(2),
        orderedAt: new Date(now - 600_000).toISOString(),
        updatedAt: new Date(now - 600_000).toISOString(),
      },
    ];
    initial.forEach((row, i) => {
      const id = `ord-${i + 1}`;
      orders.set(id, { ...row, id, productOrderId: `${row.orderNo}-01` });
    });
  }

  seed();

  return {
    listOrders: () => [...orders.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    listInquiries: () => [...inquiries],
    addOrder(input: {
      platform: MockPlatform;
      orderNo?: string;
      customerName: string;
      phone: string;
      itemName: string;
      quantity?: number;
      amount: number;
      status: MockOrderStatus;
      carrier?: string | null;
      trackingNo?: string | null;
      eta?: string | null;
    }): MockOrder {
      const now = new Date().toISOString();
      const orderNo = input.orderNo?.trim() || nextOrderNo(input.platform);
      const id = `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const needsTrack = input.status === '배송중' || input.status === '배송 완료';
      const trackingNo = input.trackingNo?.trim() || (needsTrack ? nextTrackingNo() : null);
      const carrier = input.carrier?.trim() || (needsTrack ? (input.platform === 'coupang' ? '한진택배' : 'CJ대한통운') : null);
      const order: MockOrder = {
        id,
        platform: input.platform,
        orderNo,
        productOrderId: `${orderNo}-01`,
        customerName: input.customerName.trim(),
        phone: input.phone.trim(),
        itemName: input.itemName.trim(),
        quantity: Math.max(1, input.quantity ?? 1),
        amount: Math.max(0, Math.round(input.amount)),
        status: input.status,
        carrier,
        trackingNo,
        eta: input.eta?.trim() || kstYmd(2),
        orderedAt: now,
        updatedAt: now,
      };
      orders.set(id, order);
      return order;
    },
    updateOrder(id: string, patch: Partial<Pick<MockOrder, 'status' | 'carrier' | 'trackingNo' | 'eta'>>): MockOrder | null {
      const cur = orders.get(id);
      if (!cur) return null;
      const nextStatus = patch.status ?? cur.status;
      const needsTrack = nextStatus === '배송중' || nextStatus === '배송 완료';
      const next: MockOrder = {
        ...cur,
        status: nextStatus,
        carrier: patch.carrier !== undefined ? patch.carrier : (cur.carrier || (needsTrack ? (cur.platform === 'coupang' ? '한진택배' : 'CJ대한통운') : null)),
        trackingNo: patch.trackingNo !== undefined ? patch.trackingNo : (cur.trackingNo || (needsTrack ? nextTrackingNo() : null)),
        eta: patch.eta !== undefined ? patch.eta : cur.eta,
        updatedAt: new Date().toISOString(),
      };
      orders.set(id, next);
      return next;
    },
    deleteOrder: (id: string) => orders.delete(id),
    findNaverChanged(from: Date, to: Date) {
      return [...orders.values()]
        .filter((o) => o.platform === 'naver' && new Date(o.updatedAt) >= from && new Date(o.updatedAt) <= to)
        .map((o) => ({ productOrderId: o.productOrderId }));
    },
    queryNaverProductOrders(ids: string[]) {
      const set = new Set(ids);
      return [...orders.values()].filter((o) => o.platform === 'naver' && set.has(o.productOrderId)).map(toNaverDetail);
    },
    findNaverProductOrderIds(orderNo: string) {
      return [...orders.values()]
        .filter((o) => o.platform === 'naver' && (o.orderNo === orderNo || o.productOrderId === orderNo))
        .map((o) => o.productOrderId);
    },
    queryCoupangSheets(status: string, fromYmd?: string, toYmd?: string) {
      return [...orders.values()]
        .filter((o) => o.platform === 'coupang' && COUPANG_STATUS[o.status] === status)
        .filter((o) => {
          const ymd = new Date(new Date(o.orderedAt).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
          return (!fromYmd || ymd >= fromYmd) && (!toYmd || ymd <= toYmd);
        })
        .map(toCoupangSheet);
    },
    findCoupangSheet(orderNo: string) {
      return [...orders.values()].filter((o) => o.platform === 'coupang' && o.orderNo === orderNo).map(toCoupangSheet);
    },
    addInquiry(inq: Omit<MockInquiry, 'id' | 'createdAt'>): MockInquiry {
      const item: MockInquiry = { ...inq, id: `inq-${Date.now()}`, createdAt: new Date().toISOString() };
      inquiries.unshift(item);
      if (inquiries.length > 50) inquiries.length = 50;
      return item;
    },
    reset() {
      seed();
      inquiries.length = 0;
    },
  };
}

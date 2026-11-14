// 초기 세팅용 업종 템플릿: 회원가입 후 업종을 고르면 매장 문서(소개 · 상품 · 정책) · FAQ · 문의 카테고리 초안을 채움.
// 사장님은 이 초안을 매장 문서 편집기에서 고쳐 쓰면 됨. 값은 예시라 [대괄호] 부분을 바꾸도록 안내
import type { z } from 'zod';
import type { BusinessDocFields, Category, Faq, OfferingsDocFields, PoliciesDocFields } from '@mawd/contracts';

type Tpl = {
  id: string; name: string; description: string;
  business: Omit<z.infer<typeof BusinessDocFields>, 'description'> & { description: string };
  offerings: z.infer<typeof OfferingsDocFields>;
  policies: z.infer<typeof PoliciesDocFields>;
  faqs: Omit<z.infer<typeof Faq>, 'id'>[];
  categories: Omit<z.infer<typeof Category>, 'id'>[];
  orderLookup: boolean; // 주문 · 배송 조회를 쓰는 업종인지 (데이터 조회 설정)
};

const cat = (name: string, description: string, routing: 'auto' | 'approve' | 'intake_only', sort: number) => ({ name, description, routing, enabled: true, sort });

export const TEMPLATES: Tpl[] = [
  {
    id: 'online_shop', name: '온라인 쇼핑몰', description: '스마트스토어 · 자사몰 · 쿠팡 등에서 상품을 파는 매장',
    business: { industry: 'online_shop', industry_detail: '[취급 품목] 온라인 쇼핑몰', description: '[무엇을 파는지 한두 문장으로] 자사몰과 스마트스토어에서 판매합니다. 온라인 전용(물류 창고 출고)으로 운영되어 별도의 오프라인 매장은 두고 있지 않으며, 온라인 주문은 24시간 가능합니다.', customers: '[주요 고객층]', service_area: '전국 택배 ([택배사]). 제주 · 도서산간 추가 배송비 (오프라인 매장 없음, 온라인 전용)' },
    offerings: { items: [{ name: '[대표 상품]', kind: 'product', price: '[가격]', description: '[소재 · 사이즈 · 옵션]', available: true }] },
    policies: { shipping: '배송비 [3,000원] ([3만 원] 이상 무료). 평일 오후 [2시] 전 주문은 당일 출고, 배송 1~3일.', returns: '단순 변심 교환 · 반품은 수령 후 7일 이내, 왕복 배송비 고객 부담. 불량 · 오배송은 무료 교환.', refunds: '반품 상품 확인 후 영업일 3일 안에 결제 수단으로 환불.', other: '' },
    faqs: [
      { question: '운영시간과 오프라인 매장이 있나요?', answer: '별도의 오프라인 매장은 운영하지 않는 온라인 전용(물류 창고 출고) 상점입니다. 온라인 주문은 24시간 가능하며, 고객센터 상담 운영시간은 평일 10:00~19:00(주말·공휴일 휴무)입니다.', enabled: true },
      { question: '배송은 얼마나 걸리나요?', answer: '평일 오후 2시 전 주문은 당일 출고되고, 보통 1~3일 안에 받으실 수 있어요.', enabled: true },
      { question: '교환이나 반품은 어떻게 하나요?', answer: '받으신 날부터 7일 안에 주문번호와 함께 문의 주시면 안내해 드려요. 단순 변심은 왕복 배송비가 있어요.', enabled: true },
    ],
    categories: [cat('배송', '배송 지연, 송장, 도착 예정', 'auto', 1), cat('교환·반품', '사이즈 교환, 반품, 불량', 'approve', 2), cat('환불', '환불 요청, 결제 취소', 'approve', 3), cat('상품 문의', '소재, 사이즈, 재입고', 'auto', 4), cat('기타', '그 밖의 문의', 'auto', 5)],
    orderLookup: true,
  },
  {
    id: 'food_beverage', name: '음식 · 카페', description: '카페 · 음식점 · 배달 매장',
    business: { industry: 'food_beverage', industry_detail: '[메뉴 특징] 카페', description: '[매장 소개] 매장 이용과 포장 · 배달을 함께 운영합니다.', customers: '[주요 고객층]', service_area: '[매장 주소] / 배달 가능 지역 [동네]' },
    offerings: { items: [{ name: '[대표 메뉴]', kind: 'product', price: '[가격]', description: '[재료 · 알레르기 정보]', available: true }] },
    policies: { shipping: '배달은 [배달앱] 주문으로만 받아요. 최소 주문 금액 [15,000원].', returns: '음식은 단순 변심 교환 · 환불이 어려워요. 잘못 나간 메뉴는 바로 다시 만들어 드려요.', refunds: '주문 취소는 조리 시작 전까지 가능해요.', other: '예약은 [인원] 이상 단체만 받아요. 주차 [가능 여부].' },
    faqs: [
      { question: '영업시간이 어떻게 되나요?', answer: '[요일] [시간]까지 영업해요.', enabled: true },
      { question: '주차 가능한가요?', answer: '[주차 안내]', enabled: true },
    ],
    categories: [cat('메뉴', '메뉴, 재료, 알레르기', 'auto', 1), cat('예약', '단체 예약, 대관', 'approve', 2), cat('배달', '배달 지연, 누락', 'auto', 3), cat('불만', '맛, 위생, 서비스 불만', 'approve', 4), cat('기타', '그 밖의 문의', 'auto', 5)],
    orderLookup: false,
  },
  {
    id: 'beauty', name: '뷰티 · 미용', description: '미용실 · 네일 · 피부관리 등 예약형 매장',
    business: { industry: 'beauty', industry_detail: '[시술 분야] 전문 [미용실]', description: '[매장 소개] 100% 예약제로 운영합니다.', customers: '[주요 고객층]', service_area: '[매장 주소]' },
    offerings: { items: [{ name: '[대표 시술]', kind: 'service', price: '[가격]~', description: '[소요 시간 · 기장 추가 요금]', available: true }] },
    policies: { shipping: '', returns: '시술 후 [7일] 안에 불편한 점이 있으면 무료로 다시 손봐 드려요.', refunds: '시술 후 환불은 어렵고, 선결제 이용권은 [남은 횟수 기준]으로 환불해요.', other: '예약 변경 · 취소는 [전날]까지 부탁드려요. 당일 취소 · 노쇼는 다음 예약이 제한될 수 있어요.' },
    faqs: [
      { question: '예약은 어떻게 하나요?', answer: '[네이버 예약 · 전화]로 예약하실 수 있어요.', enabled: true },
      { question: '예약 변경이 되나요?', answer: '전날까지 말씀 주시면 변경해 드려요.', enabled: true },
    ],
    categories: [cat('예약', '예약, 변경, 취소', 'auto', 1), cat('시술 문의', '가격, 소요 시간, 디자인', 'auto', 2), cat('불만·재시술', '시술 결과 불만, 재시술 요청', 'approve', 3), cat('환불', '이용권 환불', 'approve', 4), cat('기타', '그 밖의 문의', 'auto', 5)],
    orderLookup: false,
  },
  {
    id: 'education', name: '교육 · 클래스', description: '학원 · 원데이 클래스 · 온라인 강의',
    business: { industry: 'education', industry_detail: '[분야] 클래스', description: '[수업 소개] 수강 신청부터 수업 일정까지 안내해 드려요.', customers: '[수강 대상]', service_area: '[수업 장소 또는 온라인]' },
    offerings: { items: [{ name: '[대표 강좌]', kind: 'plan', price: '[수강료]', description: '[기간 · 횟수 · 준비물]', available: true }] },
    policies: { shipping: '', returns: '', refunds: '수업 시작 [7일] 전까지 전액 환불, 이후에는 [규정]에 따라 남은 회차 기준으로 환불해요.', other: '결석 시 보강은 [규정]. 수업 자료는 [제공 방법].' },
    faqs: [
      { question: '수강 신청은 어떻게 하나요?', answer: '[신청 방법]으로 신청하실 수 있어요.', enabled: true },
      { question: '환불 규정이 어떻게 되나요?', answer: '수업 시작 7일 전까지는 전액 환불돼요. 이후에는 남은 회차 기준으로 안내해 드려요.', enabled: true },
    ],
    categories: [cat('수강 신청', '신청, 일정, 정원', 'auto', 1), cat('수업 문의', '내용, 난이도, 준비물', 'auto', 2), cat('환불', '수강료 환불', 'approve', 3), cat('불만', '수업 불만', 'approve', 4), cat('기타', '그 밖의 문의', 'auto', 5)],
    orderLookup: false,
  },
  {
    id: 'other', name: '기타', description: '목록에 없는 업종 (빈 양식으로 시작)',
    business: { industry: 'other', industry_detail: '[업종]', description: '[무엇을 하는 곳인지 한두 문장으로]', customers: '', service_area: '' },
    offerings: { items: [] },
    policies: { shipping: '', returns: '', refunds: '', other: '' },
    faqs: [],
    categories: [cat('일반 문의', '서비스 이용 문의', 'auto', 1), cat('불만', '불만, 환불 요청', 'approve', 2), cat('기타', '그 밖의 문의', 'auto', 3)],
    orderLookup: false,
  },
];
export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null;

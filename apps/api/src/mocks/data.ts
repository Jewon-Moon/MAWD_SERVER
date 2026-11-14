// 목 데이터 (§14.4): 프론트가 실제 구현 전에 화면을 만들 수 있게 고정 응답을 제공합니다.
// 실제 구현으로 바꿀 때 응답 모양은 유지합니다.
import type { AllSettings, Me } from '@mawd/contracts';
import type { z } from 'zod';
import type * as C from '@mawd/contracts';

const now = '2026-11-12T03:00:00.000Z';
export const TENANT_ID = '11111111-1111-4111-8111-111111111111';

export const me: Me = {
  user: { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.com' },
  tenant: { id: TENANT_ID, name: '데모 상점' },
  integrations: { channeltalk: true, stibee: false },
  onboarding: { channeltalk: true, documents: true, test_message: false },
  setup: { done: true, template: 'online_shop' },
};

// 매장 생성 시 기본값 (실제 구현에서도 이 값을 시드로 사용)
export const defaultSettings: AllSettings = {
  response: {
    ai_enabled: true,
    channels: { chat: true, call: true },
    heat_threshold: 40,
    heat_labels: { high: 40, very_high: 70 },
    min_confidence: 0.6,
    require_grounding: true,
    max_ai_replies_per_inquiry: 5,
    owner_reply_sla_minutes: 60,
    chat_idle_minutes: 10,
    debounce_seconds: 5,
    ai_disclosure: { enabled: true, text: 'AI 상담 도우미입니다.' },
  },
  persona: {
    assistant_name: '도우미',
    formality: 'polite',
    emoji: false,
    max_reply_chars: 300,
    style_notes: '',
    banned_phrases: ['환불해 드리겠습니다', '보상해 드리겠습니다', '책임지겠습니다'],
  },
  hours: {
    timezone: 'Asia/Seoul',
    weekly: {
      mon: [{ open: '10:00', close: '19:00' }], tue: [{ open: '10:00', close: '19:00' }],
      wed: [{ open: '10:00', close: '19:00' }], thu: [{ open: '10:00', close: '19:00' }],
      fri: [{ open: '10:00', close: '19:00' }], sat: [], sun: [],
    },
    holidays: [],
  },
  notifications: {
    channeltalk_team_chat: { enabled: true, group_id: null },
    events: { pending_card: true, heated: true, handoff: true, call_ended: true, issue_suggested: true },
    min_heat_to_notify: 0,
    quiet_hours: { enabled: false, start: '22:00', end: '08:00' },
    priority: { urgent_heat_gte: 70, high_heat_gte: 40, risk_flag_is_urgent: true, handoff_is_high: true },
    alert_styles: {
      urgent: { display: 'modal', sound: true },
      high: { display: 'banner', sound: false },
      normal: { display: 'badge', sound: false },
    },
    push: { enabled: true, priorities: ['urgent', 'high'] },
  },
  voice: {
    enabled: true,
    tts: {
      engine: 'vapi', voice_name: 'coral', rate: 1.2, pitch: 1,
      instructions: '한국 온라인 쇼핑몰의 친절한 고객센터 상담원. 차분하고 따뜻한 목소리로 공감하며 말한다. 자연스러운 서울 표준어 억양.',
    },
    vapi_voice: { provider: 'azure', voice_id: 'ko-KR-SunHiNeural', model: null },
    transcriber: 'deepgram',
    keyterms: [],
    noise_suppression: 'standard',
    silence_ms: 1200,
    filler: { enabled: true, phrases: ['네, 확인해 볼게요.', '잠시만요.'] },
    barge_in: true,
    abuse_turn_limit: 3,
    max_call_minutes: 10,
    recording_notice: true,
  },
  ai: {
    model: 'liner-gpt-router',
    routing: { chat_reply: 'quality', voice_reply: 'cost', card_summary: 'quality', mail_draft: 'balanced' },
    judge: 'bivia',
    rag: { top_k: 6, include_all_under_chars: 6000 },
    monthly_budget_usd: null,
  },
  'data-access': {
    enabled: true,
    tools: { lookup_order: true, find_orders: true, customer_history: true, track_shipment: true },
    verification_methods: ['profile_match', 'order_no_last4'],
    max_verify_attempts: 3,
    max_lookups_per_inquiry: 10,
    exposed_fields: ['status', 'eta', 'items', 'amount', 'tracking_no', 'carrier', 'delivery'],
  },
  issues: { enabled: true, min_inquiries: 3, window_hours: 24, categories: [], default_recipients: 'involved' },
  instagram: { enabled: true, auto_hide: 'abusive', hide_heat_gte: 80, auto_reply: true },
};

type Row<T extends z.ZodTypeAny> = z.infer<T>;
export const defaultCategories: Row<typeof C.Category>[] = [
  { id: 'dddddddd-0000-4000-8000-000000000001', name: '배송', description: '배송 지연, 송장, 도착일 문의', routing: 'auto', enabled: true, sort: 1 },
  { id: 'dddddddd-0000-4000-8000-000000000002', name: '환불·교환', description: '환불, 교환, 반품 요청', routing: 'approve', enabled: true, sort: 2 },
  { id: 'dddddddd-0000-4000-8000-000000000003', name: '오류·장애', description: '불량품, 서비스 오류', routing: 'approve', enabled: true, sort: 3 },
  { id: 'dddddddd-0000-4000-8000-000000000004', name: '사용법', description: '사용 방법, 영업시간, 일반 안내', routing: 'auto', enabled: true, sort: 4 },
  { id: 'dddddddd-0000-4000-8000-000000000005', name: '기타', description: '위에 해당하지 않는 문의', routing: 'intake_only', enabled: true, sort: 99 },
];

export const defaultRules: Row<typeof C.EscalationRule>[] = [
  { id: 'eeeeeeee-0000-4000-8000-000000000001', name: '법적 조치 언급', enabled: true, match: { keywords: ['소송', '고소', '소비자원', '변호사'] }, action: 'handoff', risk_flag: '법적 조치 언급', notify: true, priority: 1 },
  { id: 'eeeeeeee-0000-4000-8000-000000000002', name: '매우 격앙', enabled: true, match: { heat_gte: 85 }, action: 'approve', risk_flag: '매우 격앙', notify: true, priority: 2 },
];

export const defaultTemplates: Row<typeof C.Template>[] = [
  { kind: 'greeting', channel: 'call', text: '안녕하세요, {store_name} AI 상담원 {assistant_name}입니다. 통화는 녹음됩니다. 무엇을 도와드릴까요?' },
  { kind: 'intake', channel: 'all', text: '문의 접수되었습니다. 담당자가 확인 후 {sla} 안에 안내드리겠습니다.' },
  { kind: 'calm', channel: 'all', text: '많이 불편하셨을 것 같아요. 말씀해 주신 내용을 정리해서 담당자에게 바로 전달하겠습니다.' },
  { kind: 'handoff', channel: 'all', text: '이 부분은 담당자가 직접 확인해야 합니다. {sla} 안에 연락드리겠습니다.' },
  { kind: 'handoff_followup', channel: 'all', text: '그 부분도 담당자에게 함께 전달해 둘게요. 다른 궁금한 점이 있으면 편하게 말씀해 주세요.' },
  { kind: 'off_hours', channel: 'all', text: '이 부분은 담당자 확인이 필요해요. 지금은 영업시간이 아니어서 {next_open}에 담당자가 확인하고 연락드릴게요. 그 전에 궁금한 점은 제가 계속 도와드릴게요.' },
  { kind: 'verify_request', channel: 'all', text: '확인을 위해 주문번호와 연락처 뒷 4자리를 알려주세요.' },
  { kind: 'verify_failed', channel: 'all', text: '입력하신 정보로 주문을 찾지 못했습니다. 다시 확인해 주세요.' },
  { kind: 'call_close', channel: 'call', text: '말씀하신 내용으로 접수했습니다. 감사합니다.' },
  { kind: 'abuse_warning', channel: 'all', text: '원활한 상담을 위해 표현을 조금만 순화해 주시겠어요?' },
  { kind: 'abuse_end', channel: 'all', text: '상담을 이어가기 어려워 여기서 마무리할게요. 남겨주신 내용은 담당자에게 전달됩니다.' },
];

export const defaultFaqs: Row<typeof C.Faq>[] = [
  {
    id: 'ffffffff-0000-4000-8000-000000000001',
    question: '운영시간과 오프라인 매장이 있나요?',
    answer: '별도의 오프라인 매장은 운영하지 않는 온라인 전용(물류 창고 출고) 상점입니다. 온라인 주문은 24시간 가능하며, 고객센터 상담 운영시간은 평일 10:00~19:00(주말·공휴일 휴무)입니다.',
    enabled: true,
  },
];

/** 매장 문서(MD) 기본값: 템플릿 모드 입력값. 저장한 적 없는 매장은 이 값으로 MD를 만들어 씀 (데모 상점 기준) */
export const defaultContextFields = {
  business: {
    industry: 'online_shop',
    industry_detail: '생활 · 주방용품 온라인 쇼핑몰',
    description: '머그컵 · 텀블러 · 접시 같은 생활 주방용품을 직접 골라 파는 온라인 쇼핑몰입니다. 자체 사이트와 스마트스토어에서 판매합니다. 온라인 전용(물류 창고 출고)으로 운영되어 별도의 오프라인 매장은 두고 있지 않으며, 온라인 주문은 24시간 가능합니다.',
    customers: '20~30대 1인 가구 · 선물 구매 고객',
    service_area: '전국 택배 (CJ대한통운). 제주 · 도서산간 3,000원 추가 (오프라인 매장 없음, 온라인 전용)',
  },
  offerings: {
    items: [
      { name: '머그컵', kind: 'product', price: '16,000원', description: '350ml 도자기, 전자레인지 · 식기세척기 사용 가능. 화이트 · 베이지 · 네이비', available: true },
      { name: '텀블러', kind: 'product', price: '18,000원', description: '500ml 스테인리스 진공 보온 · 보냉 6시간. 뚜껑은 식기세척기 불가', available: true },
      { name: '머그컵 2개 세트', kind: 'product', price: '29,000원', description: '같은 색 2개 + 선물 포장', available: false },
    ],
  },
  policies: {
    shipping: '배송비 3,000원 (3만 원 이상 무료). 평일 오후 2시 전 주문은 당일 출고, 배송 1~3일.',
    returns: '단순 변심 교환 · 반품은 수령 후 7일 이내, 왕복 배송비 6,000원 고객 부담. 불량 · 파손은 사진 확인 후 무료 교환.',
    refunds: '반품 상품 확인 후 영업일 3일 안에 결제 수단으로 환불.',
    other: '',
  },
} as const;

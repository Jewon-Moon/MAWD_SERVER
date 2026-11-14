// 매장별 세부 설정 (SaaS 테넌트 설정). 모든 섹션은 GET /settings/{section}, PATCH /settings/{section} (부분 수정).
// 목록형 설정(카테고리, 에스컬레이션 규칙, 템플릿, FAQ)은 별도 리소스로 CRUD 합니다.
import { z } from 'zod';

const id = z.string().uuid();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const ChannelKind = z.enum(['chat', 'call']);
export const RoutingStrategy = z.enum(['cost', 'balanced', 'quality']);

// ---------- 섹션형 설정 ----------

/** 응대 정책: AI가 언제 직접 답하고 언제 사장님에게 넘기는지 */
export const ResponsePolicy = z.object({
  ai_enabled: z.boolean().describe('AI 응대 전체 스위치. false면 모든 문의를 카드로만 전달'),
  channels: z.object({ chat: z.boolean(), call: z.boolean() }).describe('채널별 AI 응대 켜기/끄기'),
  heat_threshold: z.number().int().min(0).max(100).describe('이 점수 이상이면 격앙(B) 처리'),
  heat_labels: z.object({
    high: z.number().int().min(0).max(100),
    very_high: z.number().int().min(0).max(100),
  }).describe('카드에 보여줄 라벨 경계 (보통 < high ≤ 높음 < very_high ≤ 매우 높음)'),
  min_confidence: z.number().min(0).max(1).describe('판단 확신이 이보다 낮으면 보류(C)'),
  require_grounding: z.boolean().describe('정책 문서 · 데이터 근거가 없으면 자동 답변 금지'),
  max_ai_replies_per_inquiry: z.number().int().min(1).max(50).describe('한 문의에서 AI가 보낼 수 있는 최대 메시지 수'),
  owner_reply_sla_minutes: z.number().int().min(5).max(4320).describe('고객에게 안내할 사장님 답변 예정 시간 ({sla} 변수)'),
  chat_idle_minutes: z.number().int().min(1).max(1440).describe('채팅에서 고객이 이만큼 말이 없으면 대화를 마무리하고 요약 카드 생성'),
  debounce_seconds: z.number().int().min(1).max(30).describe('연속 메시지를 묶어 분석하는 대기 시간'),
  ai_disclosure: z.object({ enabled: z.boolean(), text: z.string().max(200) }).describe('첫 응답의 AI 고지 문구'),
});

/** 말투 · 페르소나 */
export const Persona = z.object({
  assistant_name: z.string().min(1).max(30),
  formality: z.enum(['formal', 'polite', 'casual']).describe('formal=하십시오체, polite=해요체, casual=반말'),
  emoji: z.boolean(),
  max_reply_chars: z.number().int().min(50).max(1000),
  style_notes: z.string().max(500).describe('자유 지침 (예: "제품명은 영문으로")'),
  banned_phrases: z.array(z.string().min(1)).max(100).describe('AI 출력에 나오면 전송을 막는 표현 (확약 · 보상 약속 등)'),
});

/** 매장 정보: 업종 · 무엇을 파는지 · 어떤 서비스를 하는지. AI가 답변 · 요약 카드에서 이 매장 맥락으로 안내하도록 */
export const Industry = z.enum(['online_shop', 'offline_store', 'food_beverage', 'beauty', 'fashion', 'education', 'fitness', 'health_clinic', 'lodging_travel', 'software_saas', 'service_booking', 'other']);
export const Offering = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['product', 'service', 'plan']).describe('product=상품, service=서비스, plan=요금제 · 이용권'),
  price: z.string().max(40).describe('표시 가격 (예: "16,000원", "월 9,900원"). 비워도 됨'),
  description: z.string().max(300).describe('특징 · 옵션 · 주의사항'),
  available: z.boolean().describe('판매 중 (끄면 품절 · 중단으로 안내)'),
});
// ---------- 매장 문서 (MD) ----------
// 매장 맥락을 종류별 MD 문서로 둠: 템플릿 모드(아래 필드 → templates/context/{kind}.md로 MD 생성) 또는 직접 작성 모드(사장님이 쓴 MD 그대로).
// AI 답변 · 요약 카드 프롬프트에 [매장 정보]로 들어감. 안전 규칙(확약 금지 · 개인정보 · 본인 확인 · 사장님 연결)은 코드가 강제하므로 MD로 바꿀 수 없음
export const ContextKind = z.enum(['business', 'offerings', 'policies']);
export const BusinessDocFields = z.object({
  industry: Industry.describe('업종. online_shop=온라인 쇼핑몰, offline_store=오프라인 매장, food_beverage=음식 · 카페, beauty=뷰티 · 미용, fashion=패션, education=교육 · 강의, fitness=운동 · 피트니스, health_clinic=병원 · 의원, lodging_travel=숙박 · 여행, software_saas=소프트웨어 · 앱, service_booking=예약형 서비스, other=기타'),
  industry_detail: z.string().max(100).describe('업종 상세 (예: "핸드메이드 도자기 온라인 판매")'),
  description: z.string().max(1000).describe('무엇을 파는지 · 어떤 서비스를 하는지 소개'),
  customers: z.string().max(300).describe('주요 고객층 (예: "20~30대 1인 가구")'),
  service_area: z.string().max(200).describe('배송 · 서비스 지역 (예: "전국 택배, 제주 · 도서산간 추가 배송비")'),
});
export const OfferingsDocFields = z.object({ items: z.array(Offering).max(100).describe('판매 상품 · 서비스 · 요금제') });
export const PoliciesDocFields = z.object({
  shipping: z.string().max(1000).describe('배송비 · 출고 · 배송 기간'),
  returns: z.string().max(1000).describe('교환 · 반품 조건과 비용'),
  refunds: z.string().max(1000).describe('환불 방법 · 기간 (AI는 환불을 약속하지 않고 안내만)'),
  other: z.string().max(1000).describe('예약 변경 · 회원 혜택 등 그 밖의 정책'),
});
export const ContextDocFields = { business: BusinessDocFields, offerings: OfferingsDocFields, policies: PoliciesDocFields } as const;
export const ContextDocPut = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('template'), fields: z.record(z.string(), z.unknown()).describe('종류별 필드 (GET /context-docs/{kind}/template 의 fields_schema)') }),
  z.object({ mode: z.literal('custom'), markdown: z.string().min(1).max(8000).describe('직접 작성한 MD (AI 프롬프트에 그대로). 길수록 전화 응답이 느려져 문서당 8000자까지') }),
]);
export const ContextDoc = z.object({
  kind: ContextKind,
  title: z.string(),
  mode: z.enum(['template', 'custom']),
  fields: z.record(z.string(), z.unknown()).nullable().describe('템플릿 모드일 때 입력값'),
  markdown: z.string().describe('AI에 들어가는 최종 MD'),
  is_default: z.boolean().describe('아직 저장한 적 없어 기본값'),
  updated_at: z.string().datetime().nullable(),
});

/** 영업시간 */
const TimeRange = z.object({ open: HHMM, close: HHMM });
export const BusinessHours = z.object({
  timezone: z.string().describe('IANA 시간대, 예: Asia/Seoul'),
  weekly: z.record(Weekday, z.array(TimeRange)).describe('요일별 영업 구간. 빈 배열 = 휴무'),
  holidays: z.array(z.string().date()).describe('휴무일 (YYYY-MM-DD)'),
});

// 욕설 처리는 설정 없이 완전 자동 (기본 단어 목록 즉시 판정 + Bivia 구간 판단). 매장이 단어를 등록하지 않음

/** 알림 우선순위 (감정 점수 · 위험 표시 · 사장님 판단 필요 여부로 서버가 정함) */
export const Priority = z.enum(['urgent', 'high', 'normal']);
export const AlertStyle = z.object({
  display: z.enum(['modal', 'banner', 'toast', 'badge', 'none']).describe('modal=화면 가운데 창(확인 전까지 유지), banner=상단 띠(확인 전까지 유지), toast=잠깐 뜨고 사라짐, badge=알림 개수만, none=표시 안 함'),
  sound: z.boolean().describe('알림음'),
});

/** 사장님 알림 */
export const Notifications = z.object({
  channeltalk_team_chat: z.object({ enabled: z.boolean(), group_id: z.string().nullable() }),
  events: z.object({
    pending_card: z.boolean(),
    heated: z.boolean(),
    handoff: z.boolean(),
    call_ended: z.boolean(),
    issue_suggested: z.boolean(),
  }),
  min_heat_to_notify: z.number().int().min(0).max(100),
  quiet_hours: z.object({ enabled: z.boolean(), start: HHMM, end: HHMM }).describe('이 시간에는 긴급이 아닌 알림은 배지로만, 소리는 모두 끔'),
  priority: z.object({
    urgent_heat_gte: z.number().int().min(0).max(100).describe('감정 점수가 이 이상이면 긴급'),
    high_heat_gte: z.number().int().min(0).max(100).describe('감정 점수가 이 이상이면 높음 (나머지는 보통)'),
    risk_flag_is_urgent: z.boolean().describe('법적 조치 언급 같은 위험 표시가 있으면 점수와 상관없이 긴급'),
    handoff_is_high: z.boolean().describe('사장님 판단이 필요한 문의는 최소 높음'),
  }).describe('감정 점수 → 알림 우선순위'),
  alert_styles: z.object({ urgent: AlertStyle, high: AlertStyle, normal: AlertStyle }).describe('우선순위별 사장님 화면 알림 방식'),
  push: z.object({
    enabled: z.boolean(),
    priorities: z.array(Priority).describe('이 우선순위만 휴대폰 · 브라우저 푸시(FCM)로. 조용한 시간에는 긴급만'),
  }).describe('푸시 알림 (화면을 안 보고 있을 때)'),
});

/** 전화 응대 (F9) */
export const Voice = z.object({
  enabled: z.boolean(),
  tts: z.object({
    engine: z.enum(['vapi', 'openai', 'browser']).describe('vapi=Vapi가 음성 인식 · 말 끝 감지 · 끼어들기 · 음성 합성 (판단은 우리 서버, Vapi 키 없으면 openai로 대체), openai=브라우저 음성 인식 + 서버 음성 합성, browser=브라우저 내장 음성 (즉시, 기계음)'),
    voice_name: z.string().nullable().describe('openai: alloy · ash · ballad · coral · echo · fable · nova · onyx · sage · shimmer · verse · marin · cedar (vapi는 alloy · echo · fable · nova · onyx · shimmer · marin · cedar만, 그 외는 marin) / browser: 브라우저 음성 이름. null이면 coral'),
    rate: z.number().min(0.5).max(2).describe('말 속도. 1이 보통'),
    pitch: z.number().min(0).max(2).describe('browser 엔진에서만 적용'),
    instructions: z.string().max(500).describe('openai 엔진의 말투 지시 (예: "차분하고 따뜻하게")'),
  }),
  silence_ms: z.number().int().min(300).max(2000).describe('이만큼 조용하면 고객 발화 종료로 판단'),
  filler: z.object({ enabled: z.boolean(), phrases: z.array(z.string().min(1)).max(20) }),
  barge_in: z.boolean().describe('AI가 말하는 중 고객이 말하면 즉시 멈춤'),
  abuse_turn_limit: z.number().int().min(1).max(10).describe('욕설이 이만큼 연속되면 경고 후 종료'),
  max_call_minutes: z.number().int().min(1).max(60),
  recording_notice: z.boolean(),
});

/** AI 모델 · 비용 */
export const AiSettings = z.object({
  model: z.enum(['liner-claude-router', 'liner-gpt-router', 'liner-gemini-router']),
  routing: z.object({
    chat_reply: RoutingStrategy,
    voice_reply: RoutingStrategy,
    card_summary: RoutingStrategy,
    mail_draft: RoutingStrategy,
  }).describe('작업별 라우팅 전략 (비용 / 균형 / 품질)'),
  judge: z.enum(['bivia', 'liner_decisions', 'llm']).describe('고객 발화 판단 엔진. bivia=감정 점수 · 사장님 판단 · 법적 조치 · 문의 분류를 Bivia로 (키 없거나 실패하면 llm), liner_decisions=아직 llm과 같음'),
  rag: z.object({
    top_k: z.number().int().min(1).max(20).describe('지식이 클 때 질문마다 가져올 근거 수'),
    include_all_under_chars: z.number().int().min(0).max(30000).describe('매장 지식(FAQ · 상품 · 정책 · 문서) 전체가 이 글자 수 이하면 검색 없이 다 넣음 (작은 매장은 누락 없이 정확)'),
  }).describe('매장별 지식 검색 (RAG)'),
  monthly_budget_usd: z.number().min(0).nullable().describe('월 AI 비용 상한. 넘으면 AI 응대를 접수 안내로 낮춤. null = 제한 없음'),
});

/** 데이터 조회 권한 (F12). 안전장치 S1~S9는 끌 수 없고, 범위만 조정 */
export const DataAccess = z.object({
  enabled: z.boolean(),
  tools: z.object({ lookup_order: z.boolean(), find_orders: z.boolean(), customer_history: z.boolean(), track_shipment: z.boolean().describe('택배사 실시간 배송 조회 (송장번호 · 택배사가 있는 주문)') }),
  verification_methods: z.array(z.enum(['profile_match', 'order_no_last4'])).min(1),
  max_verify_attempts: z.number().int().min(1).max(5),
  max_lookups_per_inquiry: z.number().int().min(1).max(30),
  exposed_fields: z.array(z.enum(['status', 'eta', 'items', 'amount', 'tracking_no', 'carrier', 'delivery'])).describe('고객에게 말해도 되는 필드. delivery=택배사 실시간 배송 상태'),
});

/** 반복 이슈 감지 (F8) */
export const IssueDetection = z.object({
  enabled: z.boolean(),
  min_inquiries: z.number().int().min(2).max(50),
  window_hours: z.number().int().min(1).max(168),
  categories: z.array(z.string()).describe('감지 대상 카테고리 이름. 빈 배열 = 전체'),
  default_recipients: z.enum(['involved', 'involved_and_list']).describe('공지 메일 기본 대상'),
  // 발송 전 사장님 확인은 끌 수 없음 (스펙 F8 AC)
});

/** 인스타그램 댓글 대응 (F11). 연결은 /instagram/connection, 여기서는 반응 방식만 */
export const InstagramSettings = z.object({
  enabled: z.boolean().describe('연결된 인스타 계정의 댓글을 AI가 처리'),
  auto_hide: z.enum(['off', 'abusive', 'abusive_or_heated']).describe('자동 숨김: off=안 함, abusive=욕설 · 비하만, abusive_or_heated=욕설 또는 감정 점수가 hide_heat_gte 이상'),
  hide_heat_gte: z.number().int().min(0).max(100).describe('abusive_or_heated일 때 이 점수 이상이면 숨김'),
  auto_reply: z.boolean().describe('일반 문의 댓글에 AI가 공개 답글 (매장 지식 근거, 판단이 필요하거나 격앙된 댓글은 답하지 않음)'),
});

export const SettingsSections = {
  response: ResponsePolicy,
  persona: Persona,
  hours: BusinessHours,
  notifications: Notifications,
  voice: Voice,
  ai: AiSettings,
  'data-access': DataAccess,
  issues: IssueDetection,
  instagram: InstagramSettings,
} as const;
export type SettingsSection = keyof typeof SettingsSections;
export const AllSettings = z.object(SettingsSections);
export type AllSettings = z.infer<typeof AllSettings>;

// ---------- 목록형 설정 ----------

/** 매장이 정의하는 문의 카테고리. AI 분류는 name + description을 보고 고릅니다. */
export const Category = z.object({
  id,
  name: z.string().min(1).max(30),
  description: z.string().max(300).describe('AI 분류 힌트 (예: "택배 지연, 송장 문의")'),
  routing: z.enum(['auto', 'approve', 'intake_only']).describe('auto=근거 있으면 AI 답변, approve=항상 사장님 승인, intake_only=접수 안내만'),
  enabled: z.boolean(),
  sort: z.number().int(),
});
export const CategoryInput = Category.omit({ id: true });

/** 에스컬레이션 규칙: 조건이 맞으면 AI 판단보다 우선 적용 */
export const EscalationRule = z.object({
  id,
  name: z.string().min(1).max(50),
  enabled: z.boolean(),
  match: z.object({
    keywords: z.array(z.string().min(1)).max(100).optional(),
    regex: z.string().max(300).optional(),
    heat_gte: z.number().int().min(0).max(100).optional(),
    channels: z.array(ChannelKind).optional(),
  }).describe('지정한 조건을 모두 만족하면 매칭 (keywords는 하나라도 포함)'),
  action: z.enum(['handoff', 'approve', 'end_call']),
  risk_flag: z.string().max(30).nullable().describe('카드에 붙일 위험 표시 (예: "법적 조치 언급")'),
  notify: z.boolean().describe('즉시 사장님 알림'),
  priority: z.number().int().describe('작을수록 먼저 평가'),
});
export const EscalationRuleInput = EscalationRule.omit({ id: true });

/** 고정 문구 템플릿. 변수: {store_name} {assistant_name} {sla} {customer_name} */
export const TemplateKind = z.enum([
  'greeting', 'intake', 'calm', 'handoff', 'off_hours',
  'verify_request', 'verify_failed', 'call_close', 'abuse_warning', 'abuse_end',
  'handoff_followup', // 사장님 연결을 이미 안내한 대화에서 또 연결이 필요할 때 (같은 긴 안내 반복 방지)
]);
export const Template = z.object({
  kind: TemplateKind,
  text: z.string().min(1).max(500),
  channel: z.enum(['all', 'chat', 'call']),
});
export const TemplateInput = Template.pick({ text: true, channel: true });

/** FAQ: 정책 문서보다 우선해서 답변 근거로 씁니다 */
export const Faq = z.object({
  id,
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(2000),
  enabled: z.boolean(),
});
export const FaqInput = Faq.omit({ id: true });

// ---------- 튜닝 도구 ----------

/** 설정을 바꾸기 전에 효과를 미리 보는 시뮬레이터. 실제로 보내지 않고 감사 로그에도 남지 않습니다. */
export const SimulateBody = z.object({
  channel: ChannelKind,
  messages: z.array(z.object({ sender: z.enum(['customer', 'ai', 'owner']), text: z.string().min(1) })).min(1).max(30),
  settings_override: AllSettings.partial().optional().describe('저장하지 않고 이 설정으로 시험'),
});
export const SimulateResult = z.object({
  analysis: z.object({
    category: z.string(),
    heat: z.number().int(),
    heat_label: z.string(),
    needs_owner: z.boolean(),
    confidence: z.number(),
    abuse_spans: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  }),
  route: z.enum(['A', 'B', 'C']),
  matched_rules: z.array(z.object({ id, name: z.string(), action: z.string() })),
  reply_preview: z.string().nullable().describe('고객에게 나갈 메시지 미리보기 (null = 보내지 않음)'),
  card_preview: z.record(z.string(), z.unknown()).nullable(),
  would_notify: z.boolean(),
  reasons: z.array(z.string()).describe('이렇게 판단한 이유 (설정 튜닝용)'),
});

/** 사용량 (요금 · 비용 확인용) */
export const UsageQuery = z.object({ from: z.string().date(), to: z.string().date() });
export const Usage = z.object({
  inquiries: z.number().int(),
  auto_handled: z.number().int(),
  shielded_heated: z.number().int(),
  calls: z.number().int(),
  call_minutes: z.number(),
  ai_cost_usd: z.number(),
  by_day: z.array(z.object({ date: z.string().date(), inquiries: z.number().int(), ai_cost_usd: z.number() })),
});

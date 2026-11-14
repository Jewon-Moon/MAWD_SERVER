// API 계약 (docs/feature-spec.md §14). 백엔드는 검증 · OpenAPI 생성에, 프론트는 타입에 씁니다.
import { z } from 'zod';
import { AlertStyle, Priority } from './settings.js';
import { CommerceSource } from './commerce.js';

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const id = z.string().uuid();
const isoTime = z.string().datetime();

export const Channel = z.enum(['chat', 'call', 'sns']);
export const InquiryStatus = z.enum(['pending', 'auto_done', 'done', 'manual']);
export const Route = z.enum(['A', 'B', 'C']);
export const HeatLabel = z.enum(['보통', '높음', '매우 높음']);
// 카테고리는 매장마다 직접 정의합니다(/categories). 응답에는 카테고리 이름이 들어갑니다.
export const CategoryName = z.string().min(1).max(30);

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// --- auth / me ---
export const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  store_name: z.string().min(1).max(100),
});
export const LoginBody = SignupBody.pick({ email: true, password: true });

export const Me = z.object({
  user: z.object({ id, email: z.string().email() }),
  tenant: z.object({ id, name: z.string() }),
  integrations: z.object({ channeltalk: z.boolean(), stibee: z.boolean() }),
  onboarding: z.object({ channeltalk: z.boolean(), documents: z.boolean(), test_message: z.boolean() }),
});

// --- integrations / settings ---
export const ChannelTalkKeys = z.object({ access_key: z.string().min(1), access_secret: z.string().min(1) });
export const StibeeKeys = z.object({ api_key: z.string().min(1), list_id: z.string().min(1) });
export const IntegrationResult = z.object({ ok: z.boolean(), webhook_url: z.string().url().optional(), message: z.string().optional() });

// --- dashboard / inquiries ---
export const DashboardSummary = z.object({
  today_total: z.number().int(),
  auto_handled_rate: z.number().min(0).max(1),
  shielded_heated_count: z.number().int(), // AI가 대신 받아낸 격한 문의 수
  pending_count: z.number().int(),
});

export const InquiryListItem = z.object({
  id,
  channel: Channel,
  status: InquiryStatus,
  route: Route,
  title: z.string(),
  customer_name: z.string().nullable(),
  category: CategoryName,
  heat_label: HeatLabel,
  created_at: isoTime,
  updated_at: isoTime,
});
export const InquiryListQuery = PageQuery.extend({
  status: InquiryStatus.optional(),
  channel: Channel.optional(),
});

export const Fact = z.object({ text: z.string(), source: z.enum(['order_data', 'customer_claim']) });
export const Recommendation = z.object({
  label: z.string(),
  draft: z.string(),
  policy_ref: z.string().nullable(),
});
export const Card = z.object({
  title: z.string(),
  demands: z.array(z.string()),
  facts: z.array(Fact),
  recommendations: z.array(Recommendation),
  heat_label: HeatLabel,
  risk_flags: z.array(z.string()),
});
export const Message = z.object({
  id,
  sender: z.enum(['customer', 'ai', 'owner']),
  text: z.string(), // 기본은 욕설 마스킹 상태. 원문은 /messages?raw=true
  created_at: isoTime,
});
export const InquiryDetail = InquiryListItem.extend({
  card: Card.nullable(),
  analysis: z.object({
    heat: z.number().int().min(0).max(100),
    needs_owner: z.boolean(),
    confidence: z.number().min(0).max(1),
  }).nullable(),
  messages: z.array(Message),
  ai_muted: z.boolean(),
});
export const RawMessagesQuery = z.object({ raw: z.coerce.boolean().default(false) });

export const InquiryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve'), recommendation_index: z.number().int().min(0) }),
  z.object({ type: z.literal('edit_send'), text: z.string().min(1) }),
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('hold'), memo: z.string().optional() }),
  z.object({ type: z.literal('close') }),
]);

// --- documents / orders ---
export const Document = z.object({
  id,
  title: z.string(),
  source_type: z.enum(['pdf', 'text', 'url', 'faq']),
  chunk_count: z.number().int(),
  enabled: z.boolean(), // false면 답변 근거로 쓰지 않음
  source: CommerceSource.nullable().describe('이 문서가 적용되는 판매처 (예: 쿠팡 반품 정책). null = 모든 판매처 공통'),
  created_at: isoTime,
});
export const DocumentPatch = z.object({ title: z.string().min(1).optional(), enabled: z.boolean().optional(), source: CommerceSource.nullable().optional() });
export const Order = z.object({
  id,
  source: CommerceSource,
  platform: z.string().describe('판매처 이름 (예: 네이버 스마트스토어)'),
  order_no: z.string(),
  customer_name: z.string(),
  phone_masked: z.string(),
  items: z.string(),
  amount: z.number(),
  status: z.string(),
  raw_status: z.string().nullable().describe('플랫폼 원래 상태 코드'),
  tracking_no: z.string().nullable(),
  carrier: z.string().nullable(),
  eta: z.string().nullable(),
  ordered_at: isoTime.nullable(),
  synced_at: isoTime.nullable(),
});
export const OrderImportResult = z.object({ imported: z.number().int(), skipped: z.number().int(), errors: z.array(z.string()), preview: z.array(Order).optional() });

// --- issues ---
export const Issue = z.object({
  id,
  title: z.string(),
  category: CategoryName,
  status: z.enum(['suggested', 'confirmed', 'mailed']),
  inquiry_count: z.number().int(),
  created_at: isoTime,
});
export const MailDraft = z.object({ subject: z.string(), body_html: z.string(), recipient_count: z.number().int() });

// --- calls (F9) ---
export const CallState = z.enum(['GREET', 'LISTEN', 'ANSWER', 'VERIFY', 'CALM', 'HANDOFF', 'CLOSE']);
export const CallStart = z.object({ call_id: id, greeting_text: z.string() });
export const CallTurnBody = z.object({ text: z.string().min(1) });
// POST /calls/{id}/turns 의 SSE 이벤트 (§14.3). event 이름 = type
export const CallTurnEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: CallState }),
  z.object({ type: z.literal('sentence'), text: z.string() }),
  z.object({ type: z.literal('metrics'), first_sentence_ms: z.number(), llm_first_token_ms: z.number() }),
  z.object({ type: z.literal('done'), end_call: z.boolean() }),
]);

export const CallDetail = z.object({
  call_id: id,
  inquiry_id: id,
  state: CallState,
  ended: z.boolean(),
  transcript: z.array(z.object({ role: z.enum(['customer', 'ai']), text: z.string() })),
  turn_latencies_ms: z.array(z.number()),
  card: Card.nullable(), // 통화 종료 후 생성되면 채워짐 (폴링)
});

// --- alerts (사장님 화면 알림) ---
// 서버가 우선순위와 표시 방식(매장 설정 notifications.alert_styles, 조용한 시간 반영)을 정해서 줌. 프론트는 display · sound대로 띄우기만
export const Alert = z.object({
  id,
  inquiry_id: id.nullable(), // 시험 알림은 null
  channel: Channel,
  kind: z.enum(['live', 'card']).describe('live=대화 중 우선순위가 올라감, card=대화가 끝나 요약 카드가 생김'),
  priority: Priority,
  heat: z.number().int().min(0).max(100),
  title: z.string(),
  message: z.string(),
  display: AlertStyle.shape.display,
  sound: z.boolean(),
  acked: z.boolean(),
  created_at: isoTime,
});
export const AlertListQuery = z.object({
  after: z.string().datetime().optional().describe('이 시각 이후 알림만 (폴링할 때 마지막으로 받은 created_at)'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// --- audit ---
export const AuditQuery = PageQuery.extend({
  inquiry_id: z.string().uuid().optional(),
  type: z.string().optional(), // 예: read_lookup, send, settings_change
});
export const AuditEntry = z.object({
  id,
  actor: z.enum(['ai', 'owner', 'system']),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: isoTime,
});

export type Me = z.infer<typeof Me>;
export type InquiryListItem = z.infer<typeof InquiryListItem>;
export type InquiryDetail = z.infer<typeof InquiryDetail>;
export type InquiryAction = z.infer<typeof InquiryAction>;
export type CallTurnEvent = z.infer<typeof CallTurnEvent>;

export * from './settings.js';
export * from './commerce.js';

// 통화 상태 머신 (F9). 다음 상태는 이 코드가 정하고, LLM은 그 상태에서 할 말만 만듭니다.
// 순수 함수라 LLM 없이 테스트합니다.
import type { z } from 'zod';
import type { CallState, EscalationRule, TemplateKind } from '@mawd/contracts';
import type { TenantConfig } from '../tenantConfig.js';
import type { VerifyState } from '../tools/orders.js';
import { extractCredentials } from '../tools/orders.js';
import { defaultTemplates } from '../mocks/data.js';

type State = z.infer<typeof CallState>;
type Rule = z.infer<typeof EscalationRule>;
type Kind = z.infer<typeof TemplateKind>;

export type CallSession = {
  id: string;
  channel: 'call' | 'chat';      // 같은 상태 머신 · 안전장치를 전화와 채팅이 공유
  tenantId: string;
  inquiryId: string;
  state: State;
  verify: VerifyState;
  abuseStreak: number;
  lastTurnAbuse?: { before: number; keyword: boolean }; // 직전 턴의 키워드 판정 (Bivia 판단으로 보정용)
  awaitingVerify: boolean;
  pendingQuestion: string | null; // 본인 확인 전에 받은 주문 질문 (확인 후 답변)
  heat: number;                   // 직전 분석 결과 (비동기, 다음 턴에 반영)
  needsOwner: boolean;
  riskFlags: Set<string>;
  history: { role: 'user' | 'assistant'; content: string }[];
  turnLatencies: number[];
  orderData: Record<string, unknown>[]; // 이번 통화에서 조회한 주문 (카드의 [주문 데이터] 근거)
  ended: boolean;
  category?: string;              // 문의 분류 (매장 카테고리 이름, Bivia 판단)
  judgedBy?: 'bivia' | 'llm';     // 마지막 판단 엔진
  handoffAnnounced?: boolean;     // 사장님 연결 안내를 이미 함 → 이후 일반 질문은 계속 AI가 답함 (24시간 응대)
  peakHeat?: number;              // 대화 중 가장 높았던 감정 점수 (알림 우선순위 기준)
  alerted?: 'urgent' | 'high' | 'normal'; // 이미 보낸 대화 중 알림의 최고 우선순위 (같은 단계 반복 알림 방지)
  current?: AbortController;      // 진행 중인 턴 (끼어들기 시 취소)
};

export type TurnPlan =
  | { kind: 'template'; state: State; template: Kind; endCall?: boolean }
  | { kind: 'verify'; state: 'VERIFY'; orderNo: string; last4: string }
  | { kind: 'llm'; state: 'ANSWER' | 'CALM'; lookup: boolean; question: string };

// 즉시 판정용 기본 욕설 목록 (설정 없음). 목록에 없는 변형 · 우회 표현은 Bivia가 뒤에서 잡아 다음 턴부터 반영 (judge.ts)
const BASE_ABUSE = ['씨발', '시발', '씨바', 'ㅅㅂ', 'ㅆㅂ', '썅', '개새', '병신', 'ㅂㅅ', '좆', '존나', 'ㅈㄴ', '꺼져', '닥쳐', '개같', '미친놈', '미친년', '지랄', 'ㅈㄹ'];
// "씨 발", "시.발"처럼 사이에 공백 · 기호를 넣은 우회도 잡도록 글자만 남겨 비교
const lettersOnly = (t: string) => t.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9]/g, '');
// 욕설 목록과 글자가 겹치는 일반 단어 (오탐 방지, 설정 아님)
const INNOCENT = ['시발점', '시발역', '병신년'];
const ANGER = ['화나', '짜증', '열받', '어이없', '장난하', '당장', '빨리', '몇 번', '도대체', '환불해'];
// 특정 주문을 가리키는 표현만 (본인 확인 필요). "배송비 얼마예요", "주문은 어떻게 해요" 같은 일반 질문은 매장 정보 · FAQ로 바로 답함
const ORDER_INTENT = ['주문한', '주문했', '내 주문', '제 주문', '주문 내역', '주문내역', '송장', '운송장', '도착', '언제 와', '언제와', '언제 오', '언제쯤 와', '출고', '배송 조회', '배송조회', '배송 현황', '어디쯤'];
const CLOSING = ['끊을게', '끊겠', '됐어요', '그만할게', '수고하세요', '이만', '알겠습니다 감사'];
const ORDER_MOD_PATTERNS = [
  /방문\s*수령.*(변경|바꿔|바꿀)/,
  /배송\s*(방법|방식|지).*(변경|바꿔|바꿀)/,
  /수령\s*방법.*(변경|바꿔|바꿀)/,
  /주소.*(변경|바꿔|바꿀)/,
  /주문.*변경/,
  /변경\s*가능/,
  /바꿔\s*(주|줄|드릴)/,
  /취소\s*(해|하고|요청|가능)/,
  /(교환|환불|반품)\s*(해|하고|요청)/,
];

/** 주문 변경 · 배송 방법/배송지 변경 · 취소/교환/환불 등 사장님 처리가 필요한 요청인지 판별 */
export function hasOrderModificationIntent(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  return ORDER_MOD_PATTERNS.some((re) => re.test(t));
}

export type Prefilter = { abusive: boolean; heatHint: number; orderIntent: boolean; closing: boolean; rules: Rule[] };

/** 첫 판정은 키워드로 즉시 (0ms). LLM 분석은 병렬로 돌고 다음 턴에 반영 */
export function prefilter(text: string, cfg: TenantConfig): Prefilter {
  const t = text.replace(/\s+/g, ' ');
  const squeezed = INNOCENT.reduce((acc, w) => acc.replaceAll(w, ''), lettersOnly(t));
  const abusive = BASE_ABUSE.some((w) => squeezed.includes(w));
  const angerHits = ANGER.filter((w) => t.includes(w)).length + (t.match(/!{2,}/g)?.length ?? 0);
  const heatHint = abusive ? 90 : Math.min(85, angerHits * 30);
  const rules = cfg.rules
    .filter((r) => r.enabled && (!r.match.channels || r.match.channels.includes('call')))
    .filter((r) =>
      (!r.match.keywords || r.match.keywords.some((k) => t.includes(k))) &&
      (r.match.heat_gte === undefined || heatHint >= r.match.heat_gte) &&
      (!r.match.regex || safeRegex(r.match.regex)?.test(t)))
    .filter((r) => r.match.keywords || r.match.regex || r.match.heat_gte !== undefined) // 조건 없는 규칙은 매칭 안 함
    .sort((a, b) => a.priority - b.priority);
  return {
    abusive,
    heatHint,
    orderIntent: ORDER_INTENT.some((w) => t.includes(w)) || /\d{4,}|[A-Za-z]{1,4}\d[A-Za-z0-9]{4,}/.test(t),
    closing: CLOSING.some((w) => t.includes(w)),
    rules,
  };
}

const safeRegex = (src: string) => { try { return new RegExp(src); } catch { return null; } };

/** 영업시간 판단 (매장 시간대 기준). AI 응대 여부와는 무관하고(24시간 응대), 사장님 연결 안내 문구 · 채팅 AI 대기 전환에만 씀 */
export function isOpen(hours: TenantConfig['settings']['hours'], now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: hours.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (hours.holidays.includes(date)) return false;
  const day = parts.weekday!.slice(0, 3).toLowerCase() as keyof typeof hours.weekly;
  const hhmm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  return (hours.weekly[day] ?? []).some((r) => r.open <= hhmm && hhmm < r.close);
}

/** 한 턴의 계획. 우선순위: 폭언 → 에스컬레이션 규칙 → 종료 의사 → 영업시간 → 본인 확인 → 주문 문의 → 사장님 판단 필요 → 격앙 → 일반 답변 */
export function decideTurn(s: CallSession, text: string, cfg: TenantConfig, pf: Prefilter, now: Date): TurnPlan {
  const { voice, response } = cfg.settings;
  const handoff = handoffTemplate(cfg, now);
  const da = cfg.settings['data-access'];

  const ownerNeededBefore = s.needsOwner; // 직전 턴까지의 판단만 이번 턴 HANDOFF 근거로 씀 (approve 규칙은 진정 응대를 먼저)
  if (hasOrderModificationIntent(text)) s.needsOwner = true;
  s.lastTurnAbuse = { before: s.abuseStreak, keyword: pf.abusive }; // Bivia가 나중에 욕설로 판단하면 이 턴을 연속 횟수에 다시 넣음
  s.abuseStreak = pf.abusive ? s.abuseStreak + 1 : 0;
  if (s.abuseStreak > voice.abuse_turn_limit) return { kind: 'template', state: 'CLOSE', template: 'abuse_end', endCall: true };
  if (s.abuseStreak === voice.abuse_turn_limit) return { kind: 'template', state: 'CALM', template: 'abuse_warning' };

  const rule = pf.rules[0];
  if (rule) {
    if (rule.risk_flag) s.riskFlags.add(rule.risk_flag);
    if (rule.action === 'end_call') return { kind: 'template', state: 'CLOSE', template: handoff, endCall: true };
    if (rule.action === 'handoff') { s.needsOwner = true; return { kind: 'template', state: 'HANDOFF', template: handoff }; }
    s.needsOwner = true; // approve: 응대는 이어가되 카드는 승인 대기
  }

  if (pf.closing) return { kind: 'template', state: 'CLOSE', template: 'call_close', endCall: true };

  const angry = Math.max(pf.heatHint, s.heat) >= response.heat_threshold;
  if (s.awaitingVerify) {
    const creds = extractCredentials(text);
    if (creds) return { kind: 'verify', state: 'VERIFY', ...creds };
    // 확인 문구는 차분한 주문 문의에만 다시 안내. 화를 내거나 다른 얘기를 하면 같은 문구를 반복하지 않고 아래 흐름으로 (번호를 주면 그때 확인)
    if (pf.orderIntent && !angry) return { kind: 'template', state: 'VERIFY', template: 'verify_request' };
  }

  if (pf.orderIntent && !s.awaitingVerify) {
    if (!da.enabled || !da.tools.lookup_order) return { kind: 'template', state: 'HANDOFF', template: handoff };
    if (s.verify.locked) return { kind: 'template', state: 'HANDOFF', template: handoff };
    if (s.verify.verifiedPhone) return { kind: 'llm', state: 'ANSWER', lookup: true, question: text };
    s.awaitingVerify = true;
    s.pendingQuestion = text;
    // 첫 발화에 번호까지 같이 말한 경우 바로 확인
    const creds = extractCredentials(text);
    if (creds) return { kind: 'verify', state: 'VERIFY', ...creds };
    return { kind: 'template', state: 'VERIFY', template: 'verify_request' };
  }

  // 사장님 연결 안내는 한 번만. 그 뒤 일반 질문은 계속 답하고, 또 판단이 필요하면 LLM이 [HANDOFF]를 내서 다시 안내
  if (ownerNeededBefore && !s.handoffAnnounced) return { kind: 'template', state: 'HANDOFF', template: handoff };

  if (angry) return { kind: 'llm', state: 'CALM', lookup: false, question: text };

  return { kind: 'llm', state: 'ANSWER', lookup: false, question: text };
}

/** 사장님 연결 안내 문구: 영업시간이면 'handoff'({sla} 안에 연락), 아니면 'off_hours'({next_open}에 연락 + 그 전엔 AI가 계속 도움) */
export const handoffTemplate = (cfg: TenantConfig, now: Date): Kind => (isOpen(cfg.settings.hours, now) ? 'handoff' : 'off_hours');

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_KO = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' } as const;
/** 다음 영업 시작 시각을 말로 ("내일 오전 10시", "11월 17일(월) 오전 10시"). 2주 안에 없으면 "영업일" */
export function nextOpenText(hours: TenantConfig['settings']['hours'], now: Date): string {
  const fmt = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: hours.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  const n = fmt(now);
  const nowHHMM = `${n.hour === '24' ? '00' : n.hour}:${n.minute}`;
  for (let i = 0; i < 14; i++) {
    const d = fmt(new Date(now.getTime() + i * 86_400_000));
    const date = `${d.year}-${d.month}-${d.day}`;
    if (hours.holidays.includes(date)) continue;
    const day = DAY[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
    const open = (hours.weekly[day] ?? []).map((r) => r.open).sort().find((o) => i > 0 || o > nowHHMM);
    if (!open) continue;
    const [hh, mm] = open.split(':').map(Number) as [number, number];
    const time = `${hh < 12 ? '오전' : '오후'} ${hh % 12 || 12}시${mm ? ` ${mm}분` : ''}`;
    const when = i === 0 ? '오늘' : i === 1 ? '내일' : `${Number(d.month)}월 ${Number(d.day)}일(${DAY_KO[day]})`;
    return `${when} ${time}`;
  }
  return '영업일';
}

/** 템플릿 변수 치환 */
export function renderTemplate(cfg: TenantConfig, kind: Kind, vars: { customer_name?: string; now?: Date } = {}, channel: 'call' | 'chat' = 'call'): string {
  const pick = (list: TenantConfig['templates']) => list.find((x) => x.kind === kind && (x.channel === 'all' || x.channel === channel))?.text;
  const t = pick(cfg.templates) ?? pick(defaultTemplates) ?? ''; // 매장이 다른 채널 전용으로 바꿨으면 기본 문구로
  const sla = cfg.settings.response.owner_reply_sla_minutes;
  const slaText = sla % 60 === 0 ? `${sla / 60}시간` : `${sla}분`;
  return t
    .replaceAll('{store_name}', cfg.storeName)
    .replaceAll('{assistant_name}', cfg.settings.persona.assistant_name)
    .replaceAll('{sla}', slaText)
    .replaceAll('{customer_name}', vars.customer_name ?? '고객')
    .replaceAll('{next_open}', t.includes('{next_open}') ? nextOpenText(cfg.settings.hours, vars.now ?? new Date()) : '');
}

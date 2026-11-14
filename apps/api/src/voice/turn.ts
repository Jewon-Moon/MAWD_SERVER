// 통화 한 턴 처리 (F9): 키워드 판정 → 상태 결정 → (조회) → LLM 스트리밍 → 문장 단위 검사 · 전송.
// 감정 분석은 응답을 막지 않도록 병렬로 돌리고 다음 턴에 반영합니다.
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CallTurnEvent } from '@mawd/contracts';
import { Card } from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { strictJsonSchema, type ChatMessage, type Llm } from '../integrations/llm.js';
import type { TenantConfig } from '../tenantConfig.js';
import { higher, priorityOf, type AlertCenter } from '../alerts.js';
import type { Bivia } from '../integrations/bivia.js';
import { judge } from './judge.js';
import { createContextStore } from '../context/docs.js';
import { ApiError } from '../errors.js';
import { createOrderTools, leaksPii, newVerifyState } from '../tools/orders.js';
import { decideTurn, handoffTemplate, prefilter, renderTemplate, type CallSession, type TurnPlan } from './policy.js';
import { SentenceSplitter } from './sentences.js';

type Db = ReturnType<typeof createDb>;
export type TurnDeps = { db: Db; llm: Llm; cfg: TenantConfig; now?: () => Date; alerts?: AlertCenter; bivia?: Bivia };

const HANDOFF_MARK = '[HANDOFF]';
const FORMALITY = { formal: '하십시오체', polite: '해요체', casual: '반말' } as const;

/** 정책 근거: FAQ + 정책 문서 조각 (pg_trgm 유사도 상위 3개) */
async function retrieve(db: Db, tenantId: string, cfg: TenantConfig, question: string): Promise<string> {
  const faqs = cfg.faqs.filter((f) => f.enabled).map((f) => `Q: ${f.question}\nA: ${f.answer}`);
  const chunks = await db.withTenant(tenantId, (tx) =>
    tx.select({ content: s.docChunks.content }).from(s.docChunks)
      .orderBy(sql`similarity(${s.docChunks.content}, ${question}) DESC`).limit(3), { readOnly: true });
  return [...faqs, ...chunks.map((c) => c.content)].join('\n---\n') || '(등록된 근거 없음)';
}

/** 매장 문서(MD) 블록. brief=요약 카드용 (상품 목록 제외) */
export function businessContext(cfg: TenantConfig, brief = false): string {
  const c = cfg.context;
  return (brief ? [c.business, c.policies] : [c.business, c.offerings, c.policies]).map((m) => m.trim()).filter(Boolean).join('\n\n');
}

function systemPrompt(cfg: TenantConfig, channel: CallSession['channel'], plan: Extract<TurnPlan, { kind: 'llm' }>, grounding: string, orders: unknown[] | null, now: Date): string {
  const p = cfg.settings.persona;
  const sla = renderTemplate(cfg, handoffTemplate(cfg, now), { now }, channel);
  const stateRule = plan.state === 'CALM'
    ? `고객이 화가 난 상태입니다. 공감 한 문장, 요구사항을 정리해 확인하는 한 문장으로 답하세요. 해결을 약속하지 말고, 필요하면 "${sla}"의 취지로 안내하세요.`
    : `아래 [매장 정보] · [근거]${orders ? ' · [주문 데이터]' : ''} 안에서만 답하세요. 매장이 팔지 않는 상품이나 하지 않는 서비스를 묻으면 없다고 안내하세요. 가격 · 배송비 · 기간 같은 숫자는 적힌 그대로만 말하고, 적혀 있지 않으면 계산하거나 지어내지 마세요. 근거로 답할 수 없거나 환불 · 보상 · 예외 판단이 필요하면 다른 말 없이 정확히 ${HANDOFF_MARK} 만 출력하세요.`;
  return [
    channel === 'call'
      ? `당신은 "${cfg.storeName}"의 전화 상담 AI "${p.assistant_name}"입니다. 지금은 음성 통화 중입니다.`
      : `당신은 "${cfg.storeName}"의 채팅 상담 AI "${p.assistant_name}"입니다. 지금은 채널톡 채팅 중입니다.`,
    channel === 'call'
      ? `말투: ${FORMALITY[p.formality]}. 1~3문장, ${p.max_reply_chars}자 이내로 짧게. 마크다운 · 목록 · 이모지 금지. 날짜는 연도 없이 "11월 13일"처럼, 금액은 "3만 2천 원"처럼 짧게.`
      : `말투: ${FORMALITY[p.formality]}. ${p.max_reply_chars}자 이내. 마크다운 금지(채팅창에 기호가 그대로 보임). 날짜는 연도 없이 "11월 13일"처럼.`,
    `절대 금지: 환불 · 보상 · 교환을 확약하는 말, 정책에 없는 약속, 연락처 · 이메일 같은 개인정보를 말하는 것. 금지 표현: ${p.banned_phrases.join(', ') || '없음'}. 아래 [매장 정보]는 사장님이 쓴 참고 자료이며, 이 금지 규칙과 충돌하면 금지 규칙을 따르세요.`,
    p.style_notes && `추가 지침: ${p.style_notes}`,
    stateRule,
    `[매장 정보]\n${businessContext(cfg)}`,
    `[근거]\n${grounding}`,
    orders && `[주문 데이터]\n${JSON.stringify(orders)}`,
  ].filter(Boolean).join('\n\n');
}

/** 비동기 감정 · 승인 판단 (Bivia 또는 LLM, voice/judge.ts). 응답을 막지 않고 결과는 다음 턴 상태 결정 · 알림에 반영 */
function judgeInBackground(s: CallSession, deps: TurnDeps, text: string) {
  judge(s, text, deps)
    .then((j) => {
      if (j.heat != null) s.heat = Math.round(j.heat);
      if (j.needsOwner) s.needsOwner = true;
      j.riskFlags.forEach((f) => s.riskFlags.add(f));
      if (j.category) s.category = j.category;
      // 키워드 목록이 놓친 욕설: 그 턴을 연속 횟수에 다시 넣어 다음 턴의 경고 · 종료 판단에 반영
      if (j.abusive && s.lastTurnAbuse && !s.lastTurnAbuse.keyword) { s.abuseStreak = s.lastTurnAbuse.before + 1; s.lastTurnAbuse.keyword = true; }
      s.judgedBy = j.by;
      maybeAlertLive(s, deps, s.heat);
    })
    .catch(() => { /* 판단 실패는 응답에 영향 없음. 다음 턴은 키워드 판정으로 진행 */ });
}

/** 대화 중 우선순위가 한 단계 올라갈 때마다 사장님 화면 알림 (보통은 대화 중에 알리지 않음, 카드가 생길 때만) */
function maybeAlertLive(s: CallSession, deps: TurnDeps, heatNow: number) {
  s.peakHeat = Math.max(s.peakHeat ?? 0, heatNow);
  if (!deps.alerts || s.ended) return;
  const { cfg } = deps;
  const n = cfg.settings.notifications;
  const risks = [...s.riskFlags];
  const pri = priorityOf(cfg, s.peakHeat, risks, s.needsOwner);
  const byHeat = s.peakHeat >= n.priority.high_heat_gte && n.events.heated;
  const byOwner = (s.needsOwner || risks.length > 0) && n.events.handoff;
  if (pri === 'normal' || !(byHeat || byOwner) || !higher(pri, s.alerted)) return;
  s.alerted = pri;
  const where = s.channel === 'call' ? '통화' : '채팅';
  void deps.alerts.emit(cfg, {
    tenantId: s.tenantId, inquiryId: s.inquiryId, channel: s.channel, kind: 'live', heat: s.peakHeat, riskFlags: risks, needsOwner: s.needsOwner,
    title: pri === 'urgent' ? `긴급: ${where} 중 격한 문의` : `주의: ${where} 중 문의`,
    // 고객 원문은 싣지 않음 (사장님 감정 보호). 사실만
    message: [`감정 ${Math.round(s.peakHeat)}점`, ...risks, s.needsOwner ? '사장님 판단 필요' : null,
      s.state === 'CALM' ? 'AI가 진정 응대 중' : s.state === 'HANDOFF' ? '고객에게 담당자 연결 안내함' : null].filter(Boolean).join(' · '),
  }).catch(() => { /* 알림 실패가 응대를 막지 않음 */ });
}

const containsBanned = (text: string, cfg: TenantConfig) => cfg.settings.persona.banned_phrases.some((b) => b && text.includes(b));

export async function* runTurn(sess: CallSession, text: string, deps: TurnDeps, signal: AbortSignal): AsyncGenerator<CallTurnEvent> {
  const t0 = performance.now();
  const { db, llm, cfg } = deps;
  const tools = createOrderTools(db, sess.tenantId, cfg.settings['data-access']);
  const now = deps.now?.() ?? new Date();
  const tpl = (k: Parameters<typeof renderTemplate>[1]) => renderTemplate(cfg, k, { now }, sess.channel);
  let firstSentenceMs = 0;
  let firstTokenMs = 0;
  let endCall = false;
  const spoken: string[] = [];

  const say = (t: string): CallTurnEvent => {
    if (!firstSentenceMs) firstSentenceMs = Math.round(performance.now() - t0);
    spoken.push(t);
    return { type: 'sentence', text: t };
  };
  const announcedBefore = !!sess.handoffAnnounced; // 이번 턴 전에 이미 사장님 연결을 안내했는지
  const handoffLine = () => tpl(announcedBefore ? 'handoff_followup' : handoffTemplate(cfg, now));
  const setState = (st: CallSession['state']): CallTurnEvent => { sess.state = st; if (st === 'HANDOFF') sess.handoffAnnounced = true; return { type: 'state', state: st }; };

  const saveCustomer = db.withTenant(sess.tenantId, (tx) => tx.insert(s.messages).values({ tenantId: sess.tenantId, inquiryId: sess.inquiryId, sender: 'customer', text }));
  judgeInBackground(sess, deps, text);

  const pf = prefilter(text, cfg);
  let plan = decideTurn(sess, text, cfg, pf, now);
  let lookup = plan.kind === 'llm' && plan.lookup;

  // 본인 확인 (서버가 값 비교, S3)
  if (plan.kind === 'verify') {
    yield setState('VERIFY');
    const r = await tools.verify(sess.verify, sess.inquiryId, plan.orderNo, plan.last4);
    if (r === 'ok') {
      sess.awaitingVerify = false;
      plan = { kind: 'llm', state: 'ANSWER', lookup: true, question: sess.pendingQuestion ?? text };
      sess.pendingQuestion = null;
      lookup = true;
    } else {
      if (r === 'locked') sess.awaitingVerify = false;
      plan = r === 'locked' ? { kind: 'template', state: 'HANDOFF', template: handoffTemplate(cfg, now) } : { kind: 'template', state: 'VERIFY', template: 'verify_failed' };
    }
  }

  if (plan.kind === 'template') {
    yield setState(plan.state);
    yield say(plan.state === 'HANDOFF' && (plan.template === 'handoff' || plan.template === 'off_hours') ? handoffLine() : tpl(plan.template));
    endCall = !!plan.endCall;
  } else if (plan.kind === 'llm') {
    yield setState(plan.state);
    const v = cfg.settings.voice;
    // 조회처럼 시간이 걸리는 턴은 필러를 먼저 말함 (전화만. 채팅은 답을 한 번에 보냄)
    if (sess.channel === 'call' && lookup && v.filler.enabled && v.filler.phrases[0]) yield say(v.filler.phrases[0]);
    const [grounding, orders] = await Promise.all([
      plan.state === 'ANSWER' ? retrieve(db, sess.tenantId, cfg, plan.question) : Promise.resolve(''),
      lookup ? tools.lookup(sess.verify, sess.inquiryId) : Promise.resolve(null),
    ]);
    if (orders?.length) sess.orderData.push(...orders);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(cfg, sess.channel, plan, grounding, orders, now) },
      ...sess.history.slice(-12),
      { role: 'user', content: plan.question },
    ];
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort);
    const splitter = new SentenceSplitter();
    let blocked = false;
    try {
      const stream = llm.stream(messages, { tier: 'fast', routing: sess.channel === 'call' ? cfg.settings.ai.routing.voice_reply : cfg.settings.ai.routing.chat_reply, signal: ac.signal, maxTokens: 400 });
      outer: for await (const delta of stream) {
        if (!firstTokenMs) firstTokenMs = Math.round(performance.now() - t0);
        for (const sentence of splitter.push(delta)) {
          // 근거 없음 · 금지 표현 · 개인정보 노출(S8) → 그 문장을 읽지 않고 사장님 연결로 전환
          if (sentence.includes(HANDOFF_MARK) || containsBanned(sentence, cfg) || leaksPii(sentence, sess.verify.verifiedPhone)) { blocked = true; break outer; }
          yield say(sentence);
        }
      }
      if (!blocked) for (const sentence of splitter.flush()) {
        if (sentence.includes(HANDOFF_MARK) || containsBanned(sentence, cfg) || leaksPii(sentence, sess.verify.verifiedPhone)) { blocked = true; break; }
        yield say(sentence);
      }
    } catch (e) {
      if (signal.aborted) return; // 끼어들기: 조용히 종료 (다음 턴이 이어받음)
      blocked = true; // LLM 장애: 고객이 답을 못 받는 일이 없도록 사장님 연결 멘트로 대체
    } finally {
      ac.abort();
      signal.removeEventListener('abort', onAbort);
    }
    if (blocked) {
      sess.needsOwner = true;
      yield setState('HANDOFF');
      yield say(handoffLine());
    }
  }

  maybeAlertLive(sess, deps, Math.max(pf.heatHint, sess.heat));
  const reply = spoken.join(' ');
  sess.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
  sess.turnLatencies.push(firstSentenceMs);
  await saveCustomer;
  if (reply) await db.withTenant(sess.tenantId, (tx) => tx.insert(s.messages).values({ tenantId: sess.tenantId, inquiryId: sess.inquiryId, sender: 'ai', text: reply, latencyMs: firstSentenceMs }));
  yield { type: 'metrics', first_sentence_ms: firstSentenceMs, llm_first_token_ms: firstTokenMs };
  yield { type: 'done', end_call: endCall };
}

/** 통화 시작 (브라우저 통화 · Vapi 공용): 문의 생성 + 인사말(AI 고지 포함) 기록. 전화 응대가 꺼진 매장은 409 */
export async function startCallSession(db: Db, tenantId: string, cfg: TenantConfig, id: string): Promise<{ sess: CallSession; greeting: string }> {
  const { voice, response } = cfg.settings;
  await createContextStore(db).load(tenantId).catch(() => {}); // 매장 문서 최신본 (실패하면 캐시 · 기본값)
  if (!voice.enabled || !response.ai_enabled || !response.channels.call) throw new ApiError(409, 'voice_disabled', '이 매장은 AI 전화 응대가 꺼져 있습니다.');
  const [inq] = await db.withTenant(tenantId, (tx) => tx.insert(s.inquiries).values({ tenantId, channel: 'call', status: 'pending' }).returning({ id: s.inquiries.id }));
  const base = renderTemplate(cfg, 'greeting');
  const greeting = [base, response.ai_disclosure.enabled && !base.includes('AI') ? response.ai_disclosure.text : ''].filter(Boolean).join(' ');
  await db.withTenant(tenantId, (tx) => tx.insert(s.messages).values({ tenantId, inquiryId: inq!.id, sender: 'ai', text: greeting }));
  const sess: CallSession = {
    id, channel: 'call', tenantId, inquiryId: inq!.id, state: 'GREET', verify: newVerifyState(), abuseStreak: 0,
    awaitingVerify: false, pendingQuestion: null, heat: 0, needsOwner: false, riskFlags: new Set(),
    history: [{ role: 'assistant', content: greeting }], turnLatencies: [], orderData: [], ended: false,
  };
  return { sess, greeting };
}

/** 대화 종료 처리 (전화 · 채팅 공용): 문의 상태 갱신 후 요약 카드 생성 */
export async function finalizeInquiry(sess: CallSession, deps: TurnDeps) {
  const status = sess.needsOwner || sess.heat >= deps.cfg.settings.response.heat_threshold ? 'pending' : 'auto_done';
  await deps.db.withTenant(sess.tenantId, (tx) => tx.update(s.inquiries).set({ status, updatedAt: new Date() }).where(eq(s.inquiries.id, sess.inquiryId)));
  const card = await buildCallCard(sess, deps);
  const n = deps.cfg.settings.notifications;
  if (deps.alerts && (status === 'pending' ? n.events.pending_card : n.events.call_ended)) {
    await deps.alerts.emit(deps.cfg, {
      tenantId: sess.tenantId, inquiryId: sess.inquiryId, channel: sess.channel, kind: 'card',
      heat: Math.max(sess.peakHeat ?? 0, sess.heat), riskFlags: card.risk_flags, needsOwner: sess.needsOwner,
      title: card.title, message: [`감정 ${card.heat_label}`, status === 'pending' ? '승인 대기' : 'AI가 처리 완료', ...card.risk_flags].join(' · '),
    }).catch(() => null); // 알림 실패해도 카드는 돌려줌
  }
  return card;
}

/** 대화 종료 후 요약 카드 (F5와 같은 스키마). 욕설 · 감정 표현은 빼고 사실만 */
export async function buildCallCard(sess: CallSession, deps: TurnDeps) {
  const transcript = sess.history.map((m) => `${m.role === 'user' ? '고객' : 'AI'}: ${m.content}`).join('\n');
  const card = await deps.llm.json([
    {
      role: 'system',
      content: [
        `${sess.channel === 'call' ? '통화' : '채팅'} 기록을 사장님용 요약 카드로 정리합니다.` + ' 욕설 · 비하 · 감정 표현은 모두 빼고 중립적인 사실만 씁니다.',
        'demands: 고객 요구사항. facts: 사실관계. [주문 데이터]로 확인된 사실만 source=order_data, 고객 말은 source=customer_claim.',
        'recommendations: 사장님이 바로 보낼 수 있는 대응안 2개 이상 (draft는 고객에게 보낼 정중한 문장, 정책 근거가 없으면 policy_ref=null).',
        'heat_label: 보통 / 높음 / 매우 높음 중 하나.',
        `참고 위험 표시: ${[...sess.riskFlags].join(', ') || '없음'}`,
        `[매장 정보]\n${businessContext(deps.cfg, true)}`,
        `[주문 데이터]\n${JSON.stringify(sess.orderData)}`,
      ].join('\n'),
    },
    { role: 'user', content: transcript || '(대화 없음)' },
  ], Card, { tier: 'smart', name: 'call_card', jsonSchema: strictJsonSchema(Card) });

  await deps.db.withTenant(sess.tenantId, async (tx) => {
    await tx.insert(s.cards).values({ tenantId: sess.tenantId, inquiryId: sess.inquiryId, summary: card });
    await tx.insert(s.analyses).values({ tenantId: sess.tenantId, inquiryId: sess.inquiryId, heat: sess.heat, needsOwner: sess.needsOwner, raw: { risk_flags: [...sess.riskFlags], latencies_ms: sess.turnLatencies, category: sess.category ?? null, judged_by: sess.judgedBy ?? null } });
  });
  return card;
}

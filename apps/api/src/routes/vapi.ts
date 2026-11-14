// Vapi 음성 통화. Vapi가 듣고 말하고, 답변은 Custom LLM 주소로 우리 서버에서 받음 (상태 머신 · 안전장치는 브라우저 통화와 같은 runTurn)
//   Vapi → POST /v1/vapi/{매장 webhook_token}/chat/completions   (OpenAI 호환 SSE)
//   Vapi → POST /v1/vapi/{매장 webhook_token}/events             (통화 종료 보고 → 요약 카드)
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import type { AlertCenter } from '../alerts.js';
import type { Bivia } from '../integrations/bivia.js';
import type { Rag } from '../knowledge/rag.js';
import type { Tracker } from '../integrations/tracker.js';
import type { CommerceService } from '../commerce/service.js';
import { ApiError, notFound } from '../errors.js';
import type { Llm } from '../integrations/llm.js';
import { SECRET_HEADER, vapiAssistantConfig, type VapiClient } from '../integrations/vapi.js';
import { TENANT_ID } from '../mocks/data.js';
import { getTenantConfig } from '../tenantConfig.js';
import type { CallSession } from '../voice/policy.js';
import { finalizeInquiry, runTurn, startCallSession } from '../voice/turn.js';

type Db = ReturnType<typeof createDb>;
type Sess = CallSession & { card: z.infer<typeof C.Card> | null; controlUrl: string | null; finalized: boolean };
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = z.object({ token: z.string().min(1).max(200) });
const callIdParam = z.object({ callId: z.string().min(1).max(100) });
const VapiCall = z.looseObject({ id: z.string().min(1).max(100), monitor: z.looseObject({ controlUrl: z.string().url().optional() }).optional() });
// Vapi가 보내는 OpenAI 형식 요청. metadataSendMode=variable 이면 call 객체가 같이 옴
const LlmBody = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })).default([]), call: VapiCall.optional() });
const EventBody = z.looseObject({ message: z.looseObject({ type: z.string(), status: z.string().optional(), call: VapiCall.optional() }) });
const VapiCallDetail = C.CallDetail.extend({ call_id: z.string() });

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('') : '';

export function vapiRoutes(deps: { db: Db; llm: Llm; vapi: VapiClient; alerts?: AlertCenter; bivia?: Bivia; rag?: Rag; tracker?: Tracker; commerce?: CommerceService; env?: NodeJS.ProcessEnv }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;
  // shortcut: 통화 세션을 프로세스 메모리에 둠 (서버 1대 기준, 종료 30분 뒤 삭제). 여러 대면 Redis
  const sessions = new Map<string, Sess>(); // Vapi call id → 세션
  // shortcut: 매장별 어시스턴트 id를 메모리에 (처음엔 VAPI_ASSISTANT_ID). 여러 매장이면 tenants 테이블 컬럼으로
  const assistantIds = new Map<string, string>();
  // shortcut: 인증 전이라 데모 매장 고정, Better Auth 붙일 때 세션의 매장으로 교체
  const tenantOf = () => TENANT_ID;

  const tenantFor = async (req: FastifyRequest<{ Params: { token: string } }>) => {
    const tenantId = (await deps.db.tenantForWebhook(req.params.token)) ?? notFound('webhook_not_found');
    const secret = env.VAPI_SERVER_SECRET;
    if (secret && !safeEq(String(req.headers[SECRET_HEADER] ?? ''), secret)) throw new ApiError(401, 'invalid_vapi_secret', 'Vapi 요청 확인 값이 맞지 않습니다.');
    return tenantId;
  };

  const finalize = (sess: Sess, log: FastifyRequest['log']) => {
    if (sess.finalized) return;
    sess.finalized = true; sess.ended = true; sess.state = 'CLOSE';
    sess.current?.abort();
    finalizeInquiry(sess, { db: deps.db, llm: deps.llm, alerts: deps.alerts, bivia: deps.bivia, rag: deps.rag, tracker: deps.tracker, commerce: deps.commerce, cfg: getTenantConfig(sess.tenantId) })
      .then((card) => { sess.card = card; })
      .catch((err) => log.error({ err, call: sess.id }, 'vapi call card failed'));
    setTimeout(() => sessions.delete(sess.id), 30 * 60_000).unref();
  };

  return async (app) => {
    app.post('/vapi/:token/chat/completions', {
      schema: { tags: ['vapi'], params: token, body: LlmBody, description: 'Vapi가 호출 (Custom LLM, OpenAI 호환 SSE). 프론트에서 호출하지 않음. 첫 요청(고객 발화 없음)은 인사, 이후는 마지막 고객 발화로 한 턴' },
    }, async (req, reply) => {
      const tenantId = await tenantFor(req);
      const callId = req.body.call?.id ?? (() => { throw new ApiError(400, 'vapi_call_missing', 'call 객체가 없습니다 (어시스턴트의 metadataSendMode를 variable로).'); })();
      // 맨 끝의 연속된 고객 발화를 한 턴으로 (말이 잘려 두 번에 나뉘어 와도 앞부분을 잃지 않게)
      const msgs = req.body.messages;
      let i = msgs.length;
      while (i > 0 && msgs[i - 1]!.role === 'user') i--;
      const userText = msgs.slice(i).map((m) => textOf(m.content).trim()).filter(Boolean).join(' ');

      let sess = sessions.get(callId);
      let greeting: string | null = null;
      if (!sess) {
        const started = await startCallSession(deps.db, tenantId, getTenantConfig(tenantId), callId);
        sess = { ...started.sess, card: null, controlUrl: null, finalized: false };
        sessions.set(callId, sess);
        greeting = started.greeting;
        void deps.llm.warmup();
      }
      if (sess.tenantId !== tenantId) notFound('call_not_found');
      sess.controlUrl = req.body.call?.monitor?.controlUrl ?? sess.controlUrl;

      sess.current?.abort(); // 끼어들기: Vapi가 이전 요청을 끊지 않았어도 이전 턴 생성 중단
      const ac = new AbortController();
      sess.current = ac;
      reply.hijack();
      reply.raw.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      reply.raw.on('close', () => ac.abort()); // 고객이 끼어들면 Vapi가 요청을 끊음 → LLM 생성도 취소
      const id = `chatcmpl-${callId.slice(0, 8)}-${Date.now()}`;
      const chunk = (delta: object, finish: string | null = null) =>
        reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mawd-call', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const say = (text: string) => chunk({ role: 'assistant', content: `${text} ` });

      const closing: string[] = [];
      let endCall = false;
      try {
        if (greeting) say(greeting);
        else if (userText && !sess.ended) {
          for await (const e of runTurn(sess, userText, { db: deps.db, llm: deps.llm, alerts: deps.alerts, bivia: deps.bivia, rag: deps.rag, tracker: deps.tracker, commerce: deps.commerce, cfg: getTenantConfig(tenantId) }, ac.signal)) {
            if (ac.signal.aborted) break;
            // 종료 턴(state=CLOSE)의 마지막 인사는 Vapi 통화 제어로 "다 읽고 끊기" → 응답 본문에는 싣지 않음
            if (e.type === 'sentence') (sess.state === 'CLOSE' && sess.controlUrl ? closing.push(e.text) : say(e.text));
            if (e.type === 'done' && e.end_call) { endCall = true; sess.ended = true; }
          }
        }
      } catch (err) {
        req.log.error({ err, call: callId }, 'vapi turn failed');
      } finally {
        if (sess.current === ac) sess.current = undefined;
        if (!reply.raw.writableEnded) { chunk({}, 'stop'); reply.raw.write('data: [DONE]\n\n'); reply.raw.end(); }
      }
      if (endCall && sess.controlUrl) {
        await deps.vapi.control(sess.controlUrl, { type: 'say', content: closing.join(' '), endCallAfterSpoken: true })
          .catch((err) => req.log.error({ err, call: callId }, 'vapi end call failed'));
      }
    });

    app.post('/vapi/:token/events', {
      schema: { tags: ['vapi'], params: token, body: EventBody, response: { 200: z.object({ ok: z.literal(true) }) }, description: 'Vapi 서버 메시지 (프론트에서 호출하지 않음). end-of-call-report / status-update(ended) → 요약 카드 생성' },
    }, async (req) => {
      const tenantId = await tenantFor(req);
      const { type, status, call } = req.body.message;
      const sess = call ? sessions.get(call.id) : undefined;
      if (sess && sess.tenantId === tenantId) {
        sess.controlUrl = call?.monitor?.controlUrl ?? sess.controlUrl;
        if (type === 'end-of-call-report' || (type === 'status-update' && status === 'ended')) finalize(sess, req.log);
      }
      return { ok: true as const };
    });

    // ---- 데모 화면용 ----
    app.get('/vapi/config', {
      schema: { tags: ['vapi'], response: { 200: z.object({ enabled: z.boolean(), public_key: z.string().nullable(), assistant_id: z.string().nullable() }) }, description: '브라우저에서 Vapi 웹 SDK를 쓸 수 있는지. enabled=false면 기존 브라우저 통화로' },
    }, async () => {
      const t = tenantOf();
      const enabled = deps.vapi.configured && getTenantConfig(t).settings.voice.tts.engine === 'vapi';
      return { enabled, public_key: enabled ? deps.vapi.publicKey : null, assistant_id: assistantIds.get(t) ?? (env.VAPI_ASSISTANT_ID || null) };
    });

    app.post('/vapi/assistant/sync', {
      schema: { tags: ['vapi'], response: { 200: z.object({ assistant_id: z.string() }) }, description: '매장 설정(음성 · 말 끝 감지 · 끼어들기 · 최대 통화 시간)으로 Vapi 어시스턴트를 만들거나 갱신. 통화 시작 전에 호출. 키 없으면 409 vapi_not_configured' },
    }, async () => {
      const t = tenantOf();
      if (!deps.vapi.configured) throw new ApiError(409, 'vapi_not_configured', 'VAPI_PRIVATE_KEY · VAPI_PUBLIC_KEY · PUBLIC_BASE_URL이 필요합니다.');
      const [row] = await deps.db.withTenant(t, (tx) => tx.select({ token: s.tenants.webhookToken }).from(s.tenants).where(eq(s.tenants.id, t)));
      const body = vapiAssistantConfig(getTenantConfig(t), { baseUrl: env.PUBLIC_BASE_URL!, webhookToken: row?.token ?? notFound('tenant_not_found'), secret: env.VAPI_SERVER_SECRET, tenantId: t });
      const assistantId = await deps.vapi.upsertAssistant(assistantIds.get(t) ?? (env.VAPI_ASSISTANT_ID || null), body);
      assistantIds.set(t, assistantId);
      return { assistant_id: assistantId };
    });

    const mine = (callId: string) => {
      const sess = sessions.get(callId);
      return sess && sess.tenantId === tenantOf() ? sess : notFound('call_not_found');
    };
    app.get('/vapi/calls/:callId', { schema: { tags: ['vapi'], params: callIdParam, response: { 200: VapiCallDetail }, description: 'Vapi 통화 상태 · 전사 · 요약 카드 (데모 화면 폴링용, callId는 Vapi call id)' } }, async (req) => {
      const sess = mine(req.params.callId);
      return {
        call_id: sess.id, inquiry_id: sess.inquiryId, state: sess.state, ended: sess.ended,
        transcript: sess.history.map((m) => ({ role: m.role === 'user' ? 'customer' as const : 'ai' as const, text: m.content })),
        turn_latencies_ms: sess.turnLatencies, card: sess.card,
      };
    });
    app.post('/vapi/calls/:callId/end', { schema: { tags: ['vapi'], params: callIdParam, response: { 200: z.object({ inquiry_id: z.string().uuid() }) }, description: '데모: 화면에서 끊은 직후 카드 생성 시작 (Vapi 종료 보고를 기다리지 않음, 중복 호출 무시)' } }, async (req) => {
      const sess = mine(req.params.callId);
      finalize(sess, req.log);
      return { inquiry_id: sess.inquiryId };
    });
  };
}

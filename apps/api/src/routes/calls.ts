// 실시간 통화 API (F9). 프론트는 브라우저 음성 인식 결과 텍스트를 턴마다 보내고, SSE로 문장을 받아 바로 읽습니다.
import { tenantOf } from '../auth.js';
import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import type { AlertCenter } from '../alerts.js';
import type { Bivia } from '../integrations/bivia.js';
import type { Rag } from '../knowledge/rag.js';
import type { Tracker } from '../integrations/tracker.js';
import type { CommerceService } from '../commerce/service.js';
import { ApiError, notFound } from '../errors.js';
import type { Llm } from '../integrations/llm.js';
import type { Tts } from '../integrations/tts.js';
import { getTenantConfig } from '../tenantConfig.js';
import { renderTemplate, type CallSession } from '../voice/policy.js';
import { finalizeInquiry, runTurn, startCallSession } from '../voice/turn.js';

type Db = ReturnType<typeof createDb>;
const idParam = z.object({ id: z.string().uuid() });

export function callRoutes(deps: { db: Db; llm: Llm; tts: Tts; alerts?: AlertCenter; bivia?: Bivia; rag?: Rag; tracker?: Tracker; commerce?: CommerceService }): FastifyPluginAsyncZod {
  // shortcut: 통화 세션을 프로세스 메모리에 둠 (서버 1대 기준). 여러 대로 늘리면 Redis/DB로 옮기고 스티키 라우팅
  const sessions = new Map<string, CallSession & { card: z.infer<typeof C.Card> | null }>();
  const get = (id: string) => sessions.get(id) ?? notFound('call_not_found');
  const ttsOpts = (v: C.AllSettings['voice']) => ({ voice: v.tts.voice_name ?? 'coral', speed: v.tts.rate, instructions: v.tts.instructions });

  return async (app) => {
    app.post('/calls', { schema: { tags: ['calls'], response: { 200: C.CallStart } } }, async (req) => {
      const tenantId = tenantOf(req);
      const cfg = getTenantConfig(tenantId);
      const { voice } = cfg.settings;
      const id = randomUUID();
      const { sess, greeting } = await startCallSession(deps.db, tenantId, cfg, id);
      void deps.llm.warmup(); // 첫 턴 전에 연결 수립 (측정: 첫 턴 1.9s → 연결 재사용 시 0.8s 안팎)
      if (voice.tts.engine !== 'browser' && deps.tts.configured !== false) { // vapi 매장도 Vapi 키가 없을 때는 이 경로(서버 음성)로 대신 통화
        // 고정 문구는 통화 시작에 미리 합성해 캐시에 넣어 둠 → 해당 턴은 기다림 없이 재생
        // 인사는 응답 직후 프론트가 바로 요청하며 스트리밍으로 받으므로 제외
        const fixed = [...(['verify_request', 'verify_failed', 'calm', 'handoff', 'call_close', 'abuse_warning'] as const).map((k) => renderTemplate(cfg, k)), ...voice.filler.phrases];
        for (const t of fixed) if (t) deps.tts(t, ttsOpts(voice)).then((r) => r.resume(), () => {});
      }
      sessions.set(id, { ...sess, card: null });
      return { call_id: id, greeting_text: greeting };
    });

    // <audio src>로 바로 스트리밍 재생하려고 2단계: POST로 문장을 맡기고 받은 id를 GET. 문장(주문 정보 포함 가능)을 URL에 싣지 않기 위함
    // shortcut: 프로세스 메모리, 5분 뒤 삭제 (브라우저가 같은 주소를 다시 요청할 수 있어 GET 후에도 남김)
    const ttsJobs = new Map<string, { tenantId: string; text: string }>();
    app.post('/tts', {
      schema: { tags: ['calls'], body: z.object({ text: z.string().min(1).max(500) }), response: { 200: z.object({ id: z.string().uuid(), url: z.string() }) }, description: '매장 음성 설정(voice.tts)으로 읽을 문장 등록. 받은 url을 <audio src>에 넣으면 wav를 스트리밍 재생. sentence 이벤트마다 바로 등록하면 앞 문장 재생 중에 다음 문장이 준비됨' },
    }, async (req) => {
      const tenantId = tenantOf(req);
      if (getTenantConfig(tenantId).settings.voice.tts.engine === 'browser') throw new ApiError(409, 'tts_engine_browser', '이 매장은 브라우저 음성을 씁니다.');
      if (deps.tts.configured === false) throw new ApiError(409, 'tts_not_configured', '서버 음성 합성 키(TTS_API_KEY)가 없어 브라우저 음성으로 대체합니다.');
      const id = randomUUID();
      ttsJobs.set(id, { tenantId, text: req.body.text });
      setTimeout(() => ttsJobs.delete(id), 5 * 60_000).unref();
      return { id, url: `/v1/tts/${id}` };
    });
    app.get('/tts/:id', { schema: { tags: ['calls'], params: idParam, description: 'audio/wav 스트림' } }, async (req, reply) => {
      const job = ttsJobs.get(req.params.id) ?? notFound('tts_not_found');
      const stream = await deps.tts(job.text, ttsOpts(getTenantConfig(job.tenantId).settings.voice));
      return reply.type('audio/wav').header('cache-control', 'private, max-age=300').send(stream);
    });

    app.post('/calls/:id/turns', {
      schema: { tags: ['calls'], params: idParam, body: C.CallTurnBody, description: 'SSE 스트림 (text/event-stream). 이벤트 형식은 contracts의 CallTurnEvent' },
    }, async (req, reply) => {
      const sess = get(req.params.id);
      if (sess.ended) throw new ApiError(409, 'call_ended', '이미 종료된 통화입니다.');
      sess.current?.abort(); // 끼어들기: 이전 턴 생성 중단
      const ac = new AbortController();
      sess.current = ac;

      reply.hijack();
      reply.raw.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      reply.raw.on('close', () => ac.abort()); // 클라이언트가 끊으면(끼어들기) LLM 호출도 취소
      try {
        for await (const e of runTurn(sess, req.body.text, { db: deps.db, llm: deps.llm, alerts: deps.alerts, bivia: deps.bivia, rag: deps.rag, tracker: deps.tracker, commerce: deps.commerce, cfg: getTenantConfig(sess.tenantId) }, ac.signal)) {
          if (ac.signal.aborted) break;
          reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          if (e.type === 'done' && e.end_call) sess.ended = true;
        }
      } catch (err) {
        req.log.error(err);
        if (!reply.raw.writableEnded) reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: '처리 중 오류가 발생했습니다.' })}\n\n`);
      } finally {
        if (sess.current === ac) sess.current = undefined;
        reply.raw.end();
      }
    });

    app.post('/calls/:id/end', { schema: { tags: ['calls'], params: idParam, response: { 200: z.object({ inquiry_id: z.string().uuid() }) } } }, async (req) => {
      const sess = get(req.params.id);
      sess.current?.abort();
      sess.ended = true;
      sess.state = 'CLOSE';
      // 카드는 비동기 생성 → GET /calls/:id 로 폴링 (스펙 AC: 종료 1분 안)
      finalizeInquiry(sess, { db: deps.db, llm: deps.llm, alerts: deps.alerts, bivia: deps.bivia, rag: deps.rag, tracker: deps.tracker, commerce: deps.commerce, cfg: getTenantConfig(sess.tenantId) })
        .then((card) => { sess.card = card; })
        .catch((err) => app.log.error({ err, call: sess.id }, 'call card failed'));
      return { inquiry_id: sess.inquiryId };
    });

    app.get('/calls/:id', { schema: { tags: ['calls'], params: idParam, response: { 200: C.CallDetail } } }, async (req) => {
      const sess = get(req.params.id);
      return {
        call_id: sess.id, inquiry_id: sess.inquiryId, state: sess.state, ended: sess.ended,
        transcript: sess.history.map((m) => ({ role: m.role === 'user' ? 'customer' as const : 'ai' as const, text: m.content })),
        turn_latencies_ms: sess.turnLatencies,
        card: sess.card,
      };
    });
  };
}

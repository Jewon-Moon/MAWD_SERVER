// 채널톡 웹훅 수신 + 채팅 데모용 조회. 웹훅 주소: POST /v1/webhooks/channeltalk/{매장 webhook_token}?token={채널톡 웹훅 토큰}
import { tenantOf } from '../auth.js';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { ChatService } from '../chat/service.js';
import type { createDb } from '../db/client.js';
import { ApiError, notFound } from '../errors.js';
import { parseWebhook } from '../integrations/channeltalk.js';
import { getTenantConfig } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ChatDetail = z.object({
  chat_id: z.string(), inquiry_id: z.string().uuid(), state: C.CallState, handed_off: z.boolean(), ended: z.boolean(), busy: z.boolean(),
  transcript: z.array(z.object({ role: z.enum(['customer', 'ai']), text: z.string() })), card: C.Card.nullable(),
});

export function channelTalkRoutes(deps: { db: Db; chat: ChatService; env?: NodeJS.ProcessEnv }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;

  return async (app) => {
    app.post('/webhooks/channeltalk/:token', {
      schema: {
        tags: ['webhooks'], params: z.object({ token: z.string().min(1).max(200) }), querystring: z.object({ token: z.string().optional() }),
        body: z.unknown(), response: { 200: z.object({ ok: z.literal(true) }) },
        description: '채널톡이 호출 (프론트에서 호출하지 않음). 경로의 토큰으로 매장을 찾고, CHANNELTALK_WEBHOOK_TOKEN이 있으면 ?token= 도 확인. 바로 200을 주고 처리는 뒤에서',
      },
    }, async (req) => {
      const tenantId = (await deps.db.tenantForWebhook(req.params.token)) ?? notFound('webhook_not_found');
      const expected = env.CHANNELTALK_WEBHOOK_TOKEN;
      if (expected && !safeEq(req.query.token ?? '', expected)) throw new ApiError(401, 'invalid_webhook_token', '웹훅 토큰이 맞지 않습니다.');
      const msg = parseWebhook(req.body);
      // 처리 시간(LLM)이 길어 채널톡이 실패로 보고 재시도하지 않도록 먼저 200
      if (msg) void deps.chat.handle(tenantId, msg).catch((err) => req.log.error({ err }, 'chat handle failed'));
      return { ok: true as const };
    });

    const toDetail = (sess: NonNullable<Awaited<ReturnType<ChatService['get']>>>) => ({
      chat_id: sess.chatId, inquiry_id: sess.inquiryId, state: sess.state, handed_off: sess.handedOff, ended: sess.ended,
      busy: sess.busy || sess.pending.length > 0,
      transcript: sess.history.map((m) => ({ role: m.role === 'user' ? 'customer' as const : 'ai' as const, text: m.content })),
      card: sess.card,
    });
    app.get('/chats/:chatId', { schema: { tags: ['chats'], params: z.object({ chatId: z.string().min(1).max(100) }), response: { 200: ChatDetail }, description: '채팅 대화 상태 · 전사 · 요약 카드 (데모 화면 폴링용)' } },
      async (req) => toDetail((await deps.chat.get(tenantOf(req), req.params.chatId)) ?? notFound('chat_not_found')));
    // 채널톡 없이 같은 처리를 돌려 보는 데모 · 테스트용 입구 (웹훅과 달리 답이 나올 때까지 기다렸다가 대화 상태를 돌려줌)
    app.post('/chats/:chatId/messages', {
      schema: { tags: ['chats'], params: z.object({ chatId: z.string().min(1).max(100) }), body: z.object({ text: z.string().min(1).max(2000), customer_name: z.string().min(1).max(100).optional() }), response: { 200: ChatDetail }, description: '데모: 고객 메시지를 채널톡 웹훅과 같은 경로로 처리. AI 채팅 응대가 꺼진 매장은 409 chat_disabled' },
    }, async (req) => {
      const { response } = getTenantConfig(tenantOf(req)).settings;
      if (!response.ai_enabled || !response.channels.chat) throw new ApiError(409, 'chat_disabled', '이 매장은 AI 채팅 응대가 꺼져 있습니다.');
      await deps.chat.handle(tenantOf(req), { chatId: req.params.chatId, text: req.body.text, customerName: req.body.customer_name?.trim() || '데모 고객', customerPhone: null });
      return toDetail((await deps.chat.get(tenantOf(req), req.params.chatId)) ?? notFound('chat_not_found'));
    });
    app.post('/chats/:chatId/end', { schema: { tags: ['chats'], params: z.object({ chatId: z.string().min(1).max(100) }), response: { 200: ChatDetail }, description: '대화 마무리 + 요약 카드 생성 (보통은 chat_idle_minutes 뒤 자동)' } },
      async (req) => toDetail((await deps.chat.end(tenantOf(req), req.params.chatId)) ?? notFound('chat_not_found')));
  };
}

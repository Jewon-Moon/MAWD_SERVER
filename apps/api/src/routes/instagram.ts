// 인스타그램 연동: Meta 웹훅(구독 확인 · 댓글 수신) + 매장별 계정 연결.
//   Meta → GET  /v1/webhooks/instagram   구독 확인 (hub.verify_token = INSTAGRAM_VERIFY_TOKEN)
//   Meta → POST /v1/webhooks/instagram   댓글 이벤트 (X-Hub-Signature-256 = 앱 시크릿 HMAC). 바로 200, 처리는 뒤에서
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { createDb } from '../db/client.js';
import { ApiError } from '../errors.js';
import { parseCommentWebhook, verifyMetaSignature } from '../integrations/instagram.js';
import { TENANT_ID } from '../mocks/data.js';
import type { InstagramService } from '../sns/instagram.js';

type Db = ReturnType<typeof createDb>;
const Status = z.object({ connected: z.boolean(), ig_user_id: z.string().nullable(), username: z.string().nullable(), connected_at: z.string().nullable() });

export function instagramRoutes(deps: { db: Db; instagram: InstagramService; env?: NodeJS.ProcessEnv }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;
  // shortcut: 인증 전이라 데모 매장 고정, Better Auth 붙일 때 세션의 매장으로 교체
  const tenantOf = () => TENANT_ID;

  return async (app) => {
    // 서명 확인에 원본 본문이 필요해서 이 플러그인 안에서만 JSON을 직접 파싱 (다른 라우트에는 영향 없음)
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try { done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {}); } catch (e) { done(e as Error, undefined); }
    });

    app.get('/webhooks/instagram', {
      schema: { tags: ['webhooks'], querystring: z.looseObject({ 'hub.mode': z.string().optional(), 'hub.verify_token': z.string().optional(), 'hub.challenge': z.string().optional() }), description: 'Meta 웹훅 구독 확인 (프론트에서 호출하지 않음)' },
    }, async (req, reply) => {
      const expected = env.INSTAGRAM_VERIFY_TOKEN?.trim();
      if (!expected || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== expected) throw new ApiError(403, 'instagram_verify_failed', '웹훅 확인 토큰이 맞지 않습니다.');
      return reply.type('text/plain').send(req.query['hub.challenge'] ?? '');
    });

    app.post('/webhooks/instagram', {
      schema: { tags: ['webhooks'], body: z.unknown(), response: { 200: z.object({ ok: z.literal(true) }) }, description: 'Meta 인스타그램 웹훅 (댓글). 앱 시크릿 서명이 맞아야 받음. 바로 200, 처리는 뒤에서' },
    }, async (req) => {
      const secret = env.INSTAGRAM_APP_SECRET?.trim();
      if (!secret) throw new ApiError(503, 'instagram_not_configured', '서버에 INSTAGRAM_APP_SECRET이 없습니다.');
      if (!verifyMetaSignature((req as unknown as { rawBody: Buffer }).rawBody, req.headers['x-hub-signature-256'] as string | undefined, secret)) {
        throw new ApiError(401, 'invalid_signature', '웹훅 서명이 맞지 않습니다.');
      }
      for (const c of parseCommentWebhook(req.body)) {
        void (async () => {
          const tenantId = await deps.db.tenantForInstagram(c.igUserId);
          if (tenantId) await deps.instagram.handleComment(tenantId, c);
        })().catch((err) => req.log.error({ err, comment: c.commentId }, 'instagram comment failed'));
      }
      return { ok: true as const };
    });

    // ---- 매장 연결 (사장님 화면) ----
    app.get('/instagram/connection', { schema: { tags: ['instagram'], response: { 200: Status }, description: '연결된 인스타 계정' } }, async () => deps.instagram.status(tenantOf()));
    app.put('/instagram/connection', {
      schema: { tags: ['instagram'], body: z.object({ access_token: z.string().min(20).max(1000) }), response: { 200: Status }, description: '액세스 토큰으로 계정을 확인하고 연결 (토큰은 암호화 저장). 틀리면 400, 다른 매장 계정이면 409' },
    }, async (req) => deps.instagram.connect(tenantOf(), req.body.access_token));
    app.delete('/instagram/connection', { schema: { tags: ['instagram'], response: { 200: Status }, description: '연결 해제 (토큰 삭제)' } }, async () => deps.instagram.disconnect(tenantOf()));
  };
}

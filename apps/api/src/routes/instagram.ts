// 인스타그램 연동: Meta 웹훅(구독 확인 · 댓글 수신) + 매장별 계정 연결.
//   Meta → GET  /v1/webhooks/instagram   구독 확인 (hub.verify_token = INSTAGRAM_VERIFY_TOKEN)
//   Meta → POST /v1/webhooks/instagram   댓글 이벤트 (X-Hub-Signature-256 = 앱 시크릿 HMAC). 바로 200, 처리는 뒤에서
import { loadConfig } from '../tenantConfig.js';
import { tenantOf } from '../auth.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { createDb } from '../db/client.js';
import { ApiError } from '../errors.js';
import { randomBytes } from 'node:crypto';
import { exchangeUnifiedCode, parseCommentWebhook, unifiedLoginUrl, verifyMetaSignature } from '../integrations/instagram.js';
import type { InstagramService } from '../sns/instagram.js';

type Db = ReturnType<typeof createDb>;
const Status = z.object({ connected: z.boolean(), ig_user_id: z.string().nullable(), username: z.string().nullable(), connected_at: z.string().nullable() });

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const page = (title: string, msg: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f5f7">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;max-width:420px;text-align:center"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="color:#4b5563;line-height:1.6">${esc(msg)}</p><a href="/console" style="color:#3b5bfd">콘솔로 돌아가기</a></div>`;

export function instagramRoutes(deps: { db: Db; instagram: InstagramService; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;
  // 통합 로그인 OAuth: 로그인 시작 때 만든 state → 매장 (CSRF 방지, 10분 · 한 번만)
  // shortcut: 프로세스 메모리 (서버 1대 기준). 여러 대면 Redis
  const states = new Map<string, { tenantId: string; at: number }>();
  const oauthConf = () => {
    const appId = env.INSTAGRAM_APP_ID?.trim(), configId = env.INSTAGRAM_CONFIG_ID?.trim(), appSecret = env.INSTAGRAM_APP_SECRET?.trim(), base = env.PUBLIC_BASE_URL?.trim();
    if (!appId || !configId || !appSecret || !base) throw new ApiError(503, 'instagram_oauth_not_configured', 'INSTAGRAM_APP_ID · INSTAGRAM_CONFIG_ID · INSTAGRAM_APP_SECRET · PUBLIC_BASE_URL이 필요합니다.');
    return { appId, configId, appSecret, redirectUri: `${base.replace(/\/$/, '')}/v1/instagram/oauth/callback` };
  };

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
      // Meta 앱 시크릿 · 인스타그램 앱 시크릿이 다를 수 있음 (제품마다 서명 키가 달라서 한쪽 이벤트만 401로 버려지던 문제) → 쉼표로 여러 개
      const secrets = [env.INSTAGRAM_APP_SECRET, env.INSTAGRAM_WEBHOOK_SECRETS].flatMap((v) => (v ?? '').split(',')).map((v) => v.trim()).filter(Boolean);
      if (!secrets.length) throw new ApiError(503, 'instagram_not_configured', '서버에 INSTAGRAM_APP_SECRET이 없습니다.');
      const raw = (req as unknown as { rawBody: Buffer }).rawBody, sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!secrets.some((sec) => verifyMetaSignature(raw, sig, sec))) {
        req.log.warn({ hasSig: !!sig }, 'instagram webhook signature mismatch');
        throw new ApiError(401, 'invalid_signature', '웹훅 서명이 맞지 않습니다.');
      }
      const comments = parseCommentWebhook(req.body);
      req.log.info({ comments: comments.length }, 'instagram webhook received');
      for (const c of comments) {
        void (async () => {
          const tenantId = await deps.db.tenantForInstagram(c.igUserId);
          if (!tenantId) { req.log.warn({ igUserId: c.igUserId, comment: c.commentId }, 'instagram webhook: no store connected to this account'); return; }
          await loadConfig(deps.db, tenantId);
          await deps.instagram.handleComment(tenantId, c);
        })().catch((err) => req.log.error({ err, comment: c.commentId }, 'instagram comment failed'));
      }
      return { ok: true as const };
    });

    // ---- 통합 로그인 (사장님이 "인스타 연결" 버튼 → Meta 로그인 → 콜백) ----
    app.get('/instagram/oauth/start', { schema: { tags: ['instagram'], description: 'Meta 로그인 화면으로 이동 (302). 프론트는 이 주소로 이동만 하면 됨' } }, async (req, reply) => {
      const c = oauthConf();
      const state = randomBytes(18).toString('base64url');
      for (const [k, v] of states) if (Date.now() - v.at > 10 * 60_000) states.delete(k);
      states.set(state, { tenantId: tenantOf(req), at: Date.now() });
      return reply.redirect(unifiedLoginUrl({ appId: c.appId, configId: c.configId, redirectUri: c.redirectUri, state }));
    });

    app.get('/instagram/oauth/callback', {
      schema: { tags: ['instagram'], querystring: z.looseObject({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }), description: 'Meta가 로그인 후 보내는 곳 (리디렉션 URL로 등록). code → 토큰 → 인스타 계정 연결 · 웹훅 구독 → 결과 화면' },
    }, async (req, reply) => {
      const html = (code: number, title: string, msg: string) => reply.code(code).type('text/html; charset=utf-8').send(page(title, msg));
      if (req.query.error) return html(400, '연결을 취소했어요', req.query.error_description ?? '인스타그램 연결이 완료되지 않았어요. 다시 시도해 주세요.');
      const st = req.query.state ? states.get(req.query.state) : undefined;
      if (req.query.state) states.delete(req.query.state);
      if (!st || Date.now() - st.at > 10 * 60_000 || !req.query.code) return html(400, '연결을 확인하지 못했어요', '요청이 만료됐거나 올바르지 않아요. 콘솔에서 다시 연결해 주세요.');
      try {
        const c = oauthConf();
        const token = await exchangeUnifiedCode(deps.fetchFn ?? fetch, { appId: c.appId, appSecret: c.appSecret, redirectUri: c.redirectUri, code: req.query.code });
        const s = await deps.instagram.connectUnified(st.tenantId, token);
        return html(200, '인스타그램을 연결했어요', `@${s.username ?? s.ig_user_id} 계정의 댓글을 이제 AI가 처리해요.`);
      } catch (err) {
        req.log.error({ err }, 'instagram oauth callback failed');
        return html(400, '연결하지 못했어요', err instanceof Error ? err.message : '알 수 없는 오류');
      }
    });

    // ---- 매장 연결 (사장님 화면) ----
    app.get('/instagram/connection', { schema: { tags: ['instagram'], response: { 200: Status }, description: '연결된 인스타 계정' } }, async (req) => deps.instagram.status(tenantOf(req)));
    app.post('/instagram/sync', { schema: { tags: ['instagram'], response: { 200: z.object({ fetched: z.number(), imported: z.number(), skipped: z.number() }) }, description: '연결된 인스타 게시물 댓글 동기화' } }, async (req) => deps.instagram.syncComments(tenantOf(req)));
    app.put('/instagram/connection', {
      schema: { tags: ['instagram'], body: z.object({ access_token: z.string().min(20).max(1000) }), response: { 200: Status }, description: '액세스 토큰으로 계정을 확인하고 연결 (토큰은 암호화 저장). 틀리면 400, 다른 매장 계정이면 409' },
    }, async (req) => deps.instagram.connect(tenantOf(req), req.body.access_token));
    app.delete('/instagram/connection', { schema: { tags: ['instagram'], response: { 200: Status }, description: '연결 해제 (토큰 삭제)' } }, async (req) => deps.instagram.disconnect(tenantOf(req)));
  };
}

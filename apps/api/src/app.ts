import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerErrorHandler } from './errors.js';
import { mockRoutes } from './routes/mock.js';
import { createAuth, type AuthInfo } from './auth.js';
import { accountRoutes } from './routes/account.js';
import { TENANT_ID } from './mocks/data.js';
import { loadConfig } from './tenantConfig.js';
import { settingsRoutes } from './routes/settings.js';
import { callRoutes } from './routes/calls.js';
import { inquiryRoutes } from './routes/inquiries.js';
import { createDb } from './db/client.js';
import { createLlm, type Llm } from './integrations/llm.js';
import { createTts, type Tts } from './integrations/tts.js';
import { createChannelTalkSender, type ChatSender } from './integrations/channeltalk.js';
import { createChatService } from './chat/service.js';
import { channelTalkRoutes } from './routes/channeltalk.js';
import { createVapiClient, type VapiClient } from './integrations/vapi.js';
import { vapiRoutes } from './routes/vapi.js';
import { createAlertCenter, type AlertCenter } from './alerts.js';
import { alertRoutes } from './routes/alerts.js';
import { createContextStore } from './context/docs.js';
import { contextRoutes } from './routes/context.js';
import { createFcm, webPushConfig, type PushSender } from './integrations/fcm.js';
import { createBivia, type Bivia } from './integrations/bivia.js';
import { createEmbedder, createRag, type Embedder } from './knowledge/rag.js';
import { createTracker, type Tracker } from './integrations/tracker.js';
import { documentRoutes } from './routes/documents.js';
import { createSecretBox, type SecretBox } from './secrets.js';
import { createInstagramClient, FB_GRAPH, type InstagramClient } from './integrations/instagram.js';
import { createInstagramService } from './sns/instagram.js';
import { instagramRoutes } from './routes/instagram.js';
import { createCommerceService } from './commerce/service.js';
import { commerceRoutes } from './routes/commerce.js';

export async function buildApp(opts: { logger?: boolean; db?: ReturnType<typeof createDb>; llm?: Llm; tts?: Tts; sender?: ChatSender; vapi?: VapiClient; alerts?: AlertCenter; push?: PushSender; bivia?: Bivia; embedder?: Embedder; tracker?: Tracker; secrets?: SecretBox; fetchFn?: typeof fetch; syncIntervalMs?: number; instagram?: InstagramClient; instagramFb?: InstagramClient } = {}) {
  const app = Fastify({ logger: opts.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((o) => o.trim()).filter(Boolean), credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(swagger, {
    openapi: { info: { title: '감정 방패 API', version: '0.1.0' }, servers: [{ url: '/' }] },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
  // 해커톤 MVP 통화 데모 페이지 (마이크 · 음성 합성은 브라우저 기능). 매번 읽어서 수정이 바로 반영됨
  app.get('/demo', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(new URL('../public/call.html', import.meta.url))));
  // 프론트 완성 전 기능 테스트용 콘솔 (통화 · 채팅 데모 + 매장 설정 · 규칙 · FAQ · 문구 편집 · 시뮬레이터 · 음성 연동 · 감사 로그)
  app.get('/console', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(new URL('../public/console.html', import.meta.url))));

  // 브라우저 푸시(FCM) 서비스 워커. 범위가 사이트 전체여야 해서 루트 경로에서 제공. 설정은 서버 환경변수에서 주입
  app.get('/firebase-messaging-sw.js', { schema: { hide: true } }, async (_req, reply) => {
    const cfg = webPushConfig();
    const body = cfg
      ? `importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp(${JSON.stringify(cfg.firebase)});
firebase.messaging(); // notification 페이로드는 SDK가 알아서 표시, 클릭하면 fcm_options.link로 이동`
      : '// 서버에 Firebase 웹 설정이 없음 (FIREBASE_* 환경변수)';
    return reply.type('application/javascript').header('service-worker-allowed', '/').header('cache-control', 'no-cache').send(body);
  });

  // DB · LLM은 테스트에서 바꿔 끼울 수 있게 주입. 없으면 환경변수로 생성 (DB 연결은 첫 쿼리 때 맺어짐)
  const db = opts.db ?? createDb();
  app.addHook('onClose', async () => { if (!opts.db) await db.close(); });

  // 로그인: /v1 요청마다 쿠키 · Bearer → 매장. 매장 설정은 처음 한 번 DB에서 읽어 둠 (AI 파이프라인이 동기로 읽음)
  const auth = createAuth({ db });
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    const a = await auth.resolve(req).catch(() => null);
    (req as unknown as { auth: AuthInfo | null }).auth = a;
    const tenantId = a?.tenantId ?? (process.env.DEV_ANON_TENANT === '1' ? TENANT_ID : null);
    if (tenantId) await loadConfig(db, tenantId).catch((err) => req.log.error({ err }, 'load tenant config failed'));
  });
  const secrets = opts.secrets ?? createSecretBox();
  const sender = opts.sender ?? createChannelTalkSender({ db, secrets, env: process.env, fetchFn: opts.fetchFn, log: (m) => app.log.info(m) });
  const context = createContextStore(db);
  await app.register(accountRoutes({ db, auth, context, secrets }), { prefix: '/v1' });
  await app.register(mockRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes({ db }), { prefix: '/v1' });
  const llm = opts.llm ?? createLlm();
  const bivia = opts.bivia ?? createBivia();
  const rag = createRag({ db, embedder: opts.embedder ?? createEmbedder() });
  const tracker = opts.tracker ?? createTracker();
  const commerce = createCommerceService({ db, secrets, fetchFn: opts.fetchFn, log: app.log });
  const syncMs = opts.syncIntervalMs ?? (opts.db ? 0 : Number(process.env.COMMERCE_SYNC_INTERVAL_SEC ?? '300') * 1000);
  const syncLoop = commerce.startSyncLoop(syncMs);
  app.addHook('onClose', async () => { syncLoop.stop(); });
  const push = opts.push ?? createFcm(process.env, fetch, (m) => app.log.info(m));
  const alerts = opts.alerts ?? createAlertCenter({ db, push, log: app.log, publicUrl: process.env.PUBLIC_BASE_URL || undefined });
  await app.register(alertRoutes({ db, alerts }), { prefix: '/v1' });
  await app.register(contextRoutes({ context }), { prefix: '/v1' });
  await app.register(documentRoutes({ db }), { prefix: '/v1' });
  await app.register(commerceRoutes({ commerce }), { prefix: '/v1' });
  const instagram = createInstagramService({ db, llm, ig: opts.instagram ?? createInstagramClient(opts.fetchFn), igFb: opts.instagramFb ?? createInstagramClient(opts.fetchFn, FB_GRAPH), secrets, bivia, rag, alerts, log: app.log });
  const igSyncMs = opts.db ? 0 : Number(process.env.INSTAGRAM_SYNC_INTERVAL_SEC ?? '180') * 1000;
  const igSyncLoop = instagram.startSyncLoop(igSyncMs);
  app.addHook('onClose', async () => { igSyncLoop.stop(); });
  await app.register(instagramRoutes({ db, instagram, fetchFn: opts.fetchFn }), { prefix: '/v1' });
  await app.register(inquiryRoutes({ db, sender, instagram }), { prefix: '/v1' });
  await app.register(callRoutes({ db, llm, alerts, bivia, rag, tracker, commerce, tts: opts.tts ?? createTts() }), { prefix: '/v1' });
  const chat = createChatService({ db, llm, sender, log: app.log, alerts, bivia, rag, tracker, commerce });
  await app.register(channelTalkRoutes({ db, chat, secrets, fetchFn: opts.fetchFn }), { prefix: '/v1' });
  await app.register(vapiRoutes({ db, llm, alerts, bivia, rag, tracker, commerce, vapi: opts.vapi ?? createVapiClient() }), { prefix: '/v1' });
  return app;
}

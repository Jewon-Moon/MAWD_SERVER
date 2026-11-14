import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerErrorHandler } from './errors.js';
import { mockRoutes } from './routes/mock.js';
import { settingsRoutes } from './routes/settings.js';
import { callRoutes } from './routes/calls.js';
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

export async function buildApp(opts: { logger?: boolean; db?: ReturnType<typeof createDb>; llm?: Llm; tts?: Tts; sender?: ChatSender; vapi?: VapiClient; alerts?: AlertCenter; push?: PushSender; bivia?: Bivia } = {}) {
  const app = Fastify({ logger: opts.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
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

  await app.register(mockRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes, { prefix: '/v1' });
  // DB · LLM은 테스트에서 바꿔 끼울 수 있게 주입. 없으면 환경변수로 생성 (DB 연결은 첫 쿼리 때 맺어짐)
  const db = opts.db ?? createDb();
  app.addHook('onClose', async () => { if (!opts.db) await db.close(); });
  const llm = opts.llm ?? createLlm();
  const bivia = opts.bivia ?? createBivia();
  const push = opts.push ?? createFcm(process.env, fetch, (m) => app.log.info(m));
  const alerts = opts.alerts ?? createAlertCenter({ db, push, log: app.log, publicUrl: process.env.PUBLIC_BASE_URL || undefined });
  await app.register(alertRoutes({ db, alerts }), { prefix: '/v1' });
  const context = createContextStore(db);
  await app.register(contextRoutes({ context }), { prefix: '/v1' });
  await app.register(callRoutes({ db, llm, alerts, bivia, tts: opts.tts ?? createTts() }), { prefix: '/v1' });
  const chat = createChatService({ db, llm, sender: opts.sender ?? createChannelTalkSender(process.env, (m) => app.log.info(m)), log: app.log, alerts, bivia });
  await app.register(channelTalkRoutes({ db, chat }), { prefix: '/v1' });
  await app.register(vapiRoutes({ db, llm, alerts, bivia, vapi: opts.vapi ?? createVapiClient() }), { prefix: '/v1' });
  return app;
}

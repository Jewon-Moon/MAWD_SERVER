// 회원가입 · 로그인 · 내 정보 + 초기 세팅(업종 템플릿). 데모 계정은 시드로 만든 일반 계정 (demo@mawd.app 등)
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import { authOf, tenantOf, type Auth } from '../auth.js';
import type { ContextStore } from '../context/docs.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { ApiError } from '../errors.js';
import { TEMPLATES, templateById } from '../onboarding/templates.js';
import type { SecretBox } from '../secrets.js';
import { configOf, getTenantConfig, loadConfig, saveConfig, setStoreName } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
const ok = z.object({ ok: z.literal(true) });

export function accountRoutes(deps: { db: Db; auth: Auth; context: ContextStore; secrets?: SecretBox; env?: NodeJS.ProcessEnv }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;

  async function meOf(userId: string, email: string, tenantId: string): Promise<z.infer<typeof C.Me>> {
    await loadConfig(deps.db, tenantId);
    const setup = configOf(tenantId).setup;
    const [ctSecret] = await deps.db.withTenant(
      tenantId,
      (tx) => tx.select({ kind: s.secrets.kind }).from(s.secrets).where(and(eq(s.secrets.tenantId, tenantId), eq(s.secrets.kind, 'channeltalk'))),
      { readOnly: true },
    );
    const channeltalk = Boolean(ctSecret || env.CHANNELTALK_ACCESS_KEY?.trim());
    return {
      user: { id: userId, email }, tenant: { id: tenantId, name: getTenantConfig(tenantId).storeName },
      integrations: { channeltalk, stibee: !!env.STIBEE_API_KEY?.trim() },
      onboarding: { channeltalk, documents: setup.done, test_message: false },
      setup,
    };
  }

  return async (app) => {
    app.post('/auth/signup', {
      schema: { tags: ['auth'], body: C.SignupBody, response: { 200: C.AuthResult }, description: '회원가입 → 새 매장 생성 · 로그인. 같은 이메일이면 409. 이후 setup.done=false라 초기 세팅 화면으로' },
    }, async (req, reply) => {
      const { userId, tenantId } = await deps.auth.signup(req.body.email, req.body.password, req.body.store_name);
      setStoreName(tenantId, req.body.store_name.trim());
      await saveConfig(deps.db, tenantId); // 기본 설정을 DB에 (초기 세팅 전)
      const token = await deps.auth.startSession(reply, req, userId);
      return { ...(await meOf(userId, req.body.email.trim().toLowerCase(), tenantId)), token };
    });

    app.post('/auth/login', {
      schema: { tags: ['auth'], body: C.LoginBody, response: { 200: C.AuthResult }, description: '로그인 (쿠키 + token). 틀리면 401' },
    }, async (req, reply) => {
      const userId = await deps.auth.login(req.body.email, req.body.password);
      const tenantId = await deps.db.tenantForUser(userId);
      if (!tenantId) throw new ApiError(403, 'no_store', '연결된 매장이 없어요.');
      const token = await deps.auth.startSession(reply, req, userId);
      return { ...(await meOf(userId, req.body.email.trim().toLowerCase(), tenantId)), token };
    });

    app.post('/auth/logout', { schema: { tags: ['auth'], response: { 200: ok } } }, async (req, reply) => {
      await deps.auth.logout(req, reply);
      return { ok: true as const };
    });

    app.get('/me', { schema: { tags: ['auth'], response: { 200: C.Me }, description: '로그인 정보 · 매장 · 초기 세팅 여부. 로그인 안 했으면 401' } }, async (req) => {
      const a = authOf(req);
      if (!a) throw new ApiError(401, 'unauthenticated', '로그인이 필요합니다.');
      return meOf(a.userId, a.email, a.tenantId);
    });

    // ---- 초기 세팅 ----
    app.get('/onboarding/templates', { schema: { tags: ['onboarding'], response: { 200: z.array(C.OnboardingTemplate) }, description: '업종 템플릿 목록' } },
      async () => TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, industry: t.business.industry })));

    app.get('/onboarding/status', { schema: { tags: ['onboarding'], response: { 200: z.object({ done: z.boolean(), template: z.string().nullable() }) } } }, async (req) => {
      const t = tenantOf(req);
      await loadConfig(deps.db, t);
      return configOf(t).setup;
    });

    app.post('/onboarding/apply', {
      schema: { tags: ['onboarding'], body: C.OnboardingApply, response: { 200: C.Me }, description: '업종 템플릿 적용: 매장 문서(소개 · 상품 · 정책) · FAQ · 문의 카테고리 초안을 채우고 초기 세팅 완료. 다시 호출하면 덮어씀' },
    }, async (req) => {
      const tenantId = tenantOf(req);
      const tpl = templateById(req.body.template) ?? (() => { throw new ApiError(404, 'template_not_found', '없는 템플릿이에요.'); })();
      await loadConfig(deps.db, tenantId);
      if (req.body.store_name) {
        const name = req.body.store_name.trim();
        await deps.db.withTenant(tenantId, (tx) => tx.update(s.tenants).set({ name }).where(eq(s.tenants.id, tenantId)));
        setStoreName(tenantId, name);
      }
      await deps.context.put(tenantId, 'business', { mode: 'template', fields: tpl.business });
      await deps.context.put(tenantId, 'offerings', { mode: 'template', fields: tpl.offerings });
      await deps.context.put(tenantId, 'policies', { mode: 'template', fields: tpl.policies });
      const c = configOf(tenantId);
      c.faqs = tpl.faqs.map((f) => ({ ...f, id: randomUUID() }));
      c.categories = tpl.categories.map((x) => ({ ...x, id: randomUUID() }));
      c.settings = { ...c.settings, 'data-access': { ...c.settings['data-access'], enabled: tpl.orderLookup } };
      c.setup = { done: true, template: tpl.id };
      await saveConfig(deps.db, tenantId);
      const a = authOf(req as FastifyRequest);
      return meOf(a?.userId ?? randomUUID(), a?.email ?? 'dev@localhost', tenantId);
    });
  };
}

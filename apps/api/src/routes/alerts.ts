// 사장님 화면 알림 피드 + 푸시(FCM) 기기 등록. 프론트는 GET /alerts?after= 를 몇 초마다 폴링하고 각 알림의 display · sound대로 띄웁니다.
// 화면을 안 보고 있을 때는 FCM 푸시 (매장 설정 notifications.push)
import { tenantOf } from '../auth.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { AlertCenter } from '../alerts.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { notFound } from '../errors.js';
import { webPushConfig } from '../integrations/fcm.js';
import { getTenantConfig } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
const HEAT_FOR = { urgent: 90, high: 55, normal: 10 } as const;
const PushToken = z.object({ id: z.string().uuid(), platform: z.enum(['web', 'android', 'ios']), label: z.string().nullable(), token_tail: z.string(), last_seen_at: z.string().datetime() });

export function alertRoutes(deps: { db: Db; alerts: AlertCenter; env?: NodeJS.ProcessEnv }): FastifyPluginAsyncZod {
  const env = deps.env ?? process.env;
  return async (app) => {
    app.get('/alerts', {
      schema: { tags: ['alerts'], querystring: C.AlertListQuery, response: { 200: z.object({ items: z.array(C.Alert) }) }, description: '최신순. 폴링할 때 마지막으로 받은 created_at을 after로' },
    }, async (req) => ({ items: await deps.alerts.list(tenantOf(req), req.query.after, req.query.limit) }));

    app.post('/alerts/:id/ack', {
      schema: { tags: ['alerts'], params: z.object({ id: z.string().uuid() }), response: { 200: C.Alert }, description: '확인 처리 (모달 · 배너 닫기)' },
    }, async (req) => (await deps.alerts.ack(tenantOf(req), req.params.id)) ?? notFound('alert_not_found'));

    // 통화 없이 알림 화면 · 푸시를 확인하는 데모 · 프론트 개발용. 매장 설정(우선순위 기준 · 표시 방식 · 조용한 시간 · 푸시)을 그대로 거침
    app.post('/alerts/test', {
      schema: { tags: ['alerts'], body: z.object({ priority: C.Priority }), response: { 200: C.Alert }, description: '데모: 우선순위별 시험 알림 생성 (최소 점수 기준은 무시)' },
    }, async (req) => {
      const cfg = getTenantConfig(tenantOf(req));
      const heat = HEAT_FOR[req.body.priority];
      const risk = req.body.priority === 'urgent' ? ['법적 조치 언급'] : [];
      const a = await deps.alerts.emit({ ...cfg, settings: { ...cfg.settings, notifications: { ...cfg.settings.notifications, min_heat_to_notify: 0 } } }, {
        tenantId: tenantOf(req), inquiryId: null, channel: 'call', kind: 'live', heat, riskFlags: risk, needsOwner: req.body.priority !== 'normal',
        title: `[시험] ${{ urgent: '긴급', high: '높음', normal: '보통' }[req.body.priority]} 알림`, message: `감정 ${heat}점${risk.length ? ' · ' + risk.join(' · ') : ''} · 시험 알림입니다`,
      });
      return a!;
    });

    // ---- 푸시 기기 ----
    app.get('/push/config', {
      schema: { tags: ['alerts'], response: { 200: z.object({ web: z.object({ firebase: z.record(z.string(), z.string()), vapidKey: z.string() }).nullable() }) }, description: '브라우저 푸시 등록에 필요한 Firebase 공개 설정. null이면 서버에 설정이 없음' },
    }, async () => ({ web: webPushConfig(env) }));

    app.get('/push/tokens', { schema: { tags: ['alerts'], response: { 200: z.array(PushToken) }, description: '이 매장에 등록된 푸시 기기 (토큰은 끝 6자리만)' } }, async (req) => {
      const rows = await deps.db.withTenant(tenantOf(req), (tx) => tx.select().from(s.pushTokens).where(eq(s.pushTokens.tenantId, tenantOf(req))), { readOnly: true });
      return rows.map((r) => ({ id: r.id, platform: r.platform, label: r.label, token_tail: r.token.slice(-6), last_seen_at: r.lastSeenAt.toISOString() }));
    });

    app.post('/push/tokens', {
      schema: { tags: ['alerts'], body: z.object({ token: z.string().min(20).max(4096), platform: z.enum(['web', 'android', 'ios']), label: z.string().max(100).optional() }), response: { 200: z.object({ id: z.string().uuid() }) }, description: 'FCM 등록 토큰 저장 (앱 · 브라우저가 토큰을 받거나 갱신할 때마다 호출, 같은 토큰은 갱신)' },
    }, async (req) => {
      const t = tenantOf(req);
      const [row] = await deps.db.withTenant(t, (tx) => tx.insert(s.pushTokens).values({ tenantId: t, token: req.body.token, platform: req.body.platform, label: req.body.label ?? null })
        .onConflictDoUpdate({ target: [s.pushTokens.tenantId, s.pushTokens.token], set: { lastSeenAt: sql`now()`, label: req.body.label ?? null } })
        .returning({ id: s.pushTokens.id }));
      return { id: row!.id };
    });

    app.delete('/push/tokens/:id', { schema: { tags: ['alerts'], params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.literal(true) }) }, description: '기기 등록 해제' } }, async (req) => {
      const rows = await deps.db.withTenant(tenantOf(req), (tx) => tx.delete(s.pushTokens).where(and(eq(s.pushTokens.id, req.params.id), eq(s.pushTokens.tenantId, tenantOf(req)))).returning({ id: s.pushTokens.id }));
      if (!rows.length) notFound('push_token_not_found');
      return { ok: true as const };
    });
  };
}

// 사장님 화면 알림: 감정 점수 → 우선순위(긴급 · 높음 · 보통) → 매장이 정한 표시 방식(모달 · 배너 · 토스트 · 배지).
// 기준과 방식은 모두 매장 설정 notifications.priority / alert_styles 에서 조정. 알림 본문에는 고객 원문(욕설)을 싣지 않음
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Alert, Priority as PriorityEnum } from '@mawd/contracts';
import type { createDb } from './db/client.js';
import * as s from './db/schema.js';
import type { PushSender } from './integrations/fcm.js';
import type { TenantConfig } from './tenantConfig.js';

export type Priority = z.infer<typeof PriorityEnum>;
type AlertOut = z.infer<typeof Alert>;
type Db = ReturnType<typeof createDb>;
const RANK: Record<Priority, number> = { normal: 0, high: 1, urgent: 2 };
export const higher = (a: Priority, b: Priority | null | undefined) => !b || RANK[a] > RANK[b];

/** 감정 점수 · 위험 표시 · 사장님 판단 필요 → 우선순위 */
export function priorityOf(cfg: TenantConfig, heat: number, riskFlags: string[], needsOwner: boolean): Priority {
  const p = cfg.settings.notifications.priority;
  if (heat >= p.urgent_heat_gte || (p.risk_flag_is_urgent && riskFlags.length > 0)) return 'urgent';
  if (heat >= p.high_heat_gte || (p.handoff_is_high && needsOwner)) return 'high';
  return 'normal';
}

/** 조용한 시간(매장 시간대 기준)인지. 22:00~08:00처럼 자정을 넘는 구간도 처리 */
export function inQuietHours(cfg: TenantConfig, now: Date): boolean {
  const q = cfg.settings.notifications.quiet_hours;
  if (!q.enabled) return false;
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.settings.hours.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(/^24/, '00');
  return q.start <= q.end ? q.start <= hhmm && hhmm < q.end : hhmm >= q.start || hhmm < q.end;
}

/** 우선순위별 표시 방식. 조용한 시간에는 소리를 모두 끄고, 긴급이 아니면 배지로만 */
export function styleFor(cfg: TenantConfig, priority: Priority, now: Date) {
  const s = cfg.settings.notifications.alert_styles[priority];
  if (!inQuietHours(cfg, now)) return s;
  return { display: priority === 'urgent' || s.display === 'none' ? s.display : 'badge' as const, sound: false };
}

export type AlertInput = {
  tenantId: string; inquiryId: string | null; channel: 'call' | 'chat' | 'sns'; kind: 'live' | 'card';
  heat: number; riskFlags: string[]; needsOwner: boolean; title: string; message: string;
};
export type AlertCenter = ReturnType<typeof createAlertCenter>;
type Log = { error: (o: object, m: string) => void };

const toOut = (r: typeof s.alerts.$inferSelect): AlertOut => ({
  id: r.id, inquiry_id: r.inquiryId, channel: r.channel, kind: r.kind, priority: r.priority, heat: r.heat,
  title: r.title, message: r.message, display: r.display, sound: r.sound, acked: !!r.ackedAt, created_at: r.createdAt.toISOString(),
});

/** 푸시 대상인지: 매장이 켠 우선순위만, 조용한 시간에는 긴급만 */
export function shouldPush(cfg: TenantConfig, priority: Priority, now: Date) {
  const p = cfg.settings.notifications.push;
  return p.enabled && p.priorities.includes(priority) && (priority === 'urgent' || !inQuietHours(cfg, now));
}

export function createAlertCenter(deps: { db: Db; push?: PushSender; log?: Log; publicUrl?: string; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const PRI = { urgent: '긴급', high: '높음', normal: '보통' } as const;

  async function push(cfg: TenantConfig, a: AlertOut, tenantId: string) {
    if (!deps.push || !shouldPush(cfg, a.priority, now())) return;
    const tokens = await deps.db.withTenant(tenantId, (tx) => tx.select({ id: s.pushTokens.id, token: s.pushTokens.token }).from(s.pushTokens).where(eq(s.pushTokens.tenantId, tenantId)));
    if (!tokens.length) return;
    const msg = {
      title: `[${PRI[a.priority]}] ${a.title}`, body: a.message, urgent: a.priority === 'urgent', highPriority: a.priority !== 'normal',
      tag: a.inquiry_id ?? a.id, link: deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, '')}/console` : null,
      data: { alert_id: a.id, inquiry_id: a.inquiry_id ?? '', priority: a.priority, kind: a.kind },
    };
    const results = await Promise.allSettled(tokens.map((t) => deps.push!.send(t.token, msg)));
    const invalid = tokens.filter((_, i) => results[i]!.status === 'fulfilled' && (results[i] as PromiseFulfilledResult<string>).value === 'invalid_token').map((t) => t.id);
    const sent = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length;
    results.forEach((r) => { if (r.status === 'rejected') deps.log?.error({ err: r.reason }, 'push failed'); });
    await deps.db.withTenant(tenantId, async (tx) => {
      if (invalid.length) await tx.delete(s.pushTokens).where(inArray(s.pushTokens.id, invalid));
      await tx.update(s.alerts).set({ pushed: sent }).where(eq(s.alerts.id, a.id));
    });
  }

  return {
    /** 알림 생성(DB) + 푸시(뒤에서). 매장 기준(최소 점수)에 안 맞으면 null */
    async emit(cfg: TenantConfig, a: AlertInput): Promise<AlertOut | null> {
      const n = cfg.settings.notifications;
      if (a.heat < n.min_heat_to_notify && !a.needsOwner && a.riskFlags.length === 0) return null;
      const priority = priorityOf(cfg, a.heat, a.riskFlags, a.needsOwner);
      const t = now();
      const [row] = await deps.db.withTenant(a.tenantId, (tx) => tx.insert(s.alerts).values({
        tenantId: a.tenantId, inquiryId: a.inquiryId, channel: a.channel, kind: a.kind, priority,
        heat: Math.max(0, Math.min(100, Math.round(a.heat))), title: a.title, message: a.message, ...styleFor(cfg, priority, t), createdAt: t,
      }).returning());
      const out = toOut(row!);
      void push(cfg, out, a.tenantId).catch((err) => deps.log?.error({ err }, 'push failed'));
      return out;
    },
    /** 최신순. after를 주면 그 시각 이후만 (폴링용) */
    async list(tenantId: string, after?: string, limit = 50) {
      const rows = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.alerts)
        .where(after ? and(eq(s.alerts.tenantId, tenantId), gt(s.alerts.createdAt, new Date(after))) : eq(s.alerts.tenantId, tenantId))
        .orderBy(desc(s.alerts.createdAt)).limit(limit), { readOnly: true });
      return rows.map(toOut);
    },
    async ack(tenantId: string, id: string) {
      const [row] = await deps.db.withTenant(tenantId, (tx) => tx.update(s.alerts).set({ ackedAt: now() }).where(eq(s.alerts.id, id)).returning());
      return row ? toOut(row) : null;
    },
  };
}

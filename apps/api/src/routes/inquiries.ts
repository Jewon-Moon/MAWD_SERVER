// 문의 목록 · 상세 · 사장님 처리 + 현황 요약. 채팅 · 통화 · 인스타 댓글이 쌓은 DB 그대로 (매장별)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import { tenantOf } from '../auth.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { notFound } from '../errors.js';
import { getTenantConfig } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
const idParam = z.object({ id: z.string().uuid() });

export function inquiryRoutes(deps: { db: Db }): FastifyPluginAsyncZod {
  const labelOf = (tenantId: string, heat: number | null) => {
    const l = getTenantConfig(tenantId).settings.response.heat_labels;
    return heat == null ? '보통' as const : heat >= l.very_high ? '매우 높음' as const : heat >= l.high ? '높음' as const : '보통' as const;
  };

  // 문의별 최신 분석 · 첫 고객 메시지 · 카드 제목
  async function enrich(tenantId: string, rows: (typeof s.inquiries.$inferSelect)[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    return deps.db.withTenant(tenantId, async (tx) => {
      const an = await tx.select().from(s.analyses).where(inArray(s.analyses.inquiryId, ids)).orderBy(s.analyses.createdAt);
      const msgs = await tx.select().from(s.messages).where(and(inArray(s.messages.inquiryId, ids), eq(s.messages.sender, 'customer'))).orderBy(s.messages.createdAt);
      const cards = await tx.select().from(s.cards).where(inArray(s.cards.inquiryId, ids)).orderBy(s.cards.createdAt);
      const last = <T extends { inquiryId: string }>(xs: T[]) => new Map(xs.map((x) => [x.inquiryId, x]));
      const a = last(an), c = last(cards);
      const text = new Map<string, string>();
      for (const m of msgs) text.set(m.inquiryId, [text.get(m.inquiryId), m.text].filter(Boolean).join(' '));
      return rows.map((r) => {
        const heat = a.get(r.id)?.heat ?? null;
        const card = c.get(r.id)?.summary as z.infer<typeof C.Card> | undefined;
        const preview = (text.get(r.id) ?? '').slice(0, 500);
        const raw = (a.get(r.id)?.raw ?? {}) as { category?: string };
        return {
          id: r.id, channel: r.channel, status: r.status, route: r.route ?? (a.get(r.id)?.needsOwner ? 'B' as const : 'A' as const),
          title: card?.title || preview.slice(0, 40) || '(내용 없음)', customer_name: r.customerName,
          category: raw.category || a.get(r.id)?.category || '기타', heat_label: labelOf(tenantId, heat), heat, preview,
          created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
          _card: card ?? null, _analysis: a.get(r.id) ?? null, _muted: r.aiMuted,
        };
      });
    }, { readOnly: true });
  }
  const listItem = ({ _card, _analysis, _muted, ...x }: Awaited<ReturnType<typeof enrich>>[number]) => x;

  async function detail(tenantId: string, id: string) {
    const [row] = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.inquiries).where(and(eq(s.inquiries.id, id), eq(s.inquiries.tenantId, tenantId))), { readOnly: true });
    if (!row) notFound('inquiry_not_found');
    const [x] = await enrich(tenantId, [row!]);
    const messages = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.messages).where(eq(s.messages.inquiryId, id)).orderBy(s.messages.createdAt), { readOnly: true });
    const { _card, _analysis, _muted, ...item } = x!;
    return {
      ...item, card: _card, ai_muted: _muted,
      analysis: _analysis ? { heat: _analysis.heat ?? 0, needs_owner: !!_analysis.needsOwner, confidence: _analysis.confidence ?? 1 } : null,
      messages: messages.map((m) => ({ id: m.id, sender: m.sender, text: m.text, created_at: m.createdAt.toISOString() })),
    };
  }

  return async (app) => {
    app.get('/dashboard/summary', { schema: { tags: ['inquiries'], response: { 200: C.DashboardSummary } } }, async (req) => {
      const t = tenantOf(req);
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const rows = await deps.db.withTenant(t, (tx) => tx.select({ status: s.inquiries.status, n: sql<number>`count(*)::int` }).from(s.inquiries)
        .where(and(eq(s.inquiries.tenantId, t), gte(s.inquiries.createdAt, since))).groupBy(s.inquiries.status), { readOnly: true });
      const [hot] = await deps.db.withTenant(t, (tx) => tx.select({ n: sql<number>`count(distinct ${s.analyses.inquiryId})::int` }).from(s.analyses)
        .where(and(eq(s.analyses.tenantId, t), gte(s.analyses.createdAt, since), gte(s.analyses.heat, getTenantConfig(t).settings.response.heat_threshold))), { readOnly: true });
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const total = rows.reduce((a, r) => a + r.n, 0);
      return { today_total: total, auto_handled_rate: total ? (by.auto_done ?? 0) / total : 0, shielded_heated_count: hot?.n ?? 0, pending_count: by.pending ?? 0 };
    });

    app.get('/inquiries', {
      schema: { tags: ['inquiries'], querystring: C.InquiryListQuery, response: { 200: C.Page(C.InquiryListItem) }, description: '최신순. cursor = 이전 페이지 마지막 created_at' },
    }, async (req) => {
      const t = tenantOf(req);
      const { status, channel, limit, cursor } = req.query;
      const rows = await deps.db.withTenant(t, (tx) => tx.select().from(s.inquiries).where(and(
        eq(s.inquiries.tenantId, t), status ? eq(s.inquiries.status, status) : undefined, channel ? eq(s.inquiries.channel, channel) : undefined,
        cursor ? lt(s.inquiries.createdAt, new Date(cursor)) : undefined,
      )).orderBy(desc(s.inquiries.createdAt)).limit(limit + 1), { readOnly: true });
      const page = rows.slice(0, limit);
      return { items: (await enrich(t, page)).map(listItem), next_cursor: rows.length > limit ? page.at(-1)!.createdAt.toISOString() : null };
    });

    app.get('/inquiries/:id', { schema: { tags: ['inquiries'], params: idParam, response: { 200: C.InquiryDetail } } },
      async (req) => detail(tenantOf(req), req.params.id));

    app.get('/inquiries/:id/messages', { schema: { tags: ['inquiries'], params: idParam, querystring: C.RawMessagesQuery, response: { 200: z.array(C.Message) } } },
      async (req) => (await detail(tenantOf(req), req.params.id)).messages);

    app.post('/inquiries/:id/actions', {
      schema: { tags: ['inquiries'], params: idParam, body: C.InquiryAction, response: { 200: C.InquiryDetail }, description: '사장님 처리: 추천 답변 승인 · 고쳐서 보내기 · 직접 응대(AI 끔) · 보류 · 종료' },
    }, async (req) => {
      const t = tenantOf(req), id = req.params.id, b = req.body;
      const d = await detail(t, id);
      const reply = b.type === 'edit_send' ? b.text : b.type === 'approve' ? d.card?.recommendations[b.recommendation_index]?.draft : undefined;
      const status = b.type === 'hold' ? 'pending' as const : b.type === 'manual' ? 'manual' as const : 'done' as const;
      await deps.db.withTenant(t, async (tx) => {
        // shortcut: 답변은 기록만 하고 채널로 보내지는 않음, 채널톡 · 인스타 답장 발송은 채널 sender를 붙일 때
        if (reply) await tx.insert(s.messages).values({ tenantId: t, inquiryId: id, sender: 'owner', text: reply });
        await tx.update(s.inquiries).set({ status, aiMuted: b.type === 'manual' ? true : d.ai_muted, updatedAt: new Date() }).where(eq(s.inquiries.id, id));
        await tx.insert(s.actions).values({ tenantId: t, inquiryId: id, actor: 'owner', type: b.type, payload: b });
      });
      return detail(t, id);
    });
  };
}

// 문의 목록 · 상세 · 사장님 처리 + 현황 요약. 채팅 · 통화 · 인스타 댓글이 쌓은 DB 그대로 (매장별)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import { tenantOf } from '../auth.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { notFound } from '../errors.js';
import type { ChatSender } from '../integrations/channeltalk.js';
import type { InstagramService } from '../sns/instagram.js';
import { getTenantConfig } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
const idParam = z.object({ id: z.string().uuid() });

export function inquiryRoutes(deps: { db: Db; sender?: ChatSender; instagram?: InstagramService }): FastifyPluginAsyncZod {
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
      const msgs = await tx.select().from(s.messages).where(inArray(s.messages.inquiryId, ids)).orderBy(s.messages.createdAt);
      const cards = await tx.select().from(s.cards).where(inArray(s.cards.inquiryId, ids)).orderBy(s.cards.createdAt);
      const last = <T extends { inquiryId: string }>(xs: T[]) => new Map(xs.map((x) => [x.inquiryId, x]));
      const a = last(an), c = last(cards);
      const text = new Map<string, string>();
      const lastReply = new Map<string, { text: string; at: string }>();
      for (const m of msgs) {
        if (m.sender === 'customer') {
          text.set(m.inquiryId, [text.get(m.inquiryId), m.text].filter(Boolean).join(' '));
        } else if (m.sender === 'ai' || m.sender === 'owner') {
          lastReply.set(m.inquiryId, { text: m.text, at: m.createdAt.toISOString() });
        }
      }
      return rows.map((r) => {
        const heat = a.get(r.id)?.heat ?? null;
        const card = c.get(r.id)?.summary as z.infer<typeof C.Card> | undefined;
        const previewRaw = (text.get(r.id) ?? '').slice(0, 500);
        const rep = lastReply.get(r.id);
        const raw = (a.get(r.id)?.raw ?? {}) as { category?: string; action?: 'hidden' | 'replied' | 'none'; abusive?: boolean };
        const maskedSns = r.channel === 'sns' && (raw.action === 'hidden' || raw.abusive === true);
        const preview = maskedSns
          ? '부적절한 표현이 포함되어 요약본에서 가려졌습니다. 상세 화면의 원문 보기에서 확인할 수 있습니다.'
          : previewRaw;
        return {
          id: r.id, channel: r.channel, status: r.status, route: r.route ?? (a.get(r.id)?.needsOwner ? 'B' as const : 'A' as const),
          title: maskedSns
            ? (raw.action === 'hidden' ? '숨김 처리된 악성 댓글' : '부적절한 표현 포함 댓글')
            : (card?.title || preview.slice(0, 40) || '(내용 없음)'),
          customer_name: r.customerName,
          category: raw.category || a.get(r.id)?.category || '기타', heat_label: labelOf(tenantId, heat), heat, preview,
          reply: rep?.text ?? null,
          reply_at: rep?.at ?? null,
          sns_action: raw.action ?? null,
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
      if (reply && d.channel === 'sns' && deps.instagram) {
        await deps.instagram.replyToInquiry(t, id, reply);
      }
      await deps.db.withTenant(t, async (tx) => {
        if (reply) await tx.insert(s.messages).values({ tenantId: t, inquiryId: id, sender: 'owner', text: reply });
        await tx.update(s.inquiries).set({ status, aiMuted: b.type === 'manual' ? true : d.ai_muted, updatedAt: new Date() }).where(eq(s.inquiries.id, id));
        await tx.insert(s.actions).values({ tenantId: t, inquiryId: id, actor: 'owner', type: b.type, payload: b });
      });
      if (reply && d.channel === 'chat' && deps.sender) {
        const [inqRow] = await deps.db.withTenant(t, (tx) => tx.select({ ext: s.inquiries.externalChatId }).from(s.inquiries).where(eq(s.inquiries.id, id)), { readOnly: true });
        if (inqRow?.ext) await deps.sender.send(inqRow.ext, reply, t).catch((err) => req.log.error({ err, inquiryId: id }, 'channeltalk owner reply send failed'));
      }
      return detail(t, id);
    });
  };
}

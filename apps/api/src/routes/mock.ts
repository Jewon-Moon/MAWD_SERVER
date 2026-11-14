// §14.2 전체 엔드포인트의 목 구현. 실제 구현은 기능별 라우트 파일로 하나씩 옮깁니다.
// shortcut: 인증 없이 모두 데모 매장으로 응답, Better Auth 붙일 때 preHandler로 교체
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { InquiryDetail } from '@mawd/contracts';
import * as M from '../mocks/data.js';
import { notFound } from '../errors.js';
import { auditLog } from '../mocks/audit.js';

const idParam = z.object({ id: z.string().uuid() });
const ok = z.object({ ok: z.literal(true) });
const now = () => new Date().toISOString();

export const mockRoutes: FastifyPluginAsyncZod = async (app) => {
  // 회원가입 · 로그인 · /me 는 routes/account.ts (실제 구현)

  // integrations / settings
  app.put('/integrations/channeltalk', { schema: { tags: ['settings'], body: C.ChannelTalkKeys, response: { 200: C.IntegrationResult } } },
    async () => ({ ok: true, webhook_url: 'http://localhost:8000/v1/webhooks/channeltalk/demo-token' }));
  app.put('/integrations/stibee', { schema: { tags: ['settings'], body: C.StibeeKeys, response: { 200: C.IntegrationResult } } },
    async () => ({ ok: true }));
  // 세부 설정은 routes/settings.ts

  // dashboard / inquiries
  app.get('/dashboard/summary', { schema: { tags: ['inquiries'], response: { 200: C.DashboardSummary } } },
    async () => ({ today_total: 27, auto_handled_rate: 0.63, shielded_heated_count: 5, pending_count: 2 }));
  app.get('/inquiries', { schema: { tags: ['inquiries'], querystring: C.InquiryListQuery, response: { 200: C.Page(C.InquiryListItem) } } },
    async (req) => {
      const { status, channel, limit } = req.query;
      const items = M.inquiries.filter((i) => (!status || i.status === status) && (!channel || i.channel === channel));
      return { items: items.slice(0, limit), next_cursor: null };
    });
  app.get('/inquiries/:id', { schema: { tags: ['inquiries'], params: idParam, response: { 200: C.InquiryDetail } } },
    async (req) => M.inquiryDetail(req.params.id) ?? notFound('inquiry_not_found'));
  app.get('/inquiries/:id/messages', { schema: { tags: ['inquiries'], params: idParam, querystring: C.RawMessagesQuery, response: { 200: z.array(C.Message) } } },
    async (req) => {
      const d = M.inquiryDetail(req.params.id) ?? notFound('inquiry_not_found');
      return req.query.raw ? d.messages.map((m) => ({ ...m, text: m.text.replace('●●●', '(원문 욕설)') })) : d.messages;
    });
  app.post('/inquiries/:id/actions', { schema: { tags: ['inquiries'], params: idParam, body: C.InquiryAction, response: { 200: C.InquiryDetail } } },
    async (req) => {
      const d = M.inquiryDetail(req.params.id) ?? notFound('inquiry_not_found');
      const status: InquiryDetail['status'] = req.body.type === 'hold' ? 'pending' : req.body.type === 'manual' ? 'manual' : 'done';
      return { ...d, status, ai_muted: req.body.type === 'manual' || d.ai_muted };
    });

  // documents / orders 는 routes/documents.ts · routes/commerce.ts (실제 구현)

  // issues
  const issue = { id: 'cccccccc-0000-4000-8000-000000000001', title: '11/12 배송 지연', category: '배송' as const, status: 'suggested' as const, inquiry_count: 4, created_at: now() };
  const draft = { subject: '[데모 상점] 배송 지연 안내', body_html: '<p>안녕하세요. 택배사 물량 증가로 배송이 1~2일 지연되고 있습니다.</p>', recipient_count: 4 };
  app.get('/issues', { schema: { tags: ['issues'], response: { 200: z.array(C.Issue) } } }, async () => [issue]);
  app.post('/issues/:id/draft', { schema: { tags: ['issues'], params: idParam, response: { 200: C.MailDraft } } }, async () => draft);
  app.put('/issues/:id/draft', { schema: { tags: ['issues'], params: idParam, body: C.MailDraft, response: { 200: C.MailDraft } } }, async (req) => req.body);
  app.post('/issues/:id/send', { schema: { tags: ['issues'], params: idParam, response: { 200: C.Issue } } }, async () => ({ ...issue, status: 'mailed' as const }));

  // calls (F9)
  // 실시간 통화(/calls, /calls/:id/turns, /calls/:id/end, GET /calls/:id)는 routes/calls.ts
  app.post('/calls/upload', { schema: { tags: ['calls'], response: { 200: z.object({ inquiry_id: z.string().uuid() }) } } },
    async () => ({ inquiry_id: 'aaaaaaaa-0000-4000-8000-000000000002' }));

  // audit
  app.get('/audit', { schema: { tags: ['audit'], querystring: C.AuditQuery, response: { 200: C.Page(C.AuditEntry) } } },
    async (req) => {
      const { inquiry_id, type, limit } = req.query;
      const items = auditLog.filter((a) => (!inquiry_id || a.inquiry_id === inquiry_id) && (!type || a.type === type))
        .slice(0, limit).map(({ inquiry_id: _, ...a }) => a);
      return { items, next_cursor: null };
    });

};

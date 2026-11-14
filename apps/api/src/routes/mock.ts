// §14.2 전체 엔드포인트의 목 구현. 실제 구현은 기능별 라우트 파일로 하나씩 옮깁니다.
// shortcut: 인증 없이 모두 데모 매장으로 응답, Better Auth 붙일 때 preHandler로 교체
import { randomUUID } from 'node:crypto';
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
  // auth
  app.post('/auth/signup', { schema: { tags: ['auth'], body: C.SignupBody, response: { 200: C.Me } } }, async () => M.me);
  app.post('/auth/login', { schema: { tags: ['auth'], body: C.LoginBody, response: { 200: C.Me } } }, async () => M.me);
  app.post('/auth/logout', { schema: { tags: ['auth'], response: { 200: ok } } }, async () => ({ ok: true as const }));
  app.get('/me', { schema: { tags: ['auth'], response: { 200: C.Me } } }, async () => M.me);

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

  // documents / orders
  const doc = { id: randomUUID(), title: '환불정책.pdf', source_type: 'pdf' as const, chunk_count: 12, enabled: true, created_at: now() };
  app.get('/documents', { schema: { tags: ['knowledge'], response: { 200: z.array(C.Document) } } }, async () => [doc]);
  // shortcut: 목은 multipart를 파싱하지 않음, 실제 구현 때 @fastify/multipart 추가
  app.post('/documents', { schema: { tags: ['knowledge'], response: { 200: C.Document } } }, async () => ({ ...doc, id: randomUUID(), created_at: now() }));
  app.patch('/documents/:id', { schema: { tags: ['knowledge'], params: idParam, body: C.DocumentPatch, response: { 200: C.Document } } },
    async (req) => ({ ...doc, id: req.params.id, ...req.body }));
  app.delete('/documents/:id', { schema: { tags: ['knowledge'], params: idParam, response: { 200: ok } } }, async () => ({ ok: true as const }));
  app.post('/orders/import', { schema: { tags: ['knowledge'], response: { 200: C.OrderImportResult } } },
    async () => ({ imported: 120, skipped: 2, errors: ['12행: 주문번호 없음', '57행: 금액 형식 오류'] }));
  app.get('/orders', { schema: { tags: ['knowledge'], querystring: C.PageQuery, response: { 200: C.Page(C.Order) } } },
    async () => ({
      items: [{ id: randomUUID(), order_no: '1234', customer_name: '김고객', phone_masked: '010-****-1234', items: '머그컵 외 1건', amount: 32000, status: '배송중', eta: '2026-11-13' }],
      next_cursor: null,
    }));

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

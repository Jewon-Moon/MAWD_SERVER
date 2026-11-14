import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { z } from 'zod';
import { createMockCommerceStore, DEMO_CREDS, type MockOrderStatus, type MockPlatform } from './store.js';

const OrderStatusSchema = z.enum(['결제 완료', '상품 준비중', '배송중', '배송 완료', '취소 요청', '반품 요청', '교환 요청']);
const PlatformSchema = z.enum(['naver', 'coupang']);

const CreateOrderBody = z.object({
  platform: PlatformSchema,
  orderNo: z.string().trim().max(40).optional(),
  customerName: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(4).max(30),
  itemName: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  amount: z.coerce.number().int().min(0).max(100_000_000),
  status: OrderStatusSchema.default('결제 완료'),
  carrier: z.string().trim().max(40).nullable().optional(),
  trackingNo: z.string().trim().max(50).nullable().optional(),
  eta: z.string().trim().max(20).nullable().optional(),
  autoSync: z.boolean().optional(),
});

const PatchOrderBody = z.object({
  status: OrderStatusSchema.optional(),
  carrier: z.string().trim().max(40).nullable().optional(),
  trackingNo: z.string().trim().max(50).nullable().optional(),
  eta: z.string().trim().max(20).nullable().optional(),
  autoSync: z.boolean().optional(),
});

const CreateInquiryBody = z.object({
  chatId: z.string().trim().min(1).max(100).optional(),
  platform: PlatformSchema.nullable().optional(),
  orderNo: z.string().trim().max(40).nullable().optional(),
  customerName: z.string().trim().min(1).max(60).default('데모 고객'),
  question: z.string().trim().min(1).max(2000),
});

export function buildMockCommerceApp(opts: {
  mawdBase?: string;
  mawdPublicBase?: string;
  fetchFn?: typeof fetch;
  store?: ReturnType<typeof createMockCommerceStore>;
  logger?: boolean;
} = {}) {
  const mawdBase = (opts.mawdBase || process.env.MAWD_API_BASE?.trim() || 'http://localhost:8000').replace(/\/$/, '');
  const mawdPublicBase = (opts.mawdPublicBase || process.env.MAWD_PUBLIC_URL?.trim() || process.env.PUBLIC_BASE_URL?.trim() || mawdBase).replace(/\/$/, '');
  const fetchFn = opts.fetchFn ?? fetch;
  const store = opts.store ?? createMockCommerceStore();
  const issuedTokens = new Set<string>(['demo-naver-token']);

  const app = Fastify({ logger: opts.logger ?? false });

  // 네이버 OAuth2 /v1/oauth2/token 요청은 URLSearchParams(application/x-www-form-urlencoded;charset=UTF-8)로 옴
  app.addContentTypeParser(/^application\/x-www-form-urlencoded/, { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // MAWD API는 로그인이 필요해서 데모 계정으로 로그인한 토큰(Bearer)을 씀. 만료 · 401이면 한 번 다시 로그인
  const demoEmail = process.env.MAWD_DEMO_EMAIL?.trim() || process.env.DEMO_EMAIL?.trim() || 'demo@mawd.app';
  const demoPassword = process.env.MAWD_DEMO_PASSWORD?.trim() || process.env.DEMO_PASSWORD?.trim() || 'mawd-demo-1234';
  let mawdToken: string | null = null;
  async function login(): Promise<string | null> {
    const res = await fetchFn(`${mawdBase}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ email: demoEmail, password: demoPassword }),
    });
    mawdToken = res.ok ? ((await res.json()) as { token?: string }).token ?? null : null;
    return mawdToken;
  }

  async function callMawd(path: string, init: RequestInit = {}) {
    try {
      const send = async () => fetchFn(`${mawdBase}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(mawdToken ? { authorization: `Bearer ${mawdToken}` } : {}), ...init.headers },
      });
      if (!mawdToken) await login().catch(() => null);
      let res = await send();
      if (res.status === 401 && (await login().catch(() => null))) res = await send();
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 503, data: { error: { message: err instanceof Error ? err.message : 'MAWD 서버에 연결할 수 없습니다.' } } };
    }
  }

  async function syncMawdPlatform(platform: MockPlatform) {
    const res = await callMawd(`/v1/commerce/connections/${platform}/sync`, { method: 'POST', body: '{}' });
    const body = res.data as { ok?: boolean } | null;
    return { ...res, ok: res.ok && body?.ok !== false };
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(new URL('../public/index.html', import.meta.url))));

  // ---------- 데모 프론트 전용 API ----------
  app.get('/api/state', async () => ({
    orders: store.listOrders(),
    inquiries: store.listInquiries(),
    creds: DEMO_CREDS,
    mawdBase,
    mawdPublicBase,
  }));

  app.post('/api/orders', async (req, reply) => {
    const parsed = CreateOrderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' });
    const { autoSync, ...data } = parsed.data;
    const order = store.addOrder(data);
    const sync = autoSync ? await syncMawdPlatform(order.platform) : null;
    return { order, sync };
  });

  app.patch('/api/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchOrderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' });
    const { autoSync, ...patch } = parsed.data;
    const order = store.updateOrder(id, patch as Partial<{ status: MockOrderStatus; carrier: string | null; trackingNo: string | null; eta: string | null }>);
    if (!order) return reply.code(404).send({ error: '주문을 찾을 수 없습니다.' });
    const sync = autoSync ? await syncMawdPlatform(order.platform) : null;
    return { order, sync };
  });

  app.delete('/api/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteOrder(id)) return reply.code(404).send({ error: '주문을 찾을 수 없습니다.' });
    return { ok: true };
  });

  app.post('/api/orders/reset', async () => {
    store.reset();
    return { orders: store.listOrders(), inquiries: store.listInquiries() };
  });

  app.post('/api/mawd/connect', async () => {
    const naverConn = await callMawd('/v1/commerce/connections/naver', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'api', credentials: DEMO_CREDS.naver }),
    });
    const coupangConn = await callMawd('/v1/commerce/connections/coupang', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'api', credentials: DEMO_CREDS.coupang }),
    });
    const [naverSync, coupangSync] = await Promise.all([
      naverConn.ok ? syncMawdPlatform('naver') : Promise.resolve(naverConn),
      coupangConn.ok ? syncMawdPlatform('coupang') : Promise.resolve(coupangConn),
    ]);
    return {
      ok: naverConn.ok && coupangConn.ok && naverSync.ok && coupangSync.ok,
      naver: { connect: naverConn, sync: naverSync },
      coupang: { connect: coupangConn, sync: coupangSync },
    };
  });

  app.post('/api/mawd/sync', async (req) => {
    const body = (req.body as { platform?: MockPlatform } | undefined) ?? {};
    if (body.platform === 'naver' || body.platform === 'coupang') {
      return { [body.platform]: await syncMawdPlatform(body.platform) };
    }
    const [naver, coupang] = await Promise.all([syncMawdPlatform('naver'), syncMawdPlatform('coupang')]);
    return { naver, coupang };
  });

  app.post('/api/inquiries', async (req, reply) => {
    const parsed = CreateInquiryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '문의 내용을 입력하세요.' });
    const d = parsed.data;
    const chatId = d.chatId || `commerce-demo-${Date.now()}`;
    const mawdRes = await callMawd(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: d.question, customer_name: d.customerName }),
    });
    const chat = mawdRes.ok ? (mawdRes.data as { state?: string; handed_off?: boolean; transcript?: { role: string; text: string }[] }) : null;
    const lastAi = chat?.transcript?.filter((m) => m.role === 'ai').at(-1)?.text ?? null;
    const inquiry = store.addInquiry({
      chatId,
      platform: d.platform ?? null,
      orderNo: d.orderNo ?? null,
      customerName: d.customerName,
      question: d.question,
      aiReply: lastAi,
      aiState: chat?.state ?? null,
      handedOff: Boolean(chat?.handed_off),
    });
    return { ok: mawdRes.ok, status: mawdRes.status, inquiry, chat: mawdRes.data };
  });

  app.post('/api/inquiries/:chatId/end', async (req) => {
    const { chatId } = req.params as { chatId: string };
    const mawdRes = await callMawd(`/v1/chats/${encodeURIComponent(chatId)}/end`, { method: 'POST', body: '{}' });
    return { ok: mawdRes.ok, status: mawdRes.status, chat: mawdRes.data };
  });

  // ---------- 네이버 커머스API 호환 엔드포인트 (apps/api/src/commerce/naver.ts) ----------
  app.post('/v1/oauth2/token', async (req, reply) => {
    const body = (req.body as Record<string, string> | undefined) ?? {};
    if (body.client_id !== DEMO_CREDS.naver.client_id || !body.client_secret_sign) {
      return reply.code(401).send({ message: 'Invalid client_id or signature' });
    }
    const token = `mock-naver-${Date.now()}`;
    issuedTokens.add(token);
    return { access_token: token, expires_in: 10800, token_type: 'Bearer' };
  });

  const checkNaverAuth = (authHeader: string | undefined) => {
    const tok = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? '';
    return issuedTokens.has(tok);
  };

  app.get('/v1/pay-order/seller/product-orders/last-changed-statuses', async (req, reply) => {
    if (!checkNaverAuth(req.headers.authorization)) return reply.code(401).send({ message: 'Unauthorized' });
    const q = req.query as { lastChangedFrom?: string; lastChangedTo?: string };
    const from = q.lastChangedFrom ? new Date(q.lastChangedFrom) : new Date(Date.now() - 7 * 86_400_000);
    const to = q.lastChangedTo ? new Date(q.lastChangedTo) : new Date();
    return { data: { lastChangeStatuses: store.findNaverChanged(from, to) } };
  });

  app.post('/v1/pay-order/seller/product-orders/query', async (req, reply) => {
    if (!checkNaverAuth(req.headers.authorization)) return reply.code(401).send({ message: 'Unauthorized' });
    const body = (req.body as { productOrderIds?: string[] } | undefined) ?? {};
    return { data: store.queryNaverProductOrders(body.productOrderIds ?? []) };
  });

  app.get('/v1/pay-order/seller/orders/:orderNo/product-order-ids', async (req, reply) => {
    if (!checkNaverAuth(req.headers.authorization)) return reply.code(401).send({ message: 'Unauthorized' });
    const { orderNo } = req.params as { orderNo: string };
    return { data: store.findNaverProductOrderIds(orderNo) };
  });

  // ---------- 쿠팡 Open API 호환 엔드포인트 (apps/api/src/commerce/coupang.ts) ----------
  const checkCoupangAuth = (vendorId: string, authHeader: string | undefined) =>
    vendorId === DEMO_CREDS.coupang.vendor_id && (authHeader ?? '').startsWith('CEA ');

  app.get('/v2/providers/openapi/apis/api/v4/vendors/:vendorId/ordersheets', async (req, reply) => {
    const { vendorId } = req.params as { vendorId: string };
    if (!checkCoupangAuth(vendorId, req.headers.authorization)) return reply.code(401).send({ message: 'Unauthorized' });
    const q = req.query as { createdAtFrom?: string; createdAtTo?: string; status?: string };
    return { data: store.queryCoupangSheets(q.status ?? 'ACCEPT', q.createdAtFrom, q.createdAtTo) };
  });

  app.get('/v2/providers/openapi/apis/api/v4/vendors/:vendorId/:orderNo/ordersheets', async (req, reply) => {
    const { vendorId, orderNo } = req.params as { vendorId: string; orderNo: string };
    if (!checkCoupangAuth(vendorId, req.headers.authorization)) return reply.code(401).send({ message: 'Unauthorized' });
    return { data: store.findCoupangSheet(orderNo) };
  });

  return app;
}

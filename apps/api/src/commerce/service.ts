// 외부 커머스 통합 서비스 (F13): 연결 관리 · 암호화 키 보관 · 주기적/수동 동기화 · 실시간 단건 조회 · CSV 업로드
import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type * as C from '@mawd/contracts';
import { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import type { SecretBox } from '../secrets.js';
import { createCoupangAdapter } from './coupang.js';
import { parseOrdersCsv } from './csv.js';
import { createDemoAdapter } from './demo.js';
import { createNaverAdapter } from './naver.js';
import { maskPhone, PLATFORMS, platformLabel, type CommerceAdapter, type NormalizedOrder } from './types.js';

type Db = ReturnType<typeof createDb>;
type Log = { info?: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
const secretKind = (source: C.CommerceSource) => `commerce:${source}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function createCommerceService(deps: { db: Db; secrets: SecretBox; fetchFn?: typeof fetch; log?: Log }) {
  const fetchFn = deps.fetchFn ?? fetch;

  function makeAdapter(source: C.CommerceSource, mode: 'api' | 'demo' | 'file', creds?: Record<string, string>): CommerceAdapter | null {
    if (mode === 'demo') return createDemoAdapter(source);
    if (mode !== 'api') return null;
    if (source === 'naver') return createNaverAdapter({ client_id: creds?.client_id ?? '', client_secret: creds?.client_secret ?? '', account_id: creds?.account_id || undefined }, fetchFn);
    if (source === 'coupang') return createCoupangAdapter({ vendor_id: creds?.vendor_id ?? '', access_key: creds?.access_key ?? '', secret_key: creds?.secret_key ?? '' }, fetchFn);
    return null;
  }

  async function adapterForConnection(tenantId: string, source: C.CommerceSource, mode: 'api' | 'demo' | 'file'): Promise<CommerceAdapter | null> {
    if (mode !== 'api') return makeAdapter(source, mode);
    const [sec] = await deps.db.withTenant(tenantId, (tx) =>
      tx.select({ ciphertext: s.secrets.ciphertext }).from(s.secrets).where(eq(s.secrets.kind, secretKind(source))), { readOnly: true });
    if (!sec) throw new Error('저장된 연동 키가 없습니다.');
    return makeAdapter(source, 'api', deps.secrets.open<Record<string, string>>(sec.ciphertext));
  }

  async function upsertOrders(tenantId: string, source: C.CommerceSource, rows: NormalizedOrder[], syncedAt: Date): Promise<number> {
    if (!rows.length) return 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200).map((o) => ({
        tenantId,
        source,
        orderNo: o.orderNo,
        customerName: o.customerName,
        phone: o.phone,
        email: o.email,
        items: o.items,
        amount: o.amount != null ? String(o.amount) : null,
        orderedAt: o.orderedAt,
        status: o.status,
        rawStatus: o.rawStatus,
        trackingNo: o.trackingNo,
        carrier: o.carrier,
        eta: o.eta,
        raw: o.raw ?? null,
        syncedAt,
      }));
      await deps.db.withTenant(tenantId, (tx) => tx.insert(s.orders).values(batch).onConflictDoUpdate({
        target: [s.orders.tenantId, s.orders.source, s.orders.orderNo],
        set: {
          customerName: sql`COALESCE(excluded.customer_name, ${s.orders.customerName})`,
          phone: sql`COALESCE(excluded.phone, ${s.orders.phone})`,
          email: sql`COALESCE(excluded.email, ${s.orders.email})`,
          items: sql`COALESCE(excluded.items, ${s.orders.items})`,
          amount: sql`COALESCE(excluded.amount, ${s.orders.amount})`,
          orderedAt: sql`COALESCE(excluded.ordered_at, ${s.orders.orderedAt})`,
          status: sql`excluded.status`,
          rawStatus: sql`excluded.raw_status`,
          trackingNo: sql`COALESCE(excluded.tracking_no, ${s.orders.trackingNo})`,
          carrier: sql`COALESCE(excluded.carrier, ${s.orders.carrier})`,
          eta: sql`COALESCE(excluded.eta, ${s.orders.eta})`,
          raw: sql`excluded.raw`,
          syncedAt: sql`excluded.synced_at`,
        },
      }));
    }
    return rows.length;
  }

  function toOrderOut(o: typeof s.orders.$inferSelect) {
    return {
      id: o.id,
      source: o.source as C.CommerceSource,
      platform: platformLabel(o.source),
      order_no: o.orderNo,
      customer_name: o.customerName ?? '-',
      phone_masked: maskPhone(o.phone),
      items: o.items ?? '-',
      amount: o.amount != null ? Number(o.amount) : 0,
      status: o.status ?? '확인 중',
      raw_status: o.rawStatus ?? null,
      tracking_no: o.trackingNo ?? null,
      carrier: o.carrier ?? null,
      eta: o.eta ?? null,
      ordered_at: o.orderedAt?.toISOString() ?? null,
      synced_at: o.syncedAt?.toISOString() ?? null,
    };
  }

  function listPlatforms() {
    return Object.values(PLATFORMS).map((p) => ({
      source: p.source,
      label: p.label,
      kind: p.kind,
      modes: p.modes,
      credential_fields: p.credentialFields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, required: f.required !== false })),
      admin_url: p.adminUrl,
      note: p.note,
    }));
  }

  async function listConnections(tenantId: string) {
    const [conns, counts] = await deps.db.withTenant(tenantId, async (tx) => Promise.all([
      tx.select().from(s.storeConnections),
      tx.select({ source: s.orders.source, n: count(s.orders.id) }).from(s.orders).groupBy(s.orders.source),
    ]), { readOnly: true });

    const countMap = new Map(counts.map((c) => [c.source, Number(c.n)]));
    const bySource = new Map(conns.map((c) => [c.source, c]));
    // 주문이 들어온 판매처(예: 초기 시드 csv)도 연결 목록에 표시
    const sources = new Set<string>([...bySource.keys(), ...countMap.keys()]);

    return [...sources].map((src) => {
      const c = bySource.get(src);
      const def = PLATFORMS[src as C.CommerceSource];
      return {
        source: src as C.CommerceSource,
        label: def?.label ?? src,
        mode: (c?.mode ?? 'file') as 'api' | 'demo' | 'file',
        status: (c?.status ?? 'connected') as 'connected' | 'error' | 'disabled',
        last_synced_at: c?.lastSyncedAt?.toISOString() ?? null,
        last_error: c?.lastError ?? null,
        order_count: countMap.get(src) ?? 0,
        admin_url: def?.adminUrl ?? null,
      };
    });
  }

  async function syncOne(tenantId: string, source: C.CommerceSource) {
    const [row] = await deps.db.withTenant(tenantId, (tx) =>
      tx.select().from(s.storeConnections).where(eq(s.storeConnections.source, source)), { readOnly: true });
    const conn = row ?? notFound('connection_not_found');
    if (conn.mode === 'file') throw new ApiError(409, 'file_mode_connection', `${platformLabel(source)}은(는) 파일 업로드 모드입니다. 주문 CSV를 올려주세요.`);
    if (conn.status === 'disabled') throw new ApiError(409, 'connection_disabled', '비활성화된 연동입니다.');

    const until = new Date();
    const since = conn.syncCursor ?? new Date(until.getTime() - 14 * 86_400_000); // 최초 연동 시 최근 14일
    try {
      const adapter = await adapterForConnection(tenantId, source, conn.mode);
      if (!adapter) throw new Error('지원하지 않는 연동 방식입니다.');
      const orders = await adapter.fetchChanged(since, until);
      const upserted = await upsertOrders(tenantId, source, orders, until);
      await deps.db.withTenant(tenantId, (tx) => tx.update(s.storeConnections)
        .set({ status: 'connected', syncCursor: until, lastSyncedAt: until, lastError: null, updatedAt: until })
        .where(eq(s.storeConnections.source, source)));
      return { source, ok: true, fetched: orders.length, upserted, error: null, synced_at: until.toISOString() };
    } catch (err) {
      const msg = errText(err);
      await deps.db.withTenant(tenantId, (tx) => tx.update(s.storeConnections)
        .set({ status: 'error', lastError: msg, updatedAt: until })
        .where(eq(s.storeConnections.source, source)));
      return { source, ok: false, fetched: 0, upserted: 0, error: msg, synced_at: until.toISOString() };
    }
  }

  async function upsertConnection(tenantId: string, source: C.CommerceSource, body: z.infer<typeof C.ConnectionUpsert>) {
    const def = PLATFORMS[source];
    if (!def.modes.includes(body.mode)) {
      throw new ApiError(400, 'unsupported_mode', `${def.label}은(는) 현재 ${body.mode} 연동을 지원하지 않습니다. (${def.note})`);
    }
    if (body.mode === 'api') {
      const creds = body.credentials ?? {};
      const missing = def.credentialFields.filter((f) => f.required !== false && !creds[f.key]?.trim());
      if (missing.length) throw new ApiError(422, 'missing_credentials', `필수 인증 정보가 비어 있습니다: ${missing.map((m) => m.label).join(', ')}`);
      const adapter = makeAdapter(source, 'api', creds);
      if (!adapter) throw new ApiError(400, 'unsupported_mode', 'API 어댑터가 없습니다.');
      try { await adapter.test(); } catch (err) {
        throw new ApiError(400, 'commerce_auth_failed', errText(err));
      }
      const ciphertext = deps.secrets.seal(creds);
      await deps.db.withTenant(tenantId, (tx) => tx.insert(s.secrets)
        .values({ tenantId, kind: secretKind(source), ciphertext })
        .onConflictDoUpdate({ target: [s.secrets.tenantId, s.secrets.kind], set: { ciphertext } }));
    }

    const now = new Date();
    await deps.db.withTenant(tenantId, (tx) => tx.insert(s.storeConnections)
      .values({ tenantId, source, mode: body.mode, status: 'connected', lastError: null, updatedAt: now })
      .onConflictDoUpdate({
        target: [s.storeConnections.tenantId, s.storeConnections.source],
        set: { mode: body.mode, status: 'connected', lastError: null, syncCursor: null, updatedAt: now },
      }));

    if (body.mode !== 'file') await syncOne(tenantId, source);
    const conns = await listConnections(tenantId);
    return conns.find((c) => c.source === source)!;
  }

  async function deleteConnection(tenantId: string, source: C.CommerceSource) {
    const deleted = await deps.db.withTenant(tenantId, async (tx) => {
      await tx.delete(s.secrets).where(eq(s.secrets.kind, secretKind(source)));
      return tx.delete(s.storeConnections).where(eq(s.storeConnections.source, source)).returning({ source: s.storeConnections.source });
    });
    if (!deleted.length) notFound('connection_not_found');
  }

  /** AI 응대 중 DB에 없는(또는 방금 들어온) 주문번호를 연결된 API/데모 판매처에서 실시간 조회해 바로 DB에 적재 */
  async function lookupOrderLive(tenantId: string, orderNo: string): Promise<number> {
    const conns = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.storeConnections)
      .where(and(inArray(s.storeConnections.mode, ['api', 'demo']), sql`${s.storeConnections.status} <> 'disabled'`)), { readOnly: true });
    if (!conns.length) return 0;

    const now = new Date();
    let total = 0;
    await Promise.all(conns.map(async (conn) => {
      const source = conn.source as C.CommerceSource;
      try {
        const adapter = await adapterForConnection(tenantId, source, conn.mode);
        if (!adapter || !adapter.looksLike(orderNo)) return;
        const found = await adapter.fetchOrder(orderNo);
        if (found.length) total += await upsertOrders(tenantId, source, found, now);
      } catch (err) {
        deps.log?.error({ err, tenantId, source, orderNo }, 'live commerce order lookup failed');
      }
    }));
    return total;
  }

  async function importOrders(tenantId: string, body: z.infer<typeof C.OrderImportBody>) {
    const parsed = parseOrdersCsv(body.csv);
    const now = new Date();
    if (body.dry_run) {
      const preview = parsed.orders.slice(0, 20).map((o, i) => ({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        source: body.source,
        platform: platformLabel(body.source),
        order_no: o.orderNo,
        customer_name: o.customerName ?? '-',
        phone_masked: maskPhone(o.phone),
        items: o.items ?? '-',
        amount: o.amount ?? 0,
        status: o.status,
        raw_status: o.rawStatus,
        tracking_no: o.trackingNo,
        carrier: o.carrier,
        eta: o.eta,
        ordered_at: o.orderedAt?.toISOString() ?? null,
        synced_at: now.toISOString(),
      }));
      return { imported: parsed.orders.length, skipped: parsed.skipped, errors: parsed.errors, preview };
    }

    const imported = await upsertOrders(tenantId, body.source, parsed.orders, now);
    if (imported > 0) {
      await deps.db.withTenant(tenantId, (tx) => tx.insert(s.storeConnections)
        .values({ tenantId, source: body.source, mode: 'file', status: 'connected', lastSyncedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [s.storeConnections.tenantId, s.storeConnections.source],
          set: { lastSyncedAt: now, updatedAt: now },
        }));
    }
    return { imported, skipped: parsed.skipped, errors: parsed.errors };
  }

  async function listOrders(tenantId: string, query: { source?: C.CommerceSource; q?: string; limit: number }) {
    const conds: SQL[] = [];
    if (query.source) conds.push(eq(s.orders.source, query.source));
    if (query.q?.trim()) {
      const term = query.q.trim();
      const qDigits = term.replace(/\D/g, '');
      const pat = `%${term}%`;
      const parts = [ilike(s.orders.orderNo, pat), ilike(s.orders.customerName, pat)];
      if (qDigits.length >= 4) parts.push(sql`regexp_replace(coalesce(${s.orders.phone}, ''), '[^0-9]', '', 'g') LIKE ${'%' + qDigits}`);
      conds.push(or(...parts)!);
    }
    const rows = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.orders)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${s.orders.orderedAt} DESC NULLS LAST`, desc(s.orders.syncedAt), s.orders.orderNo)
      .limit(query.limit), { readOnly: true });
    return { items: rows.map(toOrderOut), next_cursor: null };
  }

  async function syncTenant(tenantId: string) {
    const conns = await deps.db.withTenant(tenantId, (tx) => tx.select({ source: s.storeConnections.source })
      .from(s.storeConnections)
      .where(and(inArray(s.storeConnections.mode, ['api', 'demo']), sql`${s.storeConnections.status} <> 'disabled'`)), { readOnly: true });
    const results = [];
    for (const c of conns) results.push(await syncOne(tenantId, c.source as C.CommerceSource));
    return results;
  }

  function startSyncLoop(intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { stop: () => {} };
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const tenantIds = await deps.db.tenantsWithConnections();
        for (const t of tenantIds) await syncTenant(t).catch((err) => deps.log?.error({ err, tenantId: t }, 'commerce sync failed for tenant'));
      } catch (err) {
        deps.log?.error({ err }, 'commerce background sync failed');
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  return { listPlatforms, listConnections, upsertConnection, deleteConnection, syncOne, syncTenant, lookupOrderLive, importOrders, listOrders, startSyncLoop };
}

export type CommerceService = ReturnType<typeof createCommerceService>;

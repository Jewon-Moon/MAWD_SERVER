// 매장 지식 문서 (F2): 정책 · 매뉴얼 · 상품 상세 같은 글을 올리면 조각으로 나눠 저장 → 매장별 지식 검색(RAG)의 근거.
// shortcut: 텍스트 · MD만 (JSON 본문). PDF는 텍스트 추출(pdf 파서) 붙일 때 source_type=pdf로
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { notFound } from '../errors.js';
import { TENANT_ID } from '../mocks/data.js';

type Db = ReturnType<typeof createDb>;
const idParam = z.object({ id: z.string().uuid() });
const DocumentCreate = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(200_000).describe('텍스트 · MD 본문 (.md · .txt 파일 내용)'),
  source: C.CommerceSource.nullable().optional().describe('특정 판매처 전용 문서면 지정 (예: coupang). 비우면 모든 판매처 공통'),
});

/** 제목(#)마다 나누고, 그 안은 문단을 묶어 ~800자 조각. 긴 문단은 문장 경계에서, 경계가 없으면 글자 수로 자름 */
export function chunkText(text: string, max = 800): string[] {
  const out: string[] = [];
  const hardSplit = (p: string) => { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max)); };
  const sections = text.replace(/\r\n/g, '\n').split(/\n(?=#{1,6} )/).map((x) => x.trim()).filter(Boolean);
  for (const sec of sections) {
    let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (const p of sec.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
      if (p.length > max) {
        push();
        let buf = '';
        for (const sen of p.split(/(?<=[.!?。])\s+/)) {
          if (sen.length > max) { if (buf.trim()) out.push(buf.trim()); buf = ''; hardSplit(sen); continue; }
          if ((buf + ' ' + sen).length > max && buf) { out.push(buf.trim()); buf = ''; }
          buf += ' ' + sen;
        }
        if (buf.trim()) out.push(buf.trim());
      } else if ((cur + '\n\n' + p).length > max) { push(); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p;
    }
    push();
  }
  return out;
}

export function documentRoutes(deps: { db: Db }): FastifyPluginAsyncZod {
  // shortcut: 인증 전이라 데모 매장 고정, Better Auth 붙일 때 세션의 매장으로 교체
  const tenantOf = () => TENANT_ID;
  const toOut = (d: typeof s.documents.$inferSelect, chunks: number) => ({
    id: d.id,
    title: d.title,
    source_type: d.sourceType,
    chunk_count: chunks,
    enabled: d.enabled,
    source: (d.source as C.CommerceSource | null) ?? null,
    created_at: d.createdAt.toISOString(),
  });
  const counted = (t: string) => deps.db.withTenant(t, (tx) => tx.select({ d: s.documents, n: count(s.docChunks.id) }).from(s.documents)
    .leftJoin(s.docChunks, eq(s.docChunks.documentId, s.documents.id)).groupBy(s.documents.id).orderBy(s.documents.createdAt), { readOnly: true });

  return async (app) => {
    app.get('/documents', { schema: { tags: ['knowledge'], response: { 200: z.array(C.Document) }, description: '매장 지식 문서 목록 (조각 수 포함)' } },
      async () => (await counted(tenantOf())).map((r) => toOut(r.d, r.n)));

    app.post('/documents', {
      schema: { tags: ['knowledge'], body: DocumentCreate, response: { 200: C.Document }, description: '텍스트 · MD 문서 등록 → 조각으로 나눠 저장. 다음 질문부터 AI 근거로 검색됨' },
    }, async (req) => {
      const t = tenantOf();
      const parts = chunkText(req.body.content);
      const doc = await deps.db.withTenant(t, async (tx) => {
        const [d] = await tx.insert(s.documents).values({ tenantId: t, title: req.body.title, sourceType: 'text', source: req.body.source ?? null }).returning();
        if (parts.length) await tx.insert(s.docChunks).values(parts.map((content) => ({ tenantId: t, documentId: d!.id, content })));
        return d!;
      });
      return toOut(doc, parts.length);
    });

    app.patch('/documents/:id', { schema: { tags: ['knowledge'], params: idParam, body: C.DocumentPatch, response: { 200: C.Document }, description: 'enabled=false면 AI 근거에서 뺌' } }, async (req) => {
      const t = tenantOf();
      const [d] = await deps.db.withTenant(t, (tx) => tx.update(s.documents).set(req.body).where(and(eq(s.documents.id, req.params.id), eq(s.documents.tenantId, t))).returning());
      if (!d) notFound('document_not_found');
      const r = (await counted(t)).find((x) => x.d.id === d!.id)!;
      return toOut(r.d, r.n);
    });

    app.delete('/documents/:id', { schema: { tags: ['knowledge'], params: idParam, response: { 200: z.object({ ok: z.literal(true) }) } } }, async (req) => {
      const t = tenantOf();
      const rows = await deps.db.withTenant(t, (tx) => tx.delete(s.documents).where(and(eq(s.documents.id, req.params.id), eq(s.documents.tenantId, t))).returning({ id: s.documents.id }));
      if (!rows.length) notFound('document_not_found');
      return { ok: true as const };
    });
  };
}

// 매장 문서(MD): 매장 소개 · 상품 · 서비스 · 운영 정책. 템플릿 모드(필드 → templates/context/{kind}.md) 또는 직접 작성 모드(사장님 MD 그대로).
// AI 파이프라인은 동기로 읽어야 해서 매장별 MD를 메모리에 캐시하고, 대화 시작 · 저장 때 DB에서 다시 읽음
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ContextDocFields, type ContextDoc, type ContextDocPut, type ContextKind as KindEnum } from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { ApiError } from '../errors.js';
import { defaultContextFields } from '../mocks/data.js';
import { renderTemplateMd } from './render.js';

type Db = ReturnType<typeof createDb>;
export type Kind = z.infer<typeof KindEnum>;
type Doc = z.infer<typeof ContextDoc>;
export const KINDS: Kind[] = ['business', 'offerings', 'policies'];
export const TITLES: Record<Kind, string> = { business: '매장 소개', offerings: '상품 · 서비스', policies: '운영 정책' };

const INDUSTRY_KO: Record<string, string> = {
  online_shop: '온라인 쇼핑몰', offline_store: '오프라인 매장', food_beverage: '음식 · 카페', beauty: '뷰티 · 미용', fashion: '패션',
  education: '교육 · 강의', fitness: '운동 · 피트니스', health_clinic: '병원 · 의원', lodging_travel: '숙박 · 여행',
  software_saas: '소프트웨어 · 앱', service_booking: '예약형 서비스', other: '기타',
};
const OFFERING_KO: Record<string, string> = { product: '상품', service: '서비스', plan: '요금제 · 이용권' };

const templates = new Map<Kind, string>();
export const templateMd = (kind: Kind) => {
  if (!templates.has(kind)) templates.set(kind, readFileSync(new URL(`../../templates/context/${kind}.md`, import.meta.url), 'utf8'));
  return templates.get(kind)!;
};

/** 템플릿 모드: 필드 검증 → 템플릿에 넣어 MD. 필드가 스키마에 안 맞으면 422 */
export function renderDoc(kind: Kind, fields: unknown): { fields: Record<string, unknown>; markdown: string } {
  const parsed = ContextDocFields[kind].safeParse(fields);
  if (!parsed.success) throw new ApiError(422, 'validation_error', parsed.error.message);
  const f = parsed.data as Record<string, unknown>;
  const values = kind === 'business'
    ? { ...f, industry_label: INDUSTRY_KO[f.industry as string] ?? f.industry }
    : kind === 'offerings'
      ? { items: (f.items as { kind: string }[]).map((i) => ({ ...i, kind_label: OFFERING_KO[i.kind] ?? i.kind })) }
      : f;
  return { fields: f, markdown: renderTemplateMd(templateMd(kind), values) };
}

const defaultDoc = (kind: Kind): Doc => {
  const r = renderDoc(kind, defaultContextFields[kind]);
  return { kind, title: TITLES[kind], mode: 'template', fields: r.fields, markdown: r.markdown, is_default: true, updated_at: null };
};

// shortcut: 프로세스 메모리 캐시 (서버 1대 기준). 여러 대면 저장 시 다른 서버 캐시를 무효화(Redis pub/sub)
const cache = new Map<string, Record<Kind, Doc>>();

/** AI 프롬프트용 MD (동기). 아직 안 읽은 매장은 기본값 */
export function contextMarkdown(tenantId: string): Record<Kind, string> {
  const docs = cache.get(tenantId);
  return Object.fromEntries(KINDS.map((k) => [k, (docs?.[k] ?? defaultDoc(k)).markdown])) as Record<Kind, string>;
}

export function createContextStore(db: Db) {
  async function load(tenantId: string): Promise<Record<Kind, Doc>> {
    const rows = await db.withTenant(tenantId, (tx) => tx.select().from(s.contextDocs).where(eq(s.contextDocs.tenantId, tenantId)), { readOnly: true });
    const docs = Object.fromEntries(KINDS.map((k) => {
      const r = rows.find((x) => x.kind === k);
      return [k, r
        ? { kind: k, title: TITLES[k], mode: r.mode, fields: (r.fields as Record<string, unknown> | null) ?? null, markdown: r.markdown, is_default: false, updated_at: r.updatedAt.toISOString() }
        : defaultDoc(k)];
    })) as Record<Kind, Doc>;
    cache.set(tenantId, docs);
    return docs;
  }

  /** 저장 전 미리보기 (DB에 안 씀) */
  function preview(kind: Kind, body: z.infer<typeof ContextDocPut>) {
    return body.mode === 'template' ? renderDoc(kind, body.fields).markdown : body.markdown.trim() + '\n';
  }

  async function put(tenantId: string, kind: Kind, body: z.infer<typeof ContextDocPut>): Promise<Doc> {
    const r = body.mode === 'template' ? renderDoc(kind, body.fields) : { fields: null, markdown: body.markdown.trim() + '\n' };
    await db.withTenant(tenantId, (tx) => tx.insert(s.contextDocs).values({ tenantId, kind, mode: body.mode, fields: r.fields, markdown: r.markdown })
      .onConflictDoUpdate({ target: [s.contextDocs.tenantId, s.contextDocs.kind], set: { mode: body.mode, fields: r.fields, markdown: r.markdown, updatedAt: new Date() } }));
    return (await load(tenantId))[kind];
  }

  /** 기본값(템플릿)으로 되돌림 */
  async function reset(tenantId: string, kind: Kind): Promise<Doc> {
    await db.withTenant(tenantId, (tx) => tx.delete(s.contextDocs).where(eq(s.contextDocs.kind, kind)));
    return (await load(tenantId))[kind];
  }

  return { load, preview, put, reset };
}
export type ContextStore = ReturnType<typeof createContextStore>;

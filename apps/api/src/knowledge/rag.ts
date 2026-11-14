// 매장별 지식 검색(RAG): FAQ · 매장 문서(상품 · 운영 정책, ## 단위) · 올린 문서 조각에서 질문과 가까운 근거를 골라 프롬프트 [근거]에.
// - 매장 지식이 작으면(ai.rag.include_all_under_chars) 다 넣음: 검색 누락 없이 정확, 작은 매장은 대부분 여기
// - 크면 임베딩(코사인 유사도) 상위 k개. 임베딩 키가 없거나 실패하면 글자 겹침 점수로 대신
// 매장 격리: 문서 조각은 withTenant(RLS)로만 읽고, 캐시는 내용 해시 기준이라 매장끼리 섞이지 않음
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { platformLabel } from '../commerce/types.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import type { TenantConfig } from '../tenantConfig.js';

type Db = ReturnType<typeof createDb>;
export type Chunk = { source: string; text: string };
export type Embedder = { configured: boolean; embed(texts: string[]): Promise<number[][]> };
export type Rag = ReturnType<typeof createRag>;

/** 임베딩 클라이언트 (라이너 Platform 또는 OpenAI 호환). EMBED_*가 없으면 라이너/OpenAI LLM 키를 재사용 */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): Embedder {
  const llmBase = env.LLM_BASE_URL?.trim() || 'https://platform.liner.com/api/v1';
  const llmIsLiner = llmBase.includes('liner.com');
  const llmIsOpenAi = llmBase.includes('openai.com');
  const llmKey = (llmIsLiner ? env.LINER_API_KEY?.trim() : undefined) || env.LLM_API_KEY?.trim() || env.LINER_API_KEY?.trim();
  const embedBase = env.EMBED_BASE_URL?.trim() || (env.EMBED_API_KEY?.trim() ? undefined : llmIsLiner ? llmBase : undefined);
  const key = env.EMBED_API_KEY?.trim() || (llmIsLiner || llmIsOpenAi ? llmKey : '') || env.TTS_API_KEY?.trim();
  const client = key ? new OpenAI({ apiKey: key, baseURL: embedBase, timeout: 8_000, maxRetries: 1, ...(fetchFn ? { fetch: fetchFn } : {}) }) : null;
  const isLinerEmbed = (embedBase ?? '').includes('liner.com');
  const model = env.EMBED_MODEL?.trim() || (isLinerEmbed ? 'openai/text-embedding-3-small' : 'text-embedding-3-small');
  return {
    configured: !!client,
    async embed(texts) {
      const res = await client!.embeddings.create({ model, input: texts });
      return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

const sha = (t: string) => createHash('sha256').update(t).digest('base64url').slice(0, 24);
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / (Math.sqrt(x * y) || 1); };
// 임베딩 실패 시 대신: 질문의 두 글자 조각이 근거에 몇 개 있는지 (한국어는 띄어쓰기보다 글자 조각이 잘 맞음)
const bigrams = (t: string) => { const c = t.replace(/\s+/g, ''); const out = new Set<string>(); for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2)); return out; };
const keywordScore = (q: Set<string>, text: string) => { const b = bigrams(text); let n = 0; for (const g of q) if (b.has(g)) n++; return n; };

/** MD 문서를 ## 단위로 자름 (제목 줄은 각 조각 앞에 붙여 맥락 유지) */
export function splitMd(md: string, title: string): Chunk[] {
  const parts = md.split(/\n(?=## )/).map((p) => p.trim()).filter(Boolean);
  return parts.filter((p) => !/^# [^\n]*$/.test(p)).map((p) => ({ source: title, text: p.replace(/^# [^\n]*\n+/, '') }));
}

export function createRag(deps: { db: Db; embedder: Embedder }) {
  // shortcut: 임베딩을 프로세스 메모리에 (내용 해시 → 벡터, 최대 20000개). 매장 지식이 커지면 pgvector 컬럼 + 인덱스로
  const vecs = new Map<string, number[]>();

  async function chunksOf(tenantId: string, cfg: TenantConfig, opts?: { sources?: string[] }): Promise<Chunk[]> {
    const faqs = cfg.faqs.filter((f) => f.enabled).map((f) => ({ source: 'FAQ', text: `Q: ${f.question}\nA: ${f.answer}` }));
    const docs = await deps.db.withTenant(tenantId, (tx) => tx
      .select({ title: s.documents.title, docSource: s.documents.source, content: s.docChunks.content })
      .from(s.docChunks).innerJoin(s.documents, eq(s.documents.id, s.docChunks.documentId))
      .where(eq(s.documents.enabled, true)), { readOnly: true });
    // 판매처가 확정된 대화에서는 공통(source=null) + 해당 판매처 문서만 씀 (다른 플랫폼 정책과 섞이지 않게)
    const wanted = opts?.sources?.length ? new Set(opts.sources) : null;
    const filteredDocs = wanted ? docs.filter((d) => !d.docSource || wanted.has(d.docSource)) : docs;
    return [
      ...faqs,
      ...splitMd(cfg.context.offerings, '상품 · 서비스'),
      ...splitMd(cfg.context.policies, '운영 정책'),
      ...filteredDocs.map((d) => ({
        source: d.docSource ? `판매처(${platformLabel(d.docSource)}) 문서: ${d.title}` : `문서: ${d.title}`,
        text: d.content,
      })),
    ];
  }

  async function embedMissing(texts: string[]) {
    const need = [...new Set(texts)].filter((t) => !vecs.has(sha(t)));
    for (let i = 0; i < need.length; i += 96) { // 한 번에 보낼 개수 제한
      const batch = need.slice(i, i + 96);
      (await deps.embedder.embed(batch)).forEach((v, j) => vecs.set(sha(batch[j]!), v));
    }
    while (vecs.size > 20_000) vecs.delete(vecs.keys().next().value!);
  }

  /** 질문에 맞는 근거 (프롬프트용 텍스트). mode는 테스트 · 진단용 */
  async function retrieve(tenantId: string, cfg: TenantConfig, question: string, opts?: { sources?: string[] }): Promise<{ text: string; mode: 'all' | 'embedding' | 'keyword'; chunks: Chunk[] }> {
    const { top_k, include_all_under_chars } = cfg.settings.ai.rag;
    const all = await chunksOf(tenantId, cfg, opts);
    const fmt = (cs: Chunk[]) => cs.map((c) => `[${c.source}]\n${c.text}`).join('\n---\n') || '(등록된 근거 없음)';
    if (all.reduce((n, c) => n + c.text.length, 0) <= include_all_under_chars) return { text: fmt(all), mode: 'all', chunks: all };

    if (deps.embedder.configured) {
      try {
        await embedMissing([question, ...all.map((c) => c.text)]);
        const q = vecs.get(sha(question))!;
        const top = all.map((c) => ({ c, score: cosine(q, vecs.get(sha(c.text))!) })).sort((a, b) => b.score - a.score).slice(0, top_k).map((x) => x.c);
        return { text: fmt(top), mode: 'embedding', chunks: top };
      } catch { /* 아래 글자 겹침으로 */ }
    }
    const q = bigrams(question);
    const top = all.map((c) => ({ c, score: keywordScore(q, c.text) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, top_k).map((x) => x.c);
    return { text: fmt(top), mode: 'keyword', chunks: top };
  }

  return { retrieve, chunksOf };
}

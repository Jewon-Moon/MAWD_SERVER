// Instagram API (Instagram 로그인 방식, graph.instagram.com): 계정 확인 · 댓글 숨김 · 답글 + 웹훅 서명 확인.
// 권한: instagram_business_basic, instagram_business_manage_comments. 본인(테스터) 계정은 개발 모드에서 심사 없이 동작
import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH = 'https://graph.instagram.com';
export type InstagramClient = ReturnType<typeof createInstagramClient>;

export function createInstagramClient(fetchFn: typeof fetch = fetch, base = GRAPH) {
  async function call<T>(path: string, token: string, init: { method?: string; query?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await fetchFn(url, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
    const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
    if (!res.ok || j.error) throw new Error(`instagram ${path.split('/')[0]} ${res.status}: ${j.error?.message ?? ''}`.slice(0, 200));
    return j;
  }
  return {
    /** 토큰의 인스타 비즈니스 계정. user_id = 웹훅 entry.id와 같은 값 */
    me: (token: string) => call<{ user_id: string; username?: string }>('me', token, { query: { fields: 'user_id,username' } }),
    hide: (commentId: string, token: string) => call<{ success?: boolean }>(commentId, token, { method: 'POST', query: { hide: 'true' } }),
    reply: (commentId: string, message: string, token: string) => call<{ id: string }>(`${commentId}/replies`, token, { method: 'POST', query: { message } }),
  };
}

/** 웹훅이 진짜 Meta에서 왔는지: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(앱 시크릿, 원본 본문) */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export type IgComment = { igUserId: string; commentId: string; mediaId: string | null; parentId: string | null; fromId: string | null; username: string | null; text: string };

/** 웹훅 본문에서 댓글만 꺼냄 (object=instagram, entry[].changes[].field=comments). 그 밖의 이벤트는 무시 */
export function parseCommentWebhook(body: unknown): IgComment[] {
  const b = body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
  if (b?.object !== 'instagram' || !Array.isArray(b.entry)) return [];
  return b.entry.flatMap((e) => (e.changes ?? []).filter((c) => c.field === 'comments' && c.value).map((c) => {
    const v = c.value as { id?: string; text?: string; parent_id?: string; from?: { id?: string; username?: string }; media?: { id?: string } };
    return { igUserId: String(e.id ?? ''), commentId: String(v.id ?? ''), mediaId: v.media?.id ?? null, parentId: v.parent_id ?? null, fromId: v.from?.id ?? null, username: v.from?.username ?? null, text: String(v.text ?? '').trim().slice(0, 2200) };
  })).filter((c) => c.igUserId && c.commentId && c.text);
}

// Instagram API: 계정 확인 · 댓글 숨김 · 답글 + 웹훅 서명 확인.
// 두 방식: Instagram 로그인(graph.instagram.com, 토큰 직접 붙여넣기) · 통합 로그인(Unified login, graph.facebook.com, OAuth 콜백).
// 숨김 · 답글 호출 모양은 같고 주소만 다름. 본인(테스터) 계정은 개발 모드에서 심사 없이 동작
import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH = 'https://graph.instagram.com';
export const FB_GRAPH = 'https://graph.facebook.com';
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
    /** 통합 로그인: 이 토큰(비즈니스 시스템 사용자)에 할당된 인스타 계정들 */
    assignedAccounts: (token: string) => call<{ data?: { id: string; username?: string }[] }>('me/assigned_instagram_accounts', token, { query: { fields: 'id,username' } }).then((r) => r.data ?? []),
    /** 통합 로그인: 토큰이 인스타 계정 자체를 가리키는 경우 (대시보드에서 계정별로 만든 토큰) */
    profile: (token: string) => call<{ id: string; username?: string }>('me', token, { query: { fields: 'id,username' } }),
    /** 통합 로그인: 이 인스타 계정의 댓글 · DM 이벤트를 우리 앱 웹훅으로 받도록 구독 (안 하면 웹훅이 안 옴) */
    subscribe: (igUserId: string, token: string) => call<{ success?: boolean }>(`${igUserId}/subscribed_apps`, token, { method: 'POST', query: { subscribed_fields: 'comments,messages' } }),
    /** 최근 게시물 목록 (댓글 수동/폴링 동기화용) */
    listMedia: (igUserId: string, token: string, limit = 10) =>
      call<{ data?: { id: string }[] }>(`${igUserId}/media`, token, { query: { fields: 'id', limit: String(limit) } }).then((r) => r.data ?? []),
    /** 게시물의 댓글 목록 */
    listComments: (mediaId: string, token: string, limit = 25) =>
      call<{ data?: { id: string; text?: string; username?: string; from?: { id?: string; username?: string }; parent_id?: string }[] }>(
        `${mediaId}/comments`,
        token,
        { query: { fields: 'id,text,username,from,parent_id', limit: String(limit) } }
      ).then((r) => r.data ?? []),
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

/** 통합 로그인 OAuth: 로그인 화면 주소 (권한은 대시보드의 구성 config_id에 있음, scope 없음) */
export function unifiedLoginUrl(o: { appId: string; configId: string; redirectUri: string; state: string }) {
  const u = new URL('https://www.facebook.com/dialog/oauth');
  u.search = new URLSearchParams({ client_id: o.appId, config_id: o.configId, redirect_uri: o.redirectUri, response_type: 'code', state: o.state }).toString();
  return u.toString();
}

/** 통합 로그인 OAuth: 콜백의 code → 비즈니스 시스템 사용자 토큰 (기본 구성은 만료 없음). redirect_uri는 로그인 때와 같아야 함 */
export async function exchangeUnifiedCode(fetchFn: typeof fetch, o: { appId: string; appSecret: string; redirectUri: string; code: string }): Promise<string> {
  const u = new URL(`${FB_GRAPH}/oauth/access_token`);
  u.search = new URLSearchParams({ client_id: o.appId, client_secret: o.appSecret, redirect_uri: o.redirectUri, code: o.code }).toString();
  const res = await fetchFn(u, { signal: AbortSignal.timeout(10_000) });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !j.access_token) throw new Error(`토큰 교환 실패: ${j.error?.message ?? res.status}`.slice(0, 200));
  return j.access_token;
}

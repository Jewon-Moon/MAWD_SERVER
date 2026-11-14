// 인스타그램 댓글 대응 (F11): 연결 · 해제 + 댓글 한 건 처리.
// 댓글 → 판단(Bivia/LLM, 전화 · 채팅과 같은 judge) → 악성이면 숨김 / 일반 문의면 매장 지식으로 공개 답글 → 문의 기록(channel=sns) → 우선순위 알림.
// 매장 설정 instagram.*로 숨김 기준 · 자동 답글을 조절. 사장님 알림에는 댓글 원문(욕설)을 싣지 않음
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AlertCenter } from '../alerts.js';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Bivia } from '../integrations/bivia.js';
import type { IgComment, InstagramClient } from '../integrations/instagram.js';
import type { Llm } from '../integrations/llm.js';
import type { Rag } from '../knowledge/rag.js';
import type { SecretBox } from '../secrets.js';
import { getTenantConfig, type TenantConfig } from '../tenantConfig.js';
import { leaksPii, newVerifyState } from '../tools/orders.js';
import { judge } from '../voice/judge.js';
import type { CallSession } from '../voice/policy.js';
import { businessContext } from '../voice/turn.js';

type Db = ReturnType<typeof createDb>;
type Log = { error: (o: object, m: string) => void };
export type CommentResult = { action: 'hidden' | 'replied' | 'none' | 'skipped'; heat: number | null; reply: string | null };
const HANDOFF = '[HANDOFF]';

export function createInstagramService(deps: { db: Db; llm: Llm; ig: InstagramClient; igFb: InstagramClient; secrets: SecretBox; bivia?: Bivia; rag?: Rag; alerts?: AlertCenter; log?: Log }) {
  const knownTenants = new Set<string>();
  /** 저장된 토큰 + 그 토큰으로 부를 API (통합 로그인 = graph.facebook.com, 직접 붙여넣은 토큰 = graph.instagram.com) */
  async function credOf(tenantId: string): Promise<{ token: string; client: InstagramClient }> {
    knownTenants.add(tenantId);
    const [sec] = await deps.db.withTenant(tenantId, (tx) => tx.select({ c: s.secrets.ciphertext }).from(s.secrets).where(eq(s.secrets.kind, 'instagram')), { readOnly: true });
    if (!sec) throw new Error('인스타그램이 연결되어 있지 않습니다.');
    const c = deps.secrets.open<{ access_token: string; api?: 'facebook' | 'instagram' }>(sec.c);
    return { token: c.access_token, client: c.api === 'facebook' ? deps.igFb : deps.ig };
  }

  async function save(tenantId: string, igUserId: string, username: string | null, cred: { access_token: string; api: 'facebook' | 'instagram' }) {
    const owner = await deps.db.tenantForInstagram(igUserId);
    if (owner && owner !== tenantId) throw new ApiError(409, 'instagram_already_connected', '이 인스타그램 계정은 다른 매장에 연결되어 있어요.');
    const sealed = deps.secrets.seal(cred);
    await deps.db.withTenant(tenantId, async (tx) => {
      await tx.insert(s.instagramAccounts).values({ tenantId, igUserId, username })
        .onConflictDoUpdate({ target: s.instagramAccounts.tenantId, set: { igUserId, username, connectedAt: new Date() } });
      await tx.insert(s.secrets).values({ tenantId, kind: 'instagram', ciphertext: sealed })
        .onConflictDoUpdate({ target: [s.secrets.tenantId, s.secrets.kind], set: { ciphertext: sealed } });
    });
    return status(tenantId);
  }

  /** 통합 로그인 콜백에서 받은 토큰으로 연결: 할당된 인스타 계정 찾기 → 웹훅 구독 → 저장 */
  async function connectUnified(tenantId: string, accessToken: string) {
    // 비즈니스 시스템 사용자 토큰(OAuth 콜백)은 할당된 계정 목록으로, 대시보드에서 계정별로 만든 토큰은 토큰 자신이 계정
    const accounts = await deps.igFb.assignedAccounts(accessToken).catch(() => []);
    // shortcut: 할당된 계정이 여러 개면 첫 번째만. 여러 계정을 쓰는 매장이 생기면 고르는 화면
    const a = accounts[0] ?? await deps.igFb.profile(accessToken).then((p) => (p.username ? p : null)).catch(() => null);
    if (!a) throw new ApiError(400, 'instagram_no_account', '연결된 인스타그램 계정을 찾지 못했어요. 로그인할 때 인스타 계정을 선택했는지 확인해 주세요.');
    // 구독 실패해도 연결은 저장 (대시보드에서 수동 구독 가능). 실패 사유는 로그로
    await deps.igFb.subscribe(a.id, accessToken).catch((err) => deps.log?.error({ err, ig: a.id }, 'instagram webhook subscribe failed'));
    return save(tenantId, a.id, a.username ?? null, { access_token: accessToken, api: 'facebook' });
  }

  /** 토큰으로 계정을 확인하고 매장에 연결 (토큰은 암호화 저장). 다른 매장이 이미 연결한 계정이면 409 */
  /** 붙여넣은 토큰으로 연결. Instagram 로그인 토큰(graph.instagram.com)이 아니면 통합 로그인 토큰(graph.facebook.com)으로 다시 확인
   *  (Meta 대시보드 "통합 로그인 API 설정"의 토큰 생성 버튼은 Facebook 방식 토큰을 줌) */
  async function connect(tenantId: string, accessToken: string) {
    const me = await deps.ig.me(accessToken).catch(() => null);
    if (me) {
      await deps.ig.subscribe(me.user_id, accessToken).catch((err) => deps.log?.error({ err, ig: me.user_id }, 'instagram webhook subscribe failed'));
      return save(tenantId, me.user_id, me.username ?? null, { access_token: accessToken, api: 'instagram' });
    }
    try { return await connectUnified(tenantId, accessToken); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) throw e;
      throw new ApiError(400, 'instagram_token_invalid', `토큰을 확인하지 못했어요: ${e instanceof Error ? e.message : ''}`.slice(0, 300));
    }
  }

  async function status(tenantId: string) {
    const [a] = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.instagramAccounts), { readOnly: true });
    if (a) knownTenants.add(tenantId);
    return { connected: !!a, ig_user_id: a?.igUserId ?? null, username: a?.username ?? null, connected_at: a?.connectedAt.toISOString() ?? null };
  }

  async function disconnect(tenantId: string) {
    knownTenants.delete(tenantId);
    await deps.db.withTenant(tenantId, async (tx) => {
      await tx.delete(s.instagramAccounts);
      await tx.delete(s.secrets).where(eq(s.secrets.kind, 'instagram'));
    });
    return status(tenantId);
  }

  /** 일반 문의 댓글에 공개 답글 초안. 근거가 없거나 판단이 필요하면 null (공개 댓글이라 주문 · 개인정보는 DM으로 안내) */
  async function draftReply(tenantId: string, cfg: TenantConfig, c: IgComment): Promise<string | null> {
    const grounding = deps.rag ? (await deps.rag.retrieve(tenantId, cfg, c.text)).text : '';
    let out = '';
    for await (const d of deps.llm.stream([
      { role: 'system', content: [
        `당신은 "${cfg.storeName}" 인스타그램 계정의 댓글 담당 AI입니다. 공개 댓글에 답합니다.`,
        `1~2문장, ${Math.min(cfg.settings.persona.max_reply_chars, 200)}자 이내, 친근한 존댓말. 문맥에 어울리는 이모지를 1~2개 자연스럽게 넣어 주세요(불만/사과 상황 제외). 마크다운 금지.`,
        '주문 조회 · 환불 · 교환처럼 개인 정보가 필요한 건 "DM으로 주문번호를 보내주시면 확인해 드릴게요"라고 안내하세요. 환불 · 보상을 약속하지 마세요.',
        `아래 [매장 정보] · [근거] 안에서만 답하고, 근거로 답할 수 없거나 사장님 판단이 필요하면 다른 말 없이 정확히 ${HANDOFF} 만 출력하세요.`,
        `[매장 정보]\n${businessContext(cfg)}`,
        `[근거]\n${grounding || '(없음)'}`,
      ].join('\n\n') },
      { role: 'user', content: c.text },
    ], { tier: 'fast', maxTokens: 200 })) out += d;
    const reply = out.trim();
    if (!reply || reply.includes(HANDOFF) || leaksPii(reply, null) || cfg.settings.persona.banned_phrases.some((b) => b && reply.includes(b))) return null;
    return reply;
  }

  /** 댓글 한 건 처리. 웹훅에서 뒤에서 호출 */
  async function handleComment(tenantId: string, c: IgComment): Promise<CommentResult> {
    const cfg = getTenantConfig(tenantId);
    const ig = cfg.settings.instagram;
    const [acct] = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.instagramAccounts), { readOnly: true });
    // 우리 계정이 단 답글 · 댓글은 다시 처리하지 않음 (자기 답글 루프 방지)
    if (!ig.enabled || !acct || c.fromId === acct.igUserId || (c.username && c.username === acct.username)) return { action: 'skipped', heat: null, reply: null };

    const sess = { id: randomUUID(), channel: 'chat', tenantId, inquiryId: '', state: 'LISTEN', verify: newVerifyState(), abuseStreak: 0, awaitingVerify: false, pendingQuestion: null, heat: 0, needsOwner: false, riskFlags: new Set<string>(), history: [], turnLatencies: [], orderData: [], ended: false } as CallSession;
    const j = await judge(sess, c.text, { cfg, llm: deps.llm, bivia: deps.bivia });
    const heat = j.heat ?? 0;
    const shouldHide = (ig.auto_hide === 'abusive' && j.abusive) || (ig.auto_hide === 'abusive_or_heated' && (j.abusive || heat >= ig.hide_heat_gte));

    let action: CommentResult['action'] = c.hidden ? 'hidden' : 'none';
    let reply: string | null = null;
    try {
      const { token, client } = await credOf(tenantId);
      if (c.hidden) {
        action = 'hidden';
      } else if (shouldHide) {
        await client.hide(c.commentId, token);
        action = 'hidden';
      } else if (ig.auto_reply && !j.needsOwner && !j.abusive && heat < cfg.settings.response.heat_threshold && !c.parentId) {
        const draft = await draftReply(tenantId, cfg, c);
        if (draft) {
          await client.reply(c.commentId, draft, token);
          reply = draft;
          action = 'replied';
        }
      }
    } catch (err) { deps.log?.error({ err, comment: c.commentId }, 'instagram action failed'); }

    // 문의 기록 (댓글 하나 = 문의 하나). 실제 자동 답글을 달았을 때만 auto_done, 숨김 · 판단 필요 · 미답변은 사장님 확인 대기(pending)
    const status = action === 'replied' && !j.needsOwner ? 'auto_done' : 'pending';
    const inquiryId = await deps.db.withTenant(tenantId, async (tx) => {
      const [inq] = await tx.insert(s.inquiries).values({ tenantId, channel: 'sns', status, externalChatId: `ig:${c.commentId}`, customerName: c.username })
        .onConflictDoUpdate({ target: [s.inquiries.tenantId, s.inquiries.externalChatId], set: { status, updatedAt: new Date() } })
        .returning({ id: s.inquiries.id });
      await tx.insert(s.messages).values({ tenantId, inquiryId: inq!.id, sender: 'customer', text: c.text, externalMessageId: c.commentId });
      if (reply) await tx.insert(s.messages).values({ tenantId, inquiryId: inq!.id, sender: 'ai', text: reply });
      await tx.insert(s.analyses).values({ tenantId, inquiryId: inq!.id, heat: Math.round(heat), needsOwner: j.needsOwner, raw: { source: 'instagram', comment_id: c.commentId, media_id: c.mediaId, action, abusive: j.abusive, category: j.category, risk_flags: j.riskFlags, judged_by: j.by } });
      if (action !== 'none') await tx.insert(s.actions).values({ tenantId, inquiryId: inq!.id, actor: 'ai', type: `instagram_${action}`, payload: { comment_id: c.commentId } });
      return inq!.id;
    });

    // 숨겼거나 판단이 필요하거나 격앙된 댓글만 알림 (원문 대신 사실만)
    if (deps.alerts && (action === 'hidden' || j.needsOwner || heat >= cfg.settings.notifications.priority.high_heat_gte)) {
      await deps.alerts.emit(cfg, {
        tenantId, inquiryId, channel: 'sns', kind: 'live', heat, riskFlags: j.riskFlags, needsOwner: j.needsOwner,
        title: action === 'hidden' ? '인스타 악성 댓글을 숨겼어요' : '인스타 댓글 확인 필요',
        message: [`@${c.username ?? '알 수 없음'}`, `감정 ${Math.round(heat)}점`, j.abusive ? '욕설 · 비하 표현' : null, ...j.riskFlags, j.needsOwner ? '사장님 판단 필요' : null].filter(Boolean).join(' · '),
      }).catch(() => null);
    }
    deps.alerts?.emitEvent?.(tenantId, 'inquiry', { id: inquiryId });
    return { action, heat, reply };
  }

  /** Graph API로 최근 게시물의 댓글을 직접 동기화 (웹훅 미도착/연결 전 댓글 보완) */
  async function syncComments(tenantId: string): Promise<{ fetched: number; imported: number; skipped: number }> {
    const [acct] = await deps.db.withTenant(tenantId, (tx) => tx.select().from(s.instagramAccounts), { readOnly: true });
    if (!acct) throw new ApiError(400, 'instagram_not_connected', '인스타그램이 연결되어 있지 않습니다.');
    const { token, client } = await credOf(tenantId);
    const media = await client.listMedia(acct.igUserId, token, 20);
    const existing = await deps.db.withTenant(tenantId, (tx) =>
      tx.select({ ext: s.inquiries.externalChatId }).from(s.inquiries).where(eq(s.inquiries.channel, 'sns')),
      { readOnly: true }
    );
    const seen = new Set(existing.map((r) => r.ext).filter((x): x is string => Boolean(x)));

    let fetched = 0;
    let imported = 0;
    let skipped = 0;

    for (const m of media) {
      const comments = await client.listComments(m.id, token, 50).catch((err) => {
        deps.log?.error({ err, mediaId: m.id }, 'instagram listComments failed');
        return [];
      });
      for (const cm of comments) {
        fetched += 1;
        const text = (cm.text ?? '').trim().slice(0, 2200);
        if (!cm.id || !text || seen.has(`ig:${cm.id}`)) {
          skipped += 1;
          continue;
        }
        seen.add(`ig:${cm.id}`);
        const res = await handleComment(tenantId, {
          igUserId: acct.igUserId,
          commentId: cm.id,
          mediaId: m.id,
          parentId: cm.parent_id ?? null,
          fromId: cm.from?.id ?? null,
          username: cm.from?.username ?? cm.username ?? null,
          text,
          hidden: cm.hidden,
        });
        if (res.action === 'skipped') skipped += 1;
        else imported += 1;
      }
    }
    return { fetched, imported, skipped };
  }

  function startSyncLoop(intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { stop: () => {} };
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const dbTenants = await deps.db.tenantsWithInstagram?.().catch(() => null);
        const tenantIds = dbTenants ? Array.from(new Set([...dbTenants, ...knownTenants])) : [...knownTenants];
        for (const t of tenantIds) {
          try {
            await syncComments(t);
          } catch (err) {
            deps.log?.error({ err, tenantId: t }, 'instagram background sync failed for tenant');
          }
        }
      } catch (err) {
        deps.log?.error({ err }, 'instagram background sync failed');
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  return { connect, connectUnified, status, disconnect, handleComment, syncComments, startSyncLoop };
}
export type InstagramService = ReturnType<typeof createInstagramService>;
